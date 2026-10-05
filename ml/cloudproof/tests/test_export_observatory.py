"""GNN Observatory export: the replay schema, and published numbers read rather than typed."""

from __future__ import annotations

from copy import deepcopy
import json
from pathlib import Path
import shutil
import tempfile
import unittest

from ml.cloudproof.export_observatory import (
    REPLAY_KIND,
    build_replay,
    downsample,
    final_from_results,
    relation_label_map,
    supported_claim,
    validate_replay,
)
from ml.cloudproof.model import ModelConfig
from ml.cloudproof.tests.helpers import REPOSITORY
from ml.cloudproof.train import train_member
from ml.cloudproof.viz_tap import VizTapSpec, probe_samples, read_tap, select_probe_pair


RELATIONAL_FIXTURE = REPOSITORY / "artifacts" / "cloudproof" / "datasets" / "relational-pairs-95000.jsonl"
RESULTS = REPOSITORY / "artifacts" / "cloudproof" / "phase-ii-b2"
README = REPOSITORY / "README.md"
COMMITTED_REPLAY = REPOSITORY / "web" / "observatory" / "replay.json"
RESULT_FILES = ("counterfactual-ranking.json", "statistical-tests.json", "pair-audit.json")


def _fixture_section(directory: Path, every: int = 1) -> tuple[dict, dict]:
    pair = select_probe_pair(RELATIONAL_FIXTURE, split="train")
    rows = [line for line in RELATIONAL_FIXTURE.read_text(encoding="utf-8").splitlines() if line.strip()]
    (directory / "train.jsonl").write_text("\n".join(rows) + "\n", encoding="utf-8")
    (directory / "validation.jsonl").write_text("\n".join(rows[:4]) + "\n", encoding="utf-8")
    tap = directory / "tap.jsonl"
    train_member(
        seed=1337, config=ModelConfig(hidden_dim=8, layers=2, dropout=0.1),
        train_path=directory / "train.jsonl", validation_path=directory / "validation.jsonl",
        epochs=2, patience=2, learning_rate=1e-2, weight_decay=1e-4, batch_size=3, shuffle_buffer=4,
        pos_weight=1.0, max_train_records=None, max_validation_records=None, device="cpu",
        viz_tap=VizTapSpec(path=tap, probe_batch=probe_samples(pair), every=every,
                           header={"probe": {"pairId": pair["A"]["pairId"]}, "corpus": {"manifestSha256": "f" * 64}}),
    )
    return read_tap(tap)[0], pair


