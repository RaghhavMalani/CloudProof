"""Phase II-B.2 — frozen-corpus graph attribution on the CloudProof causal corpus v2.

Research question: does relational graph structure improve prediction and
deterministic verification prioritization once schedule-construction shortcuts
have been removed?

The module is a driver, not a new model. It verifies the frozen corpus against
its committed freeze record, trains the *unchanged* Phase II-B ensembles (full
heterogeneous GNN, topology-blind pooled MLP, and the same GNN on a predeclared
clock-blind representation) with :func:`ml.cloudproof.train.train_member`,
evaluates them under deterministic edge destruction, scores the relational-only
counterfactual pairs, and writes every result — including a negative one — with
uncertainty. Nothing here tunes a model after seeing test, OOD or pair results.

Sub-commands (run from the repository root)::

    python -m ml.cloudproof.phase_ii_b2 verify   --corpus DIR --freeze FILE --out ROOT
    python -m ml.cloudproof.phase_ii_b2 train    --corpus DIR --freeze FILE --out ROOT
    python -m ml.cloudproof.phase_ii_b2 evaluate --corpus DIR --freeze FILE --out ROOT
    python -m ml.cloudproof.phase_ii_b2 pairs    --corpus DIR --freeze FILE --out ROOT
    python -m ml.cloudproof.phase_ii_b2 report   --corpus DIR --freeze FILE --out ROOT
"""

from __future__ import annotations

import argparse
from collections import Counter, defaultdict
import hashlib
import json
import os
from pathlib import Path
import platform
import subprocess
import sys
import time
from typing import Any, Iterable

import numpy as np
import torch

from .constants import (
    ACTION_TYPES,
    ENSEMBLE_SEEDS,
    NODE_FEATURE_NAMES,
    RELATION_TYPES,
    RESOURCE_TYPES,
    SPLIT_NAMES,
)
from .dataset import CausalCorpusManifest, StreamingGraphDataset, iter_jsonl, label_balance
from .metrics import evaluate_binary_risk, threshold_for_f1
from .model import ModelConfig, build_model, ensemble_predict
from .perturb import DEFAULT_EDGE_SEED, EDGE_DESTRUCTION_MODES, perturb_sample, relation_mode_for
from .runtime import (
    artifact_manifest,
    json_dump,
    load_artifact,
    predict_path,
    sha256_file,
    tensorizer_for_config,
)
from .stats import (
    binomial_two_sided,
    bootstrap_mean,
    cluster_bootstrap,
    fast_auroc,
    mcnemar_exact,
    paired_bootstrap_difference,
    summarize_margins,
    wilson_interval,
)
from .tensorize import CloudProofTensorizer, clock_blind_field_list, collate_graphs
from .train import config_for_ablation, train_member


REPOSITORY = Path(__file__).resolve().parents[2]
PHASE = "II-B.2"
PRIMARY_HORIZON = 5
SECONDARY_HORIZONS = (1, 10, 20)
EVALUATION_SPLITS = ("validation", "test", "ood")

# The Phase II-B model configuration recovered from `ml/cloudproof/train.py` at
# commit b8b2b51 (unchanged for the `full` ablation by the II-B.1 audit commit).
FROZEN_RECIPE = {
    "architecture": "HeterogeneousRiskGNN",
    "hiddenDim": 48,
    "layers": 2,
    "dropout": 0.1,
    "relationHandling": "per-relation forward and reverse linear messages, mean aggregation, LayerNorm + ReLU",
    "actionEncoder": "Linear(ACTION_FEATURE_DIM, 48) + ReLU + Dropout, concatenated with the resolved target-node embedding",
    "pooling": "typed mean pooling over the seven resource types",
    "riskHead": "Linear(9*48, 48) + ReLU + Dropout + Linear(48, 1)",
    "optimizer": "AdamW",
    "learningRate": 1e-3,
    "weightDecay": 1e-4,
    "batchSize": 128,
    "epochs": 20,
    "patience": 4,
    "earlyStoppingMetric": "validation NLL (best checkpoint restored)",
    "gradientClipNorm": 5.0,
    "loss": "BCEWithLogits; pos_weight = negatives/positives when the train positive rate is outside [0.25, 0.75]",
    "shuffleBuffer": 2048,
    "ensembleSeeds": list(ENSEMBLE_SEEDS),
    "normalization": "fixed feature scales inside the tensorizer; LayerNorm per resource type in every relation layer",
    "calibration": "none post hoc; validation is used only for early stopping, checkpoint selection and the F1 threshold report",
    "torchThreads": 1,
    "device": "cpu",
    "deterministicAlgorithms": True,
}
RECIPE_KWARGS = {
    "epochs": 20,
    "patience": 4,
    "learning_rate": 1e-3,
    "weight_decay": 1e-4,
    "batch_size": 128,
    "hidden_dim": 48,
    "layers": 2,
    "dropout": 0.1,
    "shuffle_buffer": 2048,
}

MODEL_FAMILIES = {
    "gnn-full": {
        "ablation": "full",
        "clockBlind": False,
        "role": "full heterogeneous GNN, Phase II-B configuration",
    },
    "pooled-mlp": {
        "ablation": "flat-mlp",
        "clockBlind": False,
        "role": "topology-blind parameter-matched pooled MLP (typed mean/min/max/sum + action)",
    },
    "gnn-clock-blind": {
        "ablation": "full",
        "clockBlind": True,
        "role": "full heterogeneous GNN on the predeclared clock-blind representation",
    },
}
PRIMARY_MODELS = ("gnn-full", "pooled-mlp", "gnn-clock-blind")
GNN_EDGE_MODES = (
    "full",
    "randomized-edges",
    "rewired-edges",
    "no-edges",
    "collapsed-edge-types",
    "random-relation-labels",
)
SEEDED_EDGE_MODES = ("randomized-edges", "rewired-edges")
EDGE_SEEDS = (1729, 2729, 3729)
TIE_TOLERANCE = 1e-6
PAIR_BOOTSTRAP = {"resamples": 10_000, "seed": 20260922}
CLUSTER_BOOTSTRAP = {"resamples": 1_000, "seed": 20260922}
TRAJECTORY_RULE = (
    "trajectory risk = maximum ensemble-mean risk over the trajectory's emitted rows "
    "(rows end at the first incident); label = deterministic trajectory outcome"
)
ATTRIBUTION_CRITERIA = {
    "fullGnnMinimumTieAwareAccuracy": 0.60,
    "fullGnnIntervalMustExcludeChance": True,
    "fullGnnBinomialAlpha": 0.01,
    "pooledMlpChanceBand": [0.40, 0.60],
    "edgeDestructionMinimumDrop": 0.10,
    "edgeDestructionDifferenceIntervalMustExcludeZero": True,
    "clockBlindMinimumTieAwareAccuracy": 0.60,
    "clockBlindIntervalMustExcludeChance": True,
    "tieTolerance": TIE_TOLERANCE,
    "primaryPairSet": "relational-only, valid, trajectory-outcome discordant pairs",
    "primaryAccuracy": "tie-aware pairwise accuracy = (correct + 0.5 * ties) / pairs",
}


def artifact_name(model: str, horizon: int) -> str:
    return f"{model}-k{horizon}"


def model_directory(root: Path, model: str, horizon: int) -> Path:
    return root / "models" / artifact_name(model, horizon)


def tensorizer_for(model: str, horizon: int) -> CloudProofTensorizer:
    family = MODEL_FAMILIES[model]
    return CloudProofTensorizer(
        clock_blind=family["clockBlind"],
        label_horizon=None if horizon == PRIMARY_HORIZON else horizon,
    )


def _repo_relative(path: str | Path) -> str:
    """Record paths relative to the repository so artifacts do not embed a machine path."""
    resolved = Path(path).resolve()
    try:
        return resolved.relative_to(REPOSITORY).as_posix()
    except ValueError:
        return resolved.as_posix()


def _digest_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _sorted_rows(tensor: torch.Tensor) -> list[tuple[float, ...]]:
    return sorted(tuple(row) for row in tensor.tolist())


def _git_state() -> dict[str, Any]:
    def run(*arguments: str) -> str | None:
        try:
            completed = subprocess.run(
                ["git", *arguments], cwd=REPOSITORY, capture_output=True, text=True, check=False
            )
        except OSError:
            return None
        return completed.stdout.rstrip("\r\n") if completed.returncode == 0 else None

    status = run("status", "--porcelain")
    dirty = [] if not status else sorted(line[3:] for line in status.splitlines() if line.strip())
    return {
        "commitSha": (run("rev-parse", "HEAD") or "").strip() or None,
        "branch": (run("rev-parse", "--abbrev-ref", "HEAD") or "").strip() or None,
        "worktreeClean": not dirty,
        "dirtyPaths": dirty,
    }


def _environment() -> dict[str, Any]:
    return {
        "python": sys.version.split()[0],
        "torch": torch.__version__,
        "numpy": np.__version__,
        "platform": platform.platform(),
        "processor": platform.processor(),
        "cpuCount": os.cpu_count(),
        "cudaAvailable": bool(torch.cuda.is_available()),
        "device": "cpu",
    }


# ---------------------------------------------------------------------------
# Frozen-corpus verification
# ---------------------------------------------------------------------------


def _pair_groups(path: Path) -> dict[str, dict[str, dict]]:
    grouped: dict[str, dict[str, dict]] = {}
    for record in iter_jsonl(path):
        grouped.setdefault(record["pairId"], {})[record["variant"]] = record
    return grouped


def _riskier_variant(pair: dict[str, dict]) -> str | None:
    unsafe_a = bool(pair["A"]["labels"]["trajectoryUnsafe"])
    unsafe_b = bool(pair["B"]["labels"]["trajectoryUnsafe"])
    if unsafe_a == unsafe_b:
        return None
    return "B" if unsafe_b else "A"


