from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

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
    workbench_modes: dict[WorkbenchId, WorkbenchMode]

    @classmethod
    def from_data_dir(
        cls,
        data_dir: Path,
        workbench_modes: dict[WorkbenchId, WorkbenchMode] | None = None,
    ) -> "Settings":
        resolved_data_dir = data_dir.resolve()
        return cls(
            data_dir=resolved_data_dir,
            database_path=resolved_data_dir / "honghao.db",
            controlled_work_dir=resolved_data_dir / "controlled-work",
            workbench_modes=workbench_modes or default_workbench_modes(),
        )

    @classmethod
    def from_environment(cls) -> "Settings":
        repository_root = Path(__file__).resolve().parent.parent
        configured_data_dir = os.environ.get("HONGHAO_DATA_DIR")
        data_dir = Path(configured_data_dir) if configured_data_dir else repository_root / ".data"
        return cls.from_data_dir(data_dir, workbench_modes_from_environment(os.environ))

    def ensure_directories(self) -> None:
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.controlled_work_dir.mkdir(parents=True, exist_ok=True)
