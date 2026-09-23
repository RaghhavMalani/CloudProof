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


CAUSAL_MANIFEST_KIND = "cloudproof.causal-corpus-manifest"
CAUSAL_MANIFEST_SCHEMA_VERSION = 3
CAUSAL_SPLIT_POLICY = "topology-holdout-v2"
CAUSAL_AUXILIARY_FILES = {"pairs": "counterfactual-pairs.jsonl", "trajectories": "trajectories.jsonl"}
CAUSAL_REQUIRED_EXCLUSIONS = {
    "nextState",
    "labels",
    "trajectoryOutcome",
    "failureClass",
    "metadata",
    "nuisance",
    "placementKind",
    "scenarioFamily",
    "difficultyTier",
}


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


class CausalCorpusManifest:
    """Phase II-A.2 causal corpus (schema 3, ``topology-holdout-v2``).

    Exposes the same surface as :class:`CorpusManifest` so the unchanged training
    loop can consume corpus v2, plus the auxiliary pair and trajectory files and a
    check against the committed freeze record.
    """

    def __init__(self, directory: str | Path) -> None:
        self.directory = Path(directory).resolve()
        manifest_file = self.directory / "manifest.json"
        if not manifest_file.is_file():
            raise FileNotFoundError(f"missing causal corpus manifest: {manifest_file}")
        self.value = json.loads(manifest_file.read_text(encoding="utf-8"))
        self._validate_contract()

    def _validate_contract(self) -> None:
        value = self.value
        if value.get("kind") != CAUSAL_MANIFEST_KIND:
            raise ValueError("unsupported CloudProof causal corpus manifest kind")
        if value.get("schemaVersion") != CAUSAL_MANIFEST_SCHEMA_VERSION:
            raise ValueError("Phase II-B.2 requires causal corpus schema version 3")
        if value.get("splitPolicy") != CAUSAL_SPLIT_POLICY:
            raise ValueError("Phase II-B.2 requires topology-holdout-v2")
        features = value.get("features") or {}
        if features.get("boundary") != "state-and-candidate-action-only":
            raise ValueError("manifest violates the state + candidate action feature boundary")
        if not CAUSAL_REQUIRED_EXCLUSIONS.issubset(set(features.get("excluded") or [])):
            raise ValueError("manifest is missing required leakage exclusions")
        if features.get("rowsCarryNextState") is not False:
            raise ValueError("causal corpus rows must not carry the next state")
        label = value.get("label") or {}
        if label.get("defaultHorizon") != 5 or list(label.get("horizons") or []) != [1, 5, 10, 20]:
            raise ValueError("causal corpus label contract changed (K = 5 default, horizons 1/5/10/20)")
        if (value.get("generator") or {}).get("outcomeBlind") is not True:
            raise ValueError("causal corpus generation must be outcome-blind")
        if not ((value.get("acceptance") or {}).get("passed")):
            raise ValueError("causal corpus did not pass its acceptance gates")
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
        files = value.get("files") or {}
        for filename in [*DATASET_FILENAMES.values(), *CAUSAL_AUXILIARY_FILES.values()]:
            if not (files.get(filename) or {}).get("sha256"):
                raise ValueError(f"manifest has no SHA-256 for {filename}")

    def topology_splits(self) -> dict[str, str]:
        catalog = (self.value.get("parameters") or {}).get("topologyCatalog") or []
        return {entry["topologyId"]: entry["split"] for entry in catalog}

    def path_for(self, split: str) -> Path:
        if split not in DATASET_FILENAMES:
            raise ValueError(f"unsupported split: {split}")
        path = self.directory / DATASET_FILENAMES[split]
        if not path.is_file():
            raise FileNotFoundError(path)
        return path

    def auxiliary_path(self, role: str) -> Path:
        if role not in CAUSAL_AUXILIARY_FILES:
            raise ValueError(f"unsupported auxiliary file: {role}")
        path = self.directory / CAUSAL_AUXILIARY_FILES[role]
        if not path.is_file():
            raise FileNotFoundError(path)
        return path

    def all_files(self) -> dict[str, Path]:
        names = [*DATASET_FILENAMES.values(), *CAUSAL_AUXILIARY_FILES.values()]
        return {name: self.directory / name for name in sorted(names)}

    def verify_hashes(self) -> dict[str, str]:
        """Recompute every recorded SHA-256 (transitions, pairs, trajectories)."""
        verified = {}
        files = self.value.get("files") or {}
        for filename, path in self.all_files().items():
            expected = (files.get(filename) or {}).get("sha256")
            if not path.is_file():
                raise FileNotFoundError(path)
            actual = _sha256(path)
            if actual != expected:
                raise ValueError(f"SHA-256 mismatch for {filename}: {actual} != {expected}")
            expected_bytes = (files.get(filename) or {}).get("bytes")
            if expected_bytes is not None and path.stat().st_size != expected_bytes:
                raise ValueError(f"byte-count mismatch for {filename}")
            verified[filename] = actual
        return verified

    def verify_freeze(self, freeze_path: str | Path, verified: dict[str, str] | None = None) -> dict[str, Any]:
        """Check this corpus against the committed freeze record and abort on any drift."""
        freeze = json.loads(Path(freeze_path).read_text(encoding="utf-8"))
        if freeze.get("kind") != "cloudproof.causal-corpus-freeze":
            raise ValueError("unsupported freeze record kind")
        if freeze.get("corpus") != self.directory.name:
            raise ValueError(f"freeze record is for corpus {freeze.get('corpus')!r}, not {self.directory.name!r}")
        if freeze.get("manifestKind") != self.value.get("kind"):
            raise ValueError("freeze record manifest kind differs")
        if freeze.get("manifestSchemaVersion") != self.value.get("schemaVersion"):
            raise ValueError("freeze record manifest schema version differs")
        if freeze.get("splitPolicy") != self.value.get("splitPolicy"):
            raise ValueError("freeze record split policy differs")
        for key in ("id", "version", "commitSha", "outcomeBlind"):
            if (freeze.get("generator") or {}).get(key) != (self.value.get("generator") or {}).get(key):
                raise ValueError(f"freeze record generator.{key} differs")
        if freeze.get("seeds") != self.value.get("seeds"):
            raise ValueError("freeze record seeds differ")
        if freeze.get("counts") != self.value.get("counts"):
            raise ValueError("freeze record counts differ")
        if not (freeze.get("acceptance") or {}).get("passed"):
            raise ValueError("freeze record does not carry a passed acceptance")
        verified = verified if verified is not None else self.verify_hashes()
        frozen_files = freeze.get("files") or {}
        if set(frozen_files) != set(self.all_files()):
            raise ValueError("freeze record and corpus directory list different files")
        for filename, metadata in frozen_files.items():
            if metadata.get("sha256") != verified[filename]:
                raise ValueError(f"frozen SHA-256 differs for {filename}")
            if metadata.get("bytes") != self.all_files()[filename].stat().st_size:
                raise ValueError(f"frozen byte count differs for {filename}")
            manifest_entry = (self.value.get("files") or {}).get(filename) or {}
            if manifest_entry.get("sha256") != metadata.get("sha256"):
                raise ValueError(f"manifest and freeze record disagree on {filename}")
        return {
            "freezeFile": Path(freeze_path).as_posix(),
            "freezeDigest": _sha256(Path(freeze_path)),
            "corpus": freeze.get("corpus"),
            "generatorCommitSha": (freeze.get("generator") or {}).get("commitSha"),
            "seeds": freeze.get("seeds"),
            "files": {name: {"sha256": verified[name], "bytes": frozen_files[name].get("bytes")} for name in sorted(frozen_files)},
            "acceptancePassed": True,
        }

    def artifact_contract(self) -> dict[str, Any]:
        files = self.value.get("files") or {}
        return {
            "datasetKind": self.value["kind"],
            "datasetSchemaVersion": self.value.get("schemaVersion"),
            "generatorCommitSha": (self.value.get("generator") or {}).get("commitSha"),
            "splitPolicy": self.value["splitPolicy"],
            "featureBoundary": self.value["features"]["boundary"],
            "label": self.value.get("label"),
            "files": {
                name: {"sha256": metadata.get("sha256"), "bytes": metadata.get("bytes")}
                for name, metadata in sorted(files.items())
                if name.startswith("transitions-")
            },
            "auxiliaryFiles": {
                name: {"sha256": metadata.get("sha256"), "bytes": metadata.get("bytes")}
                for name, metadata in sorted(files.items())
                if name in CAUSAL_AUXILIARY_FILES.values()
            },
        }


