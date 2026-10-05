"""Synthetic H01 probe. This checks feasibility, never enables a product module.

No dependencies beyond Python 3.12. Credentials and raw protocol messages are
never printed or included in receipts. Run --self-test without a model or key.
"""
from __future__ import annotations

import argparse
from collections import deque
import hashlib
import json
import os
from pathlib import Path
import queue
import re
import socket
import subprocess
import sys
import tempfile
import threading
import time
from datetime import datetime, timezone
import urllib.error
import urllib.request

VERSION = "codex-cli 0.160.0"
BINARY_SHA256 = "fdda5fa3cf3fb3d000b876720742857676293e4315e4b045fae6f8bd7e866d1d"
MARKER = "H01-SYNTHETIC-7351"


def require(value, code):
    if not value:
        raise ValueError(code)


def parse_key(text):
    # Accept a plain key or a single key in an env/text file; reject ambiguity.
    keys = set(re.findall(r"(?<![\w-])sk-[A-Za-z0-9_-]{16,}(?![\w-])", text))
    require(len(keys) == 1, "KEY_FORMAT_OR_AMBIGUOUS")
    return keys.pop()


def read_key(path):
    raw = path.read_bytes()
    encoding = "utf-16" if raw.startswith((b"\xff\xfe", b"\xfe\xff")) else "utf-8-sig"
    try:
        return parse_key(raw.decode(encoding))
    except UnicodeError:
        raise ValueError("KEY_ENCODING") from None


def environment(home, key=""):
    allowed = {"systemroot", "windir", "path", "pathext", "comspec", "systemdrive",
               "programfiles", "programfiles(x86)", "programw6432", "programdata",
               "allusersprofile", "commonprogramfiles", "commonprogramfiles(x86)", "commonprogramw6432",
               "os", "processor_architecture", "number_of_processors"}
    env = {name: value for name, value in os.environ.items() if name.lower() in allowed}
    env.update(CODEX_HOME=str(home), USERPROFILE=str(home / "profile"),
               HOME=str(home / "profile"), TEMP=str(home / "tmp"), TMP=str(home / "tmp"),
               PYTHONUTF8="1", H01_DEEPSEEK_API_KEY=key)
    env.update(APPDATA=str(home / "profile" / "AppData" / "Roaming"),
               LOCALAPPDATA=str(home / "profile" / "AppData" / "Local"),
               HOMEDRIVE=home.drive, HOMEPATH=str(home / "profile")[len(home.drive):], USERNAME="h01-synthetic")
    (home / "tmp").mkdir(parents=True, exist_ok=True)
    (home / "profile").mkdir(exist_ok=True)
    for folder in ("Roaming", "Local", "LocalLow"):
        (home / "profile" / "AppData" / folder).mkdir(parents=True, exist_ok=True)
    return env


