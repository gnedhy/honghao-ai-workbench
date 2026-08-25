from collections.abc import Mapping
from typing import Literal


WorkbenchId = Literal["management", "procurement", "research", "sales"]
WorkbenchMode = Literal["prototype", "active", "off"]
WORKBENCH_MODES: tuple[WorkbenchMode, ...] = ("prototype", "active", "off")

WORKBENCH_IDS: tuple[WorkbenchId, ...] = (
    "management",
    "procurement",
    "research",
    "sales",
)


def default_workbench_modes() -> dict[WorkbenchId, WorkbenchMode]:
    return {workbench_id: "prototype" for workbench_id in WORKBENCH_IDS}


def workbench_modes_from_environment(environment: Mapping[str, str]) -> dict[WorkbenchId, WorkbenchMode]:
    modes = default_workbench_modes()
    for workbench_id in WORKBENCH_IDS:
        variable_name = f"HONGHAO_WORKBENCH_{workbench_id.upper()}_MODE"
        configured_mode = environment.get(variable_name, "prototype")
        if configured_mode not in WORKBENCH_MODES:
            raise ValueError(f"{variable_name} must be prototype, active, or off")
        modes[workbench_id] = configured_mode
    return modes
