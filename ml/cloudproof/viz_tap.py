"""Opt-in training tap for the GNN Observatory.

``VizTap`` records what a :class:`~ml.cloudproof.model.HeterogeneousRiskGNN` does
to one fixed probe batch while it trains, as JSON Lines that
``web/observatory.html`` replays:

* the L2 norm of every probe node's hidden state after the input encoders and
  after every message layer;
* the L2 norm of every per-edge message each relation transform produces, in
  both directions, computed by the layer's own ``_messages``;
* the Frobenius norm of every forward and reverse relation weight, per layer;
* the sigmoid risk of each probe graph under every edge-destruction mode of
  :mod:`ml.cloudproof.perturb` (with ``relation_mode_for`` choosing the relation
  mode), plus the node and message norms behind each of those risks.

The tap must not change training, and ``test_viz_tap`` proves that it does not:
training with the tap gives bit-identical weights to training without it. Every
emit runs under ``torch.no_grad()`` with the model in eval mode and restores the
previous mode afterwards. The forward hooks exist only for the duration of one
emit and are removed before it returns. Nothing in an emit draws from a global
random generator: edge destruction uses its own seeded ``torch.Generator``.

The probe is one frozen counterfactual pair, chosen by a fixed rule
(:data:`PROBE_RULE`) rather than by how any model scores it. Its two members
have identical pooled inputs and differ only in their wiring, so a
topology-blind model cannot tell them apart.
"""

from __future__ import annotations

from dataclasses import dataclass, field
import json
from pathlib import Path
from typing import Any, Iterable, Sequence

import torch
from torch import nn

from .constants import RELATION_ENDPOINTS, RELATION_TYPES, RESOURCE_TYPES
from .dataset import iter_jsonl
from .model import HeterogeneousRiskGNN
from .perturb import DEFAULT_EDGE_SEED, EDGE_DESTRUCTION_MODES, perturb_sample, relation_mode_for
from .runtime import sha256_file
from .tensorize import CloudProofTensorizer, GraphBatch, GraphSample, collate_graphs


TAP_KIND = "cloudproof.gnn-viz-tap"
TAP_SCHEMA_VERSION = 1
NORM_DIGITS = 4
RISK_DIGITS = 6
PROBE_VARIANTS = ("A", "B")
PROBE_RULE = (
    "first pair, by sorted pair ID, among the {split} split's relational-only, valid, "
    "trajectory-outcome-discordant counterfactual pairs"
)
VALIDATION_KEYS = ("count", "positiveRate", "auroc", "auprc", "brier", "ece", "nll")


def _rounded(values: Iterable[float], digits: int = NORM_DIGITS) -> list[float]:
    return [round(float(value), digits) for value in values]


def _node_norms(states: dict[str, torch.Tensor]) -> dict[str, list[float]]:
    return {
        node_type: _rounded(torch.linalg.vector_norm(states[node_type], dim=1).tolist())
        for node_type in RESOURCE_TYPES
    }


# ---------------------------------------------------------------------------
# Probe selection
# ---------------------------------------------------------------------------


def select_probe_pair(pairs_path: str | Path, split: str = "test") -> dict[str, dict]:
    """Return ``{"A": record, "B": record}`` for the pair :data:`PROBE_RULE` names.

    The rule reads only corpus construction metadata (split, relational-only,
    validity, trajectory outcome), never a model score, so the probe cannot be
    picked for looking good.
    """
    groups: dict[str, dict[str, dict]] = {}
    for record in iter_jsonl(pairs_path):
        if record.get("split") == split:
            groups.setdefault(record["pairId"], {})[record["variant"]] = record
    for pair_id in sorted(groups):
        pair = groups[pair_id]
        if set(pair) != set(PROBE_VARIANTS):
            continue
        control, treated = pair["A"], pair["B"]
        if not control.get("relationalOnly") or not (control.get("metadata") or {}).get("valid"):
            continue
        if bool(control["labels"]["trajectoryUnsafe"]) == bool(treated["labels"]["trajectoryUnsafe"]):
            continue
        return pair
    raise ValueError(f"no relational-only, valid, discordant pair in the {split} split of {pairs_path}")


def probe_samples(pair: dict[str, dict], tensorizer: CloudProofTensorizer | None = None) -> tuple[GraphSample, ...]:
    tensorizer = tensorizer or CloudProofTensorizer()
    return tuple(tensorizer.tensorize_record(pair[variant], include_label=False) for variant in PROBE_VARIANTS)


