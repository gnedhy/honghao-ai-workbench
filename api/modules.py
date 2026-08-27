import json
import os
import tempfile
from collections.abc import Mapping
from pathlib import Path
from typing import Literal


ModuleId = Literal["chat", "knowledge", "automation", "workbench", "tasks"]
ModuleMode = Literal["off", "prototype", "active"]
RuntimeEnvironment = Literal["test", "production"]
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
    if environment == "production" and any(
        mode == "active" and module_id not in reviewed_active_modules
        for module_id, mode in modes.items()
    ):
        raise ValueError("Production active modules require recorded reviews")
    return modes


def save_persisted_module_modes(
    data_dir: Path,
    environment: RuntimeEnvironment,
    modes: Mapping[ModuleId, ModuleMode],
    approved_module: ModuleId | None = None,
) -> None:
    data_dir.mkdir(parents=True, exist_ok=True)
    target = data_dir / "runtime-config.json"
    reviewed_active_modules: set[str] = set()
    if target.exists():
        existing = json.loads(target.read_text(encoding="utf-8"))
        existing_reviews = existing.get("reviewed_active_modules", []) if isinstance(existing, dict) else []
        if isinstance(existing_reviews, list):
            reviewed_active_modules.update(item for item in existing_reviews if item in MODULE_IDS)
    if approved_module is not None:
        reviewed_active_modules.add(approved_module)
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
