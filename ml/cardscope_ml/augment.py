"""Deterministic in-memory capture simulation with Pillow as an optional dependency."""

from __future__ import annotations

from dataclasses import dataclass, fields
import hashlib
from io import BytesIO
import math
import random
from typing import Any

from .errors import DependencyUnavailableError


@dataclass(frozen=True, slots=True)
class AugmentationConfig:
    perspective_probability: float = 0.75
    glare_probability: float = 0.55
    sleeve_probability: float = 0.45
    blur_probability: float = 0.35
    shadow_probability: float = 0.55
    white_balance_probability: float = 0.55
    jpeg_probability: float = 0.45
    occlusion_probability: float = 0.30
    perspective_fraction: float = 0.08
    max_blur_radius: float = 1.8
    jpeg_quality_min: int = 45
    jpeg_quality_max: int = 92
    occlusion_fraction_max: float = 0.16

    def __post_init__(self) -> None:
        for field in fields(self):
            if field.name.endswith("_probability"):
                value = getattr(self, field.name)
                if not isinstance(value, (float, int)) or not 0 <= value <= 1:
                    raise ValueError(f"{field.name} must be in [0, 1]")
        if not 0 <= self.perspective_fraction <= 0.25:
            raise ValueError("perspective_fraction must be in [0, 0.25]")
        if self.max_blur_radius < 0:
            raise ValueError("max_blur_radius must be non-negative")
        if not 1 <= self.jpeg_quality_min <= self.jpeg_quality_max <= 100:
            raise ValueError("JPEG quality bounds must satisfy 1 <= min <= max <= 100")
        if not 0 <= self.occlusion_fraction_max <= 0.4:
            raise ValueError("occlusion_fraction_max must be in [0, 0.4]")


@dataclass(frozen=True, slots=True)
class AugmentationTrace:
    seed: int
    operations: tuple[str, ...]


