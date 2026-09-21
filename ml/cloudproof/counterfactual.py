"""Score matched topology counterfactuals and report pairwise ranking accuracy."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import torch

from .dataset import iter_jsonl
from .metrics import evaluate_binary_risk
from .runtime import json_dump, load_artifact, predict_path


def evaluate_counterfactuals(
    *,
    input_path: str | Path,
    artifact_directory: str | Path,
    batch_size: int = 128,
    device: str = "cpu",
    torch_threads: int = 1,
) -> dict:
    torch.set_num_threads(torch_threads)
    config, models = load_artifact(artifact_directory, device)
    records = list(iter_jsonl(input_path))
    labels, risks, uncertainties, record_ids = predict_path(
        models, input_path, batch_size=batch_size, device=device
    )
    scored = {}
    for record, record_id, risk, uncertainty in zip(records, record_ids, risks, uncertainties, strict=True):
        if record_id != record.get("recordId"):
            raise ValueError("counterfactual inference order changed")
        pair = scored.setdefault(record["pairId"], {})
        pair[record["variant"]] = {"risk": risk, "uncertainty": uncertainty}
    margins = []
    ties = 0
    correct = 0
    for pair_id, variants in scored.items():
        if set(variants) != {"balanced", "concentrated"}:
            raise ValueError(f"pair {pair_id} is incomplete")
        margin = variants["concentrated"]["risk"] - variants["balanced"]["risk"]
        margins.append(margin)
        correct += int(margin > 0)
        ties += int(margin == 0)
    metrics = evaluate_binary_risk(labels, risks)
    return {
        "kind": "cloudproof.matched-topology-counterfactual-evaluation",
        "schemaVersion": 1,
        "modelAblation": config["ablation"],
        "labelControl": config.get("labelControl", "observed"),
        "pairs": len(scored),
        "pairwise": {
            "correct": correct,
            "ties": ties,
            "accuracy": correct / len(scored),
            "meanRiskMargin": float(np.mean(margins)),
            "medianRiskMargin": float(np.median(margins)),
            "minimumRiskMargin": min(margins),
            "maximumRiskMargin": max(margins),
        },
        "classification": metrics,
        "meanUncertainty": float(np.mean(uncertainties)),
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--batch-size", type=int, default=128)
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--threads", type=int, default=1)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    result = evaluate_counterfactuals(
        input_path=args.input,
        artifact_directory=args.model,
        batch_size=args.batch_size,
        device=args.device,
        torch_threads=args.threads,
    )
    json_dump(args.out, result)
    print(json.dumps(result, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
