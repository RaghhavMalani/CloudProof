"""Evaluate a frozen CloudProof ensemble under deterministic edge-destruction controls."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import torch

from .dataset import CorpusManifest
from .metrics import evaluate_binary_risk
from .perturb import EDGE_DESTRUCTION_MODES
from .runtime import json_dump, load_artifact, predict_path


def evaluate_edge_attribution(
    *,
    dataset_directory: str | Path,
    artifact_directory: str | Path,
    splits: tuple[str, ...] = ("validation", "test", "ood"),
    batch_size: int = 128,
    max_records: int | None = None,
    device: str = "cpu",
    torch_threads: int = 1,
) -> dict:
    if torch_threads < 1:
        raise ValueError("torch_threads must be positive")
    torch.set_num_threads(torch_threads)
    manifest = CorpusManifest(dataset_directory)
    config, models = load_artifact(artifact_directory, device)
    modes: dict[str, dict] = {}
    for mode in EDGE_DESTRUCTION_MODES:
        modes[mode] = {}
        for split in splits:
            labels, risks, uncertainties, _ = predict_path(
                models,
                manifest.path_for(split),
                batch_size=batch_size,
                max_records=max_records,
                device=device,
                edge_mode=mode,
            )
            values = evaluate_binary_risk(labels, risks)
            values["meanUncertainty"] = float(np.mean(uncertainties))
            modes[mode][split] = values
    full = modes["full"]
    deltas = {
        mode: {
            split: {
                "auroc": None
                if values[split]["auroc"] is None or full[split]["auroc"] is None
                else values[split]["auroc"] - full[split]["auroc"],
                "auprc": None
                if values[split]["auprc"] is None or full[split]["auprc"] is None
                else values[split]["auprc"] - full[split]["auprc"],
                "nll": values[split]["nll"] - full[split]["nll"],
            }
            for split in splits
        }
        for mode, values in modes.items()
        if mode != "full"
    }
    return {
        "kind": "cloudproof.graph-attribution-audit",
        "schemaVersion": 1,
        "modelAblation": config["ablation"],
        "labelControl": config.get("labelControl", "observed"),
        "edgeModes": modes,
        "deltaFromFull": deltas,
        "maxRecordsPerSplit": max_records,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--splits", default="validation,test,ood")
    parser.add_argument("--batch-size", type=int, default=128)
    parser.add_argument("--max-records", type=int)
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--threads", type=int, default=1)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    result = evaluate_edge_attribution(
        dataset_directory=args.dataset,
        artifact_directory=args.model,
        splits=tuple(item for item in args.splits.split(",") if item),
        batch_size=args.batch_size,
        max_records=args.max_records,
        device=args.device,
        torch_threads=args.threads,
    )
    json_dump(args.out, result)
    print(json.dumps(result, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