class SyntheticAugmenter:
    """Generate capture-like variants without writing derived artwork to disk."""

    def __init__(
        self,
        config: AugmentationConfig = AugmentationConfig(),
        *,
        seed: int = 20260722,
    ) -> None:
        if isinstance(seed, bool) or not isinstance(seed, int) or seed < 0:
            raise ValueError("augmentation seed must be a non-negative integer")
        self.config = config
        self.seed = seed

    def augment(
        self, image: Any, *, sample_key: str, epoch: int = 0, force_all: bool = False
    ) -> tuple[Any, AugmentationTrace]:
        Image, ImageDraw, ImageEnhance, ImageFilter = _pillow()
        if not isinstance(sample_key, str) or not sample_key:
            raise ValueError("sample_key must be a non-empty string")
        if isinstance(epoch, bool) or not isinstance(epoch, int) or epoch < 0:
            raise ValueError("epoch must be a non-negative integer")
        if not isinstance(image, Image.Image):
            raise TypeError("image must be a PIL.Image.Image")
        derived_seed = _stable_seed(self.seed, epoch, sample_key)
        rng = random.Random(derived_seed)
        result = image.convert("RGB")
        operations: list[str] = []

        steps = (
            ("perspective", self.config.perspective_probability, self._perspective),
            ("glare", self.config.glare_probability, self._glare),
            ("sleeve", self.config.sleeve_probability, self._sleeve),
            ("blur", self.config.blur_probability, self._blur),
            ("shadow", self.config.shadow_probability, self._shadow),
            ("white-balance", self.config.white_balance_probability, self._white_balance),
            ("jpeg", self.config.jpeg_probability, self._jpeg),
            ("occlusion", self.config.occlusion_probability, self._occlusion),
        )
        helpers = (Image, ImageDraw, ImageEnhance, ImageFilter)
        for name, probability, transform in steps:
            if force_all or rng.random() < probability:
                result = transform(result, rng, helpers)
                operations.append(name)
        return result, AugmentationTrace(seed=derived_seed, operations=tuple(operations))

    def _perspective(self, image: Any, rng: random.Random, helpers: tuple[Any, ...]) -> Any:
        Image = helpers[0]
        width, height = image.size
        dx = width * self.config.perspective_fraction
        dy = height * self.config.perspective_fraction
        quad = (
            rng.uniform(0, dx),
            rng.uniform(0, dy),
            width - rng.uniform(0, dx),
            rng.uniform(0, dy),
            width - rng.uniform(0, dx),
            height - rng.uniform(0, dy),
            rng.uniform(0, dx),
            height - rng.uniform(0, dy),
        )
        transform_quad = getattr(Image.Transform, "QUAD", Image.QUAD)
        resampling = getattr(Image.Resampling, "BICUBIC", Image.BICUBIC)
        return image.transform(image.size, transform_quad, quad, resample=resampling)

    def _glare(self, image: Any, rng: random.Random, helpers: tuple[Any, ...]) -> Any:
        Image, ImageDraw, _, ImageFilter = helpers
        width, height = image.size
        overlay = Image.new("RGBA", image.size, (255, 255, 255, 0))
        draw = ImageDraw.Draw(overlay)
        center = rng.uniform(0.2, 0.8) * width
        band = rng.uniform(0.07, 0.18) * width
        slant = rng.uniform(-0.25, 0.25) * width
        alpha = rng.randint(35, 110)
        draw.polygon(
            [
                (center - band + slant, 0),
                (center + band + slant, 0),
                (center + band - slant, height),
                (center - band - slant, height),
            ],
            fill=(255, 255, 245, alpha),
        )
        overlay = overlay.filter(ImageFilter.GaussianBlur(radius=max(2, width * 0.025)))
        return Image.alpha_composite(image.convert("RGBA"), overlay).convert("RGB")

    def _sleeve(self, image: Any, rng: random.Random, helpers: tuple[Any, ...]) -> Any:
        Image, ImageDraw, _, ImageFilter = helpers
        width, height = image.size
        tint = rng.choice(((185, 210, 255, 20), (235, 235, 245, 22), (190, 245, 235, 18)))
        overlay = Image.new("RGBA", image.size, tint)
        draw = ImageDraw.Draw(overlay)
        border = max(1, round(min(width, height) * 0.012))
        draw.rectangle((0, 0, width - 1, height - 1), outline=(255, 255, 255, 85), width=border)
        draw.line(
            (-width * 0.2, height * 0.75, width * 1.2, height * 0.1),
            fill=(255, 255, 255, rng.randint(20, 55)),
            width=max(1, round(width * 0.025)),
        )
        overlay = overlay.filter(ImageFilter.GaussianBlur(radius=0.6))
        return Image.alpha_composite(image.convert("RGBA"), overlay).convert("RGB")

    def _blur(self, image: Any, rng: random.Random, helpers: tuple[Any, ...]) -> Any:
        ImageFilter = helpers[3]
        radius = rng.uniform(0.25, self.config.max_blur_radius)
        return image.filter(ImageFilter.GaussianBlur(radius=radius))

    def _shadow(self, image: Any, rng: random.Random, helpers: tuple[Any, ...]) -> Any:
        Image, ImageDraw, _, ImageFilter = helpers
        width, height = image.size
        overlay = Image.new("RGBA", image.size, (0, 0, 0, 0))
        draw = ImageDraw.Draw(overlay)
        edge = rng.choice(("left", "right", "top", "bottom"))
        depth = rng.uniform(0.2, 0.55)
        alpha = rng.randint(45, 125)
        if edge == "left":
            polygon = [(0, 0), (width * depth, 0), (width * depth * 0.6, height), (0, height)]
        elif edge == "right":
            polygon = [
                (width, 0),
                (width * (1 - depth), 0),
                (width * (1 - depth * 0.6), height),
                (width, height),
            ]
        elif edge == "top":
            polygon = [(0, 0), (width, 0), (width, height * depth * 0.6), (0, height * depth)]
        else:
            polygon = [
                (0, height),
                (width, height),
                (width, height * (1 - depth * 0.6)),
                (0, height * (1 - depth)),
            ]
        draw.polygon(polygon, fill=(0, 0, 0, alpha))
        overlay = overlay.filter(ImageFilter.GaussianBlur(radius=max(2, min(width, height) * 0.04)))
        return Image.alpha_composite(image.convert("RGBA"), overlay).convert("RGB")

    def _white_balance(self, image: Any, rng: random.Random, helpers: tuple[Any, ...]) -> Any:
        Image = helpers[0]
        temperature = rng.uniform(-0.18, 0.18)
        green = rng.uniform(-0.08, 0.08)
        red_gain = 1.0 + temperature
        blue_gain = 1.0 - temperature
        green_gain = 1.0 + green
        channels = image.convert("RGB").split()
        adjusted = (
            channels[0].point(lambda value: _byte(value * red_gain)),
            channels[1].point(lambda value: _byte(value * green_gain)),
            channels[2].point(lambda value: _byte(value * blue_gain)),
        )
        return Image.merge("RGB", adjusted)

    def _jpeg(self, image: Any, rng: random.Random, helpers: tuple[Any, ...]) -> Any:
        Image = helpers[0]
        buffer = BytesIO()
        quality = rng.randint(self.config.jpeg_quality_min, self.config.jpeg_quality_max)
        image.save(buffer, format="JPEG", quality=quality, optimize=False, progressive=False)
        buffer.seek(0)
        with Image.open(buffer) as decoded:
            return decoded.convert("RGB").copy()

    def _occlusion(self, image: Any, rng: random.Random, helpers: tuple[Any, ...]) -> Any:
        ImageDraw = helpers[1]
        result = image.copy()
        width, height = result.size
        target_area = width * height * rng.uniform(0.03, self.config.occlusion_fraction_max)
        aspect = math.exp(rng.uniform(math.log(0.4), math.log(2.5)))
        rectangle_width = max(1, min(width, round(math.sqrt(target_area * aspect))))
        rectangle_height = max(1, min(height, round(math.sqrt(target_area / aspect))))
        left = rng.randint(0, max(0, width - rectangle_width))
        top = rng.randint(0, max(0, height - rectangle_height))
        fill = rng.choice(((18, 18, 20), (235, 235, 230), (85, 90, 95)))
        ImageDraw.Draw(result).rectangle(
            (left, top, left + rectangle_width, top + rectangle_height), fill=fill
        )
        return result


def _stable_seed(seed: int, epoch: int, sample_key: str) -> int:
    payload = f"cardscope-augment-v1\0{seed}\0{epoch}\0{sample_key}".encode("utf-8")
    return int.from_bytes(hashlib.sha256(payload).digest()[:8], "big")


def _byte(value: float) -> int:
    return max(0, min(255, round(value)))


def _pillow() -> tuple[Any, Any, Any, Any]:
    try:
        from PIL import Image, ImageDraw, ImageEnhance, ImageFilter
    except ImportError as exc:
        raise DependencyUnavailableError(
            "synthetic augmentation requires Pillow; install cardscope-ml[data]"
        ) from exc
    return Image, ImageDraw, ImageEnhance, ImageFilter