class Rpc:
    """One outstanding request; sufficient for this sequential feasibility probe."""
    def __init__(self, binary, cwd, env):
        self.process = subprocess.Popen([str(binary), "app-server", "--listen", "stdio://"],
                                        cwd=cwd, env=env, stdin=subprocess.PIPE,
                                        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                        text=True, encoding="utf-8")
        self.messages = queue.Queue()
        self.notifications = deque()
        self.sequence = 0
        threading.Thread(target=self.read, daemon=True).start()

    def read(self):
        try:
            for line in self.process.stdout:
                self.messages.put(json.loads(line))
        except (ValueError, OSError):
            self.messages.put({"probeError": "PROTOCOL_DECODE"})
        finally:
            self.messages.put({"probeError": "SERVER_EOF"})

    def send(self, message):
        self.process.stdin.write(json.dumps(message) + "\n")
        self.process.stdin.flush()

    def receive(self, deadline):
        try:
            message = self.messages.get(timeout=max(0, deadline - time.monotonic()))
        except queue.Empty:
            raise ValueError("PROTOCOL_TIMEOUT") from None
        require("probeError" not in message, message.get("probeError", "PROTOCOL"))
        if "method" in message and "id" in message:
            # No automatic approval, user input, or side effects in this probe.
            self.send({"id": message["id"], "error": {"code": -32601, "message": "H01 denies server requests"}})
            raise ValueError("UNEXPECTED_SERVER_REQUEST")
        return message

    def call(self, method, params, timeout=45):
        self.sequence += 1
        request_id = self.sequence
        self.send({"id": request_id, "method": method, "params": params})
        deadline = time.monotonic() + timeout
        while True:
            message = self.receive(deadline)
            if message.get("id") == request_id:
                if "error" in message and "refusing to run unsandboxed" in message["error"].get("message", ""):
                    raise ValueError("WINDOWS_SANDBOX_SETUP_REQUIRED")
                require("error" not in message, "RPC_ERROR_" + method.replace("/", "_").upper())
                return message["result"]
            require("method" in message, "UNEXPECTED_RESPONSE")
            self.notifications.append(message)

    def initialize(self):
        result = self.call("initialize", {"clientInfo": {"name": "h01_probe", "version": "1"},
                                         "capabilities": {"experimentalApi": False}})
        self.send({"method": "initialized", "params": {}})
        return result

    def turn(self, thread, prompt, skill=None, cancel=False):
        inputs = [{"type": "text", "text": prompt}]
        if skill:
            inputs.append({"type": "skill", "name": "h01-proof", "path": str(skill)})
        result = self.call("turn/start", {"threadId": thread, "input": inputs, "effort": "low"})
        turn = result["turn"]["id"]
        deadline = time.monotonic() + 150
        deltas, text, tool_ok, interrupted = 0, "", False, False
        while True:
            message = self.notifications.popleft() if self.notifications else self.receive(deadline)
            params = message.get("params", {})
            if params.get("threadId") != thread:
                continue
            if params.get("turnId") not in (None, turn):
                continue
            method = message.get("method")
            if method == "item/agentMessage/delta":
                deltas += 1
                text += params.get("delta", "")
            if method in {"item/started", "item/completed"}:
                item = params.get("item", {})
                require(item.get("type") not in {"commandExecution", "fileChange"}, "UNEXPECTED_EXECUTION")
                if method == "item/completed" and item.get("type") == "mcpToolCall":
                    tool_ok |= item.get("status") == "completed" and item.get("tool") == "lookup"
            if cancel and not interrupted and method in {"item/agentMessage/delta", "item/reasoning/textDelta", "item/reasoning/summaryTextDelta"}:
                self.call("turn/interrupt", {"threadId": thread, "turnId": turn})
                interrupted = True
            if method == "turn/completed" and params.get("turn", {}).get("id") == turn:
                status = params["turn"]["status"]
                require(status == ("interrupted" if cancel else "completed"), "TURN_" + str(status).upper())
                return {"deltaCount": deltas, "text": text, "toolCompleted": tool_ok, "cancelAcknowledged": interrupted}

    def close(self):
        if self.process.poll() is None:
            self.process.stdin.close()
            try:
                self.process.wait(timeout=8)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=8)
        self.process.stdout.close()


def mcp_stub():
    """Trusted synthetic lookup only. No filesystem, subprocess, or network tools."""
    for line in sys.stdin:
        request = json.loads(line)
        if "id" not in request:
            continue
        method = request["method"]
        if method == "initialize":
            result = {"protocolVersion": request["params"]["protocolVersion"], "capabilities": {"tools": {}},
                      "serverInfo": {"name": "h01-synthetic", "version": "1"}}
        elif method == "tools/list":
            result = {"tools": [{"name": "lookup", "description": "Return the synthetic stock count for H01 only.",
                                 "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
                                 "annotations": {"readOnlyHint": True, "destructiveHint": False}}]}
        elif method == "tools/call" and request["params"].get("name") == "lookup" and request["params"].get("arguments", {}) == {}:
            require(not os.environ.get("H01_DEEPSEEK_API_KEY"), "MCP_CREDENTIAL_LEAK")
            result = {"content": [{"type": "text", "text": '{"syntheticStockCount": 17, "credentialPresent": false}'}]}
        elif method == "ping":
            result = {}
        else:
            print(json.dumps({"jsonrpc": "2.0", "id": request["id"], "error": {"code": -32601, "message": "Unsupported synthetic method"}}), flush=True)
            continue
        print(json.dumps({"jsonrpc": "2.0", "id": request["id"], "result": result}), flush=True)


