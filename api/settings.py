from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from api.modules import (
    ModuleId,
    ModuleMode,
    RuntimeEnvironment,
    default_module_modes,
    load_persisted_module_modes,
    module_modes_from_environment,
)
from api.workbenches import (
    WorkbenchId,
    WorkbenchMode,
    default_workbench_modes,
    load_persisted_workbench_modes,
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
    environment: RuntimeEnvironment

    @classmethod
    def from_data_dir(
        cls,
        data_dir: Path,
        workbench_modes: dict[WorkbenchId, WorkbenchMode] | None = None,
        module_modes: dict[ModuleId, ModuleMode] | None = None,
        session_ttl_seconds: int = 12 * 60 * 60,
        environment: RuntimeEnvironment = "test",
    ) -> "Settings":
        if session_ttl_seconds < 1:
            raise ValueError("Session TTL must be at least one second")
        if environment not in {"test", "production"}:
            raise ValueError("Environment must be test or production")
        resolved_data_dir = data_dir.resolve()
        environment_marker = resolved_data_dir / "environment"
        if environment_marker.exists() and environment_marker.read_text(encoding="utf-8").strip() != environment:
            raise ValueError("Data directory belongs to a different environment")
        persisted_module_modes = load_persisted_module_modes(
            resolved_data_dir,
            environment,
            module_modes or default_module_modes(environment),
        )
        persisted_workbench_modes = load_persisted_workbench_modes(
            resolved_data_dir,
            environment,
            workbench_modes or default_workbench_modes(),
        )
        return cls(
            data_dir=resolved_data_dir,
            database_path=resolved_data_dir / "honghao.db",
            controlled_work_dir=resolved_data_dir / "controlled-work",
            module_modes=persisted_module_modes,
            workbench_modes=persisted_workbench_modes,
            session_ttl_seconds=session_ttl_seconds,
            environment=environment,
        )

    @classmethod
    def from_environment(cls) -> "Settings":
        repository_root = Path(__file__).resolve().parent.parent
        configured_data_dir = os.environ.get("HONGHAO_DATA_DIR")
        data_dir = Path(configured_data_dir) if configured_data_dir else repository_root / ".data"
        environment = os.environ.get("HONGHAO_ENVIRONMENT", "test")
        if environment not in {"test", "production"}:
            raise ValueError("HONGHAO_ENVIRONMENT must be test or production")
        if environment == "production" and any(
            f"HONGHAO_MODULE_{module_id.upper()}_MODE" in os.environ
            for module_id in ("chat", "knowledge", "automation", "workbench", "tasks")
        ):
            raise ValueError("Production module modes must be changed through admin settings")
        if environment == "production" and any(
            f"HONGHAO_WORKBENCH_{workbench_id.upper()}_MODE" in os.environ
            for workbench_id in ("management", "procurement", "research", "sales")
        ):
            raise ValueError("Production workbench modes must be changed through admin settings")
        return cls.from_data_dir(
            data_dir,
            workbench_modes_from_environment(os.environ),
            module_modes_from_environment(os.environ, environment),
            int(os.environ.get("HONGHAO_SESSION_TTL_SECONDS", 12 * 60 * 60)),
            environment,
        )

    def ensure_directories(self) -> None:
        self.data_dir.mkdir(parents=True, exist_ok=True)
        environment_marker = self.data_dir / "environment"
        try:
            with environment_marker.open("x", encoding="utf-8") as marker:
                marker.write(self.environment)
        except FileExistsError:
            if environment_marker.read_text(encoding="utf-8").strip() != self.environment:
                raise ValueError("Data directory belongs to a different environment")
        self.controlled_work_dir.mkdir(parents=True, exist_ok=True)