def _relational_pair_checks(
    pair_id: str,
    pair: dict[str, dict],
    tensorizer: CloudProofTensorizer,
    *,
    require_relation_difference: bool,
) -> bool:
    """Assert identical pooled inputs; return whether any relation tensor differs.

    A concordant readiness pair whose starting pods all became ready during the
    quiet prefix is byte-identical at the intervention row, so relation tensors
    can legitimately coincide there. A *discordant* pair can never coincide: the
    simulator is deterministic, so identical states would give identical outcomes.
    """
    control = tensorizer.tensorize_record(pair["A"], include_label=False)
    treated = tensorizer.tensorize_record(pair["B"], include_label=False)
    for node_type in RESOURCE_TYPES:
        if _sorted_rows(control.node_features[node_type]) != _sorted_rows(treated.node_features[node_type]):
            raise ValueError(f"{pair_id}: pooled {node_type} inputs differ between members")
    if not torch.equal(control.action_features, treated.action_features):
        raise ValueError(f"{pair_id}: action features differ between members")
    relations_differ = any(
        not torch.equal(control.edges[relation], treated.edges[relation]) for relation in RELATION_TYPES
    )
    if require_relation_difference and not relations_differ:
        raise ValueError(f"{pair_id}: discordant relational-only pair has identical relation tensors")
    for variant in ("A", "B"):
        metadata = pair[variant]["metadata"]
        if metadata.get("pooledInputsIdentical") is not True or metadata.get("flatSummaryIdentical") is not True:
            raise ValueError(f"{pair_id}: relational-only pair lost its identical-input flags")
    return relations_differ


def verify_corpus(corpus_directory: str | Path, freeze_path: str | Path, *, sample_rows: int = 200) -> dict:
    """Independently verify the frozen corpus; raise on any drift from the freeze record."""
    started = time.perf_counter()
    manifest = CausalCorpusManifest(corpus_directory)
    verified = manifest.verify_hashes()
    freeze_report = manifest.verify_freeze(freeze_path, verified)
    freeze = json.loads(Path(freeze_path).read_text(encoding="utf-8"))
    topology_splits = manifest.topology_splits()
    tensorizer = CloudProofTensorizer()

    split_reports: dict[str, dict[str, Any]] = {}
    trajectories_by_split: dict[str, set[str]] = {}
    record_ids: set[str] = set()
    for split in SPLIT_NAMES:
        rows = 0
        positives = Counter()
        outcomes = Counter()
        trajectories: set[str] = set()
        sample: list[dict] = []
        for record in iter_jsonl(manifest.path_for(split)):
            rows += 1
            if record.get("split") != split:
                raise ValueError(f"{split}: row {record.get('recordId')} carries split {record.get('split')!r}")
            topology = record.get("topologyId")
            if topology_splits.get(topology) != split:
                raise ValueError(f"{split}: topology {topology} does not belong to this split")
            if "nextState" in record:
                raise ValueError(f"{split}: row {record.get('recordId')} carries nextState")
            labels = record.get("labels") or {}
            horizons = labels.get("horizons") or {}
            if sorted(horizons, key=int) != ["1", "5", "10", "20"]:
                raise ValueError(f"{split}: row {record.get('recordId')} lacks the four horizon labels")
            if bool(labels.get("sloViolationWithinKTransitions")) != bool(horizons["5"]):
                raise ValueError(f"{split}: K=5 label disagrees with sloViolationWithinKTransitions")
            if labels.get("labelHorizonTransitions") != PRIMARY_HORIZON:
                raise ValueError(f"{split}: labelHorizonTransitions is not {PRIMARY_HORIZON}")
            record_id = record.get("recordId")
            if record_id in record_ids:
                raise ValueError(f"duplicate record ID {record_id}")
            record_ids.add(record_id)
            trajectories.add(record["trajectoryId"])
            outcomes[(record.get("metadata") or {}).get("trajectoryOutcome")] += 1
            for horizon, value in horizons.items():
                positives[horizon] += int(bool(value))
            if len(sample) < sample_rows:
                sample.append(record)
        expected_rows = freeze["counts"]["rowsBySplit"][split]
        if rows != expected_rows:
            raise ValueError(f"{split}: {rows} rows, freeze record says {expected_rows}")
        # Tensorization must be a pure function of the row: two passes agree exactly.
        for record in sample:
            left = tensorizer.tensorize_record(record)
            right = tensorizer.tensorize_record(json.loads(json.dumps(record)))
            if any(not torch.equal(left.node_features[t], right.node_features[t]) for t in RESOURCE_TYPES):
                raise ValueError(f"{split}: tensorization is not deterministic for {record.get('recordId')}")
            if any(not torch.equal(left.edges[r], right.edges[r]) for r in RELATION_TYPES):
                raise ValueError(f"{split}: edge tensorization is not deterministic for {record.get('recordId')}")
            if not torch.equal(left.action_features, right.action_features) or left.label != right.label:
                raise ValueError(f"{split}: action/label tensorization is not deterministic")
        trajectories_by_split[split] = trajectories
        split_reports[split] = {
            "rows": rows,
            "trajectories": len(trajectories),
            "trajectoryOutcomes": dict(sorted(outcomes.items())),
            "positivesByHorizon": {key: positives[key] for key in ("1", "5", "10", "20")},
            "positiveRateK5": positives["5"] / rows if rows else None,
            "tensorizationSampleChecked": len(sample),
        }
    for left in SPLIT_NAMES:
        for right in SPLIT_NAMES:
            if left < right and trajectories_by_split[left] & trajectories_by_split[right]:
                raise ValueError(f"trajectory IDs overlap between {left} and {right}")
    catalog_by_split = defaultdict(set)
    for topology, split in topology_splits.items():
        catalog_by_split[split].add(topology)
    for left in SPLIT_NAMES:
        for right in SPLIT_NAMES:
            if left < right and catalog_by_split[left] & catalog_by_split[right]:
                raise ValueError(f"topology IDs overlap between {left} and {right}")

    trajectory_total = 0
    selected = Counter()
    held_out = Counter()
    selected_ids_by_split: dict[str, set[str]] = defaultdict(set)
    for trajectory in iter_jsonl(manifest.auxiliary_path("trajectories")):
        trajectory_total += 1
        if not trajectory.get("selected"):
            continue
        selected[trajectory["outcome"]] += 1
        selected_ids_by_split[trajectory["split"]].add(trajectory["trajectoryId"])
        if trajectory["split"] != "train":
            held_out["schedules"] += 1
            held_out["counterexamples"] += int(trajectory["outcome"] == "unsafe")
    if trajectory_total != freeze["counts"]["pool"]:
        raise ValueError(f"trajectory pool has {trajectory_total} entries, freeze says {freeze['counts']['pool']}")
    if selected["safe"] != freeze["counts"]["selectedSafe"] or selected["unsafe"] != freeze["counts"]["selectedUnsafe"]:
        raise ValueError("selected trajectory counts differ from the freeze record")
    for split in SPLIT_NAMES:
        if not trajectories_by_split[split] <= selected_ids_by_split[split]:
            raise ValueError(f"{split}: transition rows reference unselected trajectories")

    pairs = _pair_groups(manifest.auxiliary_path("pairs"))
    pair_counts = Counter()
    relational = Counter()
    families = Counter()
    relational_flip_ids: list[str] = []
    flips_by_split = Counter()
    converged_by_family = Counter()
    for pair_id, pair in pairs.items():
        if set(pair) != {"A", "B"}:
            raise ValueError(f"{pair_id}: incomplete pair")
        a, b = pair["A"], pair["B"]
        for key in ("split", "topologyId", "family", "relationalOnly", "sharedExogenousScheduleDigest"):
            if a.get(key) != b.get(key):
                raise ValueError(f"{pair_id}: members disagree on {key}")
        if a["schedule"]["actions"] != b["schedule"]["actions"]:
            raise ValueError(f"{pair_id}: members do not share the exogenous schedule")
        if topology_splits.get(a["topologyId"]) != a["split"]:
            raise ValueError(f"{pair_id}: pair split does not match the topology catalog")
        pair_counts["total"] += 1
        valid = bool(a["metadata"]["valid"])
        pair_counts["valid" if valid else "invalid"] += 1
        change = a["metadata"]["outcomeChange"]
        pair_counts[change] += 1
        riskier = _riskier_variant(pair) if valid else None
        if valid and (riskier is not None) != bool(a["metadata"]["discordant"]):
            raise ValueError(f"{pair_id}: discordant flag disagrees with the trajectory labels")
        if a["relationalOnly"] and valid:
            relational["valid"] += 1
            relations_differ = _relational_pair_checks(
                pair_id, pair, tensorizer, require_relation_difference=riskier is not None
            )
            relational["relationTensorsDiffer"] += int(relations_differ)
            if not relations_differ:
                converged_by_family[a["family"]] += 1
            families[a["family"]] += 0
            if riskier is not None:
                relational["discordant"] += 1
                relational[change] += 1
                families[a["family"]] += 1
                flips_by_split[a["split"]] += 1
                relational_flip_ids.append(f"{pair_id}:{a['family']}:{change}:{riskier}")
    frozen_pairs = freeze["sanity"]["counterfactualPairs"]
    if pair_counts["total"] != frozen_pairs["counts"]["total"] or pair_counts["valid"] != frozen_pairs["counts"]["valid"]:
        raise ValueError("pair counts differ from the freeze record")
    if relational["valid"] != frozen_pairs["relationalOnly"]["validPairs"]:
        raise ValueError("relational-only valid pair count differs from the freeze record")
    if relational["discordant"] != frozen_pairs["relationalOnly"]["discordantPairs"]:
        raise ValueError("relational-only discordant pair count differs from the freeze record")
    for family, count in families.items():
        expected = (frozen_pairs["families"].get(family) or {}).get("discordant")
        if expected is not None and count != expected:
            raise ValueError(f"{family}: {count} relational flips, freeze says {expected}")

    report = {
        "kind": "cloudproof.phase-ii-b2-frozen-corpus-verification",
        "schemaVersion": 1,
        "phase": PHASE,
        "corpus": _repo_relative(manifest.directory),
        "freeze": freeze_report,
        "manifest": {
            "kind": manifest.value["kind"],
            "schemaVersion": manifest.value["schemaVersion"],
            "splitPolicy": manifest.value["splitPolicy"],
            "generatorCommitSha": manifest.value["generator"]["commitSha"],
            "label": manifest.value["label"],
            "featureBoundary": manifest.value["features"]["boundary"],
        },
        "splits": split_reports,
        "splitIntegrity": {
            "trajectoryIdsDisjoint": True,
            "topologyIdsDisjoint": True,
            "rowSplitFieldsMatchFiles": True,
            "rowTopologiesMatchCatalog": True,
            "rowsReferenceSelectedTrajectories": True,
            "topologiesBySplit": {split: len(catalog_by_split[split]) for split in SPLIT_NAMES},
        },
        "trajectories": {
            "pool": trajectory_total,
            "selectedSafe": selected["safe"],
            "selectedUnsafe": selected["unsafe"],
            "selectedBySplit": {split: len(selected_ids_by_split[split]) for split in SPLIT_NAMES},
            "heldOutSchedules": held_out["schedules"],
            "heldOutCounterexamples": held_out["counterexamples"],
        },
        "pairs": {
            "total": pair_counts["total"],
            "valid": pair_counts["valid"],
            "invalid": pair_counts["invalid"],
            "sameOutcome": pair_counts["same"],
            "safeToUnsafe": pair_counts["safe->unsafe"],
            "unsafeToSafe": pair_counts["unsafe->safe"],
            "relationalOnly": {
                "validPairs": relational["valid"],
                "pooledInputsIdenticalVerifiedAtTensorLevel": relational["valid"],
                "relationTensorsDiffer": relational["relationTensorsDiffer"],
                "stateConvergedConcordantPairs": {
                    "count": relational["valid"] - relational["relationTensorsDiffer"],
                    "byFamily": dict(sorted(converged_by_family.items())),
                    "note": "byte-identical members at the intervention row (starting pods became ready during the prefix); all concordant",
                },
                "discordantPairsRelationTensorsDiffer": relational["discordant"],
                "discordantPairs": relational["discordant"],
                "safeToUnsafe": relational["safe->unsafe"],
                "unsafeToSafe": relational["unsafe->safe"],
                "discordantByFamily": dict(sorted(families.items())),
                "discordantBySplit": dict(sorted(flips_by_split.items())),
                "discordantPairDigest": _digest_text("\n".join(sorted(relational_flip_ids))),
            },
        },
        "labelContract": {
            "primaryLabel": "labels.sloViolationWithinKTransitions == labels.horizons['5']",
            "verifiedRows": sum(item["rows"] for item in split_reports.values()),
        },
        "passed": True,
        "elapsedSeconds": time.perf_counter() - started,
    }
    return report


