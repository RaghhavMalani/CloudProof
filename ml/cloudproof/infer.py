"""Batch inference CLI returning ensemble mean risk and predictive uncertainty."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import torch
from torch.utils.data import IterableDataset

from .perturb import DEFAULT_EDGE_SEED, EDGE_DESTRUCTION_MODES
from .runtime import load_artifact, predict_samples, tensorizer_for_config
from .tensorize import CloudProofTensorizer


class RequestDataset(IterableDataset):
    def __init__(self, path: str | Path, tensorizer: CloudProofTensorizer | None = None) -> None:
        super().__init__()
        self.path = Path(path)
        self.tensorizer = tensorizer or CloudProofTensorizer()

    def __iter__(self):
        tensorizer = self.tensorizer
        with self.path.open("r", encoding="utf-8") as handle:
            for line_number, line in enumerate(handle, start=1):
                if not line.strip():
                    continue
                request = json.loads(line)
                if not isinstance(request.get("key"), str):
                    raise ValueError(f"request {line_number} has no stable key")
                yield tensorizer.tensorize(
                    request["state"], request["action"], record_id=request["key"]
                )


def infer_file(
    *,
    artifact_directory: str | Path,
    input_path: str | Path,
    output_path: str | Path,
    batch_size: int = 128,
    device: str = "cpu",
    edge_mode: str = "full",
    edge_seed: int = DEFAULT_EDGE_SEED,
) -> None:
    config, models = load_artifact(artifact_directory, device)
    _labels, risks, uncertainties, keys = predict_samples(
        models,
        RequestDataset(input_path, tensorizer_for_config(config)),
        batch_size=batch_size,
        device=device,
        edge_mode=edge_mode,
        edge_seed=edge_seed,
    )
    destination = Path(output_path)
    destination.parent.mkdir(parents=True, exist_ok=True)
    with destination.open("w", encoding="utf-8", newline="\n") as output:
        for key, risk_value, uncertainty_value in zip(keys, risks, uncertainties):
            output.write(
                json.dumps(
                    {"key": key, "risk": risk_value, "uncertainty": uncertainty_value},
                    sort_keys=True,
                    separators=(",", ":"),
                )
                + "\n"
            )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", required=True)
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--batch-size", type=int, default=128)
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--edge-mode", choices=EDGE_DESTRUCTION_MODES, default="full")
    parser.add_argument("--edge-seed", type=int, default=DEFAULT_EDGE_SEED)
    parser.add_argument("--threads", type=int, default=1)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if args.threads < 1:
        raise ValueError("threads must be positive")
    torch.set_num_threads(args.threads)
    infer_file(
        artifact_directory=args.model,
        input_path=args.input,
        output_path=args.output,
        batch_size=args.batch_size,
        device=args.device,
        edge_mode=args.edge_mode,
        edge_seed=args.edge_seed,
    )


if __name__ == "__main__":
    main()