def self_test():
    key = "sk-" + "synthetic" * 5
    assert parse_key(key) == parse_key("DEEPSEEK_API_KEY='" + key + "'")
    for invalid in ("", key + " sk-" + "different" * 5):
        try:
            parse_key(invalid)
            assert False, "ambiguous credential accepted"
        except ValueError as error:
            assert key not in str(error)
    rpc = Rpc.__new__(Rpc)
    rpc.messages = queue.Queue()
    sent = []
    rpc.send = sent.append
    rpc.messages.put({"id": 10, "method": "item/commandExecution/requestApproval"})
    try:
        rpc.receive(time.monotonic() + 1)
        assert False, "approval accepted"
    except ValueError as error:
        assert str(error) == "UNEXPECTED_SERVER_REQUEST"
    assert sent[0]["error"]["code"] == -32601
    rpc.messages.put({"probeError": "SERVER_EOF"})
    try:
        rpc.receive(time.monotonic() + 1)
        assert False, "closed server accepted"
    except ValueError as error:
        assert str(error) == "SERVER_EOF"
    with tempfile.TemporaryDirectory(prefix="h01-self-check-") as directory:
        root = Path(directory)
        key_file = root / "synthetic-key.txt"
        for encoding in ("utf-8-sig", "utf-16"):
            key_file.write_text(key, encoding=encoding)
            assert read_key(key_file) == key
        previous = os.environ.get("H01_SYNTHETIC_BUSINESS_CREDENTIAL")
        os.environ["H01_SYNTHETIC_BUSINESS_CREDENTIAL"] = "must-not-propagate"
        try:
            env = environment(root / "owned-home", key)
            assert "H01_SYNTHETIC_BUSINESS_CREDENTIAL" not in env
            assert Path(env["APPDATA"]).is_dir() and Path(env["LOCALAPPDATA"]).is_dir()
        finally:
            if previous is None:
                os.environ.pop("H01_SYNTHETIC_BUSINESS_CREDENTIAL")
            else:
                os.environ["H01_SYNTHETIC_BUSINESS_CREDENTIAL"] = previous
    print("PASS H01 parser and deny-by-default protocol self-check")


