from __future__ import annotations

import unittest

from ml.cloudproof.metrics import evaluate_binary_risk, threshold_for_f1


class MetricTests(unittest.TestCase):
    def test_perfect_predictions_have_perfect_ranking_and_zero_error(self) -> None:
        result = evaluate_binary_risk([0, 1], [0, 1], bins=5)
        self.assertEqual(result["auroc"], 1.0)
        self.assertEqual(result["auprc"], 1.0)
        self.assertEqual(result["brier"], 0.0)
        self.assertEqual(result["ece"], 0.0)
        self.assertGreater(result["nll"], 0.0)

    def test_tied_predictions_match_random_ranking(self) -> None:
        result = evaluate_binary_risk([0, 1], [0.5, 0.5])
        self.assertEqual(result["auroc"], 0.5)
        self.assertEqual(result["auprc"], 0.5)
        self.assertEqual(threshold_for_f1([0, 1], [0.5, 0.5])["threshold"], 0.0)


if __name__ == "__main__":
    unittest.main()