# ---------------------------------------------------------------------------
# Training (one process per ensemble member; the recipe is train.py's)
# ---------------------------------------------------------------------------


def _training_plan(model: str, horizon: int, args: argparse.Namespace) -> dict[str, Any]:
    family = MODEL_FAMILIES[model]
    return {
        "model": model,
        "horizon": horizon,
        "ablation": family["ablation"],
        "clockBlind": family["clockBlind"],
        "epochs": args.epochs,
        "patience": args.patience,
        "maxTrainRecords": args.max_train_records,
        "maxValidationRecords": args.max_validation_records,
    }


def _verify_split_files(manifest: CausalCorpusManifest, expected: dict[str, str]) -> None:
    for split, digest in expected.items():
        actual = sha256_file(manifest.path_for(split))
        if actual != digest:
            raise ValueError(f"{split} split changed since the orchestrator verified it: {actual} != {digest}")


def train_member_command(args: argparse.Namespace) -> None:
    torch.set_num_threads(args.threads)
    manifest = CausalCorpusManifest(args.corpus)
    expected = {"train": args.train_digest, "validation": args.validation_digest}
    _verify_split_files(manifest, expected)
    horizon = args.horizon
    tensorizer = tensorizer_for(args.model, horizon)
    model_config = config_for_ablation(
        MODEL_FAMILIES[args.model]["ablation"], args.hidden_dim, args.layers, args.dropout
    )
    started = time.perf_counter()
    model, member = train_member(
        seed=args.seed,
        config=model_config,
        train_path=manifest.path_for("train"),
        validation_path=manifest.path_for("validation"),
        epochs=args.epochs,
        patience=args.patience,
        learning_rate=args.learning_rate,
        weight_decay=args.weight_decay,
        batch_size=args.batch_size,
        shuffle_buffer=args.shuffle_buffer,
        pos_weight=args.pos_weight,
        max_train_records=args.max_train_records,
        max_validation_records=args.max_validation_records,
        device="cpu",
        tensorizer=tensorizer,
    )
    elapsed = time.perf_counter() - started
    output = Path(args.out)
    output.mkdir(parents=True, exist_ok=True)
    torch.save(model.state_dict(), output / f"member-{args.index}.pt")
    member.update({
        "index": args.index,
        "model": args.model,
        "horizon": horizon,
        "trainingSeconds": elapsed,
        "torchThreads": args.threads,
        "tensorizer": tensorizer.describe(),
        "posWeight": args.pos_weight,
        "splitDigests": expected,
        "pid": os.getpid(),
    })
    json_dump(output / f"member-{args.index}.json", member)
    print(json.dumps({"member": args.index, "model": args.model, "horizon": horizon,
                      "bestEpoch": member["bestEpoch"], "seconds": round(elapsed, 1)}))


def _artifact_config(
    *,
    manifest: CausalCorpusManifest,
    model: str,
    horizon: int,
    model_config: ModelConfig,
    balance,
    pos_weight: float,
    args: argparse.Namespace,
) -> dict[str, Any]:
    family = MODEL_FAMILIES[model]
    tensorizer = tensorizer_for(model, horizon)
    loss_is_weighted = balance.positive_rate < 0.25 or balance.positive_rate > 0.75
    return {
        "kind": "cloudproof.gnn-risk-model-config",
        "schemaVersion": 1,
        "phase": PHASE,
        "task": f"P(SLO violation within next K={horizon} transitions)",
        "ablation": family["ablation"],
        "modelFamily": model,
        "role": family["role"],
        "horizon": horizon,
        "primaryHorizon": horizon == PRIMARY_HORIZON,
        "featureTransform": {
            "clockBlind": family["clockBlind"],
            "maskedFields": clock_blind_field_list() if family["clockBlind"] else [],
        },
        "labelField": tensorizer.describe()["labelField"],
        "model": model_config.to_dict(),
        "ensembleSeeds": list(ENSEMBLE_SEEDS),
        "resourceTypes": list(RESOURCE_TYPES),
        "relationTypes": list(RELATION_TYPES),
        "actionTypes": list(ACTION_TYPES),
        "nodeFeatureNames": {key: list(value) for key, value in NODE_FEATURE_NAMES.items()},
        "leakageExclusions": [
            "identifiers",
            "topology labels",
            "split labels",
            "scenario/trajectory/pair identifiers",
            "nextState",
            "trajectory outcomes",
            "failure classes",
            "transitions-to-failure",
            "horizon labels other than the target label",
            "nuisance and matching metadata",
            "counterfactual pair labels and membership",
        ],
        "parameterCount": sum(parameter.numel() for parameter in build_model(model_config).parameters()),
        "labelControl": "observed",
        "dataset": manifest.artifact_contract(),
        "training": {
            "epochs": args.epochs,
            "patience": args.patience,
            "learningRate": args.learning_rate,
            "weightDecay": args.weight_decay,
            "batchSize": args.batch_size,
            "shuffleBuffer": args.shuffle_buffer,
            "maxTrainRecords": args.max_train_records,
            "maxValidationRecords": args.max_validation_records,
            "transitionLabelBalance": balance.to_dict(),
            "loss": "weighted-bce" if loss_is_weighted else "bce",
            "positiveWeight": pos_weight,
            "device": "cpu",
            "hashesVerified": True,
            "torchThreads": args.threads,
            "labelPermutationSeed": None,
            "validationSelectionLabels": "observed",
            "modelSelection": "train only; validation for early stopping and checkpoint selection; test/OOD untouched",
            "memberProcesses": "one process per seed, identical to sequential training",
        },
        "frozenRecipe": FROZEN_RECIPE,
    }


def _assemble_artifact(directory: Path, config: dict[str, Any], manifest: CausalCorpusManifest, args: argparse.Namespace) -> dict:
    members = []
    for index, _seed in enumerate(config["ensembleSeeds"]):
        member_file = directory / f"member-{index}.json"
        weights = directory / f"member-{index}.pt"
        if not member_file.is_file() or not weights.is_file():
            raise FileNotFoundError(f"member {index} of {directory.name} is missing")
        members.append(json.loads(member_file.read_text(encoding="utf-8")))
    json_dump(directory / "config.json", config)
    _config, models = load_artifact(directory, "cpu")
    tensorizer = tensorizer_for_config(config, None if config["horizon"] == PRIMARY_HORIZON else config["horizon"])
    labels, risks, uncertainties, _ids = predict_path(
        models,
        manifest.path_for("validation"),
        batch_size=args.batch_size,
        max_records=args.max_validation_records,
        tensorizer=tensorizer,
    )
    validation = evaluate_binary_risk(labels, risks)
    validation["thresholdSelection"] = threshold_for_f1(labels, risks)
    validation["meanUncertainty"] = float(np.mean(uncertainties))
    metrics = {
        "kind": "cloudproof.gnn-risk-model-training-metrics",
        "schemaVersion": 1,
        "phase": PHASE,
        "ablation": config["ablation"],
        "modelFamily": config["modelFamily"],
        "horizon": config["horizon"],
        "labelControl": "observed",
        "members": [
            {key: value for key, value in member.items() if key != "splitDigests"} for member in members
        ],
        "trainingSecondsTotal": sum(member["trainingSeconds"] for member in members),
        "validation": validation,
        "test": None,
        "ood": None,
    }
    json_dump(directory / "metrics.json", metrics)
    json_dump(directory / "manifest.json", artifact_manifest(directory, config))
    return metrics


