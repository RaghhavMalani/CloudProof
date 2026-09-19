from __future__ import annotations

import unittest

import torch

from ml.cloudproof.constants import ENSEMBLE_SEEDS
from ml.cloudproof.model import ModelConfig, build_model, ensemble_predict
from ml.cloudproof.tensorize import CloudProofTensorizer, collate_graphs
from ml.cloudproof.train import seed_everything
from ml.cloudproof.tests.helpers import fixture_record


class ModelTests(unittest.TestCase):
    def test_every_required_architecture_produces_one_logit_per_graph(self) -> None:
        sample = CloudProofTensorizer().tensorize_record(fixture_record())
        batch = collate_graphs([sample, sample])
        configs = [
            ModelConfig(hidden_dim=16, layers=2, dropout=0.0),
            ModelConfig(hidden_dim=16, layers=2, dropout=0.0, use_edge_types=False),
            ModelConfig(hidden_dim=16, layers=2, dropout=0.0, use_action_embedding=False),
            ModelConfig(hidden_dim=16, layers=2, dropout=0.0, use_zone_relations=False),
            ModelConfig(hidden_dim=16, layers=2, dropout=0.0, flat_mlp=True),
        ]
        for config in configs:
            with self.subTest(config=config):
                model = build_model(config).eval()
                self.assertEqual(model(batch).shape, (2,))

    def test_five_model_ensemble_returns_mean_and_standard_deviation(self) -> None:
        torch.manual_seed(7)
        sample = CloudProofTensorizer().tensorize_record(fixture_record())
        batch = collate_graphs([sample])
        models = [build_model(ModelConfig(hidden_dim=8, layers=1, dropout=0.0)).eval()
                  for _ in range(5)]
        risk, uncertainty = ensemble_predict(models, batch)
        self.assertGreaterEqual(float(risk[0]), 0.0)
        self.assertLessEqual(float(risk[0]), 1.0)
        self.assertGreaterEqual(float(uncertainty[0]), 0.0)

    def test_fixed_ensemble_seeds_reproduce_initialization(self) -> None:
        self.assertEqual(len(ENSEMBLE_SEEDS), 5)
        config = ModelConfig(hidden_dim=8, layers=1, dropout=0.0)
        for seed in ENSEMBLE_SEEDS:
            with self.subTest(seed=seed):
                seed_everything(seed)
                left = build_model(config).state_dict()
                seed_everything(seed)
                right = build_model(config).state_dict()
                self.assertTrue(all(torch.equal(left[name], right[name]) for name in left))


if __name__ == "__main__":
    unittest.main()
