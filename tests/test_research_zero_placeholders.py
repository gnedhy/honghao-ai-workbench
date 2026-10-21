from copy import deepcopy

import pytest

from api.research import packed, enqueue
from api.postgres import transaction
from tests.test_research_workbench import ready, body_for, K, records, data, trial_data


def test_original_zero_placeholders_survive_without_accepting_new_invalid_inputs(ready):
    _, _, admin, store = ready
    with transaction(store.url, write=True) as db:
        formula = body_for(store)["formula"]
        formula["source_kind"] = "erp_bom"
        placeholder = dict(kind="material", ref="missing-placeholder", code="missing-placeholder", quantity="0", ratio="0", source_row=98765, source_cells={"original": "kept"})
        formula["lines"].append(placeholder)
        db.execute("UPDATE research_formulas SET formula=%s WHERE id=%s", (packed(formula), K))
        enqueue(db, "zero placeholder fixture")
    store.process_events()
    history = records(store.url)
    body = body_for(store)
    result = store.simulate(K, body)
    assert result["formula"]["lines"][-1] == placeholder
    assert result["latest"]["cost"] == result["current_latest"]["cost"]
    assert result["inventory"]["cost"] == result["current_inventory"]["cost"]
    reordered = deepcopy(body)
    reordered["formula"]["lines"].reverse()
    assert store.simulate(K, reordered)["formula"]["lines"][0] == placeholder
    for change in ("nonzero", "new", "duplicate", "forged-source", "different-kind"):
        invalid = deepcopy(body)
        line = invalid["formula"]["lines"][-1]
        if change == "nonzero": line["quantity"] = "1"
        elif change == "new": line["ref"] = "new-invalid"
        elif change == "duplicate": invalid["formula"]["lines"].append(deepcopy(line))
        elif change == "forged-source": line["source_row"] = 98766
        else: line["kind"] = "recipe"
        with pytest.raises(ValueError, match="投料引用已失效"):
            store.simulate(K, invalid)
    assert records(store.url) == history
    saved = store.save(K, dict(body, simulation_token=result["simulation_token"]), admin)
    assert records(store.url) == history
    store.activate(K, saved, admin)
    store.process_events()
    actual = body_for(store)["formula"]
    assert actual["lines"][-1] == placeholder
    assert records(store.url)[:len(history)] == history