def _run_subprocesses(commands: list[list[str]], concurrency: int, label: str) -> None:
    pending = list(commands)
    running: list[tuple[subprocess.Popen, list[str]]] = []
    failures: list[str] = []
    while pending or running:
        while pending and len(running) < concurrency:
            command = pending.pop(0)
            running.append((subprocess.Popen(command, cwd=REPOSITORY), command))
        time.sleep(2.0)
        still_running = []
        for process, command in running:
            code = process.poll()
            if code is None:
                still_running.append((process, command))
            elif code != 0:
                failures.append(" ".join(command[-8:]))
        running = still_running
        if failures:
            for process, _command in running:
                process.terminate()
            raise RuntimeError(f"{label}: {len(failures)} process(es) failed: {failures[:3]}")


def train_command(args: argparse.Namespace) -> None:
    root = Path(args.out)
    manifest = CausalCorpusManifest(args.corpus)
    verified = manifest.verify_hashes()
    manifest.verify_freeze(args.freeze, verified)
    models = [item for item in args.models.split(",") if item]
    horizons = [int(item) for item in args.horizons.split(",") if item]
    for model in models:
        if model not in MODEL_FAMILIES:
            raise ValueError(f"unknown model family: {model}")
    train_digest = verified["transitions-train.jsonl"]
    validation_digest = verified["transitions-validation.jsonl"]
    balances = {
        horizon: label_balance(
            manifest.path_for("train"),
            args.max_train_records,
            None if horizon == PRIMARY_HORIZON else horizon,
        )
        for horizon in horizons
    }
    commands: list[list[str]] = []
    configs: dict[Path, dict[str, Any]] = {}
    for horizon in horizons:
        balance = balances[horizon]
        if balance.positive == 0 or balance.negative == 0:
            raise ValueError(f"K={horizon}: training data must contain both labels")
        heavily_imbalanced = balance.positive_rate < 0.25 or balance.positive_rate > 0.75
        pos_weight = balance.negative / balance.positive if heavily_imbalanced else 1.0
        for model in models:
            directory = model_directory(root, model, horizon)
            directory.mkdir(parents=True, exist_ok=True)
            model_config = config_for_ablation(
                MODEL_FAMILIES[model]["ablation"], args.hidden_dim, args.layers, args.dropout
            )
            configs[directory] = _artifact_config(
                manifest=manifest, model=model, horizon=horizon, model_config=model_config,
                balance=balance, pos_weight=pos_weight, args=args,
            )
            json_dump(directory / "config.json", configs[directory])
            for index, seed in enumerate(ENSEMBLE_SEEDS):
                if (directory / f"member-{index}.pt").is_file() and (directory / f"member-{index}.json").is_file() and not args.retrain:
                    continue
                commands.append([
                    sys.executable, "-m", "ml.cloudproof.phase_ii_b2", "train-member",
                    "--corpus", str(args.corpus), "--out", str(directory),
                    "--model", model, "--horizon", str(horizon),
                    "--seed", str(seed), "--index", str(index),
                    "--pos-weight", repr(pos_weight),
                    "--train-digest", train_digest, "--validation-digest", validation_digest,
                    "--epochs", str(args.epochs), "--patience", str(args.patience),
                    "--learning-rate", repr(args.learning_rate), "--weight-decay", repr(args.weight_decay),
                    "--batch-size", str(args.batch_size), "--hidden-dim", str(args.hidden_dim),
                    "--layers", str(args.layers), "--dropout", repr(args.dropout),
                    "--shuffle-buffer", str(args.shuffle_buffer), "--threads", str(args.threads),
                    *(["--max-train-records", str(args.max_train_records)] if args.max_train_records else []),
                    *(["--max-validation-records", str(args.max_validation_records)] if args.max_validation_records else []),
                ])
    print(json.dumps({"memberProcesses": len(commands), "concurrency": args.concurrency,
                      "models": models, "horizons": horizons}))
    started = time.perf_counter()
    _run_subprocesses(commands, args.concurrency, "train-member")
    summary = {}
    for directory, config in configs.items():
        metrics = _assemble_artifact(directory, config, manifest, args)
        summary[directory.name] = {
            "validationAuroc": metrics["validation"]["auroc"],
            "validationNll": metrics["validation"]["nll"],
            "bestEpochs": [member["bestEpoch"] for member in metrics["members"]],
            "trainingSecondsTotal": metrics["trainingSecondsTotal"],
        }
    # Merge rather than overwrite: separate invocations (K = 5, then the
    # secondary horizons, then any resume) each add their artifacts and a run.
    summary_path = root / "training-summary.json"
    previous = _read_json(summary_path) or {}
    merged = dict(previous.get("artifacts") or {})
    merged.update(summary)
    runs = list(previous.get("runs") or [])
    runs.append({
        "models": models,
        "horizons": horizons,
        "memberProcessesLaunched": len(commands),
        "concurrency": args.concurrency,
        "wallSeconds": time.perf_counter() - started,
        "completed": True,
    })
    json_dump(summary_path, {
        "kind": "cloudproof.phase-ii-b2-training-summary",
        "schemaVersion": 2,
        "runs": runs,
        "artifacts": dict(sorted(merged.items())),
    })
    print(json.dumps(summary, indent=2))


# ---------------------------------------------------------------------------
# Evaluation on validation / test / OOD under edge destruction
# ---------------------------------------------------------------------------


def _prediction_file(root: Path, artifact: str, mode: str, seed: int) -> Path:
    return root / "predictions" / artifact / f"{mode}-{seed}.jsonl"


def evaluate_one_command(args: argparse.Namespace) -> None:
    torch.set_num_threads(args.threads)
    manifest = CausalCorpusManifest(args.corpus)
    directory = Path(args.model_dir)
    config, models = load_artifact(directory, "cpu")
    tensorizer = tensorizer_for_config(config)
    destination = Path(args.out)
    destination.parent.mkdir(parents=True, exist_ok=True)
    started = time.perf_counter()
    with destination.open("w", encoding="utf-8", newline="\n") as handle:
        for split in EVALUATION_SPLITS:
            _labels, risks, uncertainties, ids = predict_path(
                models,
                manifest.path_for(split),
                batch_size=args.batch_size,
                max_records=args.max_records,
                edge_mode=args.edge_mode,
                edge_seed=args.edge_seed,
                tensorizer=tensorizer,
            )
            for record_id, risk, uncertainty in zip(ids, risks, uncertainties, strict=True):
                handle.write(json.dumps(
                    {"split": split, "recordId": record_id, "risk": risk, "uncertainty": uncertainty},
                    separators=(",", ":"),
                ) + "\n")
    print(json.dumps({"artifact": directory.name, "mode": args.edge_mode, "seed": args.edge_seed,
                      "seconds": round(time.perf_counter() - started, 1)}))


def _row_metadata(manifest: CausalCorpusManifest, max_records: int | None) -> dict[str, dict[str, dict]]:
    metadata: dict[str, dict[str, dict]] = {}
    for split in EVALUATION_SPLITS:
        rows: dict[str, dict] = {}
        for index, record in enumerate(iter_jsonl(manifest.path_for(split))):
            if max_records is not None and index >= max_records:
                break
            labels = record["labels"]
            rows[record["recordId"]] = {
                "trajectoryId": record["trajectoryId"],
                "horizons": {key: bool(value) for key, value in labels["horizons"].items()},
                "unsafe": (record.get("metadata") or {}).get("trajectoryOutcome") == "unsafe",
                "tier": (record.get("metadata") or {}).get("difficultyTier"),
            }
        metadata[split] = rows
    return metadata


def _load_predictions(path: Path) -> dict[str, list[tuple[str, float, float]]]:
    grouped: dict[str, list[tuple[str, float, float]]] = defaultdict(list)
    for row in iter_jsonl(path):
        grouped[row["split"]].append((row["recordId"], float(row["risk"]), float(row["uncertainty"])))
    return grouped


def _split_metrics(rows: dict[str, dict], predictions: list[tuple[str, float, float]], horizon: str, *, bootstrap: bool) -> dict:
    if not predictions:
        return {"count": 0, "auroc": None, "auprc": None, "brier": None, "ece": None, "nll": None}
    labels = []
    risks = []
    clusters = []
    uncertainties = []
    for record_id, risk, uncertainty in predictions:
        row = rows[record_id]
        labels.append(float(row["horizons"][horizon]))
        risks.append(risk)
        uncertainties.append(uncertainty)
        clusters.append(row["trajectoryId"])
    metrics = evaluate_binary_risk(labels, risks)
    metrics["meanUncertainty"] = float(np.mean(uncertainties))
    metrics["trajectories"] = len(set(clusters))
    if bootstrap:
        metrics["aurocTrajectoryBootstrap95"] = cluster_bootstrap(
            labels, risks, clusters, fast_auroc, **CLUSTER_BOOTSTRAP
        )
    return metrics


