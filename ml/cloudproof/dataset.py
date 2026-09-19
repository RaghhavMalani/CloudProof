"""Streaming access to the canonical Phase II-A corpus and manifest."""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
from pathlib import Path
import random
from typing import Any, Iterator

from torch.utils.data import IterableDataset, get_worker_info

from .constants import SPLIT_NAMES
from .tensorize import CloudProofTensorizer, GraphSample


DATASET_FILENAMES = {name: f"transitions-{name}.jsonl" for name in SPLIT_NAMES}


@dataclass(frozen=True)
class LabelBalance:
    total: int
    positive: int
    negative: int

    @property
    def positive_rate(self) -> float:
        return self.positive / self.total if self.total else 0.0

    def to_dict(self) -> dict[str, int | float]:
        return {
            "total": self.total,
            "positive": self.positive,
            "negative": self.negative,
            "positiveRate": self.positive_rate,
        }


class CorpusManifest:
    def __init__(self, directory: str | Path) -> None:
        self.directory = Path(directory).resolve()
        manifest_file = self.directory / "manifest.json"
        if not manifest_file.is_file():
            raise FileNotFoundError(f"missing Phase II-A manifest: {manifest_file}")
        self.value = json.loads(manifest_file.read_text(encoding="utf-8"))
        self._validate_contract()

    def _validate_contract(self) -> None:
        value = self.value
        if value.get("kind") != "cloudproof.research-dataset-manifest":
            raise ValueError("unsupported CloudProof manifest kind")
        if value.get("splitPolicy") != "topology-holdout-v1":
            raise ValueError("Phase II-B requires topology-holdout-v1")
        features = value.get("features") or {}
        if features.get("boundary") != "state-and-candidate-action-only":
            raise ValueError("manifest violates the state + candidate action feature boundary")
        excluded = set(features.get("excluded") or [])
        required_exclusions = {"nextState", "labels", "trajectoryOutcome", "failureClass"}
        if not required_exclusions.issubset(excluded):
            raise ValueError("manifest is missing required leakage exclusions")
        catalog = (value.get("parameters") or {}).get("topologyCatalog") or []
        split_ids = {
            split: {entry["topologyId"] for entry in catalog if entry.get("split") == split}
            for split in SPLIT_NAMES
        }
        if any(not ids for ids in split_ids.values()):
            raise ValueError("train, validation, test, and OOD topologies are all required")
        flattened = [item for split in SPLIT_NAMES for item in split_ids[split]]
        if len(flattened) != len(set(flattened)):
            raise ValueError("topology IDs overlap across splits")
        train_replicas = [
            entry["topology"]["initialReplicas"] for entry in catalog if entry.get("split") == "train"
        ]
        ood_replicas = [
            entry["topology"]["initialReplicas"] for entry in catalog if entry.get("split") == "ood"
        ]
        if not all(3 <= value <= 6 for value in train_replicas):
            raise ValueError("training topology contract must remain at 3-6 replicas")
        if not all(8 <= value <= 12 for value in ood_replicas):
            raise ValueError("OOD topology contract must remain at 8-12 replicas")

    def path_for(self, split: str) -> Path:
        if split not in DATASET_FILENAMES:
            raise ValueError(f"unsupported split: {split}")
        path = self.directory / DATASET_FILENAMES[split]
        if not path.is_file():
            raise FileNotFoundError(path)
        return path

    def verify_hashes(self) -> dict[str, str]:
        verified = {}
        files = self.value.get("files") or {}
        for split in SPLIT_NAMES:
            filename = DATASET_FILENAMES[split]
            expected = (files.get(filename) or {}).get("sha256")
            if not expected:
                raise ValueError(f"manifest has no SHA-256 for {filename}")
            digest = hashlib.sha256()
            with self.path_for(split).open("rb") as handle:
                for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                    digest.update(chunk)
            actual = digest.hexdigest()
            if actual != expected:
                raise ValueError(f"SHA-256 mismatch for {filename}: {actual} != {expected}")
            verified[filename] = actual
        return verified

    def artifact_contract(self) -> dict[str, Any]:
        return {
            "datasetKind": self.value["kind"],
            "datasetSchemaVersion": self.value.get("schemaVersion"),
            "generatorCommitSha": (self.value.get("generator") or {}).get("commitSha"),
            "splitPolicy": self.value["splitPolicy"],
            "featureBoundary": self.value["features"]["boundary"],
            "label": self.value.get("label"),
            "files": {
                name: {"sha256": metadata.get("sha256"), "bytes": metadata.get("bytes")}
                for name, metadata in sorted((self.value.get("files") or {}).items())
                if name.startswith("transitions-")
            },
        }


