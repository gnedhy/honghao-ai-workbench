import json
import os
import tempfile
from collections.abc import Mapping
from pathlib import Path
from typing import Literal

from api.modules import (
    RuntimeEnvironment,
    activation_review_is_complete,
    create_mode_change_record,
    mode_change_record_is_valid,
)


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


def load_persisted_workbench_modes(
    data_dir: Path,
    environment: RuntimeEnvironment,
    defaults: Mapping[WorkbenchId, WorkbenchMode],
) -> dict[WorkbenchId, WorkbenchMode]:
    path = data_dir / "workbench-runtime-config.json"
    modes = dict(defaults)
    if not path.exists():
        return modes
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict) or payload.get("environment") != environment:
        raise ValueError("Workbench runtime configuration is invalid or belongs to another environment")
    configured_modes = payload.get("workbench_modes")
    reviews = payload.get("activation_reviews", {})
    if not isinstance(configured_modes, dict) or not isinstance(reviews, dict):
        raise ValueError("Workbench runtime configuration is invalid")
    if any(
        workbench_id not in WORKBENCH_IDS or not activation_review_is_complete(record)
        for workbench_id, record in reviews.items()
    ):
        raise ValueError("Workbench runtime configuration activation_reviews is invalid")
    history = payload.get("activation_history", [])
    if not isinstance(history, list) or any(
        not mode_change_record_is_valid(record, WORKBENCH_IDS, WORKBENCH_MODES)
        for record in history
    ):
        raise ValueError("Workbench runtime configuration activation_history is invalid")
    for workbench_id in WORKBENCH_IDS:
        mode = configured_modes.get(workbench_id, modes[workbench_id])
        if mode not in WORKBENCH_MODES:
            raise ValueError(f"Workbench runtime configuration for {workbench_id} is invalid")
        if environment == "production" and mode == "active" and not activation_review_is_complete(reviews.get(workbench_id)):
            raise ValueError("Production active workbenches require recorded reviews")
        modes[workbench_id] = mode
    return modes


def save_persisted_workbench_modes(
    data_dir: Path,
    environment: RuntimeEnvironment,
    modes: Mapping[WorkbenchId, WorkbenchMode],
    approved_workbench: WorkbenchId | None = None,
    approved_review_record: Mapping[str, object] | None = None,
    changed_workbench: WorkbenchId | None = None,
    changed_mode: WorkbenchMode | None = None,
    changed_by: str | None = None,
) -> None:
    data_dir.mkdir(parents=True, exist_ok=True)
    target = data_dir / "workbench-runtime-config.json"
    reviews: dict[str, dict[str, object]] = {}
    history: list[dict[str, object]] = []
    if target.exists():
        existing = json.loads(target.read_text(encoding="utf-8"))
        existing_reviews = existing.get("activation_reviews", {}) if isinstance(existing, dict) else {}
        if isinstance(existing_reviews, dict):
            reviews.update({
                workbench_id: dict(record)
                for workbench_id, record in existing_reviews.items()
                if workbench_id in WORKBENCH_IDS and activation_review_is_complete(record)
            })
        existing_history = existing.get("activation_history", []) if isinstance(existing, dict) else []
        if isinstance(existing_history, list):
            history.extend(
                dict(record)
                for record in existing_history
                if mode_change_record_is_valid(record, WORKBENCH_IDS, WORKBENCH_MODES)
            )
    if approved_workbench is not None:
        if not activation_review_is_complete(approved_review_record):
            raise ValueError("Production active workbenches require recorded reviews")
        reviews[approved_workbench] = dict(approved_review_record)
    if changed_workbench is not None and changed_mode is not None and changed_by is not None:
        history.append(
            create_mode_change_record(changed_workbench, changed_mode, changed_by, approved_review_record)
        )
    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=data_dir,
            prefix=".workbench-runtime-config-",
            suffix=".tmp",
            delete=False,
        ) as temporary:
            temporary_path = Path(temporary.name)
            json.dump(
                {
                    "version": 1,
                    "environment": environment,
                    "workbench_modes": {workbench_id: modes[workbench_id] for workbench_id in WORKBENCH_IDS},
                    "activation_reviews": reviews,
                    "activation_history": history,
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
