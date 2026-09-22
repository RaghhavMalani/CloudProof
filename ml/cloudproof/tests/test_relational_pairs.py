"""Relational-only counterfactual pairs must be invisible to permutation-invariant pooling.

The fixture is produced by ``node tools/cloudproof-relational-fixture.js`` and holds the
first pair of every relational-only family. For each pair the tensorizer must yield the
same per-type multiset of node-feature rows and the same action features for both members,
so the pooled MLP's typed mean/min/max/sum inputs (and therefore its logits) are identical,
while the relation tensors differ.
"""

from __future__ import annotations

import json
import unittest

import torch

from ml.cloudproof.model import ModelConfig, build_model
from ml.cloudproof.tensorize import CloudProofTensorizer, collate_graphs
from ml.cloudproof.tests.helpers import REPOSITORY


FIXTURE = REPOSITORY / "artifacts" / "cloudproof" / "datasets" / "relational-pairs-95000.jsonl"


def _pairs() -> dict[str, dict[str, dict]]:
    grouped: dict[str, dict[str, dict]] = {}
    with FIXTURE.open("r", encoding="utf-8") as handle:
        for line in handle:
            if line.strip():
                record = json.loads(line)
                grouped.setdefault(record["pairId"], {})[record["variant"]] = record
    return grouped


def _sorted_rows(tensor: torch.Tensor) -> list[tuple[float, ...]]:
    return sorted(tuple(round(value, 6) for value in row) for row in tensor.tolist())


class RelationalPairTests(unittest.TestCase):
    def setUp(self) -> None:
        if not FIXTURE.is_file():
            self.skipTest("relational fixture not generated")
        self.pairs = _pairs()
        self.assertGreaterEqual(len(self.pairs), 2)

    def test_pooled_inputs_identical_and_relations_differ(self) -> None:
        tensorizer = CloudProofTensorizer()
        for pair_id, members in self.pairs.items():
            self.assertEqual(set(members), {"A", "B"}, pair_id)
            control = tensorizer.tensorize_record(members["A"], include_label=False)
            treated = tensorizer.tensorize_record(members["B"], include_label=False)
            for node_type, features in control.node_features.items():
                self.assertEqual(
                    _sorted_rows(features),
                    _sorted_rows(treated.node_features[node_type]),
                    f"{pair_id}: {node_type} multiset differs",
                )
            self.assertTrue(torch.equal(control.action_features, treated.action_features), pair_id)
            differing = [
                relation
                for relation in control.edges
                if not torch.equal(control.edges[relation], treated.edges[relation])
            ]
            self.assertTrue(differing, f"{pair_id}: no relation differs")
            self.assertTrue(members["A"]["metadata"]["pooledInputsIdentical"], pair_id)
            self.assertTrue(members["A"]["metadata"]["flatSummaryIdentical"], pair_id)

    def test_pooled_mlp_cannot_separate_pair_members(self) -> None:
        torch.manual_seed(1337)
        model = build_model(ModelConfig(flat_mlp=True)).eval()
        tensorizer = CloudProofTensorizer()
        for pair_id, members in self.pairs.items():
            batch = collate_graphs([
                tensorizer.tensorize_record(members["A"], include_label=False),
                tensorizer.tensorize_record(members["B"], include_label=False),
            ])
            with torch.no_grad():
                logits = model(batch)
            self.assertAlmostEqual(float(logits[0]), float(logits[1]), places=5, msg=pair_id)

    def test_pair_members_share_the_exogenous_schedule(self) -> None:
        for pair_id, members in self.pairs.items():
            self.assertEqual(
                members["A"]["sharedExogenousScheduleDigest"],
                members["B"]["sharedExogenousScheduleDigest"],
                pair_id,
            )
            self.assertEqual(members["A"]["schedule"]["actions"], members["B"]["schedule"]["actions"], pair_id)
            self.assertNotEqual(members["A"]["metadata"]["placement"], members["B"]["metadata"]["placement"], pair_id)


if __name__ == "__main__":
    unittest.main()
