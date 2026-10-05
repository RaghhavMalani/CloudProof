"""Build ``web/observatory/replay.json`` for the GNN Observatory page.

Run from the repository root::

    # Train one seed for a few epochs with the tap on, then export (laptop CPU, a few minutes)
    python -m ml.cloudproof.export_observatory demo

    # Re-export an existing tap file without training
    python -m ml.cloudproof.export_observatory export

The replay is a *demo run*: one seed, a short schedule and a prefix of the frozen
training split, so it shows how the unchanged ``HeterogeneousRiskGNN`` trains and
reasons on a real probe pair, not the published result. The published Phase
II-B.2 numbers come from the full five-seed ensemble; ``final`` copies them from
the committed result JSON and the supported-claim sentence from README.md, so
nothing in ``final`` is recomputed or typed in here.

Graphs come from the corpus records (readable pod, node and zone names), and the
export proves they are exactly the tensors the tap fed the model.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import platform
import re
import sys
import time
from typing import Any

import torch

from .constants import (
    ENSEMBLE_SEEDS,
    NODE_FEATURE_NAMES,
    RELATION_ENDPOINTS,
    RELATION_TYPES,
    RESOURCE_TYPES,
)
from .dataset import CausalCorpusManifest, iter_jsonl, label_balance
from .model import RelationLayer
from .perturb import EDGE_DESTRUCTION_MODES
from .phase_ii_b2 import FROZEN_RECIPE, RECIPE_KWARGS, _git_state, _relational_pair_checks, _repo_relative
from .runtime import sha256_file
from .tensorize import CloudProofTensorizer, collate_graphs
from .train import config_for_ablation, train_member
from .viz_tap import PROBE_VARIANTS, VizTapSpec, probe_provenance, probe_samples, read_tap, select_probe_pair


REPOSITORY = Path(__file__).resolve().parents[2]
REPLAY_KIND = "cloudproof.gnn-observatory-replay"
REPLAY_SCHEMA_VERSION = 1
DEFAULT_CORPUS = REPOSITORY / "artifacts" / "cloudproof" / "causal-corpus-v2"
DEFAULT_FREEZE = REPOSITORY / "CLOUDPROOF-PHASE-II-A2-CORPUS-FREEZE.json"
DEFAULT_RESULTS = REPOSITORY / "artifacts" / "cloudproof" / "phase-ii-b2"
DEFAULT_README = REPOSITORY / "README.md"
DEFAULT_TAP = REPOSITORY / "artifacts" / "cloudproof" / "observatory" / "tap.jsonl"
DEFAULT_OUT = REPOSITORY / "web" / "observatory" / "replay.json"
MAX_REPLAY_BYTES = 2_900_000

# The demo schedule (about a minute of single-thread laptop CPU). Everything else
# is the frozen Phase II-B.2 recipe.
DEMO = {
    "seed": ENSEMBLE_SEEDS[0],
    "epochs": 4,
    "maxTrainRecords": 24000,
    "maxValidationRecords": 4000,
    "every": 8,
    "split": "test",
}

# Published rows, in table order. Labels are page copy; every number is read from
# counterfactual-ranking.json. Seeded modes expand over the file's own edgeSeeds.
PUBLISHED_ROWS = (
    ("pooled-mlp-k5", "full", "Pooled MLP (topology-blind)"),
    ("gnn-full-k5", "full", "Full GNN"),
    ("gnn-full-k5", "no-edges", "GNN, all edges removed"),
    ("gnn-full-k5", "randomized-edges", "GNN, edges permuted, degrees kept"),
    ("gnn-full-k5", "rewired-edges", "GNN, edges uniformly rewired"),
    ("gnn-full-k5", "collapsed-edge-types", "GNN, relation transforms averaged"),
    ("gnn-full-k5", "random-relation-labels", "GNN, each relation through a wrong transform"),
    ("gnn-clock-blind-k5", "full", "Clock-blind GNN"),
)
SUPPORTED_CLAIM = re.compile(r"\*\*The supported claim is exactly this:\*\*\s*\*(?P<claim>[^*]+)\*")


# ---------------------------------------------------------------------------
# final: the published numbers, read from the committed result JSON
# ---------------------------------------------------------------------------


def supported_claim(readme_path: str | Path) -> str:
    text = Path(readme_path).read_text(encoding="utf-8")
    match = SUPPORTED_CLAIM.search(text)
    if match is None:
        raise ValueError(f"{readme_path} has no 'The supported claim is exactly this' sentence")
    return " ".join(match.group("claim").split())


def _source(path: Path) -> dict[str, str]:
    return {"path": _repo_relative(path), "sha256": sha256_file(path)}


def final_from_results(results_directory: str | Path, readme_path: str | Path, probe_pair_id: str | None) -> dict[str, Any]:
    root = Path(results_directory)
    ranking_path = root / "counterfactual-ranking.json"
    tests_path = root / "statistical-tests.json"
    audit_path = root / "pair-audit.json"
    ranking = json.loads(ranking_path.read_text(encoding="utf-8"))
    tests = json.loads(tests_path.read_text(encoding="utf-8"))
    audit = json.loads(audit_path.read_text(encoding="utf-8"))
    rows = []
    for artifact, mode, label in PUBLISHED_ROWS:
        modes = ranking["artifacts"][artifact]
        keys = [f"{mode}@{seed}" for seed in ranking["edgeSeeds"]] if f"{mode}@{ranking['edgeSeeds'][0]}" in modes else [mode]
        for key in keys:
            value = modes[key]["relationalOnly"]
            interval = value["bootstrap95TieAware"]
            rows.append({
                "artifact": artifact,
                "mode": key,
                "baseMode": mode,
                "edgeSeed": int(key.split("@")[1]) if "@" in key else None,
                "label": label,
                "pairs": value["pairs"],
                "correct": value["correct"],
                "wrong": value["wrong"],
                "ties": value["ties"],
                "tieAwareAccuracy": value["tieAwareAccuracy"],
                "bootstrap95": [interval["lower"], interval["upper"]],
                "pValue": value["binomialTiesExcluded"]["pValue"],
            })
    probe = None
    if probe_pair_id is not None:
        entry = next((item for item in audit["pairs"] if item.get("pairId") == probe_pair_id), None)
        if entry is not None:
            probe = {
                "pairId": entry["pairId"],
                "family": entry.get("family"),
                "riskier": entry.get("riskier"),
                "margins": {key: entry["margins"][key] for key in sorted(entry["margins"])},
                "marginDefinition": "risk(riskier member) - risk(safer member), five-member ensemble mean",
            }
    attribution = tests["attribution"]
    return {
        "phase": ranking["phase"],
        "primaryTest": ranking["primaryTest"],
        "tieTolerance": ranking["tieTolerance"],
        "pairs": ranking["counts"]["relationalOnlyDiscordant"],
        "graphAttribution": attribution["graphAttribution"],
        "criteria": {name: bool(condition["passed"]) for name, condition in attribution["conditions"].items()},
        "rows": rows,
        "probePair": probe,
        "supportedClaim": supported_claim(readme_path),
        "sources": {
            "counterfactualRanking": _source(ranking_path),
            "statisticalTests": _source(tests_path),
            "pairAudit": _source(audit_path),
            "claim": {"path": _repo_relative(readme_path)},
        },
    }


# ---------------------------------------------------------------------------
# graphs: the probe topologies from the corpus records
# ---------------------------------------------------------------------------


def _label(node_id: str) -> str:
    return node_id.split("/", 1)[-1]


def _round(values, digits: int = 4) -> list[float]:
    return [round(float(value), digits) for value in values]


def _graph_payload(graph_index: int, record: dict, sample, header: dict) -> dict[str, Any]:
    node_batches = header["probeNodeBatches"]
    by_batch: dict[tuple[str, int], str] = {}
    nodes = []
    for node_type in RESOURCE_TYPES:
        # The tensorizer's own order: nodes of one type sorted by ID.
        ordered = sorted(
            (node for node in record["state"]["nodes"] if node["type"] == node_type), key=lambda node: str(node["id"])
        )
        positions = [index for index, graph in enumerate(node_batches[node_type]) if graph == graph_index]
        if not (len(ordered) == len(positions) == sample.node_features[node_type].shape[0]):
            raise ValueError(f"{record['recordId']}: {node_type} count differs between record, sample and tap")
        for local, (node, batch_index) in enumerate(zip(ordered, positions)):
            by_batch[(node_type, batch_index)] = node["id"]
            nodes.append({
                "id": node["id"],
                "type": node_type,
                "label": _label(node["id"]),
                "features": node.get("features") or {},
                "encoded": dict(zip(NODE_FEATURE_NAMES[node_type], _round(sample.node_features[node_type][local].tolist()))),
                "index": local,
                "batchIndex": batch_index,
            })

    def edges_for(mode: str) -> list[dict[str, Any]]:
        edges = []
        for relation in RELATION_TYPES:
            source_type, target_type = RELATION_ENDPOINTS[relation]
            sources, targets = header["probeEdges"][mode][relation]
            for slot, (source, target) in enumerate(zip(sources, targets)):
                if node_batches[source_type][source] != graph_index:
                    continue
                if node_batches[target_type][target] != graph_index:
                    raise ValueError(f"{mode} {relation} edge crosses probe graphs")
                edges.append({
                    "rel": relation,
                    "from": by_batch[(source_type, source)],
                    "to": by_batch[(target_type, target)],
                    "slot": slot,
                })
        return edges

    edges = edges_for("full")
    corpus_edges = sorted((edge["type"], edge["from"], edge["to"]) for edge in record["state"]["edges"])
    if sorted((edge["rel"], edge["from"], edge["to"]) for edge in edges) != corpus_edges:
        raise ValueError(f"{record['recordId']}: tap edges differ from the corpus record")
    target = None
    for node_type, (graphs, rows) in header["probeTargets"].items():
        for graph, row in zip(graphs, rows):
            if graph == graph_index:
                target = by_batch[(node_type, row)]
    labels = record.get("labels") or {}
    return {
        "variant": record["variant"],
        "recordId": record["recordId"],
        "arm": record.get("arm"),
        "role": record.get("role"),
        "outcome": {
            "trajectoryUnsafe": bool(labels.get("trajectoryUnsafe")),
            "sloViolationWithinKTransitions": bool(labels.get("sloViolationWithinKTransitions")),
            "incidentClass": labels.get("incidentClass"),
        },
        "action": record["action"],
        "target": target,
        "nodes": nodes,
        "edges": edges,
        "edgesByMode": {mode: edges_for(mode) for mode in header["modes"] if mode != "full"},
    }


def graphs_from_pair(pair: dict[str, dict], header: dict, tensorizer: CloudProofTensorizer | None = None) -> tuple[list[dict], dict]:
    tensorizer = tensorizer or CloudProofTensorizer()
    if header["probeRecordIds"] != [pair[variant]["recordId"] for variant in PROBE_VARIANTS]:
        raise ValueError("the tap was recorded for a different probe pair")
    samples = probe_samples(pair, tensorizer)
    batch = collate_graphs(list(samples))
    for relation in RELATION_TYPES:
        if batch.edges[relation].tolist() != header["probeEdges"]["full"][relation]:
            raise ValueError(f"tap {relation} edges are not the tensors of this pair")
    pair_id = pair["A"]["pairId"]
    # The research code's own construction check: identical pooled node features
    # and action, different relation tensors. It raises otherwise.
    _relational_pair_checks(pair_id, pair, tensorizer, require_relation_difference=True)
    differing = [name for name in RELATION_TYPES if not torch.equal(samples[0].edges[name], samples[1].edges[name])]
    graphs = [_graph_payload(index, pair[variant], samples[index], header) for index, variant in enumerate(PROBE_VARIANTS)]
    checks = {
        "pooledInputsIdentical": True,
        "actionIdentical": True,
        "relationsDiffer": differing,
        "check": "ml.cloudproof.phase_ii_b2._relational_pair_checks (sorted node-feature rows and action vector equal)",
    }
    return graphs, checks


def relation_label_map() -> dict[str, str]:
    """Which relation's transform ``random-relation-labels`` routes each relation through.

    Read off ``RelationLayer._messages`` itself rather than restated, so the page's
    recolouring cannot drift from the model code.
    """
    with torch.random.fork_rng(devices=[]):
        torch.manual_seed(0)
        layer = RelationLayer(4, 0.0, use_edge_types=True).eval()
        values = torch.randn(3, 4)
    mapping = {}
    with torch.no_grad():
        for relation in RELATION_TYPES:
            routed = layer._messages(layer.forward_transforms, relation, values, "random-relation-labels")
            matches = [name for name in RELATION_TYPES if torch.equal(routed, layer.forward_transforms[name](values))]
            if len(matches) != 1:
                raise ValueError(f"cannot identify the transform random-relation-labels uses for {relation}")
            mapping[relation] = matches[0]
    return mapping


# ---------------------------------------------------------------------------
# frames, schema and assembly
# ---------------------------------------------------------------------------


def _frame(row: dict) -> dict:
    return {key: value for key, value in row.items() if key != "kind"}


def downsample(frames: list[dict], keep: int) -> list[dict]:
    """Keep init, epoch and best frames and an even spread of step frames."""
    fixed = [index for index, frame in enumerate(frames) if frame["phase"] != "step"]
    steps = [index for index, frame in enumerate(frames) if frame["phase"] == "step"]
    room = max(0, keep - len(fixed))
    if len(steps) > room:
        steps = [steps[round(position * (len(steps) - 1) / max(1, room - 1))] for position in range(room)] if room else []
    chosen = sorted(set(fixed) | set(steps))
    return [frames[index] for index in chosen]


def _encoded(replay: dict) -> str:
    return json.dumps(replay, separators=(",", ":"), allow_nan=False, ensure_ascii=False)


def build_replay(
    section: dict,
    pair: dict[str, dict],
    *,
    results_directory: str | Path,
    readme_path: str | Path,
    max_bytes: int = MAX_REPLAY_BYTES,
    tensorizer: CloudProofTensorizer | None = None,
) -> dict[str, Any]:
    header = section["header"]
    graphs, checks = graphs_from_pair(pair, header, tensorizer)
    recorded = [_frame(row) for row in section["frames"]]
    if not recorded:
        raise ValueError("the tap section has no frames")
    final = final_from_results(results_directory, readme_path, pair["A"]["pairId"])
    replay = {
        "kind": REPLAY_KIND,
        "schemaVersion": REPLAY_SCHEMA_VERSION,
        "meta": {
            "run": "demo",
            "notice": (
                "Replay of a short demo run (one seed, a few epochs on a prefix of the frozen training split). "
                "The published numbers come from the full five-seed ensemble (Phase II-B.2)."
            ),
            "seed": header.get("seed"),
            "model": header["model"],
            "training": header.get("training"),
            "tap": {
                "everySteps": header["everySteps"],
                "edgeSeed": header["edgeSeed"],
                "modes": header["modes"],
                "relationModes": header["relationModes"],
                "framesRecorded": len(recorded),
                "steps": max(frame["step"] for frame in recorded),
            },
            "probe": {**header.get("probe", {}), **checks},
            "corpus": header.get("corpus"),
            "git": {key: value for key, value in _git_state().items() if key != "dirtyPaths"},
            "environment": {"python": sys.version.split()[0], "torch": torch.__version__, "platform": platform.system()},
            "vocabulary": {
                "resourceTypes": list(RESOURCE_TYPES),
                "relationTypes": list(RELATION_TYPES),
                "relationEndpoints": {name: list(value) for name, value in RELATION_ENDPOINTS.items()},
                "nodeFeatureNames": {name: list(value) for name, value in NODE_FEATURE_NAMES.items()},
                "randomRelationLabels": relation_label_map(),
            },
        },
        "graphs": graphs,
        "frames": recorded,
        "final": final,
    }
    keep = len(recorded)
    while len(_encoded(replay).encode("utf-8")) > max_bytes:
        if keep <= 2:
            raise ValueError("the replay does not fit the byte budget even with two frames")
        keep = max(2, int(keep * 0.85))
        replay["frames"] = downsample(recorded, keep)
    replay["meta"]["tap"]["framesKept"] = len(replay["frames"])
    errors = validate_replay(replay)
    if errors:
        raise ValueError("invalid replay:\n  " + "\n  ".join(errors))
    return replay


def validate_replay(replay: Any) -> list[str]:
    """Structural checks the page relies on. Returns a list of problems (empty = valid)."""
    errors: list[str] = []

    def need(condition: bool, message: str) -> bool:
        if not condition:
            errors.append(message)
        return condition

    if not need(isinstance(replay, dict), "replay is not an object"):
        return errors
    need(replay.get("kind") == REPLAY_KIND, "kind")
    need(replay.get("schemaVersion") == REPLAY_SCHEMA_VERSION, "schemaVersion")
    for key in ("meta", "graphs", "frames", "final"):
        need(key in replay, f"missing {key}")
    if errors:
        return errors
    meta, graphs, frames, final = replay["meta"], replay["graphs"], replay["frames"], replay["final"]
    modes = (meta.get("tap") or {}).get("modes") or []
    need(list(modes) == list(EDGE_DESTRUCTION_MODES), "meta.tap.modes must list every edge-destruction mode")
    layer_count = ((meta.get("model") or {}).get("config") or {}).get("layers")
    need(isinstance(layer_count, int) and layer_count > 0, "meta.model.config.layers")
    for key in ("seed", "corpus", "probe", "git", "notice"):
        need(meta.get(key) not in (None, ""), f"meta.{key}")
    need(bool((meta.get("corpus") or {}).get("manifestSha256")), "meta.corpus.manifestSha256")
    label_map = (meta.get("vocabulary") or {}).get("randomRelationLabels") or {}
    need(set(label_map) == set(RELATION_TYPES) and set(label_map.values()) <= set(RELATION_TYPES),
         "meta.vocabulary.randomRelationLabels")
    need((meta.get("probe") or {}).get("pooledInputsIdentical") is True, "meta.probe.pooledInputsIdentical")

    need(isinstance(graphs, list) and len(graphs) == 2, "graphs must hold the two pair members")
    type_counts = {node_type: 0 for node_type in RESOURCE_TYPES}
    slots = {relation: 0 for relation in RELATION_TYPES}
    for graph in graphs if isinstance(graphs, list) else []:
        ids = {node["id"] for node in graph.get("nodes", [])}
        need(len(ids) == len(graph.get("nodes", [])), f"graph {graph.get('variant')}: duplicate node IDs")
        for node in graph.get("nodes", []):
            need(node.get("type") in RESOURCE_TYPES, f"node {node.get('id')}: type")
            need(isinstance(node.get("batchIndex"), int), f"node {node.get('id')}: batchIndex")
            if node.get("type") in type_counts:
                type_counts[node["type"]] += 1
        need(graph.get("target") is None or graph.get("target") in ids, f"graph {graph.get('variant')}: target")
        for mode_edges in [graph.get("edges", []), *(graph.get("edgesByMode") or {}).values()]:
            for edge in mode_edges:
                need(edge.get("rel") in RELATION_TYPES, f"edge relation {edge.get('rel')}")
                need(edge.get("from") in ids and edge.get("to") in ids, f"edge {edge} endpoints")
        for edge in graph.get("edges", []):
            if edge.get("rel") in slots:
                slots[edge["rel"]] += 1
        need(set(graph.get("edgesByMode") or {}) == set(modes) - {"full"}, f"graph {graph.get('variant')}: edgesByMode")

    need(isinstance(frames, list) and len(frames) >= 2, "frames")
    previous_step = -1
    for index, frame in enumerate(frames if isinstance(frames, list) else []):
        where = f"frames[{index}]"
        need(frame.get("phase") in {"init", "step", "epoch", "best"}, f"{where}.phase")
        need(isinstance(frame.get("step"), int) and frame["step"] >= previous_step, f"{where}.step must not decrease")
        previous_step = frame.get("step", previous_step)
        risk = frame.get("risk") or {}
        need(set(risk) == set(modes), f"{where}.risk modes")
        for mode, values in risk.items():
            need(len(values) == 2 and all(0.0 <= value <= 1.0 for value in values), f"{where}.risk.{mode}")
        layers = frame.get("layers") or []
        need(len(layers) == layer_count, f"{where}.layers count")
        for states in [frame.get("embed") or {}, *layers]:
            for node_type in RESOURCE_TYPES:
                need(len(states.get(node_type, [])) == type_counts[node_type], f"{where} {node_type} norms")
        messages = frame.get("msg") or []
        need(len(messages) == layer_count, f"{where}.msg count")
        for layer in messages:
            for relation in RELATION_TYPES:
                need(len((layer.get(relation) or {}).get("forward", [])) == slots[relation], f"{where}.msg {relation}")
        need(set((frame.get("ablation") or {})) == set(modes) - {"full"}, f"{where}.ablation modes")
        need(set(frame.get("relW") or {}) == set(RELATION_TYPES), f"{where}.relW relations")
        if errors:
            break

    rows = final.get("rows") or []
    need(len(rows) > 0, "final.rows")
    for row in rows:
        need(isinstance(row.get("tieAwareAccuracy"), float), f"final row {row.get('artifact')} {row.get('mode')}")
    need(isinstance(final.get("supportedClaim"), str) and len(final["supportedClaim"]) > 40, "final.supportedClaim")
    need(final.get("graphAttribution") in {"PASSED", "FAILED"}, "final.graphAttribution")
    return errors


def write_replay(replay: dict, out: str | Path) -> int:
    destination = Path(out)
    destination.parent.mkdir(parents=True, exist_ok=True)
    data = (_encoded(replay) + "\n").encode("utf-8")
    destination.write_bytes(data)
    return len(data)


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------


def _pair_by_id(pairs_path: Path, pair_id: str) -> dict[str, dict]:
    pair = {}
    for record in iter_jsonl(pairs_path):
        if record.get("pairId") == pair_id:
            pair[record["variant"]] = record
    if set(pair) != set(PROBE_VARIANTS):
        raise ValueError(f"{pair_id} is not a complete pair in {pairs_path}")
    return pair


def export_command(args: argparse.Namespace) -> dict:
    sections = read_tap(args.tap)
    matching = [section for section in sections if args.seed is None or section["header"].get("seed") == args.seed]
    if not matching:
        raise ValueError(f"no tap section for seed {args.seed} in {args.tap}")
    section = matching[0]
    header = section["header"]
    manifest = CausalCorpusManifest(args.corpus)
    pairs_path = manifest.auxiliary_path("pairs")
    recorded = (header.get("corpus") or {}).get("files", {}).get("counterfactual-pairs.jsonl")
    if recorded and recorded != (manifest.value.get("files") or {}).get("counterfactual-pairs.jsonl", {}).get("sha256"):
        raise ValueError("the corpus pair file differs from the one the tap recorded")
    pair = _pair_by_id(pairs_path, header["probe"]["pairId"])
    replay = build_replay(section, pair, results_directory=args.results, readme_path=args.readme, max_bytes=args.max_bytes)
    size = write_replay(replay, args.out)
    summary = {
        "out": _repo_relative(args.out),
        "bytes": size,
        "frames": len(replay["frames"]),
        "framesRecorded": replay["meta"]["tap"]["framesRecorded"],
        "probe": replay["meta"]["probe"]["pairId"],
        "finalRisk": dict(zip(("A", "B"), replay["frames"][-1]["risk"]["full"])),
    }
    print(json.dumps(summary, indent=2))
    return summary


def demo_command(args: argparse.Namespace) -> dict:
    started = time.perf_counter()
    torch.set_num_threads(args.threads)
    manifest = CausalCorpusManifest(args.corpus)
    verified = manifest.verify_hashes()
    freeze = manifest.verify_freeze(args.freeze, verified)
    pair = select_probe_pair(manifest.auxiliary_path("pairs"), split=args.split)
    tensorizer = CloudProofTensorizer()
    train_path = manifest.path_for("train")
    balance = label_balance(train_path, args.max_train_records)
    weighted = balance.positive_rate < 0.25 or balance.positive_rate > 0.75
    pos_weight = balance.negative / balance.positive if weighted else 1.0
    recipe = {key: RECIPE_KWARGS[key] for key in ("learning_rate", "weight_decay", "batch_size", "shuffle_buffer")}
    config = config_for_ablation("full", RECIPE_KWARGS["hidden_dim"], RECIPE_KWARGS["layers"], RECIPE_KWARGS["dropout"])
    provenance = probe_provenance(manifest.directory, pair, split=args.split)
    provenance["corpus"].update({"freezeFile": _repo_relative(args.freeze), "hashesVerified": True, "freezeVerified": freeze["acceptancePassed"]})
    header = {
        **provenance,
        "training": {
            "run": "demo",
            "epochs": args.epochs,
            "patience": args.epochs,
            "maxTrainRecords": args.max_train_records,
            "maxValidationRecords": args.max_validation_records,
            "learningRate": recipe["learning_rate"],
            "weightDecay": recipe["weight_decay"],
            "batchSize": recipe["batch_size"],
            "shuffleBuffer": recipe["shuffle_buffer"],
            "positiveWeight": pos_weight,
            "transitionLabelBalance": balance.to_dict(),
            "torchThreads": args.threads,
            "labelField": tensorizer.describe()["labelField"],
            "recipe": "Phase II-B.2 frozen recipe (FROZEN_RECIPE) except epochs and the training prefix",
            "architecture": FROZEN_RECIPE["architecture"],
        },
    }
    spec = VizTapSpec(path=Path(args.tap), probe_batch=probe_samples(pair, tensorizer), every=args.every, header=header)
    model, member = train_member(
        seed=args.seed,
        config=config,
        train_path=train_path,
        validation_path=manifest.path_for("validation"),
        epochs=args.epochs,
        patience=args.epochs,
        pos_weight=pos_weight,
        max_train_records=args.max_train_records,
        max_validation_records=args.max_validation_records,
        device="cpu",
        tensorizer=tensorizer,
        viz_tap=spec,
        **recipe,
    )
    del model
    print(json.dumps({"bestEpoch": member["bestEpoch"], "bestValidationNll": round(member["bestValidationNll"], 4),
                      "trainingSeconds": round(time.perf_counter() - started, 1)}))
    return export_command(argparse.Namespace(
        tap=args.tap, seed=args.seed, corpus=args.corpus, results=args.results,
        readme=args.readme, out=args.out, max_bytes=args.max_bytes,
    ))


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="command", required=True)

    def shared(command: argparse.ArgumentParser) -> None:
        command.add_argument("--corpus", type=Path, default=DEFAULT_CORPUS)
        command.add_argument("--results", type=Path, default=DEFAULT_RESULTS)
        command.add_argument("--readme", type=Path, default=DEFAULT_README)
        command.add_argument("--tap", type=Path, default=DEFAULT_TAP)
        command.add_argument("--out", type=Path, default=DEFAULT_OUT)
        command.add_argument("--max-bytes", type=int, default=MAX_REPLAY_BYTES)

    demo = commands.add_parser("demo", help="train one seed with the tap on, then export")
    shared(demo)
    demo.add_argument("--freeze", type=Path, default=DEFAULT_FREEZE)
    demo.add_argument("--seed", type=int, default=DEMO["seed"])
    demo.add_argument("--epochs", type=int, default=DEMO["epochs"])
    demo.add_argument("--max-train-records", type=int, default=DEMO["maxTrainRecords"])
    demo.add_argument("--max-validation-records", type=int, default=DEMO["maxValidationRecords"])
    demo.add_argument("--every", type=int, default=DEMO["every"])
    demo.add_argument("--split", default=DEMO["split"], help="split the probe pair is drawn from")
    demo.add_argument("--threads", type=int, default=1)
    demo.set_defaults(handler=demo_command)

    export = commands.add_parser("export", help="export an existing tap file")
    shared(export)
    export.add_argument("--seed", type=int, help="tap section to export (default: the first)")
    export.set_defaults(handler=export_command)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> None:
    args = parse_args(argv)
    args.handler(args)


if __name__ == "__main__":
    main()
