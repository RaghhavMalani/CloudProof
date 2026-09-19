"""Deterministic, leakage-resistant tensorization of CloudProof graph records."""

from __future__ import annotations

from dataclasses import dataclass
import re
from typing import Any, Iterable

import torch

from .constants import (
    ACTION_FEATURE_DIM,
    ACTION_PARAMETER_NAMES,
    ACTION_PARAMETER_SCALES,
    ACTION_TARGET_TYPES,
    ACTION_TYPES,
    NODE_FEATURE_DIMS,
    RELATION_ENDPOINTS,
    RELATION_TYPES,
    RESOURCE_TYPES,
)


def _number(value: Any, default: float = 0.0) -> float:
    if isinstance(value, bool):
        return float(value)
    if isinstance(value, (int, float)):
        return float(value)
    return default


def _version_number(value: Any) -> float:
    if not isinstance(value, str):
        return _number(value)
    match = re.search(r"(\d+(?:\.\d+)?)", value)
    return float(match.group(1)) if match else 0.0


def _bool(value: Any) -> float:
    return 1.0 if bool(value) else 0.0


def _pod_features(features: dict[str, Any]) -> list[float]:
    phase = str(features.get("phase", "")).upper()
    return [
        _bool(features.get("ready")),
        _number(features.get("cpuMillicores")) / 4000.0,
        _number(features.get("memoryMb")) / 8192.0,
        _version_number(features.get("version")) / 100.0,
        _bool(phase in {"PENDING", "STARTING"}),
        _bool(phase == "RUNNING"),
        _bool(phase == "READY"),
        _bool(phase == "TERMINATING"),
        _bool(phase == "FAILED"),
    ]


def _node_features(features: dict[str, Any]) -> list[float]:
    # `zone` is deliberately excluded: the LOCATED_IN relation carries it.
    return [
        _bool(features.get("ready")),
        _bool(features.get("draining")),
        _number(features.get("cpuCapacity")) / 8000.0,
        _number(features.get("memoryMb")) / 16384.0,
        len(features.get("taints") or []) / 4.0,
    ]


def _deployment_features(features: dict[str, Any]) -> list[float]:
    observed = features.get("observed") or {}
    return [
        _number(features.get("desiredReplicas")) / 24.0,
        _version_number(features.get("desiredVersion")) / 100.0,
        _number(features.get("maxSurge")) / 4.0,
        _number(features.get("maxUnavailable")) / 4.0,
        _number(observed.get("running")) / 24.0,
        _number(observed.get("ready")) / 24.0,
        _number(observed.get("pending")) / 24.0,
        _number(observed.get("terminating")) / 24.0,
        _number(observed.get("replicas")) / 24.0,
        _bool(features.get("rolloutActive")),
    ]


def _service_features(features: dict[str, Any]) -> list[float]:
    # endpointPodIds is another ID-bearing field and is never encoded.
    return [
        _number(features.get("minimumReady")) / 24.0,
        _number(features.get("endpointCount")) / 24.0,
    ]


def _hpa_features(features: dict[str, Any]) -> list[float]:
    return [
        _number(features.get("minReplicas")) / 24.0,
        _number(features.get("maxReplicas")) / 32.0,
        _number(features.get("targetMetric")) / 100.0,
        _number(features.get("currentMetric")) / 100.0,
        _number(features.get("sampledAtMs")) / 10000.0,
        _number(features.get("recommendation")) / 32.0,
        _bool(features.get("active")),
    ]


def _pdb_features(features: dict[str, Any]) -> list[float]:
    return [
        _number(features.get("minAvailable")) / 24.0,
        _number(features.get("disruptionsAllowed")) / 24.0,
    ]


FEATURE_ENCODERS = {
    "Pod": _pod_features,
    "Node": _node_features,
    "Deployment": _deployment_features,
    "Service": _service_features,
    "HPA": _hpa_features,
    "PDB": _pdb_features,
    "Zone": lambda features: [_bool(features.get("degraded"))],
}


@dataclass
class GraphSample:
    node_features: dict[str, torch.Tensor]
    edges: dict[str, torch.Tensor]
    action_features: torch.Tensor
    target: tuple[str, int] | None
    label: float | None = None
    record_id: str | None = None


