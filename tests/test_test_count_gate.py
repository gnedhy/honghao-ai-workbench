from pathlib import Path
import json
import subprocess

import pytest

from api.test_count_gate import main, validate_base, validate_bootstrap, validate_collection, validate_test_source


def contract(*ids: str) -> dict:
    return {"schema": 1, "api_nodeids": list(ids), "frontend": [], "retirements": []}


ONE = "tests/test_sample.py::test_one"
TWO = "tests/test_sample.py::test_two"
NEW = "tests/test_sample.py::test_new"


def test_test_count_gate_rejects_a_lower_collected_count(tmp_path: Path) -> None:
    (tmp_path / "tests").mkdir()
    (tmp_path / "tests" / "test_sample.py").write_text(
        "def test_one():\n    assert True\n",
        encoding="utf-8",
    )
    (tmp_path / "test-count-baseline.txt").write_text("2\n", encoding="ascii")
    (tmp_path / "scripts").mkdir()
    (tmp_path / "scripts" / "regression-contract.json").write_text(json.dumps(contract(ONE)), encoding="utf-8")

    assert main(["--root", str(tmp_path)]) == 1


def test_new_tests_cannot_mask_removal_of_a_protected_test() -> None:
    with pytest.raises(ValueError, match="not collected"):
        validate_collection(contract(ONE, TWO), [ONE, NEW], 2)


@pytest.mark.parametrize("ids", [[], [ONE, ONE], ["invalid"], ["tests/../../bad.py::test_bad"]])
def test_invalid_protected_inventory_is_rejected(ids: list[str]) -> None:
    with pytest.raises(ValueError):
        validate_collection(contract(*ids), [ONE, TWO], 2)


def test_retirement_requires_collected_protected_replacement_and_reason() -> None:
    before, after = contract(ONE, TWO), contract(ONE, NEW)
    with pytest.raises(ValueError, match="without retirement"):
        validate_base(after, before, 2, 2)
    after["retirements"] = [{"asset": {"kind": "api", "id": TWO}, "replacements": [{"kind": "api", "id": NEW}], "reason": "Equivalent assertions moved to named consolidated replacement"}]
    validate_base(after, before, 2, 2)
    validate_collection(after, [ONE, NEW], 2)
    after["retirements"][0]["replacements"][0]["id"] = TWO
    with pytest.raises(ValueError, match="replacement"):
        validate_base(after, before, 2, 2)


def test_baseline_cannot_be_lowered_relative_to_base() -> None:
    with pytest.raises(ValueError, match="baseline decreased"):
        validate_base(contract(ONE), contract(ONE), 1, 2)


def test_failed_collection_never_writes_inventory(tmp_path: Path, monkeypatch) -> None:
    (tmp_path / "test-count-baseline.txt").write_text("1\n", encoding="ascii")
    (tmp_path / "scripts").mkdir()
    (tmp_path / "scripts" / "regression-contract.json").write_text(json.dumps(contract(ONE)), encoding="utf-8")
    monkeypatch.setattr("api.test_count_gate.subprocess.run", lambda *args, **kwargs: subprocess.CompletedProcess(args, 2, f"{ONE}\n1 test collected", "collection error"))
    output = tmp_path / "collection.json"
    assert main(["--root", str(tmp_path), "--output", str(output)]) == 1
    assert not output.exists()


def test_missing_contract_fails_closed(tmp_path: Path) -> None:
    (tmp_path / "test-count-baseline.txt").write_text("1\n", encoding="ascii")
    assert main(["--root", str(tmp_path)]) == 1


def test_missing_base_cannot_use_an_arbitrary_bootstrap() -> None:
    with pytest.raises(ValueError, match="pinned"):
        validate_bootstrap("deadbeef", 140, contract(ONE))
    with pytest.raises(ValueError, match="pinned"):
        validate_bootstrap("1c57482eb41f48f5acd6fcd36395d38e84086948", 139, contract(ONE))


def test_disabled_test_ast_rejects_aliases_but_ignores_comment_decoys() -> None:
    validate_test_source("tests/test_sample.py", "# @pytest.mark." + "skip\ndef test_ok():\n    assert True\n")
    for source in ["import pytest as p\n@p.mark.skipif(False)\ndef test_ok(): pass", "from pytest import skip as ignore\ndef test_ok(): ignore('reason')", "import pytest\n@pytest.mark." + "xfail\ndef test_ok(): pass"]:
        with pytest.raises(ValueError, match="disabled"):
            validate_test_source("tests/test_sample.py", source)
