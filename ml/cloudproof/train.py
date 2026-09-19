"""Train a reproducible five-member CloudProof risk ensemble."""

from __future__ import annotations

import argparse
from copy import deepcopy
import json
from pathlib import Path
import random

import numpy as np
import torch
from torch import nn
from torch.utils.data import DataLoader

from .constants import ACTION_TYPES, ENSEMBLE_SEEDS, NODE_FEATURE_NAMES, RELATION_TYPES, RESOURCE_TYPES
from .dataset import CorpusManifest, StreamingGraphDataset, label_balance
from .metrics import evaluate_binary_risk, threshold_for_f1
from .model import ModelConfig, build_model, ensemble_predict
from .runtime import artifact_manifest, json_dump
from .tensorize import collate_graphs


ABLATIONS = ("full", "no-edge-types", "no-action-embedding", "no-zone-relations", "flat-mlp")


def config_for_ablation(name: str, hidden_dim: int, layers: int, dropout: float) -> ModelConfig:
    if name not in ABLATIONS:
        raise ValueError(f"unknown ablation: {name}")
    return ModelConfig(
        hidden_dim=hidden_dim,
        layers=layers,
        dropout=dropout,
        use_edge_types=name != "no-edge-types",
        use_action_embedding=name != "no-action-embedding",
        use_zone_relations=name != "no-zone-relations",
        flat_mlp=name == "flat-mlp",
    )


def seed_everything(seed: int) -> None:
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)
    torch.use_deterministic_algorithms(True)


def _member_predictions(model, loader, device) -> tuple[list[float], list[float]]:
    labels = []
    predictions = []
    model.eval()
    with torch.no_grad():
        for batch in loader:
            batch = batch.to(device)
            predictions.extend(torch.sigmoid(model(batch)).cpu().tolist())
            labels.extend(batch.labels.cpu().tolist())
    return labels, predictions


def _validation_loader(path, batch_size, max_records):
    return DataLoader(
        StreamingGraphDataset(path, max_records=max_records),
        batch_size=batch_size,
        collate_fn=collate_graphs,
        num_workers=0,
    )


def train_member(
    *,
    seed: int,
    config: ModelConfig,
    train_path: Path,
    validation_path: Path,
    epochs: int,
    patience: int,
    learning_rate: float,
    weight_decay: float,
    batch_size: int,
    shuffle_buffer: int,
    pos_weight: float,
    max_train_records: int | None,
    max_validation_records: int | None,
    device: str,
) -> tuple[nn.Module, dict]:
    seed_everything(seed)
    model = build_model(config).to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=learning_rate, weight_decay=weight_decay)
    criterion = nn.BCEWithLogitsLoss(pos_weight=torch.tensor(pos_weight, device=device))
    train_data = StreamingGraphDataset(
        train_path,
        shuffle=True,
        shuffle_seed=seed,
        shuffle_buffer=shuffle_buffer,
        max_records=max_train_records,
    )
    train_loader = DataLoader(
        train_data,
        batch_size=batch_size,
        collate_fn=collate_graphs,
        num_workers=0,
    )
    best_state = None
    best_epoch = 0
    best_nll = float("inf")
    epochs_without_improvement = 0
    history = []
    for epoch in range(1, epochs + 1):
        train_data.set_epoch(epoch)
        model.train()
        loss_sum = 0.0
        examples = 0
        for batch in train_loader:
            batch = batch.to(device)
            optimizer.zero_grad(set_to_none=True)
            logits = model(batch)
            loss = criterion(logits, batch.labels)
            loss.backward()
            nn.utils.clip_grad_norm_(model.parameters(), 5.0)
            optimizer.step()
            loss_sum += float(loss.detach()) * batch.graph_count
            examples += batch.graph_count
        validation_loader = _validation_loader(validation_path, batch_size, max_validation_records)
        labels, probabilities = _member_predictions(model, validation_loader, device)
        metrics = evaluate_binary_risk(labels, probabilities)
        history.append({"epoch": epoch, "trainLoss": loss_sum / max(1, examples), "validation": metrics})
        if metrics["nll"] < best_nll - 1e-8:
            best_nll = metrics["nll"]
            best_epoch = epoch
            best_state = deepcopy({key: value.detach().cpu() for key, value in model.state_dict().items()})
            epochs_without_improvement = 0
        else:
            epochs_without_improvement += 1
            if epochs_without_improvement >= patience:
                break
    if best_state is None:
        raise RuntimeError("training produced no model state")
    model.load_state_dict(best_state)
    model.to(device).eval()
    return model, {"seed": seed, "bestEpoch": best_epoch, "bestValidationNll": best_nll, "history": history}


