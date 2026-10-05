"""GNN Observatory tap: it observes training without changing it."""

from __future__ import annotations

import json
from pathlib import Path
import random
import shutil
import tempfile
import unittest

import numpy as np
import torch

from ml.cloudproof.constants import RELATION_TYPES, RESOURCE_TYPES
from ml.cloudproof.model import ModelConfig, build_model
from ml.cloudproof.perturb import EDGE_DESTRUCTION_MODES
from ml.cloudproof.tensorize import CloudProofTensorizer
from ml.cloudproof.tests.helpers import REPOSITORY
from ml.cloudproof.train import seed_everything, train_member
from ml.cloudproof.viz_tap import (
    TAP_KIND,
    VizTap,
    VizTapSpec,
    probe_samples,
    read_tap,
    select_probe_pair,
)


RELATIONAL_FIXTURE = REPOSITORY / "artifacts" / "cloudproof" / "datasets" / "relational-pairs-95000.jsonl"


def _training_files(directory: Path) -> tuple[Path, Path]:
    """Eight real relational-pair rows to train on and four to validate on."""
    rows = [line for line in RELATIONAL_FIXTURE.read_text(encoding="utf-8").splitlines() if line.strip()]
    directory.mkdir(parents=True, exist_ok=True)
    train = directory / "transitions-train.jsonl"
    validation = directory / "transitions-validation.jsonl"
    train.write_text("\n".join(rows) + "\n", encoding="utf-8")
    validation.write_text("\n".join(rows[:4]) + "\n", encoding="utf-8")
    return train, validation


def _train(directory: Path, viz_tap: VizTapSpec | None):
    train, validation = _training_files(directory)
    return train_member(
        seed=1337,
        # Dropout above zero makes every training step draw from the global RNG, so
        # a tap that consumed random numbers would change the weights.
        config=ModelConfig(hidden_dim=8, layers=2, dropout=0.25),
        train_path=train,
        validation_path=validation,
        epochs=3,
        patience=3,
        learning_rate=1e-2,
        weight_decay=1e-4,
        batch_size=3,
        shuffle_buffer=4,
        pos_weight=1.0,
        max_train_records=None,
        max_validation_records=None,
        device="cpu",
        viz_tap=viz_tap,
    )


