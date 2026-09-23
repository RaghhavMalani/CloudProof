"""Phase II-B.2 contracts: frozen-corpus verification, clock-blind masking, edge
destruction, label selection, model-selection isolation and the pairwise metric."""

from __future__ import annotations

from copy import deepcopy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest

import numpy as np
import torch

from ml.cloudproof.constants import ACTION_PARAMETER_NAMES, ACTION_TYPES, RELATION_TYPES, RESOURCE_TYPES
from ml.cloudproof.dataset import (
    CausalCorpusManifest,
    CorpusManifest,
    label_balance,
    open_corpus_manifest,
)
from ml.cloudproof.metrics import auroc
from ml.cloudproof.model import ModelConfig
from ml.cloudproof.perturb import EDGE_DESTRUCTION_MODES, perturb_sample
from ml.cloudproof.phase_ii_b2 import (
    ATTRIBUTION_CRITERIA,
    EDGE_SEEDS,
    GNN_EDGE_MODES,
    PRIMARY_HORIZON,
    TIE_TOLERANCE,
    _attribution_verdict,
    _mode_plan,
    _paired_comparison,
    _ranking,
    _relational_pair_checks,
    _riskier_variant,
    parse_args,
)
from ml.cloudproof.runtime import tensorizer_for_config
from ml.cloudproof.stats import (
    binomial_two_sided,
    bootstrap_mean,
    cluster_bootstrap,
    fast_auroc,
    mcnemar_exact,
    paired_bootstrap_difference,
    wilson_interval,
)
from ml.cloudproof.tensorize import (
    CLOCK_ACTION_COLUMNS,
    CLOCK_NODE_COLUMNS,
    CloudProofTensorizer,
    clock_blind_field_list,
    collate_graphs,
    mask_clock_features,
)
from ml.cloudproof.tests.helpers import REPOSITORY, fixture_record
from ml.cloudproof.train import train_member


RELATIONAL_FIXTURE = REPOSITORY / "artifacts" / "cloudproof" / "datasets" / "relational-pairs-95000.jsonl"


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _v2_record(index: int, split: str, topology: str, *, positive: bool, horizon_10: bool | None = None) -> dict:
    record = deepcopy(fixture_record())
    record["recordId"] = f"trajectory-{split}-{index // 3}:transition-{index}"
    record["trajectoryId"] = f"trajectory-{split}-{index // 3}"
    record["scenarioId"] = record["trajectoryId"]
    record["topologyId"] = topology
    record["split"] = split
    record["datasetSchemaVersion"] = 3
    record.pop("nextState", None)
    record["labels"] = {
        "sloViolationWithinKTransitions": positive,
        "labelHorizonTransitions": 5,
        "horizons": {"1": False, "5": positive, "10": positive if horizon_10 is None else horizon_10, "20": True},
        "transitionsToIncident": None,
        "incidentClass": None,
    }
    record["metadata"] = {"trajectoryOutcome": "unsafe" if positive else "safe", "difficultyTier": None}
    record["action"] = {key: value for key, value in record["action"].items() if key not in {"id", "atMs"}}
    return record


def _write_jsonl(path: Path, records: list[dict]) -> None:
    path.write_text("".join(json.dumps(item, separators=(",", ":")) + "\n" for item in records), encoding="utf-8")


def _topology(replicas: int) -> dict:
    return {"initialReplicas": replicas, "zones": 3, "hpaMaxReplicas": replicas * 2, "hpaMinReplicas": 2}