def direct_request(key, input_items, tools=None):
    payload = {"model": "deepseek-flash", "input": input_items, "stream": True,
               "reasoning": {"effort": "low"}, "max_output_tokens": 768}
    if tools:
        payload.update(tools=tools, tool_choice="auto")
    request = urllib.request.Request("https://api.deepseek.com/responses", data=json.dumps(payload).encode(),
                                     headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"})
    started = time.monotonic()
    count, text, response = 0, "", None
    with urllib.request.urlopen(request, timeout=45) as stream:
        data = []
        for raw in stream:
            require(time.monotonic() - started < 120, "API_STREAM_DEADLINE")
            line = raw.decode("utf-8").rstrip("\r\n")
            if line.startswith("data:"):
                data.append(line[5:].lstrip())
            if not line and data:
                event = json.loads("\n".join(data))
                data = []
                if event.get("type") == "response.output_text.delta":
                    count += 1
                    text += event.get("delta", "")
                elif event.get("type") == "response.completed":
                    response = event["response"]
                    break
                require(event.get("type") not in {"response.failed", "response.incomplete", "error"}, "API_STREAM_FAILED")
    require(response is not None, "API_STREAM_INCOMPLETE")
    return response, text, count, round(time.monotonic() - started, 3)


def direct_checks(key, receipt):
    initial = [{"role": "user", "content": f"Echo exactly {MARKER}. This is a synthetic integration test."}]
    first, text, count, elapsed = direct_request(key, initial)
    require(MARKER in text and count > 0, "DIRECT_STREAM_CONTENT")
    receipt["checks"].append({"id": "direct-responses-stream", "status": "passed", "deltas": count, "modelNetworkSeconds": elapsed})
    tool_input = [{"role": "user", "content": "Use synthetic_lookup to get the synthetic stock count."}]
    tools = [{"type": "function", "name": "synthetic_lookup", "description": "Synthetic stock count only.",
              "parameters": {"type": "object", "properties": {}, "additionalProperties": False}}]
    result, _, _, _ = direct_request(key, tool_input, tools)
    calls = [item for item in result["output"] if item.get("type") == "function_call"]
    require(len(calls) == 1 and calls[0]["name"] == "synthetic_lookup" and json.loads(calls[0]["arguments"]) == {}, "DIRECT_FUNCTION_CALL")
    replay = tool_input + result["output"] + [{"type": "function_call_output", "call_id": calls[0]["call_id"], "output": '{"syntheticStockCount":17}'}]
    _, answer, _, _ = direct_request(key, replay)
    require("17" in answer, "DIRECT_FUNCTION_RESULT")
    receipt["checks"].append({"id": "direct-function-roundtrip", "status": "passed"})
    replay = initial + first["output"] + [{"role": "user", "content": "Echo the original synthetic marker again."}]
    _, answer, _, _ = direct_request(key, replay)
    require(MARKER in answer, "DIRECT_HISTORY_REPLAY")
    receipt["checks"].append({"id": "direct-stateless-history-replay", "status": "passed"})


def sandbox_checks(binary, project, home, root, receipt):
    original, work, outside = project / "original.txt", project / "work", root / "other-project"
    work.mkdir()
    outside.mkdir()
    original.write_text("SYNTHETIC_ORIGINAL", encoding="utf-8")
    (outside / "private.txt").write_text("SYNTHETIC_OTHER_PROJECT", encoding="utf-8")
    junction = work / "other-project-link"
    quote = lambda path: str(path).replace("'", "''")
    creation = subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
                               f"New-Item -ItemType Junction -Path '{quote(junction)}' -Target '{quote(outside)}' | Out-Null"],
                              capture_output=True, timeout=15)
    require(creation.returncode == 0 and junction.is_dir(), "JUNCTION_FIXTURE_FAILED")
    with (home / "config.toml").open("a", encoding="utf-8") as config:
        config.write(f'''\n[permissions.h01-work.filesystem]
":minimal" = "read"
{json.dumps(str(project))} = "read"
{json.dumps(str(work))} = "write"
{json.dumps(str(Path(sys.executable).parent))} = "read"
[permissions.h01-work.network]
enabled = false
''')
    script = '''import json, os, socket, sys
from pathlib import Path
original, work, outside, junction, config = map(Path, sys.argv[1:6])
checks = []
def blocked(name, operation):
    try:
        operation()
    except PermissionError:
        checks.append(name)
        return
    raise AssertionError(name)
assert original.read_text() == "SYNTHETIC_ORIGINAL"
(work / "result.txt").write_text("SYNTHETIC_RESULT")
assert (work / "result.txt").read_text() == "SYNTHETIC_RESULT"
checks.extend(["original-readable", "working-copy-writable"])
blocked("original-write-denied", lambda: original.write_text("FORBIDDEN"))
blocked("other-project-read-denied", lambda: (outside / "private.txt").read_text())
blocked("other-project-write-denied", lambda: (outside / "forbidden.txt").write_text("FORBIDDEN"))
blocked("runtime-config-read-denied", lambda: config.read_text())
blocked("junction-read-denied", lambda: (junction / "private.txt").read_text())
blocked("junction-write-denied", lambda: (junction / "forbidden.txt").write_text("FORBIDDEN"))
assert not os.environ.get("H01_DEEPSEEK_API_KEY")
checks.append("no-model-credential-in-command")
for name, address, port in [("loopback-network-denied", "127.0.0.1", int(sys.argv[6])), ("public-network-denied", sys.argv[7], 443)]:
    try:
        connection = socket.create_connection((address, port), timeout=2)
    except OSError:
        checks.append(name)
    else:
        connection.close()
        raise AssertionError(name)
print(json.dumps(checks))
'''
    public_ip = socket.gethostbyname("api.deepseek.com")
    with socket.create_connection((public_ip, 443), timeout=8):
        pass
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        listener.listen(3)
        port = listener.getsockname()[1]
        with socket.create_connection(("127.0.0.1", port), timeout=2):
            pass
        peer, _ = listener.accept()
        peer.close()
        result = subprocess.run([str(binary), "sandbox", "--permission-profile", "h01-work", "--cd", str(project), "--",
                                 sys.executable, "-c", script, str(original), str(work), str(outside), str(junction),
                                 str(home / "config.toml"), str(port), public_ip],
                                cwd=project, env=environment(home), capture_output=True, text=True, encoding="utf-8", timeout=40)
    require(result.returncode == 0, "OS_SANDBOX_CHECK_FAILED")
    checks = json.loads(result.stdout)
    expected = {"original-readable", "working-copy-writable", "original-write-denied", "other-project-read-denied",
                "other-project-write-denied", "runtime-config-read-denied", "junction-read-denied", "junction-write-denied",
                "no-model-credential-in-command", "loopback-network-denied", "public-network-denied"}
    require(set(checks) == expected and len(checks) == len(expected), "OS_CHECK_RECEIPT_INCOMPLETE")
    require(original.read_text() == "SYNTHETIC_ORIGINAL" and not (outside / "forbidden.txt").exists(), "OS_FIXTURE_MODIFIED")
    receipt["checks"].extend({"id": name, "status": "passed"} for name in sorted(expected))


