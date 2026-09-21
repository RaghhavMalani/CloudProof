from __future__ import annotations

from copy import deepcopy
import json
from pathlib import Path
import tempfile
import unittest

import torch

from ml.cloudproof.controlled import zone_concentration_variants
from ml.cloudproof.dataset import permuted_label_vector
from ml.cloudproof.model import ModelConfig, build_model
from ml.cloudproof.perturb import EDGE_DESTRUCTION_MODES, perturb_sample, relation_mode_for
from ml.cloudproof.runtime import predict_samples
from ml.cloudproof.tensorize import CloudProofTensorizer, collate_graphs
from ml.cloudproof.tests.helpers import fixture_record


class AttributionControlTests(unittest.TestCase):
    def setUp(self) -> None:
        torch.manual_seed(17)
        self.tensorizer = CloudProofTensorizer()
        self.record = fixture_record()

    def test_action_only_is_invariant_to_state_features(self) -> None:
        changed = deepcopy(self.record)
        changed["state"]["nodes"][0]["features"]["ready"] = not bool(
            changed["state"]["nodes"][0]["features"].get("ready")
        )
        batch = collate_graphs([
            self.tensorizer.tensorize_record(self.record),
            self.tensorizer.tensorize_record(changed),
        ])
        model = build_model(ModelConfig(hidden_dim=8, dropout=0.0, input_mode="action-only")).eval()
        logits = model(batch)
        self.assertEqual(float(logits[0]), float(logits[1]))

    def test_state_only_is_invariant_to_candidate_action(self) -> None:
        changed = deepcopy(self.record)
        changed["action"] = {"type": "cloud.action.advance-time", "atMs": 0, "ms": 500}
        batch = collate_graphs([
            self.tensorizer.tensorize_record(self.record),
            self.tensorizer.tensorize_record(changed),
        ])
        model = build_model(ModelConfig(hidden_dim=8, layers=1, dropout=0.0, input_mode="state-only")).eval()
        logits = model(batch)
        self.assertEqual(float(logits[0]), float(logits[1]))

    def test_flat_mlp_is_parameter_matched_and_topology_blind(self) -> None:
        full = build_model(ModelConfig())
        flat = build_model(ModelConfig(flat_mlp=True))
        ratio = sum(parameter.numel() for parameter in flat.parameters()) / sum(
            parameter.numel() for parameter in full.parameters()
        )
        self.assertGreater(ratio, 0.8)
        self.assertLess(ratio, 1.25)

        balanced, concentrated, action = zone_concentration_variants(self.record["state"])
        batch = collate_graphs([
            self.tensorizer.tensorize(balanced, action),
            self.tensorizer.tensorize(concentrated, action),
        ])
        flat.eval()
        logits = flat(batch)
        self.assertEqual(float(logits[0]), float(logits[1]))

    def test_every_edge_destruction_mode_is_deterministic(self) -> None:
        sample = self.tensorizer.tensorize_record(self.record)
        model = build_model(ModelConfig(hidden_dim=8, layers=1, dropout=0.0)).eval()
        for mode in EDGE_DESTRUCTION_MODES:
            with self.subTest(mode=mode):
                left = perturb_sample(sample, mode)
                right = perturb_sample(sample, mode)
                for relation in left.edges:
                    self.assertTrue(torch.equal(left.edges[relation], right.edges[relation]))
                logits = model(collate_graphs([left]), relation_mode=relation_mode_for(mode))
                self.assertEqual(logits.shape, (1,))

    def test_label_permutation_is_fixed_and_prevalence_preserving(self) -> None:
        records = []
        for index in range(12):
            record = deepcopy(self.record)
            record["recordId"] = f"record-{index}"
            record["labels"]["sloViolationWithinKTransitions"] = index < 3
            records.append(record)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "records.jsonl"
            path.write_text(
                "".join(json.dumps(record, separators=(",", ":")) + "\n" for record in records),
                encoding="utf-8",
            )
            left = permuted_label_vector(path, 41)
            right = permuted_label_vector(path, 41)
        self.assertEqual(left, right)
        self.assertEqual(sum(left), 3.0)
        self.assertNotEqual(left, tuple(float(index < 3) for index in range(12)))

    def test_runtime_perturbation_stream_remains_an_iterable_dataset(self) -> None:
        sample = self.tensorizer.tensorize_record(self.record)
        model = build_model(ModelConfig(hidden_dim=8, layers=1, dropout=0.0)).eval()
        labels, risks, uncertainties, record_ids = predict_samples(
            [model], [sample], batch_size=1, edge_mode="randomized-edges"
        )
        self.assertEqual(labels, [sample.label])
        self.assertEqual(len(risks), 1)
        self.assertEqual(uncertainties, [0.0])
        self.assertEqual(record_ids, [sample.record_id])


if __name__ == "__main__":
    unittest.main()