def build_synthetic_v2_corpus(directory: Path, *, rows_per_split: int = 9) -> tuple[Path, Path]:
    """A tiny corpus directory in the causal-corpus v2 layout plus its freeze record."""
    directory.mkdir(parents=True, exist_ok=True)
    catalog = [
        {"label": "A", "split": "train", "topologyId": "topology-train", "topology": _topology(3)},
        {"label": "I", "split": "validation", "topologyId": "topology-validation", "topology": _topology(4)},
        {"label": "N", "split": "test", "topologyId": "topology-test", "topology": _topology(5)},
        {"label": "OOD-E", "split": "ood", "topologyId": "topology-ood", "topology": _topology(9)},
    ]
    counts = {"rowsBySplit": {}}
    for entry in catalog:
        split = entry["split"]
        records = [
            _v2_record(index, split, entry["topologyId"], positive=index % 3 == 0)
            for index in range(rows_per_split)
        ]
        _write_jsonl(directory / f"transitions-{split}.jsonl", records)
        counts["rowsBySplit"][split] = len(records)
    _write_jsonl(directory / "trajectories.jsonl", [])
    _write_jsonl(directory / "counterfactual-pairs.jsonl", [])
    files = {
        name: {"sha256": _sha256(directory / name), "bytes": (directory / name).stat().st_size, "role": name}
        for name in sorted(item.name for item in directory.glob("*.jsonl"))
    }
    manifest = {
        "kind": "cloudproof.causal-corpus-manifest",
        "schemaVersion": 3,
        "splitPolicy": "topology-holdout-v2",
        "generator": {"id": "cloudproof.causal-generator", "version": 1, "commitSha": "abc", "outcomeBlind": True},
        "seeds": {"count": 4, "first": 1, "last": 4},
        "counts": counts,
        "label": {"defaultHorizon": 5, "horizons": [1, 5, 10, 20]},
        "features": {
            "boundary": "state-and-candidate-action-only",
            "rowsCarryNextState": False,
            "excluded": ["nextState", "labels", "trajectoryOutcome", "failureClass", "metadata", "nuisance",
                         "placementKind", "scenarioFamily", "difficultyTier"],
        },
        "acceptance": {"passed": True},
        "parameters": {"topologyCatalog": catalog},
        "files": files,
    }
    (directory / "manifest.json").write_text(json.dumps(manifest, indent=1), encoding="utf-8")
    freeze = {
        "kind": "cloudproof.causal-corpus-freeze",
        "schemaVersion": 1,
        "corpus": directory.name,
        "manifestKind": manifest["kind"],
        "manifestSchemaVersion": 3,
        "generator": manifest["generator"],
        "seeds": manifest["seeds"],
        "splitPolicy": manifest["splitPolicy"],
        "counts": counts,
        "acceptance": {"passed": True},
        "files": files,
    }
    freeze_path = directory.parent / f"{directory.name}-freeze.json"
    freeze_path.write_text(json.dumps(freeze, indent=1), encoding="utf-8")
    return directory, freeze_path


