from __future__ import annotations

from copy import deepcopy
import unittest

import torch

from ml.cloudproof.constants import ACTION_FEATURE_DIM, NODE_FEATURE_DIMS, RELATION_TYPES, RESOURCE_TYPES
from ml.cloudproof.tensorize import CloudProofTensorizer, collate_graphs
from ml.cloudproof.tests.helpers import fixture_record


class TensorizationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tensorizer = CloudProofTensorizer()
        self.record = fixture_record()

    def assert_samples_equal(self, left, right) -> None:
        for node_type in RESOURCE_TYPES:
            self.assertTrue(torch.equal(left.node_features[node_type], right.node_features[node_type]))
        for relation in RELATION_TYPES:
            self.assertTrue(torch.equal(left.edges[relation], right.edges[relation]))
        self.assertTrue(torch.equal(left.action_features, right.action_features))
        self.assertEqual(left.target, right.target)

    def test_identical_graph_records_tensorize_byte_identically(self) -> None:
        left = self.tensorizer.tensorize_record(self.record)
        right = self.tensorizer.tensorize_record(deepcopy(self.record))
        self.assert_samples_equal(left, right)

    def test_input_order_does_not_change_tensors(self) -> None:
        changed = deepcopy(self.record)
        changed["state"]["nodes"].reverse()
        changed["state"]["edges"].reverse()
        self.assert_samples_equal(
            self.tensorizer.tensorize_record(self.record),
            self.tensorizer.tensorize_record(changed),
        )

    def test_future_labels_metadata_and_topology_ids_are_unobservable(self) -> None:
        changed = deepcopy(self.record)
        changed["nextState"] = {"kind": "tampered"}
        original_label = bool(changed["labels"].get("sloViolationWithinKTransitions"))
        changed["labels"]["sloViolationWithinKTransitions"] = not original_label
        changed["metadata"] = {"trajectoryOutcome": "tampered", "topologyLabel": "SECRET"}
        changed["topologyId"] = "topology-secret"
        changed["split"] = "ood"
        left = self.tensorizer.tensorize_record(self.record, include_label=False)
        right = self.tensorizer.tensorize_record(changed, include_label=False)
        self.assert_samples_equal(left, right)

    def test_ids_and_id_bearing_features_are_not_model_features(self) -> None:
        sample = self.tensorizer.tensorize_record(self.record)
        self.assertEqual(sample.action_features.shape, (ACTION_FEATURE_DIM,))
        for node_type in RESOURCE_TYPES:
            self.assertEqual(sample.node_features[node_type].shape[1], NODE_FEATURE_DIMS[node_type])
            self.assertEqual(sample.node_features[node_type].dtype, torch.float32)
        # Returned model inputs are numeric tensors and contain no string payload at all.
        self.assertFalse(any(isinstance(value, str) for tensor in sample.node_features.values()
                             for value in tensor.flatten().tolist()))

    def test_action_timing_is_encoded_but_action_id_is_not(self) -> None:
        original = self.tensorizer.tensorize_record(self.record)
        changed_id = deepcopy(self.record)
        changed_id["action"]["id"] = "secret-action-identifier"
        self.assertTrue(torch.equal(
            original.action_features, self.tensorizer.tensorize_record(changed_id).action_features,
        ))
        changed_time = deepcopy(self.record)
        changed_time["action"]["atMs"] += 1000
        self.assertFalse(torch.equal(
            original.action_features, self.tensorizer.tensorize_record(changed_time).action_features,
        ))

    def test_collation_offsets_edges_and_targets(self) -> None:
        sample = self.tensorizer.tensorize_record(self.record)
        batch = collate_graphs([sample, sample])
        self.assertEqual(batch.graph_count, 2)
        self.assertEqual(batch.action_features.shape, (2, ACTION_FEATURE_DIM))
        for relation in RELATION_TYPES:
            self.assertEqual(batch.edges[relation].shape[1], sample.edges[relation].shape[1] * 2)


if __name__ == "__main__":
    unittest.main()
