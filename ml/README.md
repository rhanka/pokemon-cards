# CardScope ML pipeline

This directory contains a clean-room visual retrieval pipeline for offline
training and evaluation. It does **not** contain card images, datasets,
pretrained weights, or model artifacts. MobileNetV3-Small is created with
`weights=None`; the commands never fetch a checkpoint.

The release target is a 224 px MobileNetV3-Small encoder with a L2-normalized
128-dimensional embedding. Recognition is nearest-reference retrieval in a
browser Web Worker; it is not card authentication or condition grading.

## Rights gate

Every source and every asset must appear in a versioned rights manifest. Validation is strict:
unknown or missing fields are rejected, paths must be relative, assets are content-addressed, and
all rights statements are explicit booleans. There are separate policies for:

- `inspect`: validate provenance only;
- `train`: require commercial use, derivatives, and ML training permission;
- `train-noncommercial-experiment`: allow only a local non-commercial
  experiment when the source explicitly allows non-commercial derivatives and
  ML training; it is not a release permission;
- `publish-model`: additionally require permission to redistribute derived weights;
- `publish-model-noncommercial`: additionally requires explicit
  non-commercial model redistribution **and** verified upstream rights;
- `publish-assets`: additionally require permission to redistribute source images.

Repository or dataset license badges do not establish rights to upstream Pokemon
artwork. The owner-approved `TheFusion21/PokemonCards` intake is recorded as a
local CC-BY-NC experiment only: its external image authority remains
unverified, so `publish-model-noncommercial` refuses it. Do not publish an
export merely because training succeeds. `schemas/rights-manifest.schema.json`
documents the wire contract; `tests/fixtures/rights_manifest.json` contains
invented metadata and no images.

## Lightweight setup and deterministic gate

The core package uses only the Python standard library. The gate therefore works without Torch,
Pillow, NumPy, ONNX, or network access:

```bash
python -m venv .venv
.venv/bin/pip install -r ml/requirements.txt
PYTHONPATH=ml .venv/bin/python -m pytest ml/tests
PYTHONPATH=ml .venv/bin/python -m cardscope_ml dry-run \
  --manifest ml/tests/fixtures/rights_manifest.json \
  --scores ml/tests/fixtures/dry_run_scores.json \
  --output /tmp/cardscope-ml-dry-run.json
```

The dry-run validates provenance, proves UID-separated deterministic splitting, fits the score
calibrator, and emits a deterministic benchmark-schema report. It does not claim model quality or
bit-for-bit reproducibility of an unlocked heavy Python environment.

## Data preparation and augmentation

Install the optional image stack with `pip install -e 'ml[data,dev]'`. Images remain outside Git.
At read time their SHA-256 hashes are checked against the manifest and resolved below the explicit
asset root. `SyntheticAugmenter` deterministically derives randomness from the run seed, epoch, and
sample key, and can simulate perspective, glare, sleeve tint/reflection, blur, shadow, white-balance
shift, JPEG compression, and occlusion. Synthetic variants are generated in memory, so no derived
artwork is written by default.

## Train, benchmark, export, and index

Install the heavy stack explicitly:

```bash
pip install -e 'ml[train,export]'
cardscope-ml validate-manifest --manifest /data/rights.json --operation train
cardscope-ml train --manifest /data/rights.json --asset-root /data/assets \
  --output-dir /secure/run-001 --seed 20260722
cardscope-ml benchmark --manifest /data/rights.json --asset-root /data/assets \
  --checkpoint /secure/run-001/model.pt --output /secure/run-001/benchmark.json
cardscope-ml export --manifest /data/rights.json --asset-root /data/assets \
  --checkpoint /secure/run-001/model.pt --output-dir /secure/run-001/export
cardscope-ml build-index --manifest /data/rights.json --asset-root /data/assets \
  --model /secure/run-001/export/model.int8.onnx \
  --output-dir /secure/run-001/index
```

Training uses online batch-hard triplet mining. UIDs, never individual images, are assigned to
train/validation/test by a stable SHA-256 partition. Validation and test galleries contain cleared
reference images for their own unseen UIDs; their probes must be independent captures. Unknown
probes are required to measure false accepts and calibrate abstention.

The export command produces an opset-17 float ONNX graph and performs static QDQ INT8 calibration
with manifest assets. The reference index contains only sorted UIDs, item identifiers, provenance
references, and signed 128D vectors; it never embeds source images. All artifacts include manifest
and model hashes.

## Release gates

A dry-run report is never release-eligible. A pilot report must use independent, never-seen user
captures and satisfy all of these gates before enabling the model as the primary recognizer:

- exact-printing top-1 >= 95% for beta, with a 98% product target;
- Recall@5 >= 99%, and >= 99.5% for cards valued above USD 20 when that slice is available;
- open-set false-accept rate < 0.5% with enough unknown probes to resolve that rate;
- expected calibration error <= 5% and a calibrated abstention threshold;
- corrections < 5%, pipeline p95 < 250 ms on named target phones, and INT8 model <= 5 MiB;
- explicit `publish-model` or `publish-model-noncommercial` rights approval
  for every contributing source, as applicable.

`schemas/benchmark-report.schema.json` requires sample counts, split and manifest fingerprints,
artifact sizes, and per-device latency. Release eligibility fails closed unless it also records at
least 1,000 known test probes, 600 unknown calibration probes, 600 unknown test probes, the 98%
product Top-1 target, high-value Recall@5, correction rate, publish-model rights, a hashed locked
environment, a non-empty reference index, and browser-runtime p95 on two named target phones. The
built-in Torch benchmark is useful model evidence but is deliberately marked `target_phone=false`;
an audited release step must merge exported-artifact sizes and real `onnxruntime-web` phone rows.
Report metrics without their denominators are not accepted.

## License

Pipeline source code is MIT-licensed with the application. Pokemon names and artwork belong to
their respective owners and are not licensed by this repository. Data, images, and derived weights
retain their own rights and must pass the manifest policy independently.
