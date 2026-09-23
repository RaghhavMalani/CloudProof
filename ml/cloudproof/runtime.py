"""Shared artifact loading and batched ensemble inference helpers."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Iterable

import torch
from torch.utils.data import DataLoader, IterableDataset

from .constants import RELATION_TYPES, RESOURCE_TYPES
from .dataset import StreamingGraphDataset
from .model import ModelConfig, build_model, ensemble_predict
from .perturb import DEFAULT_EDGE_SEED, perturb_sample, relation_mode_for
from .tensorize import CloudProofTensorizer, GraphSample, collate_graphs


def json_dump(path: str | Path, value: dict) -> None:
    destination = Path(path)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(
        json.dumps(value, indent=2, sort_keys=True, allow_nan=False) + "\n",
        encoding="utf-8",
    )


def sha256_file(path: str | Path) -> str:
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_artifact(
    artifact_directory: str | Path,
    device: str | torch.device = "cpu",
) -> tuple[dict, list[torch.nn.Module]]:
    directory = Path(artifact_directory)
    config = json.loads((directory / "config.json").read_text(encoding="utf-8"))
    if config.get("kind") != "cloudproof.gnn-risk-model-config":
        raise ValueError("unsupported CloudProof model artifact")
    model_config = ModelConfig.from_dict(config["model"])
    models = []
    for index, _seed in enumerate(config["ensembleSeeds"]):
        model = build_model(model_config).to(device)
        weights = torch.load(
            directory / f"member-{index}.pt",
            map_location=device,
            weights_only=True,
        )
        model.load_state_dict(weights)
        model.eval()
        models.append(model)
    return config, models


def tensorizer_for_config(config: dict, label_horizon: int | None = None) -> CloudProofTensorizer:
    """The input transform a model artifact was trained with (clock-blind or plain)."""
    transform = config.get("featureTransform") or {}
    if isinstance(transform, str):
        transform = {"clockBlind": transform == "clock-blind"}
    return CloudProofTensorizer(
        clock_blind=bool(transform.get("clockBlind")),
        label_horizon=label_horizon,
    )


class _PerturbedSamples(IterableDataset[GraphSample]):
    """Keep perturbation streams recognizable as iterable datasets to DataLoader."""

    def __init__(self, samples: Iterable[GraphSample], edge_mode: str, edge_seed: int) -> None:
        super().__init__()
        self.samples = samples
        self.edge_mode = edge_mode
        self.edge_seed = edge_seed

    def __iter__(self):
        for sample in self.samples:
            yield perturb_sample(sample, self.edge_mode, self.edge_seed)


@torch.no_grad()
def predict_samples(
    models: list[torch.nn.Module],
    samples: Iterable[GraphSample],
    *,
    batch_size: int = 128,
    device: str | torch.device = "cpu",
    edge_mode: str = "full",
    edge_seed: int = DEFAULT_EDGE_SEED,
) -> tuple[list[float], list[float], list[float], list[str | None]]:
    perturbed = _PerturbedSamples(samples, edge_mode, edge_seed)
    loader = DataLoader(perturbed, batch_size=batch_size, collate_fn=collate_graphs, num_workers=0)
    labels: list[float] = []
    risks: list[float] = []
    uncertainties: list[float] = []
    record_ids: list[str | None] = []
    for batch in loader:
        batch = batch.to(device)
        risk, uncertainty = ensemble_predict(models, batch, relation_mode_for(edge_mode))
        risks.extend(risk.cpu().tolist())
        uncertainties.extend(uncertainty.cpu().tolist())
        if batch.labels is not None:
            labels.extend(batch.labels.cpu().tolist())
        record_ids.extend(batch.record_ids)
    return labels, risks, uncertainties, record_ids


def predict_path(
    models: list[torch.nn.Module],
    path: str | Path,
    *,
    batch_size: int = 128,
    max_records: int | None = None,
    device: str | torch.device = "cpu",
    edge_mode: str = "full",
    edge_seed: int = DEFAULT_EDGE_SEED,
    tensorizer: CloudProofTensorizer | None = None,
) -> tuple[list[float], list[float], list[float], list[str | None]]:
    dataset = StreamingGraphDataset(
        path, include_label=True, max_records=max_records, tensorizer=tensorizer
    )
    return predict_samples(
        models, dataset, batch_size=batch_size, device=device, edge_mode=edge_mode, edge_seed=edge_seed
    )


def artifact_manifest(directory: str | Path, config: dict) -> dict:
    root = Path(directory)
    members = []
    for index, seed in enumerate(config["ensembleSeeds"]):
        filename = f"member-{index}.pt"
        members.append({"file": filename, "seed": seed, "sha256": sha256_file(root / filename)})
    result = {
        "kind": "cloudproof.gnn-risk-model-manifest",
        "schemaVersion": 1,
        "safetyAuthority": "deterministic-node-verifier",
        "modelRole": "schedule-risk-ranking-only",
        "resourceTypes": list(RESOURCE_TYPES),
        "relationTypes": list(RELATION_TYPES),
        "config": {"file": "config.json", "sha256": sha256_file(root / "config.json")},
        "members": members,
        "dataset": config["dataset"],
    }
    metrics = root / "metrics.json"
    if metrics.is_file():
        result["metrics"] = {"file": "metrics.json", "sha256": sha256_file(metrics)}
    return result