def probe_provenance(corpus_directory: str | Path, pair: dict[str, dict], split: str = "test") -> dict[str, Any]:
    """Header fields that pin the probe to the frozen corpus it came from."""
    directory = Path(corpus_directory)
    manifest_file = directory / "manifest.json"
    files = json.loads(manifest_file.read_text(encoding="utf-8")).get("files") or {}
    control = pair["A"]
    return {
        "probe": {
            "pairId": control["pairId"],
            "recordIds": [pair[variant]["recordId"] for variant in PROBE_VARIANTS],
            "rule": PROBE_RULE.format(split=split),
            "split": control["split"],
            "family": control.get("family"),
            "outcomeChange": (control.get("metadata") or {}).get("outcomeChange"),
        },
        "corpus": {
            "name": directory.resolve().name,
            "manifestSha256": sha256_file(manifest_file),
            "files": {
                name: (files.get(name) or {}).get("sha256")
                for name in ("counterfactual-pairs.jsonl", "transitions-train.jsonl", "transitions-validation.jsonl")
            },
        },
    }


# ---------------------------------------------------------------------------
# The tap
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class VizTapSpec:
    """Everything ``train_member`` needs to attach a tap to the model it builds."""

    path: Path
    probe_batch: tuple[GraphSample, ...]
    every: int = 50
    header: dict[str, Any] = field(default_factory=dict)
    append: bool = False

    def attach(self, model: nn.Module, **extra: Any) -> "VizTap":
        return VizTap(
            model,
            self.probe_batch,
            self.path,
            self.every,
            header={**self.header, **extra},
            append=self.append,
        )


