from collections.abc import Mapping
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