def _trajectory_metrics(rows: dict[str, dict], predictions: list[tuple[str, float, float]], *, bootstrap: bool) -> dict:
    if not predictions:
        return {"count": 0, "auroc": None, "auprc": None, "brier": None, "rule": TRAJECTORY_RULE}
    maximum: dict[str, float] = {}
    outcome: dict[str, bool] = {}
    tiers: dict[str, Any] = {}
    for record_id, risk, _uncertainty in predictions:
        row = rows[record_id]
        trajectory = row["trajectoryId"]
        maximum[trajectory] = max(maximum.get(trajectory, 0.0), risk)
        outcome[trajectory] = row["unsafe"]
        tiers[trajectory] = row["tier"]
    ordered = sorted(maximum)
    labels = [float(outcome[item]) for item in ordered]
    scores = [maximum[item] for item in ordered]
    metrics = evaluate_binary_risk(labels, scores)
    metrics.pop("calibration", None)
    metrics["rule"] = TRAJECTORY_RULE
    metrics["unsafeByTier"] = dict(sorted(Counter(str(tiers[item]) for item in ordered if outcome[item]).items()))
    if bootstrap:
        metrics["aurocBootstrap95"] = cluster_bootstrap(labels, scores, ordered, fast_auroc, **CLUSTER_BOOTSTRAP)
    return metrics


def _artifact_summaries(root: Path, artifacts: list[str]) -> dict[str, dict]:
    summaries = {}
    for artifact in artifacts:
        directory = root / "models" / artifact
        config = json.loads((directory / "config.json").read_text(encoding="utf-8"))
        metrics = json.loads((directory / "metrics.json").read_text(encoding="utf-8"))
        summaries[artifact] = {
            "modelFamily": config["modelFamily"],
            "ablation": config["ablation"],
            "horizon": config["horizon"],
            "featureTransform": config["featureTransform"],
            "parameterCount": config["parameterCount"],
            "members": [
                {"seed": member["seed"], "bestEpoch": member["bestEpoch"], "bestValidationNll": member["bestValidationNll"],
                 "trainingSeconds": member["trainingSeconds"]}
                for member in metrics["members"]
            ],
        }
    return summaries


def _mode_plan(family: str, horizon: int = PRIMARY_HORIZON) -> list[tuple[str, int]]:
    """Edge-destruction plan: every mode for primary-horizon GNNs, plain scoring otherwise."""
    if family == "pooled-mlp" or horizon != PRIMARY_HORIZON:
        return [("full", DEFAULT_EDGE_SEED)]
    plan = []
    for mode in GNN_EDGE_MODES:
        if mode in SEEDED_EDGE_MODES:
            plan.extend((mode, seed) for seed in EDGE_SEEDS)
        else:
            plan.append((mode, DEFAULT_EDGE_SEED))
    return plan


def _artifacts_present(root: Path, requested: list[str] | None) -> list[str]:
    names = []
    for directory in sorted((root / "models").iterdir()) if (root / "models").is_dir() else []:
        if (directory / "manifest.json").is_file() and (directory / "member-0.pt").is_file():
            names.append(directory.name)
    if requested:
        missing = [name for name in requested if name not in names]
        if missing:
            raise FileNotFoundError(f"missing trained artifacts: {missing}")
        return requested
    return names


def evaluate_command(args: argparse.Namespace) -> None:
    root = Path(args.out)
    manifest = CausalCorpusManifest(args.corpus)
    verified = manifest.verify_hashes()
    manifest.verify_freeze(args.freeze, verified)
    artifacts = _artifacts_present(root, [item for item in args.artifacts.split(",") if item] if args.artifacts else None)
    summaries = _artifact_summaries(root, artifacts)
    commands = []
    plans: dict[str, list[tuple[str, int]]] = {}
    for artifact in artifacts:
        plans[artifact] = _mode_plan(summaries[artifact]["modelFamily"], summaries[artifact]["horizon"])
        for mode, seed in plans[artifact]:
            output = _prediction_file(root, artifact, mode, seed)
            if output.is_file() and not args.repredict:
                continue
            commands.append([
                sys.executable, "-m", "ml.cloudproof.phase_ii_b2", "evaluate-one",
                "--corpus", str(args.corpus), "--model-dir", str(root / "models" / artifact),
                "--edge-mode", mode, "--edge-seed", str(seed), "--out", str(output),
                "--batch-size", str(args.batch_size), "--threads", "1",
                *(["--max-records", str(args.max_records)] if args.max_records else []),
            ])
    print(json.dumps({"predictionProcesses": len(commands), "concurrency": args.concurrency}))
    _run_subprocesses(commands, args.concurrency, "evaluate-one")

    rows = _row_metadata(manifest, args.max_records)
    metrics: dict[str, Any] = {}
    trajectory: dict[str, Any] = {}
    ablations: dict[str, Any] = {}
    for artifact in artifacts:
        summary = summaries[artifact]
        horizon = str(summary["horizon"])
        per_mode: dict[str, Any] = {}
        per_mode_trajectory: dict[str, Any] = {}
        for mode, seed in plans[artifact]:
            predictions = _load_predictions(_prediction_file(root, artifact, mode, seed))
            key = mode if mode not in SEEDED_EDGE_MODES else f"{mode}@{seed}"
            per_mode[key] = {
                split: _split_metrics(rows[split], predictions[split], horizon, bootstrap=(mode == "full"))
                for split in EVALUATION_SPLITS
            }
            per_mode_trajectory[key] = {
                split: _trajectory_metrics(rows[split], predictions[split], bootstrap=(mode == "full"))
                for split in EVALUATION_SPLITS
            }
            if mode == "full":
                per_mode[key]["secondaryHorizons"] = {
                    other: {
                        split: {
                            metric: value
                            for metric, value in _split_metrics(rows[split], predictions[split], other, bootstrap=False).items()
                            if metric in {"count", "positiveRate", "auroc", "auprc", "brier", "ece", "nll"}
                        }
                        for split in EVALUATION_SPLITS
                    }
                    for other in ("1", "5", "10", "20")
                    if other != horizon
                }
        metrics[artifact] = {**summary, "labelHorizon": summary["horizon"], "full": per_mode["full"]}
        trajectory[artifact] = {**{k: summary[k] for k in ("modelFamily", "horizon")}, "full": per_mode_trajectory["full"]}
        destroyed = {key: value for key, value in per_mode.items() if key != "full"}
        if destroyed:
            delta = {}
            for key, value in destroyed.items():
                delta[key] = {
                    split: {
                        metric: (
                            None if value[split][metric] is None or per_mode["full"][split][metric] is None
                            else value[split][metric] - per_mode["full"][split][metric]
                        )
                        for metric in ("auroc", "auprc", "brier", "ece", "nll")
                    }
                    for split in EVALUATION_SPLITS
                }
            seeded_means = {}
            for mode in SEEDED_EDGE_MODES:
                keys = [f"{mode}@{seed}" for seed in EDGE_SEEDS if f"{mode}@{seed}" in destroyed]
                if keys:
                    seeded_means[mode] = {
                        split: {
                            metric: (
                                None if any(destroyed[key][split][metric] is None for key in keys)
                                else float(np.mean([destroyed[key][split][metric] for key in keys]))
                            )
                            for metric in ("auroc", "auprc", "brier", "ece", "nll")
                        }
                        for split in EVALUATION_SPLITS
                    }
            ablations[artifact] = {
                "modelFamily": summary["modelFamily"],
                "horizon": summary["horizon"],
                "edgeSeeds": list(EDGE_SEEDS),
                "modes": destroyed,
                "trajectory": {key: value for key, value in per_mode_trajectory.items() if key != "full"},
                "deltaFromFull": delta,
                "seededModeMeans": seeded_means,
            }
    json_dump(root / "metrics.json", {
        "kind": "cloudproof.phase-ii-b2-metrics",
        "schemaVersion": 1,
        "phase": PHASE,
        "primaryHorizon": PRIMARY_HORIZON,
        "splits": list(EVALUATION_SPLITS),
        "maxRecordsPerSplit": args.max_records,
        "aurocIntervals": "percentile bootstrap resampling trajectories (clusters), 95%",
        "artifacts": metrics,
    })
    json_dump(root / "trajectory-metrics.json", {
        "kind": "cloudproof.phase-ii-b2-trajectory-metrics",
        "schemaVersion": 1,
        "phase": PHASE,
        "rule": TRAJECTORY_RULE,
        "maxRecordsPerSplit": args.max_records,
        "corpusBaselines": _corpus_trajectory_baselines(manifest),
        "artifacts": trajectory,
    })
    json_dump(root / "ablations.json", {
        "kind": "cloudproof.phase-ii-b2-edge-destruction",
        "schemaVersion": 1,
        "phase": PHASE,
        "modes": {
            "randomized-edges": "target column of every relation permuted per record (Phase II-B.1 control; per-node degree multisets preserved)",
            "rewired-edges": "both endpoints resampled uniformly among type-compatible nodes; edge counts preserved; original never reconstructed",
            "no-edges": "every relation removed",
            "collapsed-edge-types": "every relation transform averaged, relation identity lost",
            "random-relation-labels": "relation transforms applied under a fixed wrong relation label",
        },
        "preserved": ["node features", "node counts", "action features", "action target", "relation-type edge counts (except no-edges)"],
        "maxRecordsPerSplit": args.max_records,
        "artifacts": ablations,
    })
    print(json.dumps({artifact: {split: metrics[artifact]["full"][split]["auroc"] for split in EVALUATION_SPLITS} for artifact in artifacts}, indent=2))


def _corpus_trajectory_baselines(manifest: CausalCorpusManifest) -> dict:
    evaluation_file = manifest.directory / "evaluation.json"
    if not evaluation_file.is_file():
        return {}
    evaluation = json.loads(evaluation_file.read_text(encoding="utf-8")).get("evaluation") or {}
    return {
        "source": "causal corpus evaluation.json (heuristic and logistic baselines, same maximum rule)",
        "trajectoryMetrics": evaluation.get("trajectoryMetrics"),
        "transitionMetricsK5": {
            split: {
                name: {metric: values.get(metric) for metric in ("auroc", "auprc", "brierScore")}
                for name, values in (evaluation.get("transitionMetrics", {}).get("5", {}).get(split) or {}).items()
                if isinstance(values, dict)
            }
            for split in EVALUATION_SPLITS
        },
    }