def iter_jsonl(path: str | Path) -> Iterator[dict[str, Any]]:
    with Path(path).open("r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, start=1):
            if not line.strip():
                continue
            try:
                yield json.loads(line)
            except json.JSONDecodeError as error:
                raise ValueError(f"invalid JSON at {path}:{line_number}") from error


def label_balance(path: str | Path, max_records: int | None = None) -> LabelBalance:
    positive = 0
    total = 0
    for record in iter_jsonl(path):
        label = bool((record.get("labels") or {}).get("sloViolationWithinKTransitions"))
        positive += int(label)
        total += 1
        if max_records is not None and total >= max_records:
            break
    return LabelBalance(total=total, positive=positive, negative=total - positive)


class StreamingGraphDataset(IterableDataset[GraphSample]):
    """Deterministic streaming dataset with bounded-buffer train shuffling."""

    def __init__(
        self,
        path: str | Path,
        *,
        tensorizer: CloudProofTensorizer | None = None,
        include_label: bool = True,
        shuffle: bool = False,
        shuffle_seed: int = 0,
        shuffle_buffer: int = 2048,
        max_records: int | None = None,
    ) -> None:
        super().__init__()
        self.path = Path(path)
        self.tensorizer = tensorizer or CloudProofTensorizer()
        self.include_label = include_label
        self.shuffle = shuffle
        self.shuffle_seed = shuffle_seed
        self.shuffle_buffer = shuffle_buffer
        self.max_records = max_records
        self.epoch = 0

    def set_epoch(self, epoch: int) -> None:
        self.epoch = int(epoch)

    def _records(self) -> Iterator[dict[str, Any]]:
        worker = get_worker_info()
        yielded = 0
        for index, record in enumerate(iter_jsonl(self.path)):
            if worker is not None and index % worker.num_workers != worker.id:
                continue
            yield record
            yielded += 1
            if self.max_records is not None and yielded >= self.max_records:
                break

    def __iter__(self) -> Iterator[GraphSample]:
        records = self._records()
        if not self.shuffle:
            for record in records:
                yield self.tensorizer.tensorize_record(record, self.include_label)
            return
        randomizer = random.Random(self.shuffle_seed + self.epoch * 1_000_003)
        buffer = []
        for record in records:
            buffer.append(record)
            if len(buffer) >= self.shuffle_buffer:
                selected = randomizer.randrange(len(buffer))
                yield self.tensorizer.tensorize_record(buffer.pop(selected), self.include_label)
        while buffer:
            selected = randomizer.randrange(len(buffer))
            yield self.tensorizer.tensorize_record(buffer.pop(selected), self.include_label)


def find_zone_experiment_record(path: str | Path) -> dict[str, Any]:
    for record in iter_jsonl(path):
        state = record.get("state") or {}
        nodes = state.get("nodes") or []
        if (
            len([node for node in nodes if node.get("type") == "Pod"]) == 6
            and len([node for node in nodes if node.get("type") == "Zone"]) == 3
        ):
            return record
    raise ValueError("no six-pod, three-zone record exists for the controlled experiment")