@unittest.skipUnless(RESULTS.is_dir() and RELATIONAL_FIXTURE.is_file(), "Phase II-B.2 results not present")
class PublishedNumbersTests(unittest.TestCase):
    def setUp(self) -> None:
        self.directory = Path(tempfile.mkdtemp())

    def tearDown(self) -> None:
        shutil.rmtree(self.directory, ignore_errors=True)

    def test_final_rows_are_the_result_json_values(self) -> None:
        ranking = json.loads((RESULTS / "counterfactual-ranking.json").read_text(encoding="utf-8"))
        final = final_from_results(RESULTS, README, "pair-00035")
        self.assertEqual(final["pairs"], ranking["counts"]["relationalOnlyDiscordant"])
        for row in final["rows"]:
            source = ranking["artifacts"][row["artifact"]][row["mode"]]["relationalOnly"]
            self.assertEqual((row["correct"], row["ties"], row["pairs"]), (source["correct"], source["ties"], source["pairs"]))
            self.assertEqual(row["tieAwareAccuracy"], source["tieAwareAccuracy"])
            self.assertEqual(row["bootstrap95"], [source["bootstrap95TieAware"]["lower"], source["bootstrap95TieAware"]["upper"]])
        seeded = [row["edgeSeed"] for row in final["rows"] if row["baseMode"] == "randomized-edges"]
        self.assertEqual(seeded, ranking["edgeSeeds"])
        self.assertEqual(final["probePair"]["pairId"], "pair-00035")

    def test_changing_the_result_json_changes_final(self) -> None:
        # If any number were typed into the exporter, editing the source file would not move it.
        for name in RESULT_FILES:
            shutil.copy(RESULTS / name, self.directory / name)
        ranking = json.loads((self.directory / "counterfactual-ranking.json").read_text(encoding="utf-8"))
        full = ranking["artifacts"]["gnn-full-k5"]["full"]["relationalOnly"]
        full.update({"correct": 99, "tieAwareAccuracy": 0.123456})
        full["bootstrap95TieAware"].update({"lower": 0.11, "upper": 0.13})
        ranking["counts"]["relationalOnlyDiscordant"] = 4242
        (self.directory / "counterfactual-ranking.json").write_text(json.dumps(ranking), encoding="utf-8")
        tests = json.loads((self.directory / "statistical-tests.json").read_text(encoding="utf-8"))
        tests["attribution"]["graphAttribution"] = "FAILED"
        (self.directory / "statistical-tests.json").write_text(json.dumps(tests), encoding="utf-8")
        audit = json.loads((self.directory / "pair-audit.json").read_text(encoding="utf-8"))
        next(item for item in audit["pairs"] if item["pairId"] == "pair-00035")["margins"]["gnn-full-k5|full"] = -0.5
        (self.directory / "pair-audit.json").write_text(json.dumps(audit), encoding="utf-8")
        readme = self.directory / "README.md"
        readme.write_text("x\n- **The supported claim is exactly this:** *a different, edited claim sentence for the test only.* More.\n", encoding="utf-8")

        final = final_from_results(self.directory, readme, "pair-00035")
        row = next(item for item in final["rows"] if item["artifact"] == "gnn-full-k5" and item["mode"] == "full")
        self.assertEqual((row["correct"], row["tieAwareAccuracy"], row["bootstrap95"]), (99, 0.123456, [0.11, 0.13]))
        self.assertEqual(final["pairs"], 4242)
        self.assertEqual(final["graphAttribution"], "FAILED")
        self.assertEqual(final["probePair"]["margins"]["gnn-full-k5|full"], -0.5)
        self.assertEqual(final["supportedClaim"], "a different, edited claim sentence for the test only.")

    def test_supported_claim_is_quoted_from_the_readme(self) -> None:
        claim = supported_claim(README)
        self.assertIn(f"*{claim}*", " ".join(README.read_text(encoding="utf-8").split()))
        self.assertIn("relational message passing provides predictive information", claim)
        empty = self.directory / "README.md"
        empty.write_text("no claim here\n", encoding="utf-8")
        with self.assertRaises(ValueError):
            supported_claim(empty)