# ---------------------------------------------------------------------------
# Relational-only counterfactual pairs
# ---------------------------------------------------------------------------


def _pair_table(manifest: CausalCorpusManifest) -> tuple[list[dict], dict[str, dict[str, dict]]]:
    groups = _pair_groups(manifest.auxiliary_path("pairs"))
    table = []
    for pair_id in sorted(groups):
        pair = groups[pair_id]
        a = pair["A"]
        valid = bool(a["metadata"]["valid"])
        riskier = _riskier_variant(pair) if valid else None
        horizon_a = bool(a["labels"]["horizons"]["5"])
        horizon_b = bool(pair["B"]["labels"]["horizons"]["5"])
        table.append({
            "pairId": pair_id,
            "family": a["family"],
            "split": a["split"],
            "relationalOnly": bool(a["relationalOnly"]),
            "valid": valid,
            "outcomeChange": a["metadata"]["outcomeChange"],
            "riskier": riskier,
            "horizon5Riskier": None if horizon_a == horizon_b else ("B" if horizon_b else "A"),
        })
    return table, groups


def _score_pairs(models, groups: dict[str, dict[str, dict]], tensorizer: CloudProofTensorizer, mode: str, seed: int, batch_size: int) -> dict[str, dict[str, float]]:
    samples = []
    keys = []
    for pair_id in sorted(groups):
        for variant in ("A", "B"):
            samples.append(tensorizer.tensorize_record(groups[pair_id][variant], include_label=False))
            keys.append((pair_id, variant))
    scores: dict[str, dict[str, float]] = defaultdict(dict)
    relation_mode = relation_mode_for(mode)
    with torch.no_grad():
        for start in range(0, len(samples), batch_size):
            chunk = [perturb_sample(sample, mode, seed) for sample in samples[start:start + batch_size]]
            batch = collate_graphs(chunk)
            risk, _uncertainty = ensemble_predict(models, batch, relation_mode)
            for (pair_id, variant), value in zip(keys[start:start + batch_size], risk.tolist(), strict=True):
                scores[pair_id][variant] = float(value)
    return scores


def _ranking(entries: list[dict], scores: dict[str, dict[str, float]], truth: str) -> dict:
    """Pairwise ranking over discordant pairs; ties at |margin| <= TIE_TOLERANCE."""
    units = []
    margins = []
    strict = []
    directions = Counter()
    correct_by_direction = Counter()
    tie_by_direction = Counter()
    exact_ties = 0
    for entry in entries:
        riskier = entry[truth]
        if riskier is None:
            continue
        safer = "A" if riskier == "B" else "B"
        margin = scores[entry["pairId"]][riskier] - scores[entry["pairId"]][safer]
        direction = entry["outcomeChange"] if truth == "riskier" else f"horizon5:{riskier}"
        directions[direction] += 1
        margins.append(margin)
        if margin > TIE_TOLERANCE:
            units.append(1.0)
            strict.append("correct")
            correct_by_direction[direction] += 1
        elif margin < -TIE_TOLERANCE:
            units.append(0.0)
            strict.append("wrong")
        else:
            units.append(0.5)
            strict.append("tie")
            tie_by_direction[direction] += 1
        exact_ties += int(margin == 0.0)
    pairs = len(units)
    if pairs == 0:
        return {"pairs": 0}
    correct = strict.count("correct")
    ties = strict.count("tie")
    wrong = strict.count("wrong")
    decided = correct + wrong
    tie_aware = (correct + 0.5 * ties) / pairs
    return {
        "pairs": pairs,
        "correct": correct,
        "wrong": wrong,
        "ties": ties,
        "exactTies": exact_ties,
        "strictAccuracy": correct / pairs,
        "tieAwareAccuracy": tie_aware,
        "wilson95TieAware": wilson_interval(correct + 0.5 * ties, pairs),
        "bootstrap95TieAware": bootstrap_mean(units, **PAIR_BOOTSTRAP),
        "binomialTiesExcluded": {
            "trials": decided,
            "successes": correct,
            "pValue": binomial_two_sided(correct, decided) if decided else None,
        },
        "binomialTiesAsWrong": {
            "trials": pairs,
            "successes": correct,
            "pValue": binomial_two_sided(correct, pairs),
        },
        "margins": summarize_margins(margins),
        "marginBootstrap95": bootstrap_mean(margins, **PAIR_BOOTSTRAP),
        "byDirection": {
            direction: {
                "pairs": directions[direction],
                "correct": correct_by_direction[direction],
                "ties": tie_by_direction[direction],
                "tieAwareAccuracy": (correct_by_direction[direction] + 0.5 * tie_by_direction[direction]) / directions[direction],
            }
            for direction in sorted(directions)
        },
        "_units": units,
        "_strict": strict,
    }


def _strip_private(value: Any) -> Any:
    if isinstance(value, dict):
        return {key: _strip_private(item) for key, item in value.items() if not key.startswith("_")}
    if isinstance(value, list):
        return [_strip_private(item) for item in value]
    return value


def _subset(entries: list[dict], **conditions) -> list[dict]:
    selected = entries
    for key, expected in conditions.items():
        selected = [entry for entry in selected if entry[key] == expected]
    return selected


def _rankings_for(entries: list[dict], scores: dict[str, dict[str, float]]) -> dict[str, Any]:
    relational = [entry for entry in entries if entry["relationalOnly"] and entry["valid"]]
    placement = [entry for entry in entries if not entry["relationalOnly"] and entry["valid"]]
    result = {
        "relationalOnly": _ranking(relational, scores, "riskier"),
        "relationalOnlyByFamily": {
            family: _ranking(_subset(relational, family=family), scores, "riskier")
            for family in sorted({entry["family"] for entry in relational})
        },
        "relationalOnlyBySplit": {
            split: _ranking(_subset(relational, split=split), scores, "riskier")
            for split in SPLIT_NAMES
        },
        "relationalOnlyHeldOutTopologies": _ranking(
            [entry for entry in relational if entry["split"] != "train"], scores, "riskier"
        ),
        "relationalOnlyHorizon5Truth": _ranking(relational, scores, "horizon5Riskier"),
        "placementFamilies": _ranking(placement, scores, "riskier"),
        "allValidPairs": _ranking([entry for entry in entries if entry["valid"]], scores, "riskier"),
    }
    return result


def _paired_comparison(left: dict, right: dict) -> dict:
    left_units = left["_units"]
    right_units = right["_units"]
    left_only = sum(1 for a, b in zip(left["_strict"], right["_strict"], strict=True) if a == "correct" and b != "correct")
    right_only = sum(1 for a, b in zip(left["_strict"], right["_strict"], strict=True) if b == "correct" and a != "correct")
    return {
        "tieAwareAccuracyDifference": left["tieAwareAccuracy"] - right["tieAwareAccuracy"],
        "pairedBootstrap95": paired_bootstrap_difference(left_units, right_units, **PAIR_BOOTSTRAP),
        "mcnemarExactStrict": mcnemar_exact(left_only, right_only),
    }


def _attribution_verdict(rankings: dict[str, dict], comparisons: dict[str, dict], criteria: dict) -> dict:
    def get(name: str) -> dict | None:
        value = rankings.get(name)
        return value["relationalOnly"] if value else None

    full = get(artifact_name("gnn-full", PRIMARY_HORIZON))
    pooled = get(artifact_name("pooled-mlp", PRIMARY_HORIZON))
    clock = get(artifact_name("gnn-clock-blind", PRIMARY_HORIZON))
    conditions: dict[str, Any] = {}
    if full:
        interval = full["bootstrap95TieAware"]
        conditions["1_fullGnnAboveChance"] = {
            "tieAwareAccuracy": full["tieAwareAccuracy"],
            "bootstrap95": [interval["lower"], interval["upper"]],
            "binomialTiesExcludedP": full["binomialTiesExcluded"]["pValue"],
            "passed": (
                full["tieAwareAccuracy"] >= criteria["fullGnnMinimumTieAwareAccuracy"]
                and interval["lower"] > 0.5
                and full["binomialTiesExcluded"]["pValue"] is not None
                and full["binomialTiesExcluded"]["pValue"] < criteria["fullGnnBinomialAlpha"]
            ),
        }
    if pooled:
        band = criteria["pooledMlpChanceBand"]
        conditions["2_pooledMlpAtChance"] = {
            "tieAwareAccuracy": pooled["tieAwareAccuracy"],
            "ties": pooled["ties"],
            "passed": band[0] <= pooled["tieAwareAccuracy"] <= band[1],
        }
    if full:
        destroyed = {}
        for key, comparison in comparisons.items():
            if not key.startswith(f"{artifact_name('gnn-full', PRIMARY_HORIZON)} vs {artifact_name('gnn-full', PRIMARY_HORIZON)}["):
                continue
            destroyed[key] = {
                "drop": comparison["tieAwareAccuracyDifference"],
                "pairedBootstrap95": [comparison["pairedBootstrap95"]["lower"], comparison["pairedBootstrap95"]["upper"]],
                "passed": (
                    comparison["tieAwareAccuracyDifference"] >= criteria["edgeDestructionMinimumDrop"]
                    and comparison["pairedBootstrap95"]["excludesZero"]
                ),
            }
        conditions["3_edgeDestructionRemovesAdvantage"] = {
            "controls": destroyed,
            "passed": any(item["passed"] for item in destroyed.values()) if destroyed else False,
        }
    if clock:
        interval = clock["bootstrap95TieAware"]
        conditions["4_survivesClockBlind"] = {
            "tieAwareAccuracy": clock["tieAwareAccuracy"],
            "bootstrap95": [interval["lower"], interval["upper"]],
            "passed": (
                clock["tieAwareAccuracy"] >= criteria["clockBlindMinimumTieAwareAccuracy"]
                and interval["lower"] > 0.5
            ),
        }
    if full:
        full_interval = full["bootstrap95TieAware"]
        pooled_upper = pooled["bootstrap95TieAware"]["upper"] if pooled else None
        destroyed_controls = conditions.get("3_edgeDestructionRemovesAdvantage", {}).get("controls", {})
        difference_excludes_zero = any(
            item["pairedBootstrap95"][0] > 0.0 for item in destroyed_controls.values()
        )
        conditions["5_intervalsDeterminate"] = {
            "fullGnnInterval": [full_interval["lower"], full_interval["upper"]],
            "fullGnnIntervalWidth": full_interval["upper"] - full_interval["lower"],
            "fullGnnIntervalExcludesChance": full_interval["lower"] > 0.5,
            "fullGnnLowerAbovePooledUpper": pooled_upper is not None and full_interval["lower"] > pooled_upper,
            "someDestroyedControlDifferenceExcludesZero": difference_excludes_zero,
            "passed": (
                full_interval["lower"] > 0.5
                and pooled_upper is not None
                and full_interval["lower"] > pooled_upper
                and difference_excludes_zero
            ),
        }
    passed = bool(conditions) and all(item["passed"] for item in conditions.values()) and len(conditions) == 5
    return {
        "criteria": criteria,
        "conditions": conditions,
        "graphAttribution": "PASSED" if passed else "FAILED",
        "allowedClaim": (
            "Relational topology contributes predictive information for CloudProof's controlled "
            "Kubernetes topology interventions."
            if passed
            else "Current CloudProof topology does not provide evidence that relational message passing "
            "is responsible for the learned prioritization gain."
        ),
    }


