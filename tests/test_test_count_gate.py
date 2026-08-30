from pathlib import Path

from api.test_count_gate import main


def test_test_count_gate_rejects_a_lower_collected_count(tmp_path: Path) -> None:
    (tmp_path / "tests").mkdir()
    (tmp_path / "tests" / "test_sample.py").write_text(
        "def test_one():\n    assert True\n",
        encoding="utf-8",
    )
    (tmp_path / "test-count-baseline.txt").write_text("2\n", encoding="ascii")

    assert main(["--root", str(tmp_path)]) == 1