def open_corpus_manifest(directory: str | Path) -> CorpusManifest | CausalCorpusManifest:
    """Dispatch on the manifest kind so v1 tooling and the v2 corpus share one loader."""
    manifest_file = Path(directory) / "manifest.json"
    if not manifest_file.is_file():
        raise FileNotFoundError(f"missing CloudProof manifest: {manifest_file}")
    kind = json.loads(manifest_file.read_text(encoding="utf-8")).get("kind")
    if kind == CAUSAL_MANIFEST_KIND:
        return CausalCorpusManifest(directory)
    return CorpusManifest(directory)


def iter_jsonl(path: str | Path) -> Iterator[dict[str, Any]]:
    with Path(path).open("r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, start=1):
            if not line.strip():
                continue
            try:
                yield json.loads(line)
            except json.JSONDecodeError as error:
                raise ValueError(f"invalid JSON at {path}:{line_number}") from error


def label_balance(
    path: str | Path, max_records: int | None = None, label_horizon: int | None = None
) -> LabelBalance:
    reader = CloudProofTensorizer(label_horizon=label_horizon)
    positive = 0
    total = 0
    for record in iter_jsonl(path):
        label = bool(reader.record_label(record))
        positive += int(label)
        total += 1
        if max_records is not None and total >= max_records:
            break
    return LabelBalance(total=total, positive=positive, negative=total - positive)


def permuted_label_vector(
    path: str | Path, seed: int, max_records: int | None = None
) -> tuple[float, ...]:
    labels = []
    for record in iter_jsonl(path):
        labels.append(float(bool((record.get("labels") or {}).get("sloViolationWithinKTransitions"))))
        if max_records is not None and len(labels) >= max_records:
            break
    random.Random(seed).shuffle(labels)
    return tuple(labels)


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
        label_overrides: tuple[float, ...] | None = None,
    ) -> None:
        super().__init__()
        self.path = Path(path)
        self.tensorizer = tensorizer or CloudProofTensorizer()
        self.include_label = include_label
        self.shuffle = shuffle
        self.shuffle_seed = shuffle_seed
        self.shuffle_buffer = shuffle_buffer
        self.max_records = max_records
        self.label_overrides = label_overrides
        self.epoch = 0

    def set_epoch(self, epoch: int) -> None:
        self.epoch = int(epoch)

    def _records(self) -> Iterator[tuple[int, dict[str, Any]]]:
        worker = get_worker_info()
        for index, record in enumerate(iter_jsonl(self.path)):
            if self.max_records is not None and index >= self.max_records:
                break
            if worker is not None and index % worker.num_workers != worker.id:
                continue
            yield index, record

    def _tensorize(self, index: int, record: dict[str, Any]) -> GraphSample:
        if self.label_overrides is None:
            return self.tensorizer.tensorize_record(record, self.include_label)
        if not self.include_label:
            raise ValueError("label overrides require include_label=True")
        if index >= len(self.label_overrides):
            raise ValueError("label override vector is shorter than the dataset")
        return self.tensorizer.tensorize(
            record["state"], record["action"], self.label_overrides[index], record.get("recordId")
        )

    def __iter__(self) -> Iterator[GraphSample]:
        records = self._records()
        if not self.shuffle:
            for index, record in records:
                yield self._tensorize(index, record)
            return
        randomizer = random.Random(self.shuffle_seed + self.epoch * 1_000_003)
        buffer = []
        for indexed_record in records:
            buffer.append(indexed_record)
            if len(buffer) >= self.shuffle_buffer:
                selected = randomizer.randrange(len(buffer))
                index, record = buffer.pop(selected)
                yield self._tensorize(index, record)
        while buffer:
            selected = randomizer.randrange(len(buffer))
            index, record = buffer.pop(selected)
            yield self._tensorize(index, record)


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