def pairs_command(args: argparse.Namespace) -> None:
    torch.set_num_threads(args.threads)
    root = Path(args.out)
    manifest = CausalCorpusManifest(args.corpus)
    verified = manifest.verify_hashes()
    manifest.verify_freeze(args.freeze, verified)
    artifacts = _artifacts_present(root, [item for item in args.artifacts.split(",") if item] if args.artifacts else None)
    summaries = _artifact_summaries(root, artifacts)
    table, groups = _pair_table(manifest)

    # Re-assert the corpus construction before anything is scored.
    plain = CloudProofTensorizer()
    relational_valid = [entry for entry in table if entry["relationalOnly"] and entry["valid"]]
    relations_differ = 0
    for entry in relational_valid:
        relations_differ += int(_relational_pair_checks(
            entry["pairId"], groups[entry["pairId"]], plain,
            require_relation_difference=entry["riskier"] is not None,
        ))
    torch.manual_seed(1337)
    pooled_probe = build_model(ModelConfig(flat_mlp=True)).eval()
    max_probe_gap = 0.0
    with torch.no_grad():
        for entry in relational_valid:
            batch = collate_graphs([
                plain.tensorize_record(groups[entry["pairId"]]["A"], include_label=False),
                plain.tensorize_record(groups[entry["pairId"]]["B"], include_label=False),
            ])
            logits = pooled_probe(batch)
            max_probe_gap = max(max_probe_gap, abs(float(logits[0]) - float(logits[1])))

    rankings: dict[str, Any] = {}
    started = time.perf_counter()
    for artifact in artifacts:
        directory = root / "models" / artifact
        config, models = load_artifact(directory, "cpu")
        tensorizer = tensorizer_for_config(config)
        per_mode = {}
        for mode, seed in _mode_plan(summaries[artifact]["modelFamily"], summaries[artifact]["horizon"]):
            scores = _score_pairs(models, groups, tensorizer, mode, seed, args.batch_size)
            key = mode if mode not in SEEDED_EDGE_MODES else f"{mode}@{seed}"
            per_mode[key] = _rankings_for(table, scores)
        rankings[artifact] = per_mode
    comparisons: dict[str, dict] = {}
    primary_full = artifact_name("gnn-full", PRIMARY_HORIZON)
    if primary_full in rankings:
        base = rankings[primary_full]["full"]["relationalOnly"]
        for other in artifacts:
            if other == primary_full:
                for key, value in rankings[other].items():
                    if key != "full":
                        comparisons[f"{primary_full} vs {primary_full}[{key}]"] = _paired_comparison(base, value["relationalOnly"])
            elif summaries[other]["horizon"] == PRIMARY_HORIZON:
                comparisons[f"{primary_full} vs {other}"] = _paired_comparison(base, rankings[other]["full"]["relationalOnly"])
    verdict = _attribution_verdict({name: modes["full"] for name, modes in rankings.items()}, comparisons, ATTRIBUTION_CRITERIA)

    seeded_summary = {}
    for artifact, modes in rankings.items():
        for mode in SEEDED_EDGE_MODES:
            values = [modes[f"{mode}@{seed}"]["relationalOnly"]["tieAwareAccuracy"] for seed in EDGE_SEEDS if f"{mode}@{seed}" in modes]
            if values:
                seeded_summary.setdefault(artifact, {})[mode] = {
                    "seeds": list(EDGE_SEEDS[: len(values)]),
                    "tieAwareAccuracies": values,
                    "mean": float(np.mean(values)),
                    "minimum": float(min(values)),
                    "maximum": float(max(values)),
                }
    counts = {
        "pairs": len(table),
        "valid": sum(entry["valid"] for entry in table),
        "relationalOnlyValid": len(relational_valid),
        "relationalOnlyDiscordant": sum(1 for entry in relational_valid if entry["riskier"] is not None),
        "relationalOnlyHorizon5Discordant": sum(1 for entry in relational_valid if entry["horizon5Riskier"] is not None),
        "placementDiscordant": sum(1 for entry in table if entry["valid"] and not entry["relationalOnly"] and entry["riskier"] is not None),
    }
    json_dump(root / "counterfactual-ranking.json", {
        "kind": "cloudproof.phase-ii-b2-counterfactual-ranking",
        "schemaVersion": 1,
        "phase": PHASE,
        "primaryTest": "relational-only, valid, trajectory-outcome discordant pairs; riskier member = the unsafe trajectory",
        "tieTolerance": TIE_TOLERANCE,
        "counts": counts,
        "constructionAssertions": {
            "pooledInputsIdenticalTensorLevel": len(relational_valid),
            "relationTensorsDiffer": relations_differ,
            "discordantPairsRelationTensorsDiffer": sum(1 for entry in relational_valid if entry["riskier"] is not None),
            "untrainedPooledMlpMaximumLogitGap": max_probe_gap,
        },
        "edgeSeeds": list(EDGE_SEEDS),
        "artifacts": _strip_private(rankings),
        "seededModeSummary": seeded_summary,
        "elapsedSeconds": time.perf_counter() - started,
    })
    json_dump(root / "statistical-tests.json", {
        "kind": "cloudproof.phase-ii-b2-statistical-tests",
        "schemaVersion": 1,
        "phase": PHASE,
        "methods": {
            "pairwiseInterval": "percentile bootstrap over pairs (10,000 resamples, seed 20260922) of tie-aware accuracy; Wilson 95% interval alongside",
            "chanceTest": "exact two-sided binomial test against 0.5, reported with ties excluded and with ties counted as wrong",
            "modelComparison": "paired bootstrap of the tie-aware accuracy difference over the same pairs plus an exact McNemar test on strict outcomes",
            "transitionAuroc": "percentile bootstrap resampling trajectories (1,000 resamples) because rows of one trajectory are not independent",
            "fixedBudget": "deterministic ranking given the scores; only the random baseline has a seed (1337); no repeated trials are claimed",
        },
        "primary": {
            artifact: _strip_private(modes["full"]["relationalOnly"]) for artifact, modes in rankings.items()
        },
        "comparisons": _strip_private(comparisons),
        "attribution": verdict,
    })
    print(json.dumps({
        "relationalOnlyTieAwareAccuracy": {
            artifact: {mode: round(values["relationalOnly"]["tieAwareAccuracy"], 4) for mode, values in modes.items()}
            for artifact, modes in rankings.items()
        },
        "graphAttribution": verdict["graphAttribution"],
    }, indent=2))


# ---------------------------------------------------------------------------
# Experiment-level config, clock-blind summary and manifest
# ---------------------------------------------------------------------------


def _read_json(path: Path) -> dict | None:
    return json.loads(path.read_text(encoding="utf-8")) if path.is_file() else None