@unittest.skipUnless(RELATIONAL_FIXTURE.is_file(), "relational fixture not generated")
class VizTapTests(unittest.TestCase):
    def setUp(self) -> None:
        self.directory = Path(tempfile.mkdtemp())
        self.pair = select_probe_pair(RELATIONAL_FIXTURE, split="train")
        self.probe = probe_samples(self.pair)

    def tearDown(self) -> None:
        shutil.rmtree(self.directory, ignore_errors=True)

    def test_training_with_the_tap_gives_bit_identical_weights(self) -> None:
        plain_model, plain_member = _train(self.directory / "plain", None)
        tap_path = self.directory / "tap.jsonl"
        tapped_model, tapped_member = _train(
            self.directory / "tapped", VizTapSpec(path=tap_path, probe_batch=self.probe, every=1)
        )
        plain_state, tapped_state = plain_model.state_dict(), tapped_model.state_dict()
        self.assertEqual(plain_state.keys(), tapped_state.keys())
        for name, value in plain_state.items():
            self.assertTrue(torch.equal(value, tapped_state[name]), name)
        self.assertEqual(plain_member, tapped_member)
        # The tap really ran: a frame after every one of the optimizer steps.
        frames = read_tap(tap_path)[0]["frames"]
        steps = [frame["step"] for frame in frames if frame["phase"] == "step"]
        self.assertEqual(steps, list(range(1, len(steps) + 1)))
        self.assertGreaterEqual(len(steps), 6)

    def test_emit_leaves_rng_mode_gradients_and_hooks_untouched(self) -> None:
        seed_everything(7)
        model = build_model(ModelConfig(hidden_dim=8, layers=2, dropout=0.25))
        for parameter in model.parameters():
            parameter.grad = torch.full_like(parameter, 0.5)
        tap = VizTap(model, self.probe, self.directory / "tap.jsonl", every=1)
        for training in (True, False):
            model.train(training)
            torch_state, python_state, numpy_state = torch.get_rng_state(), random.getstate(), np.random.get_state()
            tap.emit(step=1, epoch=1, train_loss=0.5)
            self.assertTrue(torch.equal(torch_state, torch.get_rng_state()))
            self.assertEqual(python_state, random.getstate())
            numpy_after = np.random.get_state()
            self.assertTrue(np.array_equal(numpy_state[1], numpy_after[1]))
            self.assertEqual(numpy_state[2:], numpy_after[2:])
            self.assertEqual(model.training, training)
            self.assertTrue(all(layer.training == training for layer in model.modules()))
            for layer in model.message_layers:
                self.assertEqual(len(layer._forward_hooks), 0)
            for parameter in model.parameters():
                self.assertTrue(torch.equal(parameter.grad, torch.full_like(parameter, 0.5)))

    def test_rows_cover_every_mode_layer_node_and_edge(self) -> None:
        tap_path = self.directory / "tap.jsonl"
        model, member = _train(self.directory / "run", VizTapSpec(path=tap_path, probe_batch=self.probe, every=2))
        sections = read_tap(tap_path)
        self.assertEqual(len(sections), 1)
        header, frames = sections[0]["header"], sections[0]["frames"]
        self.assertEqual(header["kind"], f"{TAP_KIND}.header")
        self.assertEqual(header["seed"], 1337)
        self.assertEqual(header["probeRecordIds"], [self.pair["A"]["recordId"], self.pair["B"]["recordId"]])
        self.assertEqual(header["modes"], list(EDGE_DESTRUCTION_MODES))
        phases = [frame["phase"] for frame in frames]
        self.assertEqual(phases[0], "init")
        self.assertEqual(phases[-1], "best")
        self.assertEqual(phases.count("epoch"), len(member["history"]))
        self.assertTrue(all(frame["step"] % 2 == 0 for frame in frames if frame["phase"] == "step"))
        epoch_frames = [frame for frame in frames if frame["phase"] == "epoch"]
        for frame, history in zip(epoch_frames, member["history"], strict=True):
            self.assertAlmostEqual(frame["validation"]["nll"], history["validation"]["nll"], places=5)
            self.assertAlmostEqual(frame["trainLoss"], history["trainLoss"], places=5)

        node_counts = {node_type: len(header["probeNodeBatches"][node_type]) for node_type in RESOURCE_TYPES}
        for frame in frames:
            self.assertEqual(set(frame["risk"]), set(EDGE_DESTRUCTION_MODES))
            for mode, risks in frame["risk"].items():
                self.assertEqual(len(risks), 2, mode)
                self.assertTrue(all(0.0 <= value <= 1.0 for value in risks), mode)
            # The pair's pooled inputs are identical, so with every edge removed the
            # two members are the same input and must score the same.
            self.assertEqual(frame["risk"]["no-edges"][0], frame["risk"]["no-edges"][1])
            self.assertEqual(len(frame["layers"]), 2)
            for states in [frame["embed"], *frame["layers"]]:
                self.assertEqual({key: len(value) for key, value in states.items()}, node_counts)
            self.assertEqual(set(frame["relW"]), set(RELATION_TYPES))
            self.assertTrue(all(len(norms["forward"]) == 2 for norms in frame["relW"].values()))
            for mode in EDGE_DESTRUCTION_MODES:
                messages = frame["msg"] if mode == "full" else frame["ablation"][mode]["msg"]
                for layer in messages:
                    for relation in RELATION_TYPES:
                        expected = len(header["probeEdges"][mode][relation][0])
                        self.assertEqual(len(layer[relation]["forward"]), expected, (mode, relation))
                        self.assertEqual(len(layer[relation]["reverse"]), expected, (mode, relation))
        # The last frame describes the restored best checkpoint the caller receives.
        tap = VizTap(model, self.probe, self.directory / "check.jsonl", every=1)
        check = tap.emit(step=0, epoch=0, train_loss=None)
        self.assertEqual(check["risk"], frames[-1]["risk"])
        self.assertEqual(check["layers"], frames[-1]["layers"])

    def test_appended_sections_are_read_back_per_member(self) -> None:
        tap_path = self.directory / "tap.jsonl"
        seed_everything(1)
        first = build_model(ModelConfig(hidden_dim=8, layers=2, dropout=0.0))
        second = build_model(ModelConfig(hidden_dim=8, layers=2, dropout=0.0))
        VizTap(first, self.probe, tap_path, header={"seed": 1}).emit(step=0, epoch=0, train_loss=None, phase="init")
        VizTap(second, self.probe, tap_path, header={"seed": 2}, append=True).emit(step=0, epoch=0, train_loss=None, phase="init")
        sections = read_tap(tap_path)
        self.assertEqual([section["header"]["seed"] for section in sections], [1, 2])
        self.assertEqual([len(section["frames"]) for section in sections], [1, 1])
        rows = [json.loads(line) for line in tap_path.read_text(encoding="utf-8").splitlines()]
        self.assertEqual(len(rows), 4)

    def test_tap_rejects_models_without_message_layers(self) -> None:
        with self.assertRaises(TypeError):
            VizTap(build_model(ModelConfig(flat_mlp=True)), self.probe, self.directory / "tap.jsonl")
        with self.assertRaises(ValueError):
            VizTap(build_model(ModelConfig(hidden_dim=8)), self.probe, self.directory / "tap.jsonl", every=0)


@unittest.skipUnless(RELATIONAL_FIXTURE.is_file(), "relational fixture not generated")
class ProbeSelectionTests(unittest.TestCase):
    def test_rule_takes_the_first_relational_only_discordant_pair(self) -> None:
        pair = select_probe_pair(RELATIONAL_FIXTURE, split="train")
        # The fixture holds four relational-only pairs; only pair-00020 flips the outcome.
        self.assertEqual(pair["A"]["pairId"], "pair-00020")
        self.assertNotEqual(pair["A"]["labels"]["trajectoryUnsafe"], pair["B"]["labels"]["trajectoryUnsafe"])
        with self.assertRaises(ValueError):
            select_probe_pair(RELATIONAL_FIXTURE, split="test")

    def test_probe_members_share_pooled_inputs_and_differ_in_wiring(self) -> None:
        control, treated = probe_samples(select_probe_pair(RELATIONAL_FIXTURE, split="train"), CloudProofTensorizer())
        for node_type in RESOURCE_TYPES:
            self.assertEqual(
                sorted(map(tuple, control.node_features[node_type].tolist())),
                sorted(map(tuple, treated.node_features[node_type].tolist())),
            )
        self.assertTrue(torch.equal(control.action_features, treated.action_features))
        self.assertTrue(any(not torch.equal(control.edges[name], treated.edges[name]) for name in RELATION_TYPES))


if __name__ == "__main__":
    unittest.main()