class FrozenCorpusVerificationTests(unittest.TestCase):
    def test_recorded_hashes_are_recomputed_and_any_byte_change_aborts(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            corpus, freeze = build_synthetic_v2_corpus(Path(temporary) / "causal-corpus-test")
            manifest = CausalCorpusManifest(corpus)
            verified = manifest.verify_hashes()
            self.assertEqual(set(verified), {
                "transitions-train.jsonl", "transitions-validation.jsonl", "transitions-test.jsonl",
                "transitions-ood.jsonl", "trajectories.jsonl", "counterfactual-pairs.jsonl",
            })
            report = manifest.verify_freeze(freeze, verified)
            self.assertTrue(report["acceptancePassed"])
            self.assertEqual(report["files"]["transitions-train.jsonl"]["sha256"], verified["transitions-train.jsonl"])
            with (corpus / "transitions-test.jsonl").open("ab") as handle:
                handle.write(b"\n")
            with self.assertRaisesRegex(ValueError, "SHA-256 mismatch for transitions-test.jsonl"):
                manifest.verify_hashes()

    def test_freeze_record_drift_aborts(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            corpus, freeze = build_synthetic_v2_corpus(Path(temporary) / "causal-corpus-test")
            manifest = CausalCorpusManifest(corpus)
            record = json.loads(freeze.read_text(encoding="utf-8"))
            record["files"]["trajectories.jsonl"]["sha256"] = "0" * 64
            drifted = freeze.with_name("drifted.json")
            drifted.write_text(json.dumps(record), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "frozen SHA-256 differs"):
                manifest.verify_freeze(drifted)
            record = json.loads(freeze.read_text(encoding="utf-8"))
            record["counts"]["rowsBySplit"]["train"] += 1
            drifted.write_text(json.dumps(record), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "counts differ"):
                manifest.verify_freeze(drifted)

    def test_manifest_dispatch_and_v2_contract(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            corpus, _freeze = build_synthetic_v2_corpus(Path(temporary) / "causal-corpus-test")
            manifest = open_corpus_manifest(corpus)
            self.assertIsInstance(manifest, CausalCorpusManifest)
            self.assertEqual(manifest.topology_splits()["topology-ood"], "ood")
            self.assertEqual(manifest.artifact_contract()["splitPolicy"], "topology-holdout-v2")
            self.assertIn("counterfactual-pairs.jsonl", manifest.artifact_contract()["auxiliaryFiles"])
            value = json.loads((corpus / "manifest.json").read_text(encoding="utf-8"))
            value["acceptance"]["passed"] = False
            (corpus / "manifest.json").write_text(json.dumps(value), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "acceptance"):
                CausalCorpusManifest(corpus)
            value["kind"] = "cloudproof.research-dataset-manifest"
            (corpus / "manifest.json").write_text(json.dumps(value), encoding="utf-8")
            with self.assertRaises(ValueError):
                open_corpus_manifest(corpus)
            self.assertIs(type(open_corpus_manifest.__annotations__), dict)
            self.assertTrue(issubclass(CorpusManifest, object))


class ClockBlindTests(unittest.TestCase):
    def setUp(self) -> None:
        self.record = fixture_record()

    def test_declared_fields_are_the_only_masked_inputs(self) -> None:
        self.assertEqual(clock_blind_field_list(), ["HPA.sampled_at", "action.atMs"])
        self.assertEqual(CLOCK_NODE_COLUMNS, {"HPA": 4})
        self.assertEqual(CLOCK_ACTION_COLUMNS, (len(ACTION_TYPES) + len(RESOURCE_TYPES) + 1 + ACTION_PARAMETER_NAMES.index("atMs"),))
        plain = CloudProofTensorizer().tensorize_record(self.record)
        blind = CloudProofTensorizer(clock_blind=True).tensorize_record(self.record)
        for node_type in RESOURCE_TYPES:
            left = plain.node_features[node_type].clone()
            if node_type in CLOCK_NODE_COLUMNS:
                self.assertTrue(bool((blind.node_features[node_type][:, CLOCK_NODE_COLUMNS[node_type]] == 0).all()))
                left[:, CLOCK_NODE_COLUMNS[node_type]] = 0.0
            self.assertTrue(torch.equal(left, blind.node_features[node_type]), node_type)
        action = plain.action_features.clone()
        for column in CLOCK_ACTION_COLUMNS:
            action[column] = 0.0
        self.assertTrue(torch.equal(action, blind.action_features))
        for relation in RELATION_TYPES:
            self.assertTrue(torch.equal(plain.edges[relation], blind.edges[relation]))
        self.assertEqual(plain.target, blind.target)
        self.assertEqual(plain.label, blind.label)

    def test_clock_blind_representation_ignores_the_hpa_clock_and_action_time(self) -> None:
        shifted = deepcopy(self.record)
        for node in shifted["state"]["nodes"]:
            if node["type"] == "HPA":
                node["features"]["sampledAtMs"] = (node["features"].get("sampledAtMs") or 0) + 4321
        shifted["action"]["atMs"] = (shifted["action"].get("atMs") or 0) + 999
        plain = CloudProofTensorizer()
        blind = CloudProofTensorizer(clock_blind=True)
        self.assertFalse(torch.equal(
            plain.tensorize_record(self.record).node_features["HPA"],
            plain.tensorize_record(shifted).node_features["HPA"],
        ))
        left = blind.tensorize_record(self.record)
        right = blind.tensorize_record(shifted)
        self.assertTrue(torch.equal(left.node_features["HPA"], right.node_features["HPA"]))
        self.assertTrue(torch.equal(left.action_features, right.action_features))
        # Idempotent and deterministic: masking twice equals masking once.
        twice = mask_clock_features(left)
        self.assertTrue(torch.equal(twice.node_features["HPA"], left.node_features["HPA"]))
        self.assertEqual(blind.describe()["maskedFields"], clock_blind_field_list())
        self.assertTrue(tensorizer_for_config({"featureTransform": {"clockBlind": True}}).clock_blind)
        self.assertFalse(tensorizer_for_config({}).clock_blind)


class EdgeDestructionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.sample = CloudProofTensorizer().tensorize_record(fixture_record())

    def test_destructive_modes_keep_node_features_counts_and_action(self) -> None:
        for mode in ("randomized-edges", "rewired-edges", "no-edges"):
            with self.subTest(mode=mode):
                destroyed = perturb_sample(self.sample, mode)
                for node_type in RESOURCE_TYPES:
                    self.assertTrue(torch.equal(destroyed.node_features[node_type], self.sample.node_features[node_type]))
                self.assertTrue(torch.equal(destroyed.action_features, self.sample.action_features))
                self.assertEqual(destroyed.target, self.sample.target)
                self.assertEqual(destroyed.label, self.sample.label)
                for relation in RELATION_TYPES:
                    expected = 0 if mode == "no-edges" else self.sample.edges[relation].shape[1]
                    self.assertEqual(destroyed.edges[relation].shape[1], expected, relation)

    def test_randomization_changes_edges_and_is_seeded(self) -> None:
        def sorted_edges(sample):
            return {relation: sorted(map(tuple, sample.edges[relation].t().tolist())) for relation in RELATION_TYPES}

        original = sorted_edges(self.sample)
        for mode in ("randomized-edges", "rewired-edges"):
            with self.subTest(mode=mode):
                first = perturb_sample(self.sample, mode, 1729)
                again = perturb_sample(self.sample, mode, 1729)
                other = perturb_sample(self.sample, mode, 2729)
                self.assertNotEqual(sorted_edges(first), original)
                for relation in RELATION_TYPES:
                    self.assertTrue(torch.equal(first.edges[relation], again.edges[relation]))
                self.assertNotEqual(sorted_edges(first), sorted_edges(other))
        rewired = perturb_sample(self.sample, "rewired-edges", 1729)
        # Rewired endpoints stay inside the type-compatible node ranges.
        for relation in RELATION_TYPES:
            edges = rewired.edges[relation]
            if edges.shape[1] == 0:
                continue
            source_type, target_type = {"RUNS_ON": ("Pod", "Node"), "OWNS": ("Deployment", "Pod"),
                                        "ROUTES_TO": ("Service", "Pod"), "LOCATED_IN": ("Node", "Zone"),
                                        "SELECTS": ("Service", "Deployment"), "PROTECTS": ("PDB", "Deployment"),
                                        "SCALES": ("HPA", "Deployment")}[relation]
            self.assertLess(int(edges[0].max()), self.sample.node_features[source_type].shape[0])
            self.assertLess(int(edges[1].max()), self.sample.node_features[target_type].shape[0])
        self.assertEqual(set(EDGE_DESTRUCTION_MODES), set(GNN_EDGE_MODES))

    def test_mode_plan_uses_every_seed_for_primary_gnns_only(self) -> None:
        plan = _mode_plan("gnn-full", PRIMARY_HORIZON)
        self.assertEqual([mode for mode, _seed in plan if mode == "randomized-edges"], ["randomized-edges"] * len(EDGE_SEEDS))
        self.assertEqual(_mode_plan("pooled-mlp", PRIMARY_HORIZON), [("full", 1729)])
        self.assertEqual(_mode_plan("gnn-full", 10), [("full", 1729)])


class LabelSelectionTests(unittest.TestCase):
    def test_horizon_labels_are_selected_without_touching_features(self) -> None:
        record = _v2_record(0, "train", "topology-train", positive=False, horizon_10=True)
        self.assertEqual(CloudProofTensorizer().record_label(record), 0.0)
        self.assertEqual(CloudProofTensorizer(label_horizon=10).record_label(record), 1.0)
        self.assertEqual(CloudProofTensorizer(label_horizon=5).record_label(record), 0.0)
        with self.assertRaises(ValueError):
            CloudProofTensorizer(label_horizon=7).record_label(record)
        left = CloudProofTensorizer().tensorize_record(record)
        right = CloudProofTensorizer(label_horizon=10).tensorize_record(record)
        for node_type in RESOURCE_TYPES:
            self.assertTrue(torch.equal(left.node_features[node_type], right.node_features[node_type]))
        self.assertTrue(torch.equal(left.action_features, right.action_features))
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "rows.jsonl"
            _write_jsonl(path, [record, _v2_record(1, "train", "topology-train", positive=True, horizon_10=True)])
            self.assertEqual(label_balance(path).positive, 1)
            self.assertEqual(label_balance(path, label_horizon=10).positive, 2)

    def test_pair_labels_membership_and_identifiers_never_enter_features(self) -> None:
        if not RELATIONAL_FIXTURE.is_file():
            self.skipTest("relational fixture not generated")
        with RELATIONAL_FIXTURE.open("r", encoding="utf-8") as handle:
            record = json.loads(next(line for line in handle if line.strip()))
        tampered = deepcopy(record)
        tampered["labels"] = {"trajectoryUnsafe": not record["labels"]["trajectoryUnsafe"], "horizons": {"1": True, "5": True, "10": True, "20": True}}
        tampered["metadata"] = {"outcomeChange": "safe->unsafe", "discordant": True, "valid": True, "placement": {}}
        tampered["relationalOnly"] = not record["relationalOnly"]
        tampered["family"] = "secret-family"
        tampered["pairId"] = "pair-secret"
        tampered["arm"] = "treated"
        tampered["split"] = "ood"
        tampered["topologyId"] = "topology-secret"
        tensorizer = CloudProofTensorizer()
        left = tensorizer.tensorize_record(record, include_label=False)
        right = tensorizer.tensorize_record(tampered, include_label=False)
        for node_type in RESOURCE_TYPES:
            self.assertTrue(torch.equal(left.node_features[node_type], right.node_features[node_type]))
        for relation in RELATION_TYPES:
            self.assertTrue(torch.equal(left.edges[relation], right.edges[relation]))
        self.assertTrue(torch.equal(left.action_features, right.action_features))

    def test_relational_pair_checks_on_the_committed_fixture(self) -> None:
        if not RELATIONAL_FIXTURE.is_file():
            self.skipTest("relational fixture not generated")
        grouped: dict[str, dict[str, dict]] = {}
        with RELATIONAL_FIXTURE.open("r", encoding="utf-8") as handle:
            for line in handle:
                if line.strip():
                    item = json.loads(line)
                    grouped.setdefault(item["pairId"], {})[item["variant"]] = item
        tensorizer = CloudProofTensorizer()
        for pair_id, pair in grouped.items():
            self.assertTrue(_relational_pair_checks(pair_id, pair, tensorizer, require_relation_difference=True), pair_id)
            self.assertIn(_riskier_variant(pair), {None, "A", "B"})
        broken = deepcopy(next(iter(grouped.values())))
        pod = next(node for node in broken["B"]["state"]["nodes"] if node["type"] == "Pod")
        pod["features"]["ready"] = not pod["features"].get("ready")
        with self.assertRaisesRegex(ValueError, "pooled .* inputs differ"):
            _relational_pair_checks("broken", broken, tensorizer, require_relation_difference=False)


class PairwiseMetricTests(unittest.TestCase):
    def _entries(self):
        return [
            {"pairId": "p1", "riskier": "B", "outcomeChange": "safe->unsafe", "horizon5Riskier": "B"},
            {"pairId": "p2", "riskier": "A", "outcomeChange": "unsafe->safe", "horizon5Riskier": None},
            {"pairId": "p3", "riskier": "B", "outcomeChange": "safe->unsafe", "horizon5Riskier": "B"},
            {"pairId": "p4", "riskier": "B", "outcomeChange": "safe->unsafe", "horizon5Riskier": "B"},
            {"pairId": "p5", "riskier": None, "outcomeChange": "same", "horizon5Riskier": None},
        ]

    def test_ranking_counts_correct_wrong_and_tolerance_ties(self) -> None:
        scores = {
            "p1": {"A": 0.2, "B": 0.7},                 # correct
            "p2": {"A": 0.1, "B": 0.4},                 # wrong (A is riskier)
            "p3": {"A": 0.5, "B": 0.5},                 # exact tie
            "p4": {"A": 0.30, "B": 0.30 + 1e-8},        # tie within tolerance
            "p5": {"A": 0.9, "B": 0.1},                 # concordant, ignored
        }
        result = _ranking(self._entries(), scores, "riskier")
        self.assertEqual((result["pairs"], result["correct"], result["wrong"], result["ties"], result["exactTies"]), (4, 1, 1, 2, 1))
        self.assertAlmostEqual(result["strictAccuracy"], 0.25)
        self.assertAlmostEqual(result["tieAwareAccuracy"], 0.5)
        self.assertEqual(result["binomialTiesExcluded"]["trials"], 2)
        self.assertAlmostEqual(result["binomialTiesExcluded"]["pValue"], 1.0)
        self.assertAlmostEqual(result["binomialTiesAsWrong"]["pValue"], binomial_two_sided(1, 4))
        self.assertEqual(result["byDirection"]["safe->unsafe"]["pairs"], 3)
        self.assertEqual(result["byDirection"]["unsafe->safe"]["correct"], 0)
        self.assertAlmostEqual(result["margins"]["mean"], (0.5 - 0.3 + 0.0 + 1e-8) / 4)
        self.assertLess(result["bootstrap95TieAware"]["lower"], result["tieAwareAccuracy"])
        horizon = _ranking(self._entries(), scores, "horizon5Riskier")
        self.assertEqual(horizon["pairs"], 3)
        self.assertLessEqual(TIE_TOLERANCE, 1e-6)

    def test_paired_comparison_and_verdict_logic(self) -> None:
        entries = self._entries()
        strong = {"p1": {"A": 0.1, "B": 0.9}, "p2": {"A": 0.9, "B": 0.1}, "p3": {"A": 0.2, "B": 0.8},
                  "p4": {"A": 0.3, "B": 0.7}, "p5": {"A": 0.5, "B": 0.5}}
        weak = {"p1": {"A": 0.5, "B": 0.5}, "p2": {"A": 0.5, "B": 0.5}, "p3": {"A": 0.5, "B": 0.5},
                "p4": {"A": 0.5, "B": 0.5}, "p5": {"A": 0.5, "B": 0.5}}
        left = _ranking(entries, strong, "riskier")
        right = _ranking(entries, weak, "riskier")
        comparison = _paired_comparison(left, right)
        self.assertAlmostEqual(comparison["tieAwareAccuracyDifference"], 0.5)
        self.assertEqual(comparison["mcnemarExactStrict"]["leftOnly"], 4)
        rankings = {"gnn-full-k5": {"relationalOnly": left}, "pooled-mlp-k5": {"relationalOnly": right},
                    "gnn-clock-blind-k5": {"relationalOnly": left}}
        comparisons = {"gnn-full-k5 vs gnn-full-k5[no-edges]": comparison, "gnn-full-k5 vs pooled-mlp-k5": comparison}
        verdict = _attribution_verdict(rankings, comparisons, ATTRIBUTION_CRITERIA)
        self.assertEqual(set(verdict["conditions"]), {
            "1_fullGnnAboveChance", "2_pooledMlpAtChance", "3_edgeDestructionRemovesAdvantage",
            "4_survivesClockBlind", "5_intervalsDeterminate",
        })
        # Four pairs cannot reach the binomial alpha, so the verdict must stay FAILED.
        self.assertEqual(verdict["graphAttribution"], "FAILED")
        self.assertFalse(verdict["conditions"]["1_fullGnnAboveChance"]["passed"])
        self.assertTrue(verdict["conditions"]["2_pooledMlpAtChance"]["passed"])


class StatisticsTests(unittest.TestCase):
    def test_exact_binomial_wilson_and_mcnemar(self) -> None:
        self.assertAlmostEqual(binomial_two_sided(7, 10), 352 / 1024)
        self.assertAlmostEqual(binomial_two_sided(5, 10), 1.0)
        self.assertLess(binomial_two_sided(130, 173), 1e-9)
        lower, upper = wilson_interval(86.5, 173)
        self.assertLess(lower, 0.5)
        self.assertGreater(upper, 0.5)
        self.assertGreater(wilson_interval(130, 173)[0], 0.65)
        self.assertEqual(mcnemar_exact(0, 0)["pValue"], None)
        self.assertAlmostEqual(mcnemar_exact(7, 3)["pValue"], binomial_two_sided(7, 10))

    def test_fast_auroc_matches_reference_with_ties(self) -> None:
        generator = np.random.default_rng(3)
        labels = generator.integers(0, 2, size=500).astype(float)
        scores = np.round(generator.random(500), 1)
        self.assertAlmostEqual(fast_auroc(labels, scores), auroc(labels, scores), places=12)
        self.assertIsNone(fast_auroc(np.ones(5), np.arange(5)))

    def test_bootstraps_are_seeded_and_paired(self) -> None:
        values = [1.0] * 30 + [0.0] * 10
        first = bootstrap_mean(values, resamples=500, seed=5)
        second = bootstrap_mean(values, resamples=500, seed=5)
        self.assertEqual(first, second)
        self.assertLess(first["lower"], 0.75)
        self.assertGreater(first["upper"], 0.75)
        paired = paired_bootstrap_difference([1.0] * 40, [0.5] * 40, resamples=200, seed=1)
        self.assertTrue(paired["excludesZero"])
        self.assertAlmostEqual(paired["mean"], 0.5)
        clusters = [f"trajectory-{index // 5}" for index in range(100)]
        labels = [float(index % 3 == 0) for index in range(100)]
        scores = [(index % 3 == 0) * 0.5 + (index % 7) / 14 for index in range(100)]
        result = cluster_bootstrap(labels, scores, clusters, resamples=50, seed=2)
        self.assertEqual(result["clusters"], 20)
        self.assertLessEqual(result["lower"], result["value"])
        self.assertGreaterEqual(result["upper"], result["value"])


class ModelSelectionIsolationTests(unittest.TestCase):
    def _tiny_corpus(self, directory: Path) -> tuple[Path, Path]:
        train = [_v2_record(index, "train", "topology-train", positive=index % 2 == 0) for index in range(8)]
        validation = [_v2_record(index, "validation", "topology-validation", positive=index % 2 == 1) for index in range(4)]
        _write_jsonl(directory / "transitions-train.jsonl", train)
        _write_jsonl(directory / "transitions-validation.jsonl", validation)
        return directory / "transitions-train.jsonl", directory / "transitions-validation.jsonl"

    def test_member_training_reads_only_train_and_validation_and_is_seed_deterministic(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            train_path, validation_path = self._tiny_corpus(Path(temporary))
            self.assertFalse((Path(temporary) / "transitions-test.jsonl").exists())
            self.assertFalse((Path(temporary) / "transitions-ood.jsonl").exists())
            kwargs = dict(
                config=ModelConfig(hidden_dim=8, layers=1, dropout=0.0),
                train_path=train_path, validation_path=validation_path,
                epochs=2, patience=1, learning_rate=1e-3, weight_decay=1e-4, batch_size=4,
                shuffle_buffer=4, pos_weight=1.0, max_train_records=None, max_validation_records=None,
                device="cpu", tensorizer=CloudProofTensorizer(clock_blind=True),
            )
            left, left_member = train_member(seed=1337, **kwargs)
            right, right_member = train_member(seed=1337, **kwargs)
            other, _ = train_member(seed=2027, **kwargs)
            for name, value in left.state_dict().items():
                self.assertTrue(torch.equal(value, right.state_dict()[name]), name)
            self.assertEqual(left_member["history"], right_member["history"])
            self.assertTrue(any(
                not torch.equal(value, other.state_dict()[name]) for name, value in left.state_dict().items()
            ))

    def test_train_member_cli_has_no_test_or_ood_inputs(self) -> None:
        arguments = parse_args([
            "train-member", "--corpus", "x", "--out", "y", "--model", "gnn-full", "--horizon", "5",
            "--seed", "1", "--index", "0", "--pos-weight", "2.5", "--train-digest", "a", "--validation-digest", "b",
        ])
        names = set(vars(arguments))
        self.assertFalse({"test_digest", "ood_digest", "test", "ood"} & names)
        self.assertEqual(arguments.horizon, 5)
        evaluate = parse_args(["evaluate-one", "--corpus", "x", "--model-dir", "m", "--out", "o", "--edge-mode", "rewired-edges", "--edge-seed", "7"])
        self.assertEqual((evaluate.edge_mode, evaluate.edge_seed), ("rewired-edges", 7))


if __name__ == "__main__":
    unittest.main()
