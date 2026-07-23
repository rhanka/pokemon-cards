"""CardScope's rights-gated visual retrieval pipeline."""

from .calibration import ScoreCalibrator, fit_score_calibrator, select_accept_threshold
from .metrics import RetrievalMetrics, evaluate_retrieval, expected_calibration_error
from .rights import RightsManifest, load_rights_manifest
from .split import SplitConfig, split_manifest

__all__ = [
    "RetrievalMetrics",
    "RightsManifest",
    "ScoreCalibrator",
    "SplitConfig",
    "evaluate_retrieval",
    "expected_calibration_error",
    "fit_score_calibrator",
    "load_rights_manifest",
    "select_accept_threshold",
    "split_manifest",
]

__version__ = "0.1.0"
