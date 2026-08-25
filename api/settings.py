from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from api.modules import ModuleId, ModuleMode, default_module_modes, module_modes_from_environment
from api.workbenches import (
    WorkbenchId,
    WorkbenchMode,
    default_workbench_modes,
    workbench_modes_from_environment,
)


@dataclass(frozen=True)
class Settings:
    data_dir: Path
    database_path: Path
    controlled_work_dir: Path
    module_modes: dict[ModuleId, ModuleMode]
    workbench_modes: dict[WorkbenchId, WorkbenchMode]
    session_ttl_seconds: int

    @classmethod
    def from_data_dir(
        cls,
        data_dir: Path,
        workbench_modes: dict[WorkbenchId, WorkbenchMode] | None = None,
        module_modes: dict[ModuleId, ModuleMode] | None = None,
        session_ttl_seconds: int = 12 * 60 * 60,
    ) -> "Settings":
        if session_ttl_seconds < 1:
            raise ValueError("Session TTL must be at least one second")
        resolved_data_dir = data_dir.resolve()
        return cls(
            data_dir=resolved_data_dir,
            database_path=resolved_data_dir / "honghao.db",
            controlled_work_dir=resolved_data_dir / "controlled-work",
            module_modes=module_modes or default_module_modes(),
            workbench_modes=workbench_modes or default_workbench_modes(),
            session_ttl_seconds=session_ttl_seconds,
        )

    @classmethod
    def from_environment(cls) -> "Settings":
        repository_root = Path(__file__).resolve().parent.parent
        configured_data_dir = os.environ.get("HONGHAO_DATA_DIR")
        data_dir = Path(configured_data_dir) if configured_data_dir else repository_root / ".data"
        return cls.from_data_dir(
            data_dir,
            workbench_modes_from_environment(os.environ),
            module_modes_from_environment(os.environ),
            int(os.environ.get("HONGHAO_SESSION_TTL_SECONDS", 12 * 60 * 60)),
        )

    def ensure_directories(self) -> None:
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.controlled_work_dir.mkdir(parents=True, exist_ok=True)
