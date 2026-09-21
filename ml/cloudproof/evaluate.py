"""Final validation, held-out test, OOD, calibration, and topology evaluation."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np

from .controlled import run_zone_concentration_experiment
from .dataset import CorpusManifest, find_zone_experiment_record
from .metrics import evaluate_binary_risk
from .runtime import artifact_manifest, json_dump, load_artifact, predict_path


def evaluate_artifact(
    *,
    dataset_directory: str | Path,
    artifact_directory: str | Path,
    batch_size: int = 128,
    max_records: int | None = None,
    device: str = "cpu",
) -> dict:
    manifest = CorpusManifest(dataset_directory)
    config, models = load_artifact(artifact_directory, device)
    if config["dataset"]["splitPolicy"] != manifest.value["splitPolicy"]:
        raise ValueError("model and evaluation split policies differ")
    expected_files = config["dataset"]["files"]
    for filename, metadata in expected_files.items():
        actual = ((manifest.value.get("files") or {}).get(filename) or {}).get("sha256")
        if actual != metadata.get("sha256"):
            raise ValueError(f"model was trained against a different {filename}")

    previous = json.loads((Path(artifact_directory) / "metrics.json").read_text(encoding="utf-8"))
    metrics = {
        "kind": "cloudproof.gnn-risk-model-evaluation",
        "schemaVersion": 1,
        "ablation": config["ablation"],
        "labelControl": config.get("labelControl", "observed"),
        "members": previous.get("members"),
    }
    for split in ("validation", "test", "ood"):
        labels, risks, uncertainties, _ = predict_path(
            models,
            manifest.path_for(split),
            batch_size=batch_size,
            max_records=max_records,
            device=device,
        )
        split_metrics = evaluate_binary_risk(labels, risks)
        split_metrics["meanUncertainty"] = float(np.mean(uncertainties))
        split_metrics["maxUncertainty"] = float(np.max(uncertainties))
        metrics[split] = split_metrics

    controlled_record = find_zone_experiment_record(manifest.path_for("train"))
    metrics["controlledZoneConcentration"] = run_zone_concentration_experiment(
        models, controlled_record, device
    )
    json_dump(Path(artifact_directory) / "metrics.json", metrics)
    json_dump(Path(artifact_directory) / "manifest.json", artifact_manifest(artifact_directory, config))
    return metrics


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--batch-size", type=int, default=128)
    parser.add_argument("--max-records", type=int)
    parser.add_argument("--device", default="cpu")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    result = evaluate_artifact(
        dataset_directory=args.dataset,
        artifact_directory=args.model,
        batch_size=args.batch_size,
        max_records=args.max_records,
        device=args.device,
    )
    print(json.dumps(result, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
