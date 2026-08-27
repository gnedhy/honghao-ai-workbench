import json
import os
import tempfile
from collections.abc import Mapping
from pathlib import Path
from typing import Literal


ModuleId = Literal["chat", "knowledge", "automation", "workbench", "tasks"]
ModuleMode = Literal["off", "prototype", "active"]
MODULE_MODES: tuple[ModuleMode, ...] = ("off", "prototype", "active")
MODULE_IDS: tuple[ModuleId, ...] = (
    "chat",
    "knowledge",
    "automation",
    "workbench",
    "tasks",
)

_DEFAULT_MODULE_MODES: dict[ModuleId, ModuleMode] = {
    "chat": "off",
    "knowledge": "off",
    "automation": "off",
    "workbench": "active",
    "tasks": "off",
}

_API_PREFIXES: tuple[tuple[str, ModuleId], ...] = (
    ("/api/conversation-submissions", "chat"),
    ("/api/conversations", "chat"),
    ("/api/projects", "chat"),
    ("/api/knowledge", "knowledge"),
    ("/api/skills", "automation"),
    ("/api/workflows", "automation"),
    ("/api/connectors", "automation"),
    ("/api/workbenches", "workbench"),
    ("/api/tasks", "tasks"),
)


def default_module_modes() -> dict[ModuleId, ModuleMode]:
    return dict(_DEFAULT_MODULE_MODES)


def module_modes_from_environment(environment: Mapping[str, str]) -> dict[ModuleId, ModuleMode]:
    modes = default_module_modes()
    for module_id in MODULE_IDS:
        variable_name = f"HONGHAO_MODULE_{module_id.upper()}_MODE"
        configured_mode = environment.get(variable_name, modes[module_id])
        if configured_mode not in MODULE_MODES:
            raise ValueError(f"{variable_name} must be off, prototype, or active")
        modes[module_id] = configured_mode
    return modes


def module_for_api_path(path: str) -> ModuleId | None:
    for prefix, module_id in _API_PREFIXES:
        if path == prefix or path.startswith(f"{prefix}/"):
            return module_id
    return None


def load_persisted_module_modes(
    data_dir: Path,
    environment: str,
    defaults: Mapping[ModuleId, ModuleMode],
) -> dict[ModuleId, ModuleMode]:
    path = data_dir / "runtime-config.json"
    modes = dict(defaults)
    if not path.exists():
        return modes
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("Runtime configuration must be an object")
    if payload.get("environment") != environment:
        raise ValueError("Runtime configuration belongs to a different environment")
    configured_modes = payload.get("module_modes")
    if not isinstance(configured_modes, dict):
        raise ValueError("Runtime configuration module_modes must be an object")
    for module_id in MODULE_IDS:
        configured_mode = configured_modes.get(module_id, modes[module_id])
        if configured_mode not in MODULE_MODES:
            raise ValueError(f"Runtime configuration for {module_id} must be off, prototype, or active")
        modes[module_id] = configured_mode
    return modes


def save_persisted_module_modes(
    data_dir: Path,
    environment: str,
    modes: Mapping[ModuleId, ModuleMode],
) -> None:
    data_dir.mkdir(parents=True, exist_ok=True)
    target = data_dir / "runtime-config.json"
    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=data_dir,
            prefix=".runtime-config-",
            suffix=".tmp",
            delete=False,
        ) as temporary:
            temporary_path = Path(temporary.name)
            json.dump(
                {
                    "version": 1,
                    "environment": environment,
                    "module_modes": {module_id: modes[module_id] for module_id in MODULE_IDS},
                },
                temporary,
                ensure_ascii=False,
                indent=2,
            )
            temporary.flush()
            os.fsync(temporary.fileno())
        os.replace(temporary_path, target)
    finally:
        if temporary_path is not None and temporary_path.exists():
            temporary_path.unlink()