def train_ensemble(
    *,
    dataset_directory: str | Path,
    output_directory: str | Path,
    ablation: str = "full",
    seeds: tuple[int, ...] = ENSEMBLE_SEEDS,
    epochs: int = 20,
    patience: int = 4,
    learning_rate: float = 1e-3,
    weight_decay: float = 1e-4,
    batch_size: int = 128,
    hidden_dim: int = 48,
    layers: int = 2,
    dropout: float = 0.1,
    shuffle_buffer: int = 2048,
    max_train_records: int | None = None,
    max_validation_records: int | None = None,
    verify_hashes: bool = True,
    device: str = "cpu",
) -> dict:
    if len(seeds) != 5:
        raise ValueError("Phase II-B requires exactly five independently initialized models")
    manifest = CorpusManifest(dataset_directory)
    verified_hashes = manifest.verify_hashes() if verify_hashes else None
    train_path = manifest.path_for("train")
    validation_path = manifest.path_for("validation")
    balance = label_balance(train_path, max_train_records)
    if balance.positive == 0 or balance.negative == 0:
        raise ValueError("training data must contain both labels")
    heavily_imbalanced = balance.positive_rate < 0.25 or balance.positive_rate > 0.75
    pos_weight = balance.negative / balance.positive if heavily_imbalanced else 1.0
    model_config = config_for_ablation(ablation, hidden_dim, layers, dropout)
    output = Path(output_directory)
    output.mkdir(parents=True, exist_ok=True)
    config = {
        "kind": "cloudproof.gnn-risk-model-config",
        "schemaVersion": 1,
        "task": "P(SLO violation within next K transitions)",
        "ablation": ablation,
        "model": model_config.to_dict(),
        "ensembleSeeds": list(seeds),
        "resourceTypes": list(RESOURCE_TYPES),
        "relationTypes": list(RELATION_TYPES),
        "actionTypes": list(ACTION_TYPES),
        "nodeFeatureNames": {key: list(value) for key, value in NODE_FEATURE_NAMES.items()},
        "leakageExclusions": [
            "identifiers",
            "topology labels",
            "split labels",
            "nextState",
            "trajectory outcomes",
            "failure classes",
        ],
        "dataset": manifest.artifact_contract(),
        "training": {
            "epochs": epochs,
            "patience": patience,
            "learningRate": learning_rate,
            "weightDecay": weight_decay,
            "batchSize": batch_size,
            "shuffleBuffer": shuffle_buffer,
            "maxTrainRecords": max_train_records,
            "maxValidationRecords": max_validation_records,
            "transitionLabelBalance": balance.to_dict(),
            "loss": "weighted-bce" if heavily_imbalanced else "bce",
            "positiveWeight": pos_weight,
            "device": device,
            "hashesVerified": bool(verified_hashes),
        },
    }
    json_dump(output / "config.json", config)

    models = []
    members = []
    for index, seed in enumerate(seeds):
        model, member = train_member(
            seed=seed,
            config=model_config,
            train_path=train_path,
            validation_path=validation_path,
            epochs=epochs,
            patience=patience,
            learning_rate=learning_rate,
            weight_decay=weight_decay,
            batch_size=batch_size,
            shuffle_buffer=shuffle_buffer,
            pos_weight=pos_weight,
            max_train_records=max_train_records,
            max_validation_records=max_validation_records,
            device=device,
        )
        torch.save(model.state_dict(), output / f"member-{index}.pt")
        models.append(model)
        members.append(member)

    validation_loader = _validation_loader(validation_path, batch_size, max_validation_records)
    labels = []
    probabilities = []
    uncertainties = []
    with torch.no_grad():
        for batch in validation_loader:
            batch = batch.to(device)
            risk, uncertainty = ensemble_predict(models, batch)
            labels.extend(batch.labels.cpu().tolist())
            probabilities.extend(risk.cpu().tolist())
            uncertainties.extend(uncertainty.cpu().tolist())
    validation_metrics = evaluate_binary_risk(labels, probabilities)
    validation_metrics["thresholdSelection"] = threshold_for_f1(labels, probabilities)
    validation_metrics["meanUncertainty"] = float(np.mean(uncertainties))
    metrics = {
        "kind": "cloudproof.gnn-risk-model-training-metrics",
        "schemaVersion": 1,
        "ablation": ablation,
        "members": members,
        "validation": validation_metrics,
        "test": None,
        "ood": None,
    }
    json_dump(output / "metrics.json", metrics)
    json_dump(output / "manifest.json", artifact_manifest(output, config))
    return metrics


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--ablation", choices=ABLATIONS, default="full")
    parser.add_argument("--seeds", default=",".join(str(seed) for seed in ENSEMBLE_SEEDS))
    parser.add_argument("--epochs", type=int, default=20)
    parser.add_argument("--patience", type=int, default=4)
    parser.add_argument("--learning-rate", type=float, default=1e-3)
    parser.add_argument("--weight-decay", type=float, default=1e-4)
    parser.add_argument("--batch-size", type=int, default=128)
    parser.add_argument("--hidden-dim", type=int, default=48)
    parser.add_argument("--layers", type=int, default=2)
    parser.add_argument("--dropout", type=float, default=0.1)
    parser.add_argument("--shuffle-buffer", type=int, default=2048)
    parser.add_argument("--max-train-records", type=int)
    parser.add_argument("--max-validation-records", type=int)
    parser.add_argument("--skip-hash-verification", action="store_true")
    parser.add_argument("--device", default="cpu")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    seeds = tuple(int(value) for value in args.seeds.split(",") if value)
    result = train_ensemble(
        dataset_directory=args.dataset,
        output_directory=args.out,
        ablation=args.ablation,
        seeds=seeds,
        epochs=args.epochs,
        patience=args.patience,
        learning_rate=args.learning_rate,
        weight_decay=args.weight_decay,
        batch_size=args.batch_size,
        hidden_dim=args.hidden_dim,
        layers=args.layers,
        dropout=args.dropout,
        shuffle_buffer=args.shuffle_buffer,
        max_train_records=args.max_train_records,
        max_validation_records=args.max_validation_records,
        verify_hashes=not args.skip_hash_verification,
        device=args.device,
    )
    print(json.dumps({"out": str(Path(args.out).resolve()), "validation": result["validation"]}, indent=2))


if __name__ == "__main__":
    main()
