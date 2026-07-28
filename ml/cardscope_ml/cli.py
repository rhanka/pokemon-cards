"""Command-line interface. Heavy modules are imported only by their subcommands."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys
from typing import Sequence

from .dry_run import run_dry_run
from .errors import CardscopeMLError
from .rights import TRAINING_OPERATIONS, Operation, load_rights_manifest


TRAINING_OPERATION_CHOICES = [operation.value for operation in sorted(TRAINING_OPERATIONS)]


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="cardscope-ml")
    subparsers = parser.add_subparsers(dest="command", required=True)

    validate = subparsers.add_parser("validate-manifest", help="validate provenance and policy")
    validate.add_argument("--manifest", required=True)
    validate.add_argument(
        "--operation", choices=[operation.value for operation in Operation], default="inspect"
    )
    validate.add_argument("--asset-root", help="also verify declared files and SHA-256 digests")

    dry_run = subparsers.add_parser("dry-run", help="run the dependency-free deterministic gate")
    dry_run.add_argument("--manifest", required=True)
    dry_run.add_argument("--scores", required=True)
    dry_run.add_argument("--output", required=True)
    dry_run.add_argument("--seed", type=int, default=20260722)
    dry_run.add_argument("--target-far", type=float, default=0.005)

    train = subparsers.add_parser("train", help="train MobileNetV3-Small with batch-hard loss")
    train.add_argument("--manifest", required=True)
    train.add_argument("--asset-root", required=True)
    train.add_argument("--output-dir", required=True)
    train.add_argument("--seed", type=int, default=20260722)
    train.add_argument("--epochs", type=int, default=20)
    train.add_argument("--classes-per-batch", type=int, default=16)
    train.add_argument("--samples-per-class", type=int, default=4)
    train.add_argument("--learning-rate", type=float, default=3e-4)
    train.add_argument("--weight-decay", type=float, default=1e-4)
    train.add_argument("--triplet-margin", type=float, default=0.2)
    train.add_argument("--workers", type=int, default=0)
    train.add_argument("--device", default="auto")
    train.add_argument("--checkpoint-every-epochs", type=int, default=1)
    train.add_argument("--resume-checkpoint")
    train.add_argument("--pretrained-backbone", action="store_true")
    train.add_argument("--freeze-backbone-epochs", type=int, default=0)
    train.add_argument("--operation", choices=TRAINING_OPERATION_CHOICES, default=Operation.TRAIN.value)

    benchmark = subparsers.add_parser("benchmark", help="evaluate UID-separated held-out captures")
    benchmark.add_argument("--manifest", required=True)
    benchmark.add_argument("--asset-root", required=True)
    benchmark.add_argument("--checkpoint", required=True)
    benchmark.add_argument("--output", required=True)
    benchmark.add_argument("--target-far", type=float, default=0.005)
    benchmark.add_argument("--device", default="cpu")
    benchmark.add_argument("--batch-size", type=int, default=64)
    benchmark.add_argument(
        "--operation", choices=TRAINING_OPERATION_CHOICES, default=Operation.TRAIN.value
    )

    export = subparsers.add_parser("export", help="export float ONNX and static QDQ INT8")
    export.add_argument("--manifest", required=True)
    export.add_argument("--asset-root", required=True)
    export.add_argument("--checkpoint", required=True)
    export.add_argument("--output-dir", required=True)
    export.add_argument("--calibration-samples", type=int, default=128)
    export.add_argument("--release", action="store_true")
    export.add_argument("--operation", choices=TRAINING_OPERATION_CHOICES, default=Operation.TRAIN.value)

    index = subparsers.add_parser("build-index", help="build the image-free INT8 reference index")
    index.add_argument("--manifest", required=True)
    index.add_argument("--asset-root", required=True)
    index.add_argument("--model", required=True)
    index.add_argument("--output-dir", required=True)
    index.add_argument("--release", action="store_true")
    index.add_argument("--operation", choices=TRAINING_OPERATION_CHOICES, default=Operation.TRAIN.value)

    verify = subparsers.add_parser(
        "verify-artifacts", help="verify hashes and same-reference retrieval through ONNX and the index"
    )
    verify.add_argument("--manifest", required=True)
    verify.add_argument("--asset-root", required=True)
    verify.add_argument("--checkpoint", required=True)
    verify.add_argument("--model", required=True)
    verify.add_argument("--index", required=True)
    verify.add_argument("--output", required=True)
    verify.add_argument("--seed", type=int, default=20260722)
    verify.add_argument("--held-out-only", action="store_true")
    verify.add_argument("--operation", choices=TRAINING_OPERATION_CHOICES, default=Operation.TRAIN.value)

    synthetic = subparsers.add_parser(
        "synthetic-holdout", help="evaluate synthetic captures from held-out test UIDs"
    )
    synthetic.add_argument("--manifest", required=True)
    synthetic.add_argument("--asset-root", required=True)
    synthetic.add_argument("--checkpoint", required=True)
    synthetic.add_argument("--model", required=True)
    synthetic.add_argument("--index", required=True)
    synthetic.add_argument("--output", required=True)
    synthetic.add_argument("--seed", type=int, default=20260722)
    synthetic.add_argument("--variants-per-reference", type=int, default=1)
    synthetic.add_argument(
        "--operation", choices=TRAINING_OPERATION_CHOICES, default=Operation.TRAIN.value
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        if args.command == "validate-manifest":
            manifest = load_rights_manifest(args.manifest)
            manifest.assert_allowed(args.operation)
            if args.asset_root:
                manifest.verify_assets(args.asset_root)
            payload = {
                "dataset_id": manifest.dataset_id,
                "fingerprint": manifest.fingerprint,
                "items": len(manifest.items),
                "operation": args.operation,
                "sources": len(manifest.sources),
                "valid": True,
            }
        elif args.command == "dry-run":
            payload = run_dry_run(
                manifest_path=args.manifest,
                scores_path=args.scores,
                output_path=args.output,
                seed=args.seed,
                target_far=args.target_far,
            )
        elif args.command == "train":
            from .train import TrainingConfig, train

            payload = train(
                manifest_path=args.manifest,
                asset_root=args.asset_root,
                output_dir=args.output_dir,
                config=TrainingConfig(
                    seed=args.seed,
                    epochs=args.epochs,
                    classes_per_batch=args.classes_per_batch,
                    samples_per_class=args.samples_per_class,
                    learning_rate=args.learning_rate,
                    weight_decay=args.weight_decay,
                    triplet_margin=args.triplet_margin,
                    workers=args.workers,
                    device=args.device,
                    checkpoint_every_epochs=args.checkpoint_every_epochs,
                    resume_checkpoint=args.resume_checkpoint,
                    pretrained_backbone=args.pretrained_backbone,
                    freeze_backbone_epochs=args.freeze_backbone_epochs,
                ),
                operation=args.operation,
            )
        elif args.command == "benchmark":
            from .benchmark import benchmark

            payload = benchmark(
                manifest_path=args.manifest,
                asset_root=args.asset_root,
                checkpoint_path=args.checkpoint,
                output_path=args.output,
                target_far=args.target_far,
                device=args.device,
                batch_size=args.batch_size,
                operation=args.operation,
            )
        elif args.command == "export":
            from .export import export_onnx_int8

            payload = export_onnx_int8(
                manifest_path=args.manifest,
                asset_root=args.asset_root,
                checkpoint_path=args.checkpoint,
                output_dir=args.output_dir,
                calibration_samples=args.calibration_samples,
                release=args.release,
                operation=args.operation,
            )
        elif args.command == "synthetic-holdout":
            from .verify import verify_synthetic_holdout_retrieval

            payload = verify_synthetic_holdout_retrieval(
                manifest_path=args.manifest,
                asset_root=args.asset_root,
                checkpoint_path=args.checkpoint,
                model_path=args.model,
                index_path=args.index,
                output_path=args.output,
                seed=args.seed,
                variants_per_reference=args.variants_per_reference,
                operation=args.operation,
            )
        elif args.command == "build-index":
            from .index import build_reference_index

            payload = build_reference_index(
                manifest_path=args.manifest,
                asset_root=args.asset_root,
                model_path=args.model,
                output_dir=args.output_dir,
                release=args.release,
                operation=args.operation,
            )
        elif args.command == "verify-artifacts":
            from .verify import verify_reference_retrieval

            payload = verify_reference_retrieval(
                manifest_path=args.manifest,
                asset_root=args.asset_root,
                checkpoint_path=args.checkpoint,
                model_path=args.model,
                index_path=args.index,
                output_path=args.output,
                operation=args.operation,
                seed=args.seed,
                held_out_only=args.held_out_only,
            )
        else:  # pragma: no cover - argparse prevents this branch
            parser.error(f"unknown command {args.command!r}")
            return 2
    except (CardscopeMLError, ValueError, OSError) as exc:
        print(f"cardscope-ml: {exc}", file=sys.stderr)
        return 2
    print(json.dumps(payload, sort_keys=True, indent=2, ensure_ascii=False, allow_nan=False))
    return 0
