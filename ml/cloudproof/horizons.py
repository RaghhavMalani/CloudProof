"""Evaluate one frozen model against deterministic labels at several future horizons."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import torch

from .dataset import CorpusManifest, iter_jsonl
from .metrics import evaluate_binary_risk
from .runtime import json_dump, load_artifact, predict_path


def evaluate_horizons(
    *,
    dataset_directory: str | Path,
    artifact_directory: str | Path,
    labels_path: str | Path,
    split: str,
    batch_size: int = 128,
    max_records: int | None = None,
    device: str = "cpu",
    torch_threads: int = 1,
) -> dict:
    torch.set_num_threads(torch_threads)
    manifest = CorpusManifest(dataset_directory)
    config, models = load_artifact(artifact_directory, device)
    _, risks, _, record_ids = predict_path(
        models,
        manifest.path_for(split),
        batch_size=batch_size,
        max_records=max_records,
        device=device,
    )
    horizon_labels = {
        row["recordId"]: row["labels"]
        for row in iter_jsonl(labels_path)
        if row.get("split") == split
    }
    horizons = sorted({key for values in horizon_labels.values() for key in values}, key=int)
    result = {}
    for horizon in horizons:
        labels = []
        for record_id in record_ids:
            if record_id not in horizon_labels:
                raise ValueError(f"missing horizon labels for {record_id}")
            labels.append(float(bool(horizon_labels[record_id][horizon])))
        result[horizon] = evaluate_binary_risk(labels, risks)
    return {
        "kind": "cloudproof.horizon-analysis",
        "schemaVersion": 1,
        "modelAblation": config["ablation"],
        "split": split,
        "maxRecords": max_records,
        "horizons": result,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--labels", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--split", default="validation")
    parser.add_argument("--batch-size", type=int, default=128)
    parser.add_argument("--max-records", type=int)
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--threads", type=int, default=1)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    result = evaluate_horizons(
        dataset_directory=args.dataset,
        artifact_directory=args.model,
        labels_path=args.labels,
        split=args.split,
        batch_size=args.batch_size,
        max_records=args.max_records,
        device=args.device,
        torch_threads=args.threads,
    )
    json_dump(args.out, result)
    print(json.dumps(result, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
