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

## Collector and local model builder

The application runtime remains TypeScript/Svelte. Python is used only as an
offline training tool; it is never started by the API or deployed to Kubernetes.
The repository includes a bounded TypeScript collector for the declared CSV and
its approved image CDN. It validates every redirect, byte budget, PNG header,
pixel count, SHA-256 digest, and records an atomic resume state plus an intake
report. Data and artifacts stay in ignored `ml/data/` and `ml/artifacts/`
directories.

Start with a small, resumable batch (the same command safely resumes it):

```bash
npm run scrape:pokemon-cards -- \
  --accept-source-terms --limit=64 \
  --output=ml/data/pokemon-cards-scrape
```

`--all` is deliberate and requires `--max-total-bytes`; source rows that do not
meet the fixed URL and identifier contract are recorded in `intake-report.json`
instead of stopping a valid batch. The generated manifest is an experiment
record, not a public-release clearance.

Install the heavy training tools locally, then build a local experimental
checkpoint. Add `--export --index` only when ONNX dependencies are installed:

```bash
pip install -e 'ml[train,export]'
npm run build:visual-model -- \
  --acknowledge-experimental-model \
  --manifest=ml/data/pokemon-cards-scrape/rights-manifest.json \
  --assets=ml/data/pokemon-cards-scrape/assets \
  --python=ml/.venv/bin/python --workers=4 --pretrained-backbone \
  --freeze-backbone-epochs=1 --epochs=20 --export --index
```

The builder invokes Python through argument vectors (no shell), first validates
all asset hashes, writes `build-manifest.json`, and records the rights operation
in the checkpoint, export, and index. It does not accept a release flag,
publish an artifact, or deploy anything. A reference-only corpus can produce a
baseline checkpoint, but `--benchmark` is rejected until the manifest has
independent camera captures and unknown-card probes.
`--pretrained-backbone` explicitly downloads the TorchVision ImageNet MobileNet
weights for local fine-tuning and records that origin in training metadata; omit
the flag only for an intentionally random-initialized experiment.
The current float ONNX artifact is below the 5 MiB runtime budget and is the
selected retrieval model. Static INT8 is exported as a fidelity diagnostic only;
it is not selected automatically. When `--index` is selected, the builder also
reloads the ONNX model and verifies that every canonical reference retrieves
itself from the generated index. The resulting `reference-smoke.json` keeps the
global artifact-integrity figure separate from `held_out_from_training`: the
latter reports only validation and test UIDs, which are excluded from the
training partition. The checkpoint is read again to prove its manifest, seed,
operation, and split fingerprint match that report; export metadata then binds
that checkpoint to the exact ONNX runtime model and index. It is valid
catalogue-generalisation evidence, but still not a camera-recognition
benchmark.

To regenerate only the meaningful catalogue holdout result without rereading
the training references, invoke `cardscope-ml verify-artifacts` with
`--held-out-only`; it evaluates validation and test UIDs only, while retaining
the same checkpoint → ONNX → index integrity checks.

For a zero-cost robustness diagnostic before field captures exist, add
`--synthetic-holdout --synthetic-variants=2` to the builder. It creates
in-memory perspective/glare/sleeve/blur/JPEG variants only from test UIDs that
were excluded from learning, then reports Top-1 and Recall@5 separately in
`synthetic-holdout.json`. It never writes derived images and is always marked
non-deployable; it must not replace independent camera or unknown-card probes.
An interrupted local run resumes deterministically with
`--resume-checkpoint=<output>/model.last.pt` and the same manifest, seed, and
epoch target; the builder rejects a checkpoint from a different split.

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
train/validation/test by a stable SHA-256 partition. Capture groups may not
cross split boundaries or roles, even when they contain different cards.
Validation and test galleries contain cleared reference images for their
own unseen UIDs; their probes must be independent captures. Unknown probes are
required to measure false accepts and calibrate abstention.

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