@dataclass
class GraphBatch:
    node_features: dict[str, torch.Tensor]
    node_batches: dict[str, torch.Tensor]
    edges: dict[str, torch.Tensor]
    action_features: torch.Tensor
    targets: dict[str, torch.Tensor]
    labels: torch.Tensor | None
    record_ids: list[str | None]
    graph_count: int

    def to(self, device: torch.device | str) -> "GraphBatch":
        return GraphBatch(
            node_features={key: value.to(device) for key, value in self.node_features.items()},
            node_batches={key: value.to(device) for key, value in self.node_batches.items()},
            edges={key: value.to(device) for key, value in self.edges.items()},
            action_features=self.action_features.to(device),
            targets={key: value.to(device) for key, value in self.targets.items()},
            labels=None if self.labels is None else self.labels.to(device),
            record_ids=self.record_ids,
            graph_count=self.graph_count,
        )


class CloudProofTensorizer:
    """Turns only ``state + candidate action`` into tensors.

    IDs are used transiently to resolve relation endpoints and an action target.
    They are absent from every returned tensor. Future state, labels, split names,
    topology labels, scenario metadata, and trajectory outcomes are not read.
    """

    def tensorize_record(self, record: dict[str, Any], include_label: bool = True) -> GraphSample:
        if not isinstance(record.get("state"), dict) or not isinstance(record.get("action"), dict):
            raise ValueError("record must contain state and action objects")
        label = None
        if include_label:
            labels = record.get("labels") or {}
            label = float(bool(labels.get("sloViolationWithinKTransitions")))
        return self.tensorize(record["state"], record["action"], label, record.get("recordId"))

    def tensorize(
        self,
        state: dict[str, Any],
        action: dict[str, Any],
        label: float | None = None,
        record_id: str | None = None,
    ) -> GraphSample:
        if state.get("kind") != "cloudproof.infrastructure-graph":
            raise ValueError("expected cloudproof.infrastructure-graph state")

        grouped: dict[str, list[dict[str, Any]]] = {name: [] for name in RESOURCE_TYPES}
        for node in state.get("nodes") or []:
            node_type = node.get("type")
            if node_type not in grouped:
                raise ValueError(f"unsupported resource type: {node_type}")
            grouped[node_type].append(node)
        for nodes in grouped.values():
            nodes.sort(key=lambda item: str(item.get("id", "")))

        node_lookup: dict[str, tuple[str, int]] = {}
        node_features: dict[str, torch.Tensor] = {}
        for node_type in RESOURCE_TYPES:
            rows = []
            for index, node in enumerate(grouped[node_type]):
                node_id = node.get("id")
                if not isinstance(node_id, str) or not node_id:
                    raise ValueError("graph nodes require non-empty IDs for relation wiring")
                if node_id in node_lookup:
                    raise ValueError(f"duplicate graph node ID: {node_id}")
                node_lookup[node_id] = (node_type, index)
                rows.append(FEATURE_ENCODERS[node_type](node.get("features") or {}))
            if rows:
                node_features[node_type] = torch.tensor(rows, dtype=torch.float32)
            else:
                node_features[node_type] = torch.empty((0, NODE_FEATURE_DIMS[node_type]), dtype=torch.float32)

        relation_rows: dict[str, list[tuple[int, int]]] = {name: [] for name in RELATION_TYPES}
        sortable_edges = sorted(
            state.get("edges") or [],
            key=lambda edge: (str(edge.get("type", "")), str(edge.get("from", "")), str(edge.get("to", ""))),
        )
        for edge in sortable_edges:
            relation = edge.get("type")
            if relation not in RELATION_ENDPOINTS:
                raise ValueError(f"unsupported relation type: {relation}")
            source = node_lookup.get(edge.get("from"))
            target = node_lookup.get(edge.get("to"))
            expected = RELATION_ENDPOINTS[relation]
            if source is None or target is None:
                raise ValueError(f"relation {relation} references an unknown node")
            if (source[0], target[0]) != expected:
                raise ValueError(
                    f"relation {relation} expected {expected[0]}->{expected[1]}, "
                    f"got {source[0]}->{target[0]}"
                )
            relation_rows[relation].append((source[1], target[1]))
        edges = {
            relation: (
                torch.tensor(rows, dtype=torch.long).t().contiguous()
                if rows else torch.empty((2, 0), dtype=torch.long)
            )
            for relation, rows in relation_rows.items()
        }

        action_features, target_type = self._encode_action(action)
        target = self._resolve_target(action, target_type, node_lookup)
        action_features[len(ACTION_TYPES) + len(RESOURCE_TYPES)] = float(target is not None)
        return GraphSample(node_features, edges, action_features, target, label, record_id)

    @staticmethod
    def _encode_action(action: dict[str, Any]) -> tuple[torch.Tensor, str | None]:
        values = [0.0] * ACTION_FEATURE_DIM
        action_type = action.get("type")
        if action_type not in ACTION_TYPES:
            raise ValueError(f"unsupported action type: {action_type}")
        values[ACTION_TYPES.index(action_type)] = 1.0
        target_type = ACTION_TARGET_TYPES.get(action_type)
        target_offset = len(ACTION_TYPES)
        if target_type is not None:
            values[target_offset + RESOURCE_TYPES.index(target_type)] = 1.0

        parameter_offset = target_offset + len(RESOURCE_TYPES) + 1
        for index, name in enumerate(ACTION_PARAMETER_NAMES):
            raw = action.get(name)
            if name == "version":
                raw = _version_number(raw)
            values[parameter_offset + index] = _number(raw) / ACTION_PARAMETER_SCALES[name]
        return torch.tensor(values, dtype=torch.float32), target_type

    @staticmethod
    def _resolve_target(
        action: dict[str, Any],
        target_type: str | None,
        node_lookup: dict[str, tuple[str, int]],
    ) -> tuple[str, int] | None:
        if target_type is None:
            return None
        target_field = {
            "Node": "nodeId",
            "Zone": "zoneId",
            "Pod": "podId",
            "Deployment": "deploymentId",
            "Service": "serviceId",
            "HPA": "hpaId",
            "PDB": "pdbId",
        }[target_type]
        target_id = action.get(target_field)
        semantic_defaults = {
            "Deployment": "deployment/api",
            "Service": "service/api",
            "HPA": "hpa/api",
            "PDB": "pdb/api",
        }
        if target_id is None:
            target_id = semantic_defaults.get(target_type)
        if target_id is None:
            return None
        target_id = str(target_id)
        prefix = target_type.lower()
        if not target_id.startswith(f"{prefix}/"):
            target_id = f"{prefix}/{target_id}"
        resolved = node_lookup.get(target_id)
        if resolved is None or resolved[0] != target_type:
            return None
        return resolved