def report_command(args: argparse.Namespace) -> None:
    root = Path(args.out)
    manifest = CausalCorpusManifest(args.corpus)
    verified = manifest.verify_hashes()
    freeze = manifest.verify_freeze(args.freeze, verified)
    artifacts = _artifacts_present(root, None)
    summaries = _artifact_summaries(root, artifacts)
    metrics = _read_json(root / "metrics.json") or {}
    trajectory = _read_json(root / "trajectory-metrics.json") or {}
    ranking = _read_json(root / "counterfactual-ranking.json") or {}
    tests = _read_json(root / "statistical-tests.json") or {}
    fixed_budget = _read_json(root / "fixed-budget.json")
    ablations = _read_json(root / "ablations.json") or {}

    config = {
        "kind": "cloudproof.phase-ii-b2-config",
        "schemaVersion": 1,
        "phase": PHASE,
        "researchQuestion": (
            "Does relational graph structure improve prediction and deterministic verification "
            "prioritization once schedule-construction shortcuts have been removed?"
        ),
        "corpus": {"directory": _repo_relative(manifest.directory), "freeze": freeze},
        "frozenRecipe": FROZEN_RECIPE,
        "recipeKwargs": RECIPE_KWARGS,
        "models": {name: {**family, "artifact": artifact_name(name, PRIMARY_HORIZON)} for name, family in MODEL_FAMILIES.items()},
        "primaryHorizon": PRIMARY_HORIZON,
        "secondaryHorizons": list(SECONDARY_HORIZONS),
        "edgeModes": list(GNN_EDGE_MODES),
        "edgeSeeds": list(EDGE_SEEDS),
        "clockBlindFields": clock_blind_field_list(),
        "trajectoryRule": TRAJECTORY_RULE,
        "attributionCriteria": ATTRIBUTION_CRITERIA,
        "pairBootstrap": PAIR_BOOTSTRAP,
        "clusterBootstrap": CLUSTER_BOOTSTRAP,
        "tieTolerance": TIE_TOLERANCE,
        "prohibitions": [
            "no dataset change", "no generation tuning", "no tuning after test/OOD/pair results",
            "no LLM", "no RL", "no new simulator features", "no counterexample-guided retraining",
            "no optimization for the relational-pair benchmark",
        ],
        "trainedArtifacts": summaries,
    }
    json_dump(root / "config.json", config)

    def pick(mapping: dict | None, *keys: str) -> Any:
        value = mapping
        for key in keys:
            if not isinstance(value, dict) or key not in value:
                return None
            value = value[key]
        return value

    full_name = artifact_name("gnn-full", PRIMARY_HORIZON)
    clock_name = artifact_name("gnn-clock-blind", PRIMARY_HORIZON)
    clock_blind = {
        "kind": "cloudproof.phase-ii-b2-clock-blind",
        "schemaVersion": 1,
        "phase": PHASE,
        "maskedFields": clock_blind_field_list(),
        "keptFields": "every other encoded feature, including durations (ms, delayMs, durationMs) and version numbers",
        "architectureIdentical": pick(summaries, full_name, "parameterCount") == pick(summaries, clock_name, "parameterCount"),
        "transitionMetrics": {
            name: {
                split: {
                    metric: pick(metrics, "artifacts", name, "full", split, metric)
                    for metric in ("auroc", "auprc", "brier", "ece", "nll")
                }
                for split in EVALUATION_SPLITS
            }
            for name in (full_name, clock_name)
        },
        "trajectoryMetrics": {
            name: {
                split: {metric: pick(trajectory, "artifacts", name, "full", split, metric) for metric in ("auroc", "auprc", "brier")}
                for split in EVALUATION_SPLITS
            }
            for name in (full_name, clock_name)
        },
        "relationalOnlyPairs": {
            name: {
                mode: {
                    key: pick(ranking, "artifacts", name, mode, "relationalOnly", key)
                    for key in ("pairs", "correct", "ties", "tieAwareAccuracy", "strictAccuracy", "bootstrap95TieAware")
                }
                for mode in (pick(ranking, "artifacts", name) or {})
            }
            for name in (full_name, clock_name)
        },
        "edgeDestruction": {name: pick(ablations, "artifacts", name, "deltaFromFull") for name in (full_name, clock_name)},
        "fixedBudget": None if fixed_budget is None else {
            name: pick(fixed_budget, "methods", name) for name in ("gnn", "gnnClockBlind")
        },
        "attribution": pick(tests, "attribution"),
    }
    json_dump(root / "clock-blind.json", clock_blind)

    files = {}
    for path in sorted(root.rglob("*")):
        if not path.is_file() or path.suffix == ".log" or (path.name == "manifest.json" and path.parent == root):
            continue
        relative = path.relative_to(root).as_posix()
        if relative.startswith("predictions/"):
            continue
        files[relative] = {"bytes": path.stat().st_size, "sha256": sha256_file(path)}
    predictions = sorted(path.relative_to(root).as_posix() for path in (root / "predictions").rglob("*.jsonl")) if (root / "predictions").is_dir() else []
    training_summary = _read_json(root / "training-summary.json") or {}
    json_dump(root / "manifest.json", {
        "kind": "cloudproof.phase-ii-b2-manifest",
        "schemaVersion": 1,
        "phase": PHASE,
        "git": _git_state(),
        "environment": _environment(),
        "corpusFreeze": freeze,
        "modelSeeds": list(ENSEMBLE_SEEDS),
        "edgeSeeds": list(EDGE_SEEDS),
        "training": {
            "runs": training_summary.get("runs"),
            "perArtifact": {
                name: {
                    "trainingSecondsTotal": sum(member["trainingSeconds"] for member in summary["members"]),
                    "bestEpochs": [member["bestEpoch"] for member in summary["members"]],
                }
                for name, summary in summaries.items()
            },
        },
        "modelWeights": {
            name: [
                {"file": f"models/{name}/member-{index}.pt", "seed": seed,
                 "sha256": sha256_file(root / "models" / name / f"member-{index}.pt"),
                 "bytes": (root / "models" / name / f"member-{index}.pt").stat().st_size}
                for index, seed in enumerate(ENSEMBLE_SEEDS)
            ]
            for name in artifacts
        },
        "weightsCommitted": False,
        "predictionFiles": predictions,
        "files": files,
    })
    print(json.dumps({"artifacts": artifacts, "files": len(files), "attribution": pick(tests, "attribution", "graphAttribution")}))


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _add_corpus_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--corpus", default="artifacts/cloudproof/causal-corpus-v2")
    parser.add_argument("--freeze", default="CLOUDPROOF-PHASE-II-A2-CORPUS-FREEZE.json")
    parser.add_argument("--out", default="artifacts/cloudproof/phase-ii-b2")


def _add_recipe_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--epochs", type=int, default=RECIPE_KWARGS["epochs"])
    parser.add_argument("--patience", type=int, default=RECIPE_KWARGS["patience"])
    parser.add_argument("--learning-rate", type=float, default=RECIPE_KWARGS["learning_rate"])
    parser.add_argument("--weight-decay", type=float, default=RECIPE_KWARGS["weight_decay"])
    parser.add_argument("--batch-size", type=int, default=RECIPE_KWARGS["batch_size"])
    parser.add_argument("--hidden-dim", type=int, default=RECIPE_KWARGS["hidden_dim"])
    parser.add_argument("--layers", type=int, default=RECIPE_KWARGS["layers"])
    parser.add_argument("--dropout", type=float, default=RECIPE_KWARGS["dropout"])
    parser.add_argument("--shuffle-buffer", type=int, default=RECIPE_KWARGS["shuffle_buffer"])
    parser.add_argument("--max-train-records", type=int)
    parser.add_argument("--max-validation-records", type=int)
    parser.add_argument("--threads", type=int, default=1)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    subparsers = parser.add_subparsers(dest="command", required=True)

    verify = subparsers.add_parser("verify", help="verify the frozen corpus against its freeze record")
    _add_corpus_arguments(verify)

    train = subparsers.add_parser("train", help="train the frozen ensembles, one process per member")
    _add_corpus_arguments(train)
    _add_recipe_arguments(train)
    train.add_argument("--models", default=",".join(PRIMARY_MODELS))
    train.add_argument("--horizons", default=str(PRIMARY_HORIZON))
    train.add_argument("--concurrency", type=int, default=8)
    train.add_argument("--retrain", action="store_true")

    member = subparsers.add_parser("train-member", help="internal: train one ensemble member")
    member.add_argument("--corpus", required=True)
    member.add_argument("--out", required=True)
    member.add_argument("--model", required=True, choices=sorted(MODEL_FAMILIES))
    member.add_argument("--horizon", type=int, required=True)
    member.add_argument("--seed", type=int, required=True)
    member.add_argument("--index", type=int, required=True)
    member.add_argument("--pos-weight", type=float, required=True)
    member.add_argument("--train-digest", required=True)
    member.add_argument("--validation-digest", required=True)
    _add_recipe_arguments(member)

    evaluate = subparsers.add_parser("evaluate", help="score validation/test/OOD under edge destruction")
    _add_corpus_arguments(evaluate)
    evaluate.add_argument("--artifacts", default="")
    evaluate.add_argument("--batch-size", type=int, default=128)
    evaluate.add_argument("--max-records", type=int)
    evaluate.add_argument("--concurrency", type=int, default=8)
    evaluate.add_argument("--repredict", action="store_true")

    one = subparsers.add_parser("evaluate-one", help="internal: predictions for one artifact and edge mode")
    one.add_argument("--corpus", required=True)
    one.add_argument("--model-dir", required=True)
    one.add_argument("--edge-mode", choices=EDGE_DESTRUCTION_MODES, default="full")
    one.add_argument("--edge-seed", type=int, default=DEFAULT_EDGE_SEED)
    one.add_argument("--out", required=True)
    one.add_argument("--batch-size", type=int, default=128)
    one.add_argument("--max-records", type=int)
    one.add_argument("--threads", type=int, default=1)

    pairs = subparsers.add_parser("pairs", help="score the counterfactual pairs and run the attribution test")
    _add_corpus_arguments(pairs)
    pairs.add_argument("--artifacts", default="")
    pairs.add_argument("--batch-size", type=int, default=128)
    pairs.add_argument("--threads", type=int, default=1)

    report = subparsers.add_parser("report", help="write config.json, clock-blind.json and manifest.json")
    _add_corpus_arguments(report)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> None:
    args = parse_args(argv)
    if args.command == "verify":
        report = verify_corpus(args.corpus, args.freeze)
        json_dump(Path(args.out) / "frozen-corpus-verification.json", report)
        print(json.dumps({"passed": report["passed"], "rows": report["labelContract"]["verifiedRows"],
                          "relationalOnlyDiscordant": report["pairs"]["relationalOnly"]["discordantPairs"],
                          "seconds": round(report["elapsedSeconds"], 1)}))
    elif args.command == "train":
        train_command(args)
    elif args.command == "train-member":
        train_member_command(args)
    elif args.command == "evaluate":
        evaluate_command(args)
    elif args.command == "evaluate-one":
        evaluate_one_command(args)
    elif args.command == "pairs":
        pairs_command(args)
    elif args.command == "report":
        report_command(args)
    else:  # pragma: no cover - argparse enforces the choice
        raise ValueError(args.command)


if __name__ == "__main__":
    main()
