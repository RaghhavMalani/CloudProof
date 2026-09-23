from __future__ import annotations

import unittest

import torch

from ml.cloudproof.constants import RESOURCE_TYPES
from ml.cloudproof.controlled import zone_concentration_variants
from ml.cloudproof.tensorize import CloudProofTensorizer
from ml.cloudproof.tests.helpers import fixture_record


class ControlledExperimentTests(unittest.TestCase):
    def test_balanced_and_concentrated_graphs_differ_only_relationally(self) -> None:
        record = fixture_record()
        balanced, concentrated, action = zone_concentration_variants(record["state"])
        tensorizer = CloudProofTensorizer()
        left = tensorizer.tensorize(balanced, action)
        right = tensorizer.tensorize(concentrated, action)
        for node_type in RESOURCE_TYPES:
            self.assertTrue(torch.equal(left.node_features[node_type], right.node_features[node_type]))
        self.assertFalse(torch.equal(left.edges["RUNS_ON"], right.edges["RUNS_ON"]))
        self.assertTrue(torch.equal(left.action_features, right.action_features))


if __name__ == "__main__":
    unittest.main()
