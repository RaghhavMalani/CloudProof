"""Run the required Phase II-B model ablations without changing data splits."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from .constants import ENSEMBLE_SEEDS
from .evaluate import evaluate_artifact
from .runtime import json_dump
from .train import ABLATIONS, train_ensemble


def run_ablations(
    *,
    dataset_directory: str | Path,
    output_directory: str | Path,
    seeds: tuple[int, ...] = ENSEMBLE_SEEDS,
    epochs: int = 20,
    patience: int = 4,
    batch_size: int = 128,
    hidden_dim: int = 48,
    layers: int = 2,
    dropout: float = 0.1,
    max_train_records: int | None = None,
    max_validation_records: int | None = None,
    max_evaluation_records: int | None = None,
    verify_hashes: bool = True,
    device: str = "cpu",
) -> dict:
    root = Path(output_directory)
    results = {}
    for ablation in ABLATIONS:
        target = root / ablation
        train_ensemble(
            dataset_directory=dataset_directory,
            output_directory=target,
            ablation=ablation,
            seeds=seeds,
            epochs=epochs,
            patience=patience,
            batch_size=batch_size,
            hidden_dim=hidden_dim,
            layers=layers,
            dropout=dropout,
            max_train_records=max_train_records,
            max_validation_records=max_validation_records,
            verify_hashes=verify_hashes,
            device=device,
        )
        results[ablation] = evaluate_artifact(
            dataset_directory=dataset_directory,
            artifact_directory=target,
            batch_size=batch_size,
            max_records=max_evaluation_records,
            device=device,
        )
    summary = {
        "kind": "cloudproof.gnn-ablation-study",
        "schemaVersion": 1,
        "variants": {
            name: {
                split: {
                    metric: result[split][metric]
                    for metric in ("auroc", "auprc", "brier", "ece", "nll")
                }
                for split in ("validation", "test", "ood")
            }
            for name, result in results.items()
        },
        "controlledZoneConcentration": {
            name: result["controlledZoneConcentration"] for name, result in results.items()
        },
    }
    json_dump(root / "summary.json", summary)
    return summary


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--seeds", default=",".join(str(seed) for seed in ENSEMBLE_SEEDS))
    parser.add_argument("--epochs", type=int, default=20)
    parser.add_argument("--patience", type=int, default=4)
    parser.add_argument("--batch-size", type=int, default=128)
    parser.add_argument("--hidden-dim", type=int, default=48)
    parser.add_argument("--layers", type=int, default=2)
    parser.add_argument("--dropout", type=float, default=0.1)
    parser.add_argument("--max-train-records", type=int)
    parser.add_argument("--max-validation-records", type=int)
    parser.add_argument("--max-evaluation-records", type=int)
    parser.add_argument("--skip-hash-verification", action="store_true")
    parser.add_argument("--device", default="cpu")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    summary = run_ablations(
        dataset_directory=args.dataset,
        output_directory=args.out,
        seeds=tuple(int(value) for value in args.seeds.split(",") if value),
        epochs=args.epochs,
        patience=args.patience,
        batch_size=args.batch_size,
        hidden_dim=args.hidden_dim,
        layers=args.layers,
        dropout=args.dropout,
        max_train_records=args.max_train_records,
        max_validation_records=args.max_validation_records,
        max_evaluation_records=args.max_evaluation_records,
        verify_hashes=not args.skip_hash_verification,
        device=args.device,
    )
    print(json.dumps(summary, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
