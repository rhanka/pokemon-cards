import pytest


torch = pytest.importorskip("torch", reason="Torch is an optional training dependency")
pytest.importorskip("torchvision", reason="TorchVision is an optional training dependency")

from cardscope_ml.model import (
    ARCHITECTURE,
    EMBEDDING_DIMENSION,
    INPUT_SIZE,
    build_model,
    load_checkpoint,
)


def test_load_checkpoint_accepts_the_current_torch_stack_shape(tmp_path) -> None:
    model = build_model()
    path = tmp_path / "model.pt"
    torch.save(
        {
            "format_version": 1,
            "architecture": ARCHITECTURE,
            "embedding_dimension": EMBEDDING_DIMENSION,
            "input_size": INPUT_SIZE,
            "state_dict": model.state_dict(),
        },
        path,
    )

    loaded, checkpoint = load_checkpoint(str(path))
    loaded.eval()

    assert checkpoint["architecture"] == ARCHITECTURE
    with torch.inference_mode():
        assert loaded(torch.zeros((1, 3, 224, 224))).shape == (1, EMBEDDING_DIMENSION)