@unittest.skipUnless(RESULTS.is_dir() and RELATIONAL_FIXTURE.is_file(), "Phase II-B.2 results not present")
class ReplaySchemaTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.directory = Path(tempfile.mkdtemp())
        cls.section, cls.pair = _fixture_section(cls.directory)
        cls.replay = build_replay(cls.section, cls.pair, results_directory=RESULTS, readme_path=README)

    @classmethod
    def tearDownClass(cls) -> None:
        shutil.rmtree(cls.directory, ignore_errors=True)

    def test_replay_from_a_tap_is_valid_and_mirrors_the_corpus_records(self) -> None:
        replay = self.replay
        self.assertEqual(replay["kind"], REPLAY_KIND)
        self.assertEqual(validate_replay(replay), [])
        self.assertEqual(len(replay["frames"]), len(self.section["frames"]))
        for graph, variant in zip(replay["graphs"], ("A", "B"), strict=True):
            record = self.pair[variant]
            self.assertEqual(graph["recordId"], record["recordId"])
            self.assertEqual(
                sorted((edge["rel"], edge["from"], edge["to"]) for edge in graph["edges"]),
                sorted((edge["type"], edge["from"], edge["to"]) for edge in record["state"]["edges"]),
            )
            self.assertEqual({node["id"] for node in graph["nodes"]}, {node["id"] for node in record["state"]["nodes"]})
            self.assertEqual(graph["target"], f"node/{record['action']['nodeId']}")
            for mode, edges in graph["edgesByMode"].items():
                expected = 0 if mode == "no-edges" else len(graph["edges"])
                self.assertEqual(len(edges), expected, mode)
        self.assertTrue(replay["meta"]["probe"]["pooledInputsIdentical"])
        self.assertIn("RUNS_ON", replay["meta"]["probe"]["relationsDiffer"])

    def test_byte_budget_downsamples_steps_but_keeps_init_epoch_and_best(self) -> None:
        size = len(json.dumps(self.replay, separators=(",", ":")))
        small = build_replay(self.section, self.pair, results_directory=RESULTS, readme_path=README, max_bytes=size * 2 // 3)
        self.assertLess(len(small["frames"]), len(self.replay["frames"]))
        phases = [frame["phase"] for frame in small["frames"]]
        self.assertEqual(phases[0], "init")
        self.assertEqual(phases[-1], "best")
        self.assertEqual(phases.count("epoch"), [frame["phase"] for frame in self.replay["frames"]].count("epoch"))
        self.assertEqual(validate_replay(small), [])
        frames = [{"phase": "step", "step": index} for index in range(10)]
        self.assertEqual([frame["step"] for frame in downsample(frames, 4)], [0, 3, 6, 9])

    def test_validation_reports_each_kind_of_breakage(self) -> None:
        breakages = {
            "risk modes": lambda replay: replay["frames"][1]["risk"].pop("no-edges"),
            "norms": lambda replay: replay["frames"][0]["layers"][0]["Pod"].pop(),
            "endpoints": lambda replay: replay["graphs"][0]["edges"][0].update({"to": "pod/ghost"}),
            "claim": lambda replay: replay["final"].update({"supportedClaim": ""}),
            "steps": lambda replay: replay["frames"][-1].update({"step": -1}),
            "messages": lambda replay: replay["frames"][0]["msg"][1]["OWNS"]["forward"].pop(),
            "graphs": lambda replay: replay["graphs"].pop(),
        }
        for name, breakage in breakages.items():
            broken = deepcopy(self.replay)
            breakage(broken)
            self.assertNotEqual(validate_replay(broken), [], name)
        self.assertNotEqual(validate_replay({"kind": REPLAY_KIND}), [])

    def test_relation_label_map_is_the_one_the_model_uses(self) -> None:
        import torch
        from ml.cloudproof.constants import RELATION_TYPES
        from ml.cloudproof.model import RelationLayer

        mapping = self.replay["meta"]["vocabulary"]["randomRelationLabels"]
        self.assertEqual(mapping, relation_label_map())
        self.assertEqual(sorted(mapping.values()), sorted(RELATION_TYPES))
        self.assertTrue(all(source != target for source, target in mapping.items()))
        layer = RelationLayer(6, 0.0, use_edge_types=True).eval()
        values = torch.ones(2, 6)
        with torch.no_grad():
            for relation, routed in mapping.items():
                self.assertTrue(torch.equal(
                    layer._messages(layer.reverse_transforms, relation, values, "random-relation-labels"),
                    layer.reverse_transforms[routed](values),
                ))

    def test_a_tap_for_another_pair_is_rejected(self) -> None:
        other = deepcopy(self.pair)
        for variant in ("A", "B"):
            other[variant]["recordId"] = other[variant]["recordId"].replace("pair-", "pair-9")
        with self.assertRaisesRegex(ValueError, "different probe pair"):
            build_replay(self.section, other, results_directory=RESULTS, readme_path=README)


@unittest.skipUnless(COMMITTED_REPLAY.is_file() and RESULTS.is_dir(), "no committed replay")
class CommittedReplayTests(unittest.TestCase):
    def test_committed_replay_is_valid_and_its_final_matches_the_results(self) -> None:
        replay = json.loads(COMMITTED_REPLAY.read_text(encoding="utf-8"))
        self.assertEqual(validate_replay(replay), [])
        self.assertLess(COMMITTED_REPLAY.stat().st_size, 3_000_000)
        expected = final_from_results(RESULTS, README, replay["meta"]["probe"]["pairId"])
        self.assertEqual(replay["final"], json.loads(json.dumps(expected)))
        self.assertEqual(replay["meta"]["run"], "demo")
        self.assertIn("five-seed ensemble", replay["meta"]["notice"])


if __name__ == "__main__":
    unittest.main()
