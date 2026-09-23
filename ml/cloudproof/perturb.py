"""Deterministic structural interventions for graph-model attribution tests."""

from __future__ import annotations

import hashlib

import torch

from .constants import RELATION_ENDPOINTS, RELATION_TYPES
from .tensorize import GraphSample


EDGE_DESTRUCTION_MODES = (
    "full",
    "randomized-edges",
    "rewired-edges",
    "collapsed-edge-types",
    "no-edges",
    "random-relation-labels",
)
DEFAULT_EDGE_SEED = 1729


def _sample_seed(sample: GraphSample, seed: int) -> int:
    identity = sample.record_id or "anonymous"
    digest = hashlib.sha256(f"{seed}:{identity}".encode("utf-8")).digest()
    return int.from_bytes(digest[:8], "big") % (2**63 - 1)


def _sorted_columns(edge_index: torch.Tensor) -> list[tuple[int, int]]:
    return sorted((int(source), int(target)) for source, target in edge_index.t().tolist())


def perturb_sample(sample: GraphSample, mode: str, seed: int = DEFAULT_EDGE_SEED) -> GraphSample:
    """Return ``sample`` with its relation tensors destroyed according to ``mode``.

    Node features, node counts, action features, the action target, the label and
    the record ID are never touched. Every relation keeps its edge count.

    * ``randomized-edges`` (Phase II-B.1 control): permutes the target column of
      each relation, which preserves every per-node degree multiset.
    * ``rewired-edges`` (Phase II-B.2 control): resamples both endpoints uniformly
      among type-compatible nodes, which also destroys the degree structure. If
      the resampled multiset happens to equal the original, the targets are
      rolled by one position so the original graph is never reconstructed.
    * ``no-edges``: removes every relation.

    The randomization is seeded from ``seed`` and the record ID, so the same
    record receives the same destroyed graph in every evaluation.
    """
    if mode not in EDGE_DESTRUCTION_MODES:
        raise ValueError(f"unsupported edge-destruction mode: {mode}")
    if mode not in {"randomized-edges", "rewired-edges", "no-edges"}:
        return sample
    edges = {}
    generator = torch.Generator().manual_seed(_sample_seed(sample, seed))
    for relation in RELATION_TYPES:
        original = sample.edges[relation]
        if mode == "no-edges":
            edges[relation] = torch.empty((2, 0), dtype=torch.long)
            continue
        count = original.shape[1]
        if count == 0:
            edges[relation] = original.clone()
            continue
        if mode == "randomized-edges":
            randomized = original.clone()
            if count > 1:
                permutation = torch.randperm(count, generator=generator)
                if torch.equal(permutation, torch.arange(count)):
                    permutation = torch.roll(permutation, shifts=1)
                randomized[1] = randomized[1, permutation]
            edges[relation] = randomized
            continue
        source_type, target_type = RELATION_ENDPOINTS[relation]
        source_count = sample.node_features[source_type].shape[0]
        target_count = sample.node_features[target_type].shape[0]
        rewired = torch.stack([
            torch.randint(0, source_count, (count,), generator=generator),
            torch.randint(0, target_count, (count,), generator=generator),
        ])
        if _sorted_columns(rewired) == _sorted_columns(original):
            if target_count > 1:
                rewired[1] = (rewired[1] + 1) % target_count
            elif source_count > 1:
                rewired[0] = (rewired[0] + 1) % source_count
        edges[relation] = rewired
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
