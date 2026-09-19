"""Batch inference CLI returning ensemble mean risk and predictive uncertainty."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from torch.utils.data import DataLoader, IterableDataset

from .runtime import load_artifact
from .model import ensemble_predict
from .tensorize import CloudProofTensorizer, collate_graphs


class RequestDataset(IterableDataset):
    def __init__(self, path: str | Path) -> None:
        super().__init__()
        self.path = Path(path)

    def __iter__(self):
        tensorizer = CloudProofTensorizer()
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
) -> None:
    _config, models = load_artifact(artifact_directory, device)
    loader = DataLoader(
        RequestDataset(input_path),
        batch_size=batch_size,
        collate_fn=collate_graphs,
        num_workers=0,
    )
    destination = Path(output_path)
    destination.parent.mkdir(parents=True, exist_ok=True)
    with destination.open("w", encoding="utf-8", newline="\n") as output:
        for batch in loader:
            batch = batch.to(device)
            risk, uncertainty = ensemble_predict(models, batch)
            for key, risk_value, uncertainty_value in zip(
                batch.record_ids, risk.cpu().tolist(), uncertainty.cpu().tolist()
            ):
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
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    infer_file(
        artifact_directory=args.model,
        input_path=args.input,
        output_path=args.output,
        batch_size=args.batch_size,
        device=args.device,
    )


if __name__ == "__main__":
    main()