class VizTap:
    """Writes one header row on construction and one frame row per :meth:`emit`.

    ``probe_batch`` is the sequence of probe :class:`GraphSample` objects (not a
    collated batch), because each edge-destruction mode is applied per sample
    with ``perturb_sample`` before collation, exactly as Phase II-B.2 scores pairs.
    """

    def __init__(
        self,
        model: nn.Module,
        probe_batch: Sequence[GraphSample],
        path: str | Path,
        every: int = 50,
        *,
        header: dict[str, Any] | None = None,
        append: bool = False,
        edge_seed: int = DEFAULT_EDGE_SEED,
    ) -> None:
        if not isinstance(model, HeterogeneousRiskGNN):
            raise TypeError("the tap observes HeterogeneousRiskGNN message layers")
        if int(every) < 1:
            raise ValueError("every must be a positive number of optimizer steps")
        samples = tuple(probe_batch)
        if not samples:
            raise ValueError("the probe batch is empty")
        self.model = model
        self.every = int(every)
        self.edge_seed = edge_seed
        self.path = Path(path)
        self.batches: dict[str, GraphBatch] = {
            mode: collate_graphs([perturb_sample(sample, mode, edge_seed) for sample in samples])
            for mode in EDGE_DESTRUCTION_MODES
        }
        self.path.parent.mkdir(parents=True, exist_ok=True)
        if not append:
            self.path.write_text("", encoding="utf-8")
        full = self.batches["full"]
        self._write({
            "kind": f"{TAP_KIND}.header",
            "schemaVersion": TAP_SCHEMA_VERSION,
            "everySteps": self.every,
            "edgeSeed": edge_seed,
            "modes": list(EDGE_DESTRUCTION_MODES),
            "relationModes": {mode: relation_mode_for(mode) for mode in EDGE_DESTRUCTION_MODES},
            "model": {
                "architecture": type(model).__name__,
                "config": model.config.to_dict(),
                "parameterCount": sum(parameter.numel() for parameter in model.parameters()),
            },
            "probeRecordIds": list(full.record_ids),
            "probeNodeBatches": {node_type: full.node_batches[node_type].tolist() for node_type in RESOURCE_TYPES},
            "probeTargets": {node_type: full.targets[node_type].tolist() for node_type in RESOURCE_TYPES},
            "probeEdges": {
                mode: {relation: batch.edges[relation].tolist() for relation in RELATION_TYPES}
                for mode, batch in self.batches.items()
            },
            **(header or {}),
        })

    def due(self, step: int) -> bool:
        return step % self.every == 0

    def emit(
        self,
        *,
        step: int,
        epoch: int,
        train_loss: float | None,
        phase: str = "step",
        validation: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        model = self.model
        was_training = model.training
        captured: dict[str, dict[str, dict[int, dict[str, torch.Tensor]]]] = {}
        current = {"mode": "full"}

        def hook_for(index: int):
            def hook(_module, inputs, output):
                record = captured.setdefault(current["mode"], {"inputs": {}, "outputs": {}})
                record["inputs"][index] = inputs[0]
                record["outputs"][index] = output
            return hook

        handles = [layer.register_forward_hook(hook_for(index)) for index, layer in enumerate(model.message_layers)]
        try:
            model.eval()
            with torch.no_grad():
                logits = {}
                for mode in EDGE_DESTRUCTION_MODES:
                    current["mode"] = mode
                    logits[mode] = model(self.batches[mode], relation_mode=relation_mode_for(mode))
                for handle in handles:
                    handle.remove()
                row = self._frame(captured, logits, step, epoch, train_loss, phase, validation)
        finally:
            for handle in handles:
                handle.remove()
            model.train(was_training)
        self._write(row)
        return row

    def _frame(self, captured, logits, step, epoch, train_loss, phase, validation) -> dict[str, Any]:
        layers = list(self.model.message_layers)
        full = captured["full"]
        row: dict[str, Any] = {
            "kind": f"{TAP_KIND}.frame",
            "phase": phase,
            "step": int(step),
            "epoch": int(epoch),
            "trainLoss": None if train_loss is None else round(float(train_loss), 6),
            "embed": _node_norms(full["inputs"][0]),
            "layers": [_node_norms(full["outputs"][index]) for index in range(len(layers))],
            "msg": self._messages(full, "full"),
            "relW": self._relation_weights(),
            "risk": {
                mode: _rounded(torch.sigmoid(logits[mode]).tolist(), RISK_DIGITS)
                for mode in EDGE_DESTRUCTION_MODES
            },
            "ablation": {
                mode: {
                    "layers": [_node_norms(captured[mode]["outputs"][index]) for index in range(len(layers))],
                    "msg": self._messages(captured[mode], mode),
                }
                for mode in EDGE_DESTRUCTION_MODES
                if mode != "full"
            },
        }
        if validation is not None:
            row["validation"] = {
                key: (round(float(validation[key]), 6) if isinstance(validation.get(key), float) else validation.get(key))
                for key in VALIDATION_KEYS
            }
        return row

    def _messages(self, record: dict[str, dict[int, dict[str, torch.Tensor]]], mode: str) -> list[dict[str, dict[str, list[float]]]]:
        """Per-edge message norms, recomputed with the layer's own ``_messages`` on the
        exact inputs the layer saw, in the column order of ``self.batches[mode].edges``."""
        batch = self.batches[mode]
        relation_mode = relation_mode_for(mode)
        result = []
        for index, layer in enumerate(self.model.message_layers):
            states = record["inputs"][index]
            per_relation = {}
            for relation in RELATION_TYPES:
                edge_index = batch.edges[relation]
                skipped = relation == "LOCATED_IN" and not self.model.config.use_zone_relations
                if edge_index.shape[1] == 0 or skipped:
                    per_relation[relation] = {"forward": [], "reverse": []}
                    continue
                source_type, target_type = RELATION_ENDPOINTS[relation]
                forward = layer._messages(
                    layer.forward_transforms, relation, states[source_type][edge_index[0]], relation_mode
                )
                reverse = layer._messages(
                    layer.reverse_transforms, relation, states[target_type][edge_index[1]], relation_mode
                )
                per_relation[relation] = {
                    "forward": _rounded(torch.linalg.vector_norm(forward, dim=1).tolist()),
                    "reverse": _rounded(torch.linalg.vector_norm(reverse, dim=1).tolist()),
                }
            result.append(per_relation)
        return result

    def _relation_weights(self) -> dict[str, dict[str, list[float]]]:
        layers = list(self.model.message_layers)
        names = RELATION_TYPES if self.model.config.use_edge_types else ("shared",)
        with torch.no_grad():
            return {
                name: {
                    direction: [
                        round(float(torch.linalg.matrix_norm(getattr(layer, f"{direction}_transforms")[name].weight)), NORM_DIGITS)
                        for layer in layers
                    ]
                    for direction in ("forward", "reverse")
                }
                for name in names
            }

    def _write(self, row: dict[str, Any]) -> None:
        # One append per row and no long-lived handle, so an interrupted run leaves
        # every completed row on disk and nothing to close.
        with self.path.open("a", encoding="utf-8", newline="\n") as handle:
            handle.write(json.dumps(row, separators=(",", ":"), allow_nan=False) + "\n")


def read_tap(path: str | Path) -> list[dict[str, Any]]:
    """Split a tap file into sections of ``{"header": ..., "frames": [...]}``.

    ``train_ensemble`` appends one section per ensemble member to the same file.
    """
    sections: list[dict[str, Any]] = []
    for row in iter_jsonl(path):
        kind = row.get("kind")
        if kind == f"{TAP_KIND}.header":
            if row.get("schemaVersion") != TAP_SCHEMA_VERSION:
                raise ValueError(f"unsupported tap schema version: {row.get('schemaVersion')}")
            sections.append({"header": row, "frames": []})
        elif kind == f"{TAP_KIND}.frame":
            if not sections:
                raise ValueError("tap frame before any header")
            sections[-1]["frames"].append(row)
        else:
            raise ValueError(f"unknown tap row kind: {kind}")
    return sections
