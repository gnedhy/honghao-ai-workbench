import json
import os
import re
import tempfile
from collections.abc import Mapping, Sequence
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal
from uuid import UUID


ModuleId = Literal["chat", "knowledge", "automation", "workbench", "tasks"]
ModuleMode = Literal["off", "prototype", "active"]
RuntimeEnvironment = Literal["test", "production"]
MODULE_MODES: tuple[ModuleMode, ...] = ("off", "prototype", "active")
REQUIRED_ACTIVATION_REVIEWS = frozenset({"business", "security", "code", "rollback"})
_ISSUE_URL = re.compile(r"^https://github\.com/[^/]+/[^/]+/issues/\d+$")
_PULL_REQUEST_URL = re.compile(r"^https://github\.com/[^/]+/[^/]+/pull/\d+$")
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


def create_activation_review_record(
    reviews: Sequence[str],
    *,
    reviewed_by: str,
    issue_url: str,
    pull_request_url: str,
) -> dict[str, object]:
    if set(reviews) != REQUIRED_ACTIVATION_REVIEWS:
        raise ValueError("Production active modules require recorded reviews")
    return {
        "checks": sorted(REQUIRED_ACTIVATION_REVIEWS),
        "reviewed_by": reviewed_by,
        "reviewed_at": datetime.now(UTC).isoformat(),
        "issue_url": issue_url,
        "pull_request_url": pull_request_url,
    }


def activation_review_is_complete(record: object) -> bool:
    if not isinstance(record, dict):
        return False
    checks = record.get("checks")
    if not (
        isinstance(checks, list)
        and all(isinstance(check, str) for check in checks)
        and set(checks) == REQUIRED_ACTIVATION_REVIEWS
        and all(
            isinstance(record.get(key), str) and bool(record[key])
            for key in ("reviewed_by", "reviewed_at", "issue_url", "pull_request_url")
        )
    ):
        return False
    try:
        UUID(record["reviewed_by"])
        reviewed_at = datetime.fromisoformat(record["reviewed_at"])
    except (TypeError, ValueError):
        return False
    return (
        reviewed_at.tzinfo is not None
        and _ISSUE_URL.fullmatch(record["issue_url"]) is not None
        and _PULL_REQUEST_URL.fullmatch(record["pull_request_url"]) is not None
    )


def create_mode_change_record(
    target_id: str,
    mode: str,
    changed_by: str,
    activation_review: Mapping[str, object] | None = None,
) -> dict[str, object]:
    return {
        "target_id": target_id,
        "mode": mode,
        "changed_by": changed_by,
        "changed_at": datetime.now(UTC).isoformat(),
        "activation_review": dict(activation_review) if activation_review is not None else None,
    }


def mode_change_record_is_valid(
    record: object,
    target_ids: Sequence[str],
    modes: Sequence[str],
    require_active_review: bool = False,
) -> bool:
    if not isinstance(record, dict):
        return False
    try:
        UUID(record.get("changed_by"))
        changed_at = datetime.fromisoformat(record.get("changed_at"))
    except (TypeError, ValueError):
        return False
    mode = record.get("mode")
    review = record.get("activation_review")
    return (
        record.get("target_id") in target_ids
        and mode in modes
        and changed_at.tzinfo is not None
        and (review is None or activation_review_is_complete(review))
        and (not require_active_review or mode != "active" or activation_review_is_complete(review))
    )


def default_module_modes(environment: RuntimeEnvironment = "test") -> dict[ModuleId, ModuleMode]:
    if environment == "production":
        return {module_id: "off" for module_id in MODULE_IDS}
    return dict(_DEFAULT_MODULE_MODES)


def module_modes_from_environment(
    environment: Mapping[str, str],
    runtime_environment: RuntimeEnvironment = "test",
) -> dict[ModuleId, ModuleMode]:
    modes = default_module_modes(runtime_environment)
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
    environment: RuntimeEnvironment,
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
    reviewed_active_modules = payload.get("reviewed_active_modules", [])
    if not isinstance(reviewed_active_modules, list):
        raise ValueError("Runtime configuration reviewed_active_modules must be a list")
    activation_reviews = payload.get("activation_reviews", {})
    if not isinstance(activation_reviews, dict):
        raise ValueError("Runtime configuration activation_reviews must be an object")
    if any(
        module_id not in MODULE_IDS or not activation_review_is_complete(record)
        for module_id, record in activation_reviews.items()
    ):
        raise ValueError("Runtime configuration activation_reviews is invalid")
    activation_history = payload.get("activation_history", [])
    if not isinstance(activation_history, list) or any(
        not mode_change_record_is_valid(record, MODULE_IDS, MODULE_MODES, environment == "production")
        for record in activation_history
    ):
        raise ValueError("Runtime configuration activation_history is invalid")
    if environment == "production" and any(
        mode == "active"
        and not activation_review_is_complete(activation_reviews.get(module_id))
        for module_id, mode in modes.items()
    ):
        raise ValueError("Production active modules require recorded reviews")
    return modes


def save_persisted_module_modes(
    data_dir: Path,
    environment: RuntimeEnvironment,
    modes: Mapping[ModuleId, ModuleMode],
    approved_module: ModuleId | None = None,
    approved_review_record: Mapping[str, object] | None = None,
    changed_module: ModuleId | None = None,
    changed_mode: ModuleMode | None = None,
    changed_by: str | None = None,
) -> None:
    data_dir.mkdir(parents=True, exist_ok=True)
    target = data_dir / "runtime-config.json"
    reviewed_active_modules: set[str] = set()
    activation_reviews: dict[str, dict[str, object]] = {}
    activation_history: list[dict[str, object]] = []
    if target.exists():
        existing = json.loads(target.read_text(encoding="utf-8"))
        existing_reviews = existing.get("reviewed_active_modules", []) if isinstance(existing, dict) else []
        if isinstance(existing_reviews, list):
            reviewed_active_modules.update(item for item in existing_reviews if item in MODULE_IDS)
        existing_activation_reviews = existing.get("activation_reviews", {}) if isinstance(existing, dict) else {}
        if isinstance(existing_activation_reviews, dict):
            activation_reviews.update({
                module_id: dict(record)
                for module_id, record in existing_activation_reviews.items()
                if module_id in MODULE_IDS and activation_review_is_complete(record)
            })
        existing_history = existing.get("activation_history", []) if isinstance(existing, dict) else []
        if isinstance(existing_history, list):
            activation_history.extend(
                dict(record)
                for record in existing_history
                if mode_change_record_is_valid(record, MODULE_IDS, MODULE_MODES, environment == "production")
            )
    if approved_module is not None:
        if not activation_review_is_complete(approved_review_record):
            raise ValueError("Production active modules require recorded reviews")
        reviewed_active_modules.add(approved_module)
        activation_reviews[approved_module] = dict(approved_review_record)
    if changed_module is not None and changed_mode is not None and changed_by is not None:
        activation_history.append(
            create_mode_change_record(changed_module, changed_mode, changed_by, approved_review_record)
        )
    reviewed_active_modules.intersection_update(
        module_id for module_id, mode in modes.items() if mode == "active"
    )
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
                    "reviewed_active_modules": sorted(reviewed_active_modules),
                    "activation_reviews": activation_reviews,
                    "activation_history": activation_history,
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
