"""Strict, dependency-free rights and provenance manifest validation."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from enum import Enum
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
from typing import Any, Iterable, Mapping
from urllib.parse import urlparse

from .errors import DataIntegrityError, ManifestError

SCHEMA_VERSION = 1
_IDENTIFIER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp"}

_TOP_LEVEL_FIELDS = {
    "schema_version",
    "dataset_id",
    "created_at",
    "description",
    "intended_use",
    "sources",
    "items",
}
_SOURCE_FIELDS = {
    "source_id",
    "provider",
    "origin_url",
    "acquired_at",
    "rights_holder",
    "rights_basis",
    "license_id",
    "license_url",
    "terms_url",
    "terms_verified_at",
    "commercial_use_allowed",
    "noncommercial_use_allowed",
    "derivatives_allowed",
    "ml_training_allowed",
    "model_redistribution_allowed",
    "noncommercial_model_redistribution_allowed",
    "asset_redistribution_allowed",
    "upstream_rights_verified",
    "attribution",
    "notes",
}
_ITEM_FIELDS = {
    "item_id",
    "card_uid",
    "relative_path",
    "sha256",
    "source_id",
    "role",
    "capture_group",
    "language",
    "set_id",
    "variant",
}
_RIGHTS_BASES = {"owned", "licensed", "public-domain", "explicit-permission"}
_ITEM_ROLES = {"reference", "capture", "unknown"}


class Operation(str, Enum):
    INSPECT = "inspect"
    TRAIN = "train"
    TRAIN_NONCOMMERCIAL_EXPERIMENT = "train-noncommercial-experiment"
    PUBLISH_MODEL = "publish-model"
    PUBLISH_MODEL_NONCOMMERCIAL = "publish-model-noncommercial"
    PUBLISH_ASSETS = "publish-assets"


@dataclass(frozen=True, slots=True)
class SourceRights:
    source_id: str
    provider: str
    origin_url: str
    acquired_at: str
    rights_holder: str
    rights_basis: str
    license_id: str
    license_url: str
    terms_url: str
    terms_verified_at: str
    commercial_use_allowed: bool
    noncommercial_use_allowed: bool
    derivatives_allowed: bool
    ml_training_allowed: bool
    model_redistribution_allowed: bool
    noncommercial_model_redistribution_allowed: bool
    asset_redistribution_allowed: bool
    upstream_rights_verified: bool
    attribution: str
    notes: str


@dataclass(frozen=True, slots=True)
class ImageItem:
    item_id: str
    card_uid: str
    relative_path: str
    sha256: str
    source_id: str
    role: str
    capture_group: str
    language: str
    set_id: str
    variant: str


@dataclass(frozen=True, slots=True)
class RightsManifest:
    schema_version: int
    dataset_id: str
    created_at: str
    description: str
    intended_use: str
    sources: tuple[SourceRights, ...]
    items: tuple[ImageItem, ...]
    fingerprint: str

    @property
    def source_by_id(self) -> dict[str, SourceRights]:
        return {source.source_id: source for source in self.sources}

    def assert_allowed(self, operation: Operation | str) -> None:
        """Fail closed when any contributing source disallows an operation."""

        try:
            selected = operation if isinstance(operation, Operation) else Operation(operation)
        except ValueError as exc:
            raise ManifestError(f"unsupported operation: {operation!r}") from exc
        if selected is Operation.INSPECT:
            return

        if selected is Operation.TRAIN_NONCOMMERCIAL_EXPERIMENT:
            required = [
                ("noncommercial_use_allowed", "non-commercial use"),
                ("derivatives_allowed", "derivative works"),
                ("ml_training_allowed", "ML training"),
            ]
        else:
            required = [
                ("commercial_use_allowed", "commercial use"),
                ("derivatives_allowed", "derivative works"),
                ("ml_training_allowed", "ML training"),
                ("upstream_rights_verified", "verified upstream rights"),
            ]
        if selected is Operation.PUBLISH_MODEL:
            required.append(("model_redistribution_allowed", "model redistribution"))
        elif selected is Operation.PUBLISH_MODEL_NONCOMMERCIAL:
            required = [
                ("noncommercial_use_allowed", "non-commercial use"),
                ("derivatives_allowed", "derivative works"),
                ("ml_training_allowed", "ML training"),
                (
                    "noncommercial_model_redistribution_allowed",
                    "non-commercial model redistribution",
                ),
                ("upstream_rights_verified", "verified upstream rights"),
            ]
        elif selected is Operation.PUBLISH_ASSETS:
            required.append(("asset_redistribution_allowed", "asset redistribution"))

        failures: list[str] = []
        used_sources = {item.source_id for item in self.items}
        for source in self.sources:
            if source.source_id not in used_sources:
                continue
            for field, label in required:
                if not getattr(source, field):
                    failures.append(f"{source.source_id}: {label} is not allowed")
        if failures:
            raise ManifestError(
                f"rights policy refused operation {selected.value!r}: " + "; ".join(failures)
            )

    def verify_assets(
        self,
        asset_root: str | Path,
        *,
        roles: Iterable[str] | None = None,
    ) -> tuple[Path, ...]:
        """Resolve below ``asset_root`` and verify every selected content hash."""

        root = Path(asset_root).expanduser().resolve(strict=True)
        wanted = set(roles) if roles is not None else None
        resolved: list[Path] = []
        for item in self.items:
            if wanted is not None and item.role not in wanted:
                continue
            candidate = (root / item.relative_path).resolve(strict=False)
            try:
                candidate.relative_to(root)
            except ValueError as exc:
                raise DataIntegrityError(
                    f"asset {item.item_id!r} escapes the declared asset root"
                ) from exc
            if not candidate.is_file():
                raise DataIntegrityError(f"asset {item.item_id!r} is missing: {candidate}")
            digest = _sha256_file(candidate)
            if digest != item.sha256:
                raise DataIntegrityError(
                    f"asset {item.item_id!r} digest mismatch: expected {item.sha256}, got {digest}"
                )
            resolved.append(candidate)
        return tuple(resolved)


def load_rights_manifest(path: str | Path) -> RightsManifest:
    manifest_path = Path(path)
    try:
        raw_text = manifest_path.read_text(encoding="utf-8")
    except OSError as exc:
        raise ManifestError(f"cannot read rights manifest {manifest_path}: {exc}") from exc
    try:
        raw = json.loads(raw_text)
    except json.JSONDecodeError as exc:
        raise ManifestError(
            f"invalid JSON at line {exc.lineno}, column {exc.colno}: {exc.msg}"
        ) from exc
    return parse_rights_manifest(raw)


def parse_rights_manifest(raw: Any) -> RightsManifest:
    root = _expect_object(raw, "manifest")
    _exact_fields(root, _TOP_LEVEL_FIELDS, "manifest")
    version = root["schema_version"]
    if type(version) is not int or version != SCHEMA_VERSION:
        raise ManifestError(f"manifest.schema_version must be exactly {SCHEMA_VERSION}")

    dataset_id = _identifier(root["dataset_id"], "manifest.dataset_id")
    created_at = _timestamp(root["created_at"], "manifest.created_at")
    description = _nonempty(root["description"], "manifest.description")
    intended_use = _nonempty(root["intended_use"], "manifest.intended_use")

    raw_sources = _nonempty_list(root["sources"], "manifest.sources")
    sources = tuple(_parse_source(source, index) for index, source in enumerate(raw_sources))
    source_ids = [source.source_id for source in sources]
    _unique(source_ids, "manifest.sources[].source_id")

    raw_items = _nonempty_list(root["items"], "manifest.items")
    items = tuple(_parse_item(item, index) for index, item in enumerate(raw_items))
    _unique([item.item_id for item in items], "manifest.items[].item_id")

    known_sources = set(source_ids)
    for index, item in enumerate(items):
        if item.source_id not in known_sources:
            raise ManifestError(
                f"manifest.items[{index}].source_id references unknown source {item.source_id!r}"
            )

    reference_uids = {item.card_uid for item in items if item.role == "reference"}
    for index, item in enumerate(items):
        if item.role == "capture" and item.card_uid not in reference_uids:
            raise ManifestError(
                f"manifest.items[{index}] capture UID {item.card_uid!r} has no reference item"
            )
    if not reference_uids:
        raise ManifestError("manifest.items must include at least one reference image")

    canonical = json.dumps(root, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    fingerprint = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    return RightsManifest(
        schema_version=version,
        dataset_id=dataset_id,
        created_at=created_at,
        description=description,
        intended_use=intended_use,
        sources=sources,
        items=items,
        fingerprint=fingerprint,
    )


def _parse_source(raw: Any, index: int) -> SourceRights:
    path = f"manifest.sources[{index}]"
    source = _expect_object(raw, path)
    _exact_fields(source, _SOURCE_FIELDS, path)
    rights_basis = _nonempty(source["rights_basis"], f"{path}.rights_basis")
    if rights_basis not in _RIGHTS_BASES:
        raise ManifestError(
            f"{path}.rights_basis must be one of {sorted(_RIGHTS_BASES)}, got {rights_basis!r}"
        )
    values: dict[str, Any] = {
        "source_id": _identifier(source["source_id"], f"{path}.source_id"),
        "provider": _nonempty(source["provider"], f"{path}.provider"),
        "origin_url": _url(source["origin_url"], f"{path}.origin_url"),
        "acquired_at": _timestamp(source["acquired_at"], f"{path}.acquired_at"),
        "rights_holder": _nonempty(source["rights_holder"], f"{path}.rights_holder"),
        "rights_basis": rights_basis,
        "license_id": _nonempty(source["license_id"], f"{path}.license_id"),
        "license_url": _url(source["license_url"], f"{path}.license_url"),
        "terms_url": _url(source["terms_url"], f"{path}.terms_url"),
        "terms_verified_at": _timestamp(
            source["terms_verified_at"], f"{path}.terms_verified_at"
        ),
        "attribution": _nonempty(source["attribution"], f"{path}.attribution"),
        "notes": _nonempty(source["notes"], f"{path}.notes"),
    }
    for field in (
        "commercial_use_allowed",
        "noncommercial_use_allowed",
        "derivatives_allowed",
        "ml_training_allowed",
        "model_redistribution_allowed",
        "noncommercial_model_redistribution_allowed",
        "asset_redistribution_allowed",
        "upstream_rights_verified",
    ):
        values[field] = _boolean(source[field], f"{path}.{field}")
    return SourceRights(**values)


def _parse_item(raw: Any, index: int) -> ImageItem:
    path = f"manifest.items[{index}]"
    item = _expect_object(raw, path)
    _exact_fields(item, _ITEM_FIELDS, path)
    relative_path = _nonempty(item["relative_path"], f"{path}.relative_path")
    pure_path = PurePosixPath(relative_path)
    if pure_path.is_absolute() or ".." in pure_path.parts or "." in pure_path.parts:
        raise ManifestError(f"{path}.relative_path must be a normalized relative POSIX path")
    if str(pure_path) != relative_path or pure_path.suffix.lower() not in _IMAGE_SUFFIXES:
        raise ManifestError(
            f"{path}.relative_path must be normalized and end in {sorted(_IMAGE_SUFFIXES)}"
        )
    digest = _nonempty(item["sha256"], f"{path}.sha256")
    if not _SHA256.fullmatch(digest):
        raise ManifestError(f"{path}.sha256 must be 64 lowercase hexadecimal characters")
    role = _nonempty(item["role"], f"{path}.role")
    if role not in _ITEM_ROLES:
        raise ManifestError(f"{path}.role must be one of {sorted(_ITEM_ROLES)}")
    return ImageItem(
        item_id=_identifier(item["item_id"], f"{path}.item_id"),
        card_uid=_identifier(item["card_uid"], f"{path}.card_uid"),
        relative_path=relative_path,
        sha256=digest,
        source_id=_identifier(item["source_id"], f"{path}.source_id"),
        role=role,
        capture_group=_identifier(item["capture_group"], f"{path}.capture_group"),
        language=_identifier(item["language"], f"{path}.language"),
        set_id=_identifier(item["set_id"], f"{path}.set_id"),
        variant=_identifier(item["variant"], f"{path}.variant"),
    )


def _expect_object(value: Any, path: str) -> Mapping[str, Any]:
    if not isinstance(value, dict):
        raise ManifestError(f"{path} must be a JSON object")
    return value


def _exact_fields(value: Mapping[str, Any], expected: set[str], path: str) -> None:
    actual = set(value)
    missing = sorted(expected - actual)
    unknown = sorted(actual - expected)
    details: list[str] = []
    if missing:
        details.append(f"missing {missing}")
    if unknown:
        details.append(f"unknown {unknown}")
    if details:
        raise ManifestError(f"{path} fields are invalid: " + "; ".join(details))


def _nonempty(value: Any, path: str) -> str:
    if not isinstance(value, str) or not value.strip() or value != value.strip():
        raise ManifestError(f"{path} must be a non-empty, trimmed string")
    return value


def _identifier(value: Any, path: str) -> str:
    text = _nonempty(value, path)
    if not _IDENTIFIER.fullmatch(text):
        raise ManifestError(f"{path} contains unsupported identifier characters")
    return text


def _boolean(value: Any, path: str) -> bool:
    if type(value) is not bool:
        raise ManifestError(f"{path} must be an explicit JSON boolean")
    return value


def _url(value: Any, path: str) -> str:
    text = _nonempty(value, path)
    parsed = urlparse(text)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ManifestError(f"{path} must be an absolute HTTP(S) URL")
    return text


def _timestamp(value: Any, path: str) -> str:
    text = _nonempty(value, path)
    normalized = text[:-1] + "+00:00" if text.endswith("Z") else text
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError as exc:
        raise ManifestError(f"{path} must be an RFC 3339 timestamp") from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ManifestError(f"{path} must include an explicit timezone")
    return text


def _nonempty_list(value: Any, path: str) -> list[Any]:
    if not isinstance(value, list) or not value:
        raise ManifestError(f"{path} must be a non-empty JSON array")
    return value


def _unique(values: list[str], path: str) -> None:
    seen: set[str] = set()
    duplicates: set[str] = set()
    for value in values:
        if value in seen:
            duplicates.add(value)
        seen.add(value)
    if duplicates:
        raise ManifestError(f"{path} contains duplicates: {sorted(duplicates)}")


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()
