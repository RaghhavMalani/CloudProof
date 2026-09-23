"""The Phase II-B.2 report's tables are rendered from the committed result JSON."""

from __future__ import annotations

import unittest

from ml.cloudproof.phase_ii_b2_report import (
    DEFAULT_DOCUMENT,
    DEFAULT_ROOT,
    _count,
    _interval,
    _p,
    _signed,
    apply_tables,
    render_tables,
)


class FormattingTests(unittest.TestCase):
    def test_p_values_intervals_and_signs(self) -> None:
        self.assertEqual(_p(7.4e-25), "7.4 × 10⁻²⁵")
        self.assertEqual(_p(9.96e-5), "1.0 × 10⁻⁴")
        self.assertEqual(_p(0.36), "0.36")
        self.assertEqual(_p(None), "—")
        self.assertEqual(_interval({"lower": 0.8205, "upper": 0.919}), "[0.821, 0.919]")
        self.assertEqual(_interval([-0.035, 0.012], signed=True), "[−0.035, +0.012]")
        self.assertEqual(_signed(-0.0121), "−0.012")
        self.assertEqual(_count(7791.67), "7 792")
        self.assertEqual(_count(340290752), "340 290 752")


class GeneratedBlockTests(unittest.TestCase):
    def test_blocks_are_replaced_and_every_table_must_appear_once(self) -> None:
        document = "intro\n<!-- generated:a -->\nold\n<!-- /generated:a -->\ntext\n<!-- generated:b -->\n<!-- /generated:b -->\n"
        updated = apply_tables(document, {"a": "| x |", "b": "| y |"})
        self.assertIn("<!-- generated:a -->\n| x |\n<!-- /generated:a -->", updated)
        self.assertIn("<!-- generated:b -->\n| y |\n<!-- /generated:b -->", updated)
        self.assertEqual(apply_tables(updated, {"a": "| x |", "b": "| y |"}), updated)
        with self.assertRaisesRegex(ValueError, "missing"):
            apply_tables(document, {"a": "| x |", "b": "| y |", "c": "| z |"})
        with self.assertRaisesRegex(ValueError, "no renderer"):
            apply_tables(document, {"a": "| x |"})

    def test_committed_report_tables_match_the_artifacts(self) -> None:
        document = DEFAULT_DOCUMENT.read_text(encoding="utf-8")
        self.assertEqual(apply_tables(document, render_tables(DEFAULT_ROOT)), document,
                         "run `python -m ml.cloudproof.phase_ii_b2_report` to regenerate the report tables")


if __name__ == "__main__":
    unittest.main()