def run(args, receipt):
    require(os.name == "nt", "WINDOWS_REQUIRED")
    binary = args.codex.resolve(strict=True)
    with binary.open("rb") as stream:
        require(hashlib.file_digest(stream, "sha256").hexdigest() == BINARY_SHA256, "BINARY_HASH")
    version = subprocess.run([str(binary), "--version"], capture_output=True, text=True, timeout=15)
    require(version.returncode == 0 and version.stdout.strip() == VERSION, "BINARY_VERSION")
    receipt["checks"].append({"id": "binary", "status": "passed"})
    key = read_key(args.key_file)
    direct_checks(key, receipt)
    with tempfile.TemporaryDirectory(prefix="h01-") as directory:
        root = Path(directory)
        project, home = root / "project", root / "home"
        project.mkdir(exist_ok=True)
        home.mkdir(exist_ok=True)
        skill = project / ".agents" / "skills" / "h01-proof" / "SKILL.md"
        skill.parent.mkdir(parents=True, exist_ok=True)
        skill.write_text('---\nname: h01-proof\ndescription: Synthetic H01 feasibility skill.\n---\nWhen invoked, include H01-SKILL-9842 in your answer. Do not run commands.\n', encoding="utf-8")
        (project / "AGENTS.md").write_text("Append H01-RULE-6228 to every final answer. Never run shell commands or modify files.\n", encoding="utf-8")
        command_env = environment(home)
        command_env.pop("H01_DEEPSEEK_API_KEY")
        command_env.pop("CODEX_HOME")
        command_env_toml = "{ " + ", ".join(json.dumps(name) + " = " + json.dumps(value) for name, value in command_env.items()) + " }"
        config = f'''model = "deepseek-flash"
model_provider = "deepseek"
model_catalog_json = {json.dumps(str(args.catalog.resolve()))}
model_reasoning_effort = "low"
web_search = "disabled"
approval_policy = "on-request"
default_permissions = "h01"
[permissions.h01.filesystem]
":minimal" = "read"
{json.dumps(str(project))} = "read"
[permissions.h01.network]
enabled = false
[windows]
sandbox = {json.dumps(args.windows_sandbox)}
[model_providers.deepseek]
name = "deepseek"
base_url = "https://api.deepseek.com/"
env_key = "H01_DEEPSEEK_API_KEY"
wire_api = "responses"
request_max_retries = 0
stream_max_retries = 0
stream_idle_timeout_ms = 45000
[shell_environment_policy]
inherit = "none"
set = {command_env_toml}
[features]
shell_tool = false
unified_exec = false
apps = false
plugins = false
multi_agent = false
memories = false
skip_host_skill_discovery = true
[analytics]
enabled = false
[skills]
include_instructions = false
[mcp_servers.h01]
command = {json.dumps(sys.executable)}
args = [{json.dumps(str(Path(__file__).resolve()))}, "--mcp-stub"]
env = {{ H01_DEEPSEEK_API_KEY = "" }}
enabled_tools = ["lookup"]
'''
        (home / "config.toml").write_text(config, encoding="utf-8")
        env = environment(home, key)
        if args.windows_sandbox == "mxc":
            sandbox_checks(binary, project, home, root, receipt)
            receipt["checks"].append({"id": "windows-read-write-isolation", "status": "passed"})
        rpc = Rpc(binary, project, env)
        try:
            rpc.initialize()
            receipt["checks"].append({"id": "stdio-initialize", "status": "passed"})
            readiness = rpc.call("windowsSandbox/readiness", {})
            receipt["checks"].append({"id": "windows-sandbox-readiness", "status": readiness["status"]})
            listing = rpc.call("skills/list", {"cwds": [str(project)], "forceReload": True})
            skills = [item for entry in listing["data"] for item in entry["skills"]]
            require(any(item["name"] == "h01-proof" and Path(item["path"]) == skill for item in skills), "PROJECT_SKILL_MISSING")
            foreign = [item for item in skills if not Path(item["path"]).is_relative_to(root)]
            for item in foreign:
                rpc.call("skills/config/write", {"path": item["path"], "enabled": False})
            if foreign:
                listing = rpc.call("skills/list", {"cwds": [str(project)], "forceReload": True})
                skills = [item for entry in listing["data"] for item in entry["skills"]]
            require(all(not item["enabled"] or Path(item["path"]).is_relative_to(root) for item in skills), "PERSONAL_SKILL_DISCOVERY")
            receipt["checks"].append({"id": "isolated-skill-list", "status": "passed", "foreignSkillsDisabled": len(foreign)})
            start = rpc.call("thread/start", {"cwd": str(project), "modelProvider": "deepseek", "model": "deepseek-flash",
                                             "baseInstructions": "Use only synthetic inputs. Do not run shell commands or modify files."})
            thread = start["thread"]["id"]
            first = rpc.turn(thread, f"Remember {MARKER} for this task. Reply with it and the project rule marker.")
            require(first["deltaCount"] > 0 and MARKER in first["text"] and "H01-RULE-6228" in first["text"], "STREAM_OR_RULE")
            receipt["checks"].append({"id": "real-stream-and-project-rule", "status": "passed", "deltas": first["deltaCount"]})
            tool = rpc.turn(thread, "Invoke the h01 lookup tool to get the synthetic stock count. Include the result and the skill marker.", skill=skill)
            require(tool["toolCompleted"] and "17" in tool["text"] and "H01-SKILL-9842" in tool["text"], "TOOL_OR_SKILL")
            receipt["checks"].append({"id": "real-mcp-and-skill", "status": "passed"})
            cancelled = rpc.turn(thread, "Write 3000 numbered synthetic sample sentences. Do not use tools.", cancel=True)
            require(cancelled["cancelAcknowledged"], "CANCEL_NOT_ACKNOWLEDGED")
            receipt["checks"].append({"id": "real-cancel", "status": "passed"})
        finally:
            rpc.close()
        rpc = Rpc(binary, project, env)
        try:
            rpc.initialize()
            resumed = rpc.call("thread/resume", {"threadId": thread, "cwd": str(project)})
            require(resumed["thread"]["id"] == thread, "RESUME_ID_CHANGED")
            followup = rpc.turn(thread, "What was the original H01 synthetic task marker? Reply with it. Do not use tools.")
            require(MARKER in followup["text"], "RESUME_HISTORY_LOST")
            receipt["checks"].append({"id": "process-restart-resume", "status": "passed"})
        finally:
            rpc.close()
    receipt["localFeasibility"] = "passed" if args.windows_sandbox == "mxc" else "not-verified"
    receipt["checks"].append({"id": "target-server-capability", "status": "not-verified"})
    receipt["status"] = "blocked"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--mcp-stub", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--codex", type=Path)
    parser.add_argument("--catalog", type=Path)
    parser.add_argument("--key-file", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--windows-sandbox", choices=("unelevated", "elevated", "mxc"), default="unelevated")
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return 0
    if args.mcp_stub:
        mcp_stub()
        return 0
    require(all((args.codex, args.catalog, args.key_file, args.output)), "REQUIRED_ARGUMENTS")
    args.output = args.output.resolve()
    inputs = [args.codex, args.catalog, args.key_file]
    require(args.output not in {path.resolve() for path in inputs}, "OUTPUT_OVERWRITES_INPUT")
    require(not args.output.exists(), "OUTPUT_ALREADY_EXISTS")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    receipt = {"schema": 1, "checkedAt": datetime.now(timezone.utc).isoformat(), "version": VERSION,
               "windowsSandboxMode": args.windows_sandbox,
               "model": "deepseek-flash", "status": "failed", "checks": []}
    started = time.monotonic()
    try:
        run(args, receipt)
    except urllib.error.HTTPError as error:
        receipt["failure"] = "DEEPSEEK_HTTP_" + str(error.code)
        error.close()
    except ValueError as error:
        # Only internal codes may cross the reporting boundary.
        code = str(error)
        receipt["failure"] = code if re.fullmatch(r"[A-Z0-9_]+", code) else "VALIDATION_ERROR"
        if code == "WINDOWS_SANDBOX_SETUP_REQUIRED":
            receipt["status"] = "blocked"
            receipt["checks"].append({"id": "restricted-thread-start-fail-closed", "status": "passed"})
    except (OSError, subprocess.SubprocessError, KeyError, TypeError):
        receipt["failure"] = "PROBE_RUNTIME_ERROR"
    receipt["elapsedSeconds"] = round(time.monotonic() - started, 3)
    with args.output.open("x", encoding="utf-8") as output:
        output.write(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps(receipt))
    return 2 if receipt["status"] == "blocked" else 1


if __name__ == "__main__":
    raise SystemExit(main())