def collate_graphs(samples: Iterable[GraphSample]) -> GraphBatch:
    samples = list(samples)
    if not samples:
        raise ValueError("cannot collate an empty graph batch")
    node_features: dict[str, torch.Tensor] = {}
    node_batches: dict[str, torch.Tensor] = {}
    offsets: list[dict[str, int]] = []
    running = {name: 0 for name in RESOURCE_TYPES}
    per_type_features = {name: [] for name in RESOURCE_TYPES}
    per_type_batches = {name: [] for name in RESOURCE_TYPES}
    for graph_index, sample in enumerate(samples):
        offsets.append(running.copy())
        for node_type in RESOURCE_TYPES:
            features = sample.node_features[node_type]
            per_type_features[node_type].append(features)
            per_type_batches[node_type].append(
                torch.full((features.shape[0],), graph_index, dtype=torch.long)
            )
            running[node_type] += features.shape[0]
    for node_type in RESOURCE_TYPES:
        node_features[node_type] = torch.cat(per_type_features[node_type], dim=0)
        node_batches[node_type] = torch.cat(per_type_batches[node_type], dim=0)

    edges: dict[str, torch.Tensor] = {}
    for relation in RELATION_TYPES:
        source_type, target_type = RELATION_ENDPOINTS[relation]
        parts = []
        for graph_index, sample in enumerate(samples):
            item = sample.edges[relation]
            if item.numel() == 0:
                continue
            shifted = item.clone()
            shifted[0] += offsets[graph_index][source_type]
            shifted[1] += offsets[graph_index][target_type]
            parts.append(shifted)
        edges[relation] = torch.cat(parts, dim=1) if parts else torch.empty((2, 0), dtype=torch.long)

    target_parts: dict[str, list[tuple[int, int]]] = {name: [] for name in RESOURCE_TYPES}
    for graph_index, sample in enumerate(samples):
        if sample.target is None:
            continue
        node_type, local_index = sample.target
        target_parts[node_type].append((graph_index, offsets[graph_index][node_type] + local_index))
    targets = {
        node_type: (
            torch.tensor(rows, dtype=torch.long).t().contiguous()
            if rows else torch.empty((2, 0), dtype=torch.long)
        )
        for node_type, rows in target_parts.items()
    }
    labels = None
    if all(sample.label is not None for sample in samples):
        labels = torch.tensor([sample.label for sample in samples], dtype=torch.float32)
    elif any(sample.label is not None for sample in samples):
        raise ValueError("a batch cannot mix labeled and unlabeled graphs")
    return GraphBatch(
        node_features=node_features,
        node_batches=node_batches,
        edges=edges,
        action_features=torch.stack([sample.action_features for sample in samples]),
        targets=targets,
        labels=labels,
        record_ids=[sample.record_id for sample in samples],
        graph_count=len(samples),
    )
