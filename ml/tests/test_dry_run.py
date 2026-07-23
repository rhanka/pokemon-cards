import json
from pathlib import Path

from cardscope_ml.dry_run import run_dry_run

FIXTURES = Path(__file__).parent / "fixtures"


def test_should_emit_identical_report_for_identical_inputs(tmp_path: Path) -> None:
    first_path = tmp_path / "first.json"
    second_path = tmp_path / "second.json"

    first = run_dry_run(
        manifest_path=FIXTURES / "rights_manifest.json",
        scores_path=FIXTURES / "dry_run_scores.json",
        output_path=first_path,
    )
    second = run_dry_run(
        manifest_path=FIXTURES / "rights_manifest.json",
        scores_path=FIXTURES / "dry_run_scores.json",
        output_path=second_path,
    )

    assert first == second
    assert first_path.read_bytes() == second_path.read_bytes()
    assert json.loads(first_path.read_text(encoding="utf-8")) == first
    assert first["mode"] == "dry-run"
    assert first["eligible_for_release"] is False
    assert first["metrics"]["known_queries"] == 4
    assert first["metrics"]["unknown_queries"] == 2
