"""Deterministic structural interventions for graph-model attribution tests."""

from __future__ import annotations

import hashlib

import torch

from .constants import RELATION_TYPES
from .tensorize import GraphSample


EDGE_DESTRUCTION_MODES = (
    "full",
    "randomized-edges",
    "collapsed-edge-types",
    "no-edges",
    "random-relation-labels",
)


def _sample_seed(sample: GraphSample, seed: int) -> int:
    identity = sample.record_id or "anonymous"
    digest = hashlib.sha256(f"{seed}:{identity}".encode("utf-8")).digest()
    return int.from_bytes(digest[:8], "big") % (2**63 - 1)


def perturb_sample(sample: GraphSample, mode: str, seed: int = 1729) -> GraphSample:
    if mode not in EDGE_DESTRUCTION_MODES:
        raise ValueError(f"unsupported edge-destruction mode: {mode}")
    if mode not in {"randomized-edges", "no-edges"}:
        return sample
    edges = {}
    generator = torch.Generator().manual_seed(_sample_seed(sample, seed))
    for relation in RELATION_TYPES:
        original = sample.edges[relation]
        if mode == "no-edges":
            edges[relation] = torch.empty((2, 0), dtype=torch.long)
            continue
        randomized = original.clone()
        count = randomized.shape[1]
        if count > 1:
            permutation = torch.randperm(count, generator=generator)
            if torch.equal(permutation, torch.arange(count)):
                permutation = torch.roll(permutation, shifts=1)
            randomized[1] = randomized[1, permutation]
        edges[relation] = randomized
    return GraphSample(
        node_features=sample.node_features,
        edges=edges,
        action_features=sample.action_features,
        target=sample.target,
        label=sample.label,
        record_id=sample.record_id,
    )


def relation_mode_for(edge_mode: str) -> str:
    if edge_mode in {"collapsed-edge-types", "random-relation-labels"}:
        return edge_mode
    if edge_mode in EDGE_DESTRUCTION_MODES:
        return "full"
    raise ValueError(f"unsupported edge-destruction mode: {edge_mode}")
