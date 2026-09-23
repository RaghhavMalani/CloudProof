"""Render the numeric tables of CLOUDPROOF-PHASE-II-B2.md from the result JSON.

Every table in the report sits between ``<!-- generated:NAME -->`` and
``<!-- /generated:NAME -->`` markers and is produced here from the files under
``artifacts/cloudproof/phase-ii-b2``; no number in a table is typed by hand.
Rendering reads JSON only: no model, corpus row or random draw is touched, so
the output is a pure function of the committed artifacts.

    python -m ml.cloudproof.phase_ii_b2_report            # rewrite the generated blocks
    python -m ml.cloudproof.phase_ii_b2_report --check    # exit 1 if any block is stale
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
import re
import sys
from typing import Any, Callable


REPOSITORY = Path(__file__).resolve().parents[2]
DEFAULT_ROOT = REPOSITORY / "artifacts" / "cloudproof" / "phase-ii-b2"
DEFAULT_DOCUMENT = REPOSITORY / "CLOUDPROOF-PHASE-II-B2.md"
SPLITS = ("validation", "test", "ood")
SPLIT_LABELS = {"validation": "validation", "test": "test", "ood": "OOD", "train": "train"}
FULL, POOLED, CLOCK = "gnn-full-k5", "pooled-mlp-k5", "gnn-clock-blind-k5"
EDGE_SEEDS = (1729, 2729, 3729)
FAMILIES = ("node-concentration", "readiness-wiring", "readiness-drain", "capacity-distribution")
MODEL_LABELS = {FULL: "Full GNN", POOLED: "Pooled MLP", CLOCK: "Clock-blind GNN"}
MODE_LABELS = {
    "full": "intact",
    "no-edges": "no edges",
    "collapsed-edge-types": "collapsed edge types",
    "random-relation-labels": "random relation labels",
    **{f"randomized-edges@{seed}": f"randomized edges @{seed}" for seed in EDGE_SEEDS},
    **{f"rewired-edges@{seed}": f"rewired edges @{seed}" for seed in EDGE_SEEDS},
}
GNN_MODES = (
    "full",
    *(f"randomized-edges@{seed}" for seed in EDGE_SEEDS),
    *(f"rewired-edges@{seed}" for seed in EDGE_SEEDS),
    "no-edges",
    "collapsed-edge-types",
    "random-relation-labels",
)
FIXED_BUDGET_METHODS = {
    "random": "Random (seed 1337)",
    "coverageGuided": "Coverage-guided",
    "heuristic": "Heuristic",
    "logistic": "Logistic",
    "pooledMlp": "Pooled MLP",
    "gnn": "Full GNN",
    "gnnRandomizedEdges": "GNN, randomized edges @1729",
    "gnnRewiredEdges": "GNN, rewired edges @1729",
    "gnnNoEdges": "GNN, no edges",
    "gnnClockBlind": "Clock-blind GNN",
}
BUDGETS = ("100", "500", "1000", "5000")
SUPERSCRIPT = str.maketrans("-0123456789", "⁻⁰¹²³⁴⁵⁶⁷⁸⁹")


# ---------------------------------------------------------------------------
# Formatting
# ---------------------------------------------------------------------------


def _num(value: float | None, digits: int = 3) -> str:
    return "—" if value is None else f"{value:.{digits}f}"


def _signed(value: float | None, digits: int = 3) -> str:
    if value is None:
        return "—"
    text = f"{value:+.{digits}f}"
    return text.replace("-", "−")


def _interval(bounds, digits: int = 3, signed: bool = False) -> str:
    if bounds is None:
        return "—"
    lower, upper = (bounds["lower"], bounds["upper"]) if isinstance(bounds, dict) else bounds
    if lower is None or upper is None:
        return "—"
    render = _signed if signed else _num
    return f"[{render(lower, digits)}, {render(upper, digits)}]"


def _p(value: float | None) -> str:
    if value is None:
        return "—"
    if value >= 0.01:
        return f"{value:.2f}"
    exponent = math.floor(math.log10(value))
    mantissa = value / 10**exponent
    if round(mantissa, 1) >= 10.0:
        mantissa, exponent = mantissa / 10.0, exponent + 1
    return f"{mantissa:.1f} × 10{str(exponent).translate(SUPERSCRIPT)}"


def _count(value: int | float) -> str:
    return f"{round(value):,}".replace(",", " ")


def _table(headers: list[str], rows: list[list[str]], align: str) -> str:
    if len(align) != len(headers) or any(len(row) != len(headers) for row in rows):
        raise ValueError("table shape mismatch")
    rule = ["---:" if code == "r" else "---" for code in align]
    lines = ["| " + " | ".join(headers) + " |", "| " + " | ".join(rule) + " |"]
    lines += ["| " + " | ".join(row) + " |" for row in rows]
    return "\n".join(lines)


def _accuracy_cell(block: dict) -> str:
    wrong = block["pairs"] - block["correct"] - block["ties"]
    return f"{_num(block['tieAwareAccuracy'])} ({block['correct']}/{block['ties']}/{wrong})"


# ---------------------------------------------------------------------------
# Inputs
# ---------------------------------------------------------------------------


def _read(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def load_artifacts(root: Path) -> dict[str, Any]:
    data = {
        name: _read(root / f"{name}.json")
        for name in (
            "config", "frozen-corpus-verification", "metrics", "trajectory-metrics", "counterfactual-ranking",
            "statistical-tests", "ablations", "clock-blind", "fixed-budget", "training-summary", "pair-audit",
        )
    }
    data["models"] = {
        directory.name: {
            "config": _read(directory / "config.json"),
            "metrics": _read(directory / "metrics.json"),
        }
        for directory in sorted((root / "models").iterdir())
        if (directory / "config.json").is_file() and (directory / "metrics.json").is_file()
    }
    return data


def _relational(data: dict, artifact: str, mode: str = "full", subset: str = "relationalOnly") -> dict:
    return data["counterfactual-ranking"]["artifacts"][artifact][mode][subset]


# ---------------------------------------------------------------------------
# Tables
# ---------------------------------------------------------------------------


def headline(data: dict) -> str:
    comparisons = data["statistical-tests"]["comparisons"]
    arms = [(FULL, "full", None), (POOLED, "full", f"{FULL} vs {POOLED}"), (FULL, "no-edges", f"{FULL} vs {FULL}[no-edges]")]
    arms += [(FULL, f"randomized-edges@{seed}", f"{FULL} vs {FULL}[randomized-edges@{seed}]") for seed in EDGE_SEEDS]
    arms += [(FULL, f"rewired-edges@{seed}", f"{FULL} vs {FULL}[rewired-edges@{seed}]") for seed in EDGE_SEEDS]
    arms += [(CLOCK, "full", f"{FULL} vs {CLOCK}")]
    rows = []
    for artifact, mode, comparison in arms:
        block = _relational(data, artifact, mode)
        label = MODEL_LABELS[artifact] if mode == "full" else f"{MODEL_LABELS[artifact]}, {MODE_LABELS[mode]}"
        difference = "—"
        if comparison:
            item = comparisons[comparison]
            difference = f"{_signed(item['tieAwareAccuracyDifference'])} {_interval(item['pairedBootstrap95'], signed=True)}"
        rows.append([
            f"**{label}**" if (artifact, mode) == (FULL, "full") else label,
            str(block["correct"]), str(block["wrong"]), str(block["ties"]),
            f"{_num(block['tieAwareAccuracy'])} {_interval(block['bootstrap95TieAware'])}",
            _p(block["binomialTiesExcluded"]["pValue"]),
            difference,
        ])
    verdict = data["statistical-tests"]["attribution"]["graphAttribution"]
    table = _table(
        ["Arm (N = 173 decisive pairs)", "Correct", "Wrong", "Ties", "Tie-aware accuracy [bootstrap 95 %]",
         "Exact binomial p (ties excluded)", "Full GNN minus arm [paired bootstrap 95 %]"],
        rows, "lrrrlrl",
    )
    return f"{table}\n\nVerdict recorded in `statistical-tests.json`: **{verdict}**."


def corpus_files(data: dict) -> str:
    freeze = data["frozen-corpus-verification"]["freeze"]
    rows = [[f"`{name}`", _count(item["bytes"]), f"`{item['sha256']}`"] for name, item in sorted(freeze["files"].items())]
    table = _table(["File", "Bytes", "SHA-256 (recomputed = frozen)"], rows, "lrl")
    return (
        f"{table}\n\nFreeze record `{freeze['freezeFile']}`, generator commit `{freeze['generatorCommitSha'][:7]}`, "
        f"acceptance passed: {'yes' if freeze['acceptancePassed'] else 'no'}."
    )


def corpus_pairs(data: dict) -> str:
    verification = data["frozen-corpus-verification"]
    pairs = verification["pairs"]
    relational = pairs["relationalOnly"]
    converged = relational["stateConvergedConcordantPairs"]
    by_family = ", ".join(f"{name} {count}" for name, count in relational["discordantByFamily"].items())
    by_split = ", ".join(f"{SPLIT_LABELS[name]} {count}" for name, count in relational["discordantBySplit"].items())
    converged_family = ", ".join(f"{name} {count}" for name, count in converged["byFamily"].items())
    rows = [
        ["Rows verified (train / validation / test / OOD files)", _count(verification["labelContract"]["verifiedRows"])],
        ["Counterfactual pairs (valid / invalid)", f"{_count(pairs['total'])} ({_count(pairs['valid'])} / {pairs['invalid']})"],
        ["Relational-only valid pairs (pooled inputs identical at tensor level)", _count(relational["validPairs"])],
        ["… of which relation tensors differ", _count(relational["relationTensorsDiffer"])],
        ["… state-converged, byte-identical members (all concordant; excluded)", f"{converged['count']} ({converged_family})"],
        ["**Decisive pairs: relational-only, outcome-flipping**", f"**{relational['discordantPairs']}**"],
        ["… safe→unsafe / unsafe→safe", f"{relational['safeToUnsafe']} / {relational['unsafeToSafe']}"],
        ["… by family", by_family],
        ["… by topology split", by_split],
        ["… with differing relation tensors", str(relational["discordantPairsRelationTensorsDiffer"])],
        ["Sorted `pairId:family:change:riskier` digest", f"`{relational['discordantPairDigest']}`"],
    ]
    return _table(["Quantity", "Value"], rows, "ll")


RECIPE_ORDER = (
    "architecture", "hiddenDim", "layers", "relationHandling", "actionEncoder", "pooling", "riskHead", "dropout",
    "optimizer", "learningRate", "weightDecay", "batchSize", "shuffleBuffer", "epochs", "patience",
    "earlyStoppingMetric", "loss", "gradientClipNorm", "normalization", "calibration", "ensembleSeeds",
    "torchThreads", "device", "deterministicAlgorithms",
)


def model_config(data: dict) -> str:
    recipe = data["config"]["frozenRecipe"]
    trained = data["config"]["trainedArtifacts"]
    keys = [key for key in RECIPE_ORDER if key in recipe] + sorted(set(recipe) - set(RECIPE_ORDER))
    rows = [[key, recipe[key] if isinstance(recipe[key], str) else f"`{json.dumps(recipe[key])}`"] for key in keys]
    for artifact in (FULL, POOLED, CLOCK):
        model = data["models"][artifact]["config"]
        balance = model["training"]["transitionLabelBalance"]
        rows.append([
            f"{MODEL_LABELS[artifact]} (`{artifact}`)",
            f"{_count(trained[artifact]['parameterCount'])} parameters; loss `{model['training']['loss']}`, "
            f"pos_weight {model['training']['positiveWeight']:.3f} (train positive rate {balance['positiveRate'] * 100:.2f} %); "
            f"masked fields: {', '.join(f'`{field}`' for field in model['featureTransform']['maskedFields']) or 'none'}",
        ])
    return _table(["Item", "Frozen value (`config.json`, `models/*/config.json`)"], rows, "ll")


def training(data: dict) -> str:
    summary = data["training-summary"]["artifacts"]
    rows = []
    for artifact in (FULL, POOLED, CLOCK):
        members = data["models"][artifact]["metrics"]["members"]
        seconds = [member["trainingSeconds"] for member in members]
        per_epoch = [member["trainingSeconds"] / len(member["history"]) for member in members]
        rows.append([
            f"{MODEL_LABELS[artifact]} (`{artifact}`)",
            ", ".join(str(member["bestEpoch"]) for member in members),
            ", ".join(str(len(member["history"])) for member in members),
            f"{_count(min(seconds))} – {_count(max(seconds))} ({_count(sum(seconds))} total)",
            f"{_count(min(per_epoch))} – {_count(max(per_epoch))}",
            _num(summary[artifact]["validationAuroc"], 4),
            _num(summary[artifact]["validationNll"], 4),
        ])
    return _table(
        ["Artifact", "Best epoch per member", "Epochs run", "Member training seconds", "Seconds per epoch",
         "Validation AUROC (ensemble)", "Validation NLL"],
        rows, "lllllrr",
    )


def training_runs(data: dict) -> str:
    rows = []
    for index, run in enumerate(data["training-summary"]["runs"], start=1):
        wall = run.get("wallSeconds")
        rows.append([
            str(index), ", ".join(run["models"]), ", ".join(str(item) for item in run["horizons"]),
            str(run["memberProcessesLaunched"]), str(run["concurrency"]),
            "not recorded" if wall is None else _count(wall),
            "yes" if run.get("completed") else "no",
            run.get("note", "—"),
        ])
    first = data["training-summary"]["runs"][0]
    member_seconds = sum(
        member["trainingSeconds"] for artifact in (FULL, POOLED, CLOCK) for member in data["models"][artifact]["metrics"]["members"]
    )
    secondary = [name for name, model in data["models"].items() if model["config"]["horizon"] != 5]
    secondary_seconds = sum(
        member["trainingSeconds"] for name in secondary for member in data["models"][name]["metrics"]["members"]
    )
    secondary_members = sum(len(data["models"][name]["metrics"]["members"]) for name in secondary)
    table = _table(
        ["Run", "Models", "Horizons", "Member processes", "Concurrency", "Wall seconds", "Completed", "Note"],
        rows, "lllrrrll",
    )
    return (
        f"{table}\n\nPrimary K = 5 run: {_count(member_seconds)} member-seconds in {_count(first['wallSeconds'])} wall "
        f"seconds, i.e. on average {member_seconds / first['wallSeconds']:.1f} members' worth of progress at once "
        f"with {first['concurrency']} processes launched concurrently. Secondary heads: {secondary_members} members, "
        f"{_count(secondary_seconds)} member-seconds."
    )


def _transition_row(label: str, split: str, values: dict, interval: dict | None) -> list[str]:
    auroc = _num(values["auroc"], 4) + (f" {_interval(interval, 4)}" if interval else "")
    return [label, SPLIT_LABELS[split], auroc, _num(values["auprc"], 4), _num(values["brier"], 4),
            _num(values["ece"], 4), _num(values["nll"], 4)]


def natural_transition(data: dict) -> str:
    metrics = data["metrics"]["artifacts"]
    ablation = data["ablations"]["artifacts"][FULL]
    rows = []
    for artifact in (FULL, POOLED, CLOCK):
        for split in SPLITS:
            values = metrics[artifact]["full"][split]
            rows.append(_transition_row(MODEL_LABELS[artifact], split, values, values["aurocTrajectoryBootstrap95"]))
    for mode, label in (("randomized-edges", "Full GNN, randomized edges (mean of 3 seeds)"),
                        ("rewired-edges", "Full GNN, rewired edges (mean of 3 seeds)")):
        for split in SPLITS:
            rows.append(_transition_row(label, split, ablation["seededModeMeans"][mode][split], None))
    for split in SPLITS:
        rows.append(_transition_row("Full GNN, no edges", split, ablation["modes"]["no-edges"][split], None))
    table = _table(["Model", "Split", "AUROC [95 % trajectory bootstrap]", "AUPRC", "Brier", "ECE", "NLL"], rows, "llrrrrr")
    rates = " / ".join(f"{metrics[FULL]['full'][split]['positiveRate'] * 100:.1f} %" for split in SPLITS)
    rows_count = " / ".join(_count(metrics[FULL]["full"][split]["count"]) for split in SPLITS)
    baselines = data["trajectory-metrics"]["corpusBaselines"]["transitionMetricsK5"]
    baseline_rows = [
        [name, *(f"{_num(baselines[split][name]['auroc'], 3)} / {_num(baselines[split][name]['auprc'], 3)}" for split in SPLITS)]
        for name in ("heuristic", "logistic", "random")
    ]
    baseline_table = _table(["Corpus baseline (same rows)", "validation AUROC / AUPRC", "test", "OOD"], baseline_rows, "lrrr")
    return f"{table}\n\nRows {rows_count}; positive rate {rates} (validation / test / OOD).\n\n{baseline_table}"


def trajectory(data: dict) -> str:
    artifacts = data["trajectory-metrics"]["artifacts"]
    rows = []
    for artifact in (FULL, POOLED, CLOCK):
        for split in SPLITS:
            values = artifacts[artifact]["full"][split]
            unsafe = round(values["count"] * values["positiveRate"])
            rows.append([
                MODEL_LABELS[artifact], SPLIT_LABELS[split], f"{_count(values['count'])} ({_count(unsafe)})",
                f"{_num(values['auroc'], 4)} {_interval(values['aurocBootstrap95'], 4)}",
                _num(values["auprc"], 4), _num(values["brier"], 4),
            ])
    baselines = data["trajectory-metrics"]["corpusBaselines"]["trajectoryMetrics"]
    for name in ("heuristic", "logistic"):
        for split in SPLITS:
            values = baselines[split][name]
            rows.append([f"Corpus {name} (same rule)", SPLIT_LABELS[split], _count(baselines[split]["trajectories"]),
                         _num(values["auroc"], 4), _num(values["auprc"], 4), "—"])
    table = _table(["Model", "Split", "Trajectories (unsafe)", "AUROC [95 % bootstrap]", "AUPRC", "Brier"], rows, "llrrrr")
    return f"{table}\n\nRule: {data['trajectory-metrics']['rule']}."


def pairs_primary(data: dict) -> str:
    rows = []
    arms = [(POOLED, "full")] + [(FULL, mode) for mode in GNN_MODES] + [(CLOCK, mode) for mode in GNN_MODES]
    for artifact, mode in arms:
        block = _relational(data, artifact, mode)
        directions = block["byDirection"]

        def direction(name: str) -> str:
            item = directions[name]
            wrong = item["pairs"] - item["correct"] - item["ties"]
            return f"{_num(item['tieAwareAccuracy'])} ({item['correct']}/{item['ties']}/{wrong})"

        rows.append([
            MODEL_LABELS[artifact], MODE_LABELS[mode], str(block["correct"]), str(block["wrong"]), str(block["ties"]),
            f"{_num(block['tieAwareAccuracy'])} {_interval(block['bootstrap95TieAware'])}",
            _interval(block["wilson95TieAware"]),
            _p(block["binomialTiesExcluded"]["pValue"]),
            direction("safe->unsafe"), direction("unsafe->safe"),
            f"{_signed(block['margins']['mean'], 4)} {_interval(block['marginBootstrap95'], 4, signed=True)}",
            _signed(block["margins"]["median"], 4),
        ])
    return _table(
        ["Model", "Edges", "Correct", "Wrong", "Ties", "Tie-aware [bootstrap 95 %]", "Wilson 95 %",
         "Binomial p (ties excl.)", "safe→unsafe (c/t/w)", "unsafe→safe (c/t/w)", "Mean margin [95 %]", "Median margin"],
        rows, "llrrrllrllll",
    )


def pairs_breakdown(data: dict) -> str:
    models = (FULL, CLOCK, POOLED)
    rows = []

    def add(label: str, getter: Callable[[str], dict], interval: bool = False) -> None:
        cells = []
        for artifact in models:
            block = getter(artifact)
            cell = _accuracy_cell(block)
            if interval:
                cell += f" {_interval(block['bootstrap95TieAware'])}, p = {_p(block['binomialTiesExcluded']['pValue'])}"
            cells.append(cell)
        rows.append([label, str(getter(FULL)["pairs"]), *cells])

    for direction in ("safe->unsafe", "unsafe->safe"):
        add(direction.replace("->", "→"), lambda artifact, name=direction: _relational(data, artifact)["byDirection"][name])
    for family in FAMILIES:
        add(f"family: {family}", lambda artifact, name=family: _relational(data, artifact, subset="relationalOnlyByFamily")[name])
    for split in ("train", "validation", "test", "ood"):
        add(f"topology split: {SPLIT_LABELS[split]}", lambda artifact, name=split: _relational(data, artifact, subset="relationalOnlyBySplit")[name])
    add("held-out topologies (validation + test + OOD)", lambda artifact: _relational(data, artifact, subset="relationalOnlyHeldOutTopologies"), True)
    add("relational-only, horizon-5 truth", lambda artifact: _relational(data, artifact, subset="relationalOnlyHorizon5Truth"), True)
    add("placement families (flat-visible)", lambda artifact: _relational(data, artifact, subset="placementFamilies"), True)
    add("all valid discordant pairs", lambda artifact: _relational(data, artifact, subset="allValidPairs"), True)
    return _table(
        ["Subset", "Pairs", "Full GNN: tie-aware (c/t/w)", "Clock-blind GNN", "Pooled MLP"], rows, "lrlll",
    )


def attribution_criteria(data: dict) -> str:
    attribution = data["statistical-tests"]["attribution"]
    criteria = attribution["criteria"]
    conditions = attribution["conditions"]
    c1, c2, c3 = conditions["1_fullGnnAboveChance"], conditions["2_pooledMlpAtChance"], conditions["3_edgeDestructionRemovesAdvantage"]
    c4, c5 = conditions["4_survivesClockBlind"], conditions["5_intervalsDeterminate"]
    controls = c3["controls"]
    passing = sum(1 for item in controls.values() if item["passed"])
    failing = ", ".join(key.split("[")[1].rstrip("]") for key, item in controls.items() if not item["passed"]) or "none"
    strict = data["pair-audit"]["strictEdgeDestructionReading"]
    yes = lambda flag: "yes" if flag else "**no**"  # noqa: E731
    rows = [
        ["1", f"Full GNN tie-aware ≥ {criteria['fullGnnMinimumTieAwareAccuracy']:.2f}, bootstrap lower bound > 0.5, "
              f"binomial p (ties excluded) < {criteria['fullGnnBinomialAlpha']}",
         f"{_num(c1['tieAwareAccuracy'])} {_interval(c1['bootstrap95'])}, p = {_p(c1['binomialTiesExcludedP'])}", yes(c1["passed"])],
        ["2", f"Pooled MLP tie-aware within [{criteria['pooledMlpChanceBand'][0]:.2f}, {criteria['pooledMlpChanceBand'][1]:.2f}]",
         f"{_num(c2['tieAwareAccuracy'])} ({c2['ties']} ties)", yes(c2["passed"])],
        ["3", f"At least one destroyed-edge control loses ≥ {criteria['edgeDestructionMinimumDrop']:.2f} with a paired interval excluding 0",
         f"{passing} of {len(controls)} controls qualify (not: {failing})", yes(c3["passed"])],
        ["4", f"Clock-blind GNN tie-aware ≥ {criteria['clockBlindMinimumTieAwareAccuracy']:.2f}, bootstrap lower bound > 0.5",
         f"{_num(c4['tieAwareAccuracy'])} {_interval(c4['bootstrap95'])}", yes(c4["passed"])],
        ["5", "Full-GNN interval excludes 0.5 and lies above the pooled-MLP interval; a destroyed-control difference excludes 0",
         f"{_interval(c5['fullGnnInterval'])} vs pooled upper bound; difference excludes 0: {yes(c5['someDestroyedControlDifferenceExcludesZero'])}",
         yes(c5["passed"])],
        ["3′ (audit)", "Stricter reading added after the verdict: *every* seeded randomization control (3 randomized + 3 rewired) "
                       "individually loses ≥ 0.10 with a paired interval excluding 0",
         f"{sum(strict['controls'].values())} of {len(strict['controls'])}", yes(strict["passed"])],
    ]
    table = _table(["#", "Criterion", "Measured (N = 173)", "Passed"], rows, "llll")
    return f"{table}\n\n**Graph attribution: {attribution['graphAttribution']}.**"


def pairs_family(data: dict) -> str:
    rows = []
    for artifact in (FULL, CLOCK):
        for mode in GNN_MODES:
            by_family = _relational(data, artifact, mode, "relationalOnlyByFamily")
            rows.append([
                MODEL_LABELS[artifact], MODE_LABELS[mode],
                *(_num(by_family[family]["tieAwareAccuracy"]) for family in FAMILIES),
                _num(_relational(data, artifact, mode)["tieAwareAccuracy"]),
            ])
    counts = {family: _relational(data, FULL, "full", "relationalOnlyByFamily")[family]["pairs"] for family in FAMILIES}
    return _table(
        ["Model", "Edges", *(f"{family} (n = {counts[family]})" for family in FAMILIES), "overall (n = 173)"],
        rows, "llrrrrr",
    )


def pairs_comparisons(data: dict) -> str:
    comparisons = data["statistical-tests"]["comparisons"]
    order = [f"{FULL} vs {POOLED}", f"{FULL} vs {FULL}[no-edges]"]
    order += [f"{FULL} vs {FULL}[randomized-edges@{seed}]" for seed in EDGE_SEEDS]
    order += [f"{FULL} vs {FULL}[rewired-edges@{seed}]" for seed in EDGE_SEEDS]
    order += [f"{FULL} vs {FULL}[collapsed-edge-types]", f"{FULL} vs {FULL}[random-relation-labels]", f"{FULL} vs {CLOCK}"]
    rows = []
    for key in order:
        item = comparisons[key]
        right = key.split(" vs ")[1]
        label = MODEL_LABELS.get(right) or f"Full GNN, {MODE_LABELS[right.split('[')[1].rstrip(']')]}"
        mcnemar = item["mcnemarExactStrict"]
        rows.append([
            f"Full GNN vs {label}", _signed(item["tieAwareAccuracyDifference"]),
            _interval(item["pairedBootstrap95"], signed=True),
            f"{mcnemar['leftOnly']} / {mcnemar['rightOnly']}", _p(mcnemar["pValue"]),
        ])
    return _table(
        ["Comparison (same 173 pairs)", "Δ tie-aware accuracy", "Paired bootstrap 95 %", "McNemar left-only / right-only", "McNemar p"],
        rows, "lrlrr",
    )


def edge_natural(data: dict) -> str:
    ablation = data["ablations"]["artifacts"][FULL]
    metrics = data["metrics"]["artifacts"][FULL]["full"]
    trajectory = data["trajectory-metrics"]["artifacts"][FULL]["full"]
    rows = [[
        "intact (absolute values)",
        " / ".join(_num(metrics[split]["auroc"], 4) for split in SPLITS),
        " / ".join(_num(metrics[split]["auprc"], 4) for split in ("test", "ood")),
        " / ".join(_num(metrics[split]["nll"], 4) for split in ("test", "ood")),
        " / ".join(_num(trajectory[split]["auroc"], 4) for split in ("test", "ood")),
    ]]
    for mode in GNN_MODES[1:]:
        delta = ablation["deltaFromFull"][mode]
        rows.append([
            MODE_LABELS[mode],
            " / ".join(_signed(delta[split]["auroc"], 4) for split in SPLITS),
            " / ".join(_signed(delta[split]["auprc"], 4) for split in ("test", "ood")),
            " / ".join(_signed(delta[split]["nll"], 4) for split in ("test", "ood")),
            " / ".join(_num(ablation["trajectory"][mode][split]["auroc"], 4) for split in ("test", "ood")),
        ])
    return _table(
        ["Frozen full GNN, edges", "Δ AUROC validation / test / OOD", "Δ AUPRC test / OOD", "Δ NLL test / OOD",
         "Trajectory AUROC test / OOD"],
        rows, "lrrrr",
    )


def clock_blind(data: dict) -> str:
    blind = data["clock-blind"]
    rows = []
    for metric in ("auroc", "auprc", "nll", "ece"):
        for split in SPLITS:
            left = blind["transitionMetrics"][FULL][split][metric]
            right = blind["transitionMetrics"][CLOCK][split][metric]
            rows.append([f"transition {metric.upper()}, {SPLIT_LABELS[split]}", _num(left, 4), _num(right, 4), _signed(right - left, 4)])
    for split in SPLITS:
        left = blind["trajectoryMetrics"][FULL][split]["auroc"]
        right = blind["trajectoryMetrics"][CLOCK][split]["auroc"]
        rows.append([f"trajectory AUROC, {SPLIT_LABELS[split]}", _num(left, 4), _num(right, 4), _signed(right - left, 4)])
    for mode in GNN_MODES:
        left = blind["relationalOnlyPairs"][FULL][mode]["tieAwareAccuracy"]
        right = blind["relationalOnlyPairs"][CLOCK][mode]["tieAwareAccuracy"]
        rows.append([f"173 pairs, tie-aware, {MODE_LABELS[mode]}", _num(left), _num(right), _signed(right - left)])
    for budget in BUDGETS:
        left = blind["fixedBudget"]["gnn"]["budgets"][budget]["failuresFound"]
        right = blind["fixedBudget"]["gnnClockBlind"]["budgets"][budget]["failuresFound"]
        rows.append([f"fixed budget {_count(int(budget))}: counterexamples", str(left), str(right), f"{right - left:+d}".replace("-", "−")])
    table = _table(["Metric", "Full GNN", "Clock-blind GNN", "Clock-blind minus full"], rows, "lrrr")
    fields = ", ".join(f"`{field}`" for field in blind["maskedFields"])
    return (
        f"Masked columns: {fields}; identical architecture: {'yes' if blind['architectureIdentical'] else 'no'}.\n\n{table}"
    )


def fixed_budget(data: dict) -> str:
    methods = data["fixed-budget"]["methods"]
    best = {budget: max(methods[name]["budgets"][budget]["failuresFound"] for name in FIXED_BUDGET_METHODS) for budget in BUDGETS}
    rows = []
    for name, label in FIXED_BUDGET_METHODS.items():
        budgets = methods[name]["budgets"]

        def found(budget: str) -> str:
            value = budgets[budget]["failuresFound"]
            return f"**{_count(value)}**" if value == best[budget] else _count(value)

        coverage = budgets["100"]["controllerStateCoverage"]
        rows.append([
            label, *(found(budget) for budget in BUDGETS),
            f"{budgets['1000']['failureRecall']:.3f} / {budgets['5000']['failureRecall']:.3f}",
            str(budgets["1000"]["schedulesToFirstCounterexample"]),
            f"{budgets['100']['uniqueFailureClassCount']} / {budgets['1000']['uniqueFailureClassCount']}",
            f"{coverage['target']['covered']}/{coverage['target']['total']} · {len(coverage['transitionTypes'])}",
            f"{_count(budgets['1000']['controllerStateCoverage']['controllerStates']['count'])} / "
            f"{_count(budgets['5000']['controllerStateCoverage']['controllerStates']['count'])}",
            _count(budgets["5000"]["verificationWallTimeMs"] / 1000.0),
        ])
    pool = data["fixed-budget"]["pool"]
    table = _table(
        ["Prioritizer", "CEs @100", "@500", "@1 000", "@5 000", "Recall @1 000 / @5 000", "Schedules to first CE",
         "Failure classes @100 / @1 000", "Action targets · transition types @100", "Controller states @1 000 / @5 000",
         "Verification wall s @5 000"],
        rows, "lrrrrrrrrrr",
    )
    replay = data["fixed-budget"]["phaseOneReplay"]
    return (
        f"{table}\n\nPool: {_count(pool['schedules'])} held-out schedules, {_count(pool['counterexamples'])} counterexamples; "
        f"replay fingerprints verified: {'yes' if data['fixed-budget']['replayFingerprintsVerified'] else 'no'}; "
        f"{_count(data['fixed-budget']['uniqueInferenceRequests'])} unique inference requests; Phase I replay "
        f"byte-identical: {'yes' if replay['byteIdentical'] else 'no'} ({replay['violationClass']}); safety authority: "
        f"`{data['fixed-budget']['safetyAuthority']}`."
    )


def fixed_budget_chance(data: dict) -> str:
    pool = data["fixed-budget"]["pool"]
    total, positives = pool["schedules"], pool["counterexamples"]
    rate = positives / total
    methods = data["fixed-budget"]["methods"]
    spread = {}
    for budget in BUDGETS:
        draws = int(budget)
        variance = draws * rate * (1 - rate) * (total - draws) / (total - 1)
        spread[budget] = (draws * rate, math.sqrt(variance))
    rows = [[
        "uninformative ranking: mean ± SD",
        *(f"{_num(mean, 1)} ± {_num(sd, 2)}" for mean, sd in (spread[budget] for budget in BUDGETS)),
    ]]
    for name, label in FIXED_BUDGET_METHODS.items():
        rows.append([label, *(
            _signed((methods[name]["budgets"][budget]["failuresFound"] - spread[budget][0]) / spread[budget][1], 1)
            for budget in BUDGETS
        )])
    return _table(["z against a hypergeometric draw", "@100", "@500", "@1 000", "@5 000"], rows, "lrrrr")


def held_out_audit(data: dict) -> str:
    subsets = data["pair-audit"]["postHocSubsets"]
    names = {
        "allDecisivePairs": "all decisive pairs",
        "trainTopologies": "train topologies",
        "heldOutTopologies": "held-out topologies (validation + test + OOD)",
        "unseenTopologies": "unseen topologies (test + OOD)",
    }
    accuracy_rows, delta_rows = [], []
    for key, label in names.items():
        subset = subsets[key]
        families = " / ".join(str(subset["families"].get(family, 0)) for family in FAMILIES)
        cells = []
        for artifact in (FULL, CLOCK):
            item = subset["models"][artifact]
            cells.append(
                f"{_num(item['tieAwareAccuracy'])} {_interval(item['bootstrap95TieAware'])}, p = {_p(item['binomialTiesExcludedP'])}"
            )
        accuracy_rows.append([label, str(subset["pairs"]), families, *cells])
        for artifact in (FULL, CLOCK):
            controls = subset["models"][artifact]["versusSeededControls"]
            delta_rows.append([
                label, MODEL_LABELS[artifact],
                *(
                    f"{_signed(controls[control]['difference'])} {_interval(controls[control]['pairedBootstrap95'], signed=True)}"
                    for control in (*(f"randomized-edges@{seed}" for seed in EDGE_SEEDS), *(f"rewired-edges@{seed}" for seed in EDGE_SEEDS))
                ),
            ])
    accuracy = _table(
        ["Subset (post hoc)", "Pairs", "nc / rw / rd / cd", "Full GNN tie-aware [95 %], p", "Clock-blind GNN"],
        accuracy_rows, "lrrll",
    )
    deltas = _table(
        ["Subset (post hoc)", "Model", *(f"minus randomized @{seed}" for seed in EDGE_SEEDS), *(f"minus rewired @{seed}" for seed in EDGE_SEEDS)],
        delta_rows, "llllllll",
    )
    tied = data["pair-audit"]["tiedByConstruction"]
    widest = max(item["maximumAbsoluteMargin"] for item in tied.values())
    return (
        f"{accuracy}\n\n{deltas}\n\nFamilies: nc node-concentration, rw readiness-wiring, rd readiness-drain, "
        f"cd capacity-distribution. Re-scoring reproduced all {len(data['pair-audit']['reproduction'])} committed arms; "
        f"the three arms with identical inputs by construction tie every pair (largest |margin| {widest:.1e}, "
        f"tolerance {data['pair-audit']['tieTolerance']:.0e})."
    )


def secondary_transition(data: dict) -> str:
    metrics = data["metrics"]["artifacts"]
    rows = []
    for horizon in (1, 5, 10, 20):
        for family in ("gnn-full", "pooled-mlp"):
            artifact = f"{family}-k{horizon}"
            values = metrics[artifact]["full"]
            rows.append([
                str(horizon), " / ".join(f"{values[split]['positiveRate'] * 100:.1f} %" for split in SPLITS),
                "GNN head" if family == "gnn-full" else "Pooled MLP head",
                " / ".join(_num(values[split]["auroc"], 4) for split in SPLITS),
                " / ".join(_num(values[split]["auprc"], 4) for split in SPLITS),
                " / ".join(_num(values[split]["nll"], 4) for split in ("test", "ood")),
                ", ".join(str(member["bestEpoch"]) for member in metrics[artifact]["members"]),
            ])
        if horizon != 5:
            scored = metrics[FULL]["full"]["secondaryHorizons"][str(horizon)]
            rows.append([
                str(horizon), "", f"frozen K = 5 GNN scored at K = {horizon}",
                " / ".join(_num(scored[split]["auroc"], 4) for split in SPLITS),
                " / ".join(_num(scored[split]["auprc"], 4) for split in SPLITS),
                " / ".join(_num(scored[split]["nll"], 4) for split in ("test", "ood")),
                "—",
            ])
    return _table(
        ["K", "Positive rate val / test / OOD", "Model", "AUROC val / test / OOD", "AUPRC val / test / OOD",
         "NLL test / OOD", "Best epochs"],
        rows, "rllllll",
    )


def secondary_pairs(data: dict) -> str:
    rows = []
    for horizon in (1, 5, 10, 20):
        gnn = _relational(data, f"gnn-full-k{horizon}")
        pooled = _relational(data, f"pooled-mlp-k{horizon}")
        rows.append([
            str(horizon),
            f"{gnn['correct']} / {gnn['ties']} / {_num(gnn['tieAwareAccuracy'])} {_interval(gnn['bootstrap95TieAware'])}",
            f"{pooled['correct']} / {pooled['ties']} / {_num(pooled['tieAwareAccuracy'])}",
        ])
    return _table(["K", "GNN head: correct / ties / tie-aware [95 %]", "Pooled MLP head: correct / ties / tie-aware"], rows, "rll")


TABLES: dict[str, Callable[[dict], str]] = {
    "headline": headline,
    "corpus-files": corpus_files,
    "corpus-pairs": corpus_pairs,
    "model-config": model_config,
    "training": training,
    "training-runs": training_runs,
    "natural-transition": natural_transition,
    "trajectory": trajectory,
    "pairs-primary": pairs_primary,
    "pairs-breakdown": pairs_breakdown,
    "attribution-criteria": attribution_criteria,
    "pairs-family": pairs_family,
    "pairs-comparisons": pairs_comparisons,
    "edge-natural": edge_natural,
    "clock-blind": clock_blind,
    "fixed-budget": fixed_budget,
    "fixed-budget-chance": fixed_budget_chance,
    "held-out-audit": held_out_audit,
    "secondary-transition": secondary_transition,
    "secondary-pairs": secondary_pairs,
}
BLOCK = re.compile(
    r"<!-- generated:(?P<name>[a-z0-9-]+) -->\n(?:(?P<body>.*?)\n)?<!-- /generated:(?P=name) -->", re.DOTALL
)


def render_tables(root: Path) -> dict[str, str]:
    data = load_artifacts(root)
    return {name: render(data) for name, render in TABLES.items()}


def apply_tables(document: str, tables: dict[str, str]) -> str:
    """Replace every generated block; every table must appear exactly once."""
    seen: list[str] = []

    def replace(match: re.Match) -> str:
        name = match.group("name")
        if name not in tables:
            raise ValueError(f"document has a generated block with no renderer: {name}")
        seen.append(name)
        return f"<!-- generated:{name} -->\n{tables[name]}\n<!-- /generated:{name} -->"

    updated = BLOCK.sub(replace, document)
    missing = sorted(set(tables) - set(seen))
    duplicated = sorted({name for name in seen if seen.count(name) > 1})
    if missing or duplicated:
        raise ValueError(f"generated blocks missing {missing} or duplicated {duplicated}")
    return updated


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", default=str(DEFAULT_ROOT), help="Phase II-B.2 artifact directory")
    parser.add_argument("--doc", default=str(DEFAULT_DOCUMENT), help="report whose generated blocks are rewritten")
    parser.add_argument("--check", action="store_true", help="exit 1 if the document differs from the artifacts")
    args = parser.parse_args(argv)
    document_path = Path(args.doc)
    document = document_path.read_text(encoding="utf-8")
    updated = apply_tables(document, render_tables(Path(args.out)))
    if args.check:
        if updated != document:
            print(f"{document_path.name}: generated tables are stale; run python -m ml.cloudproof.phase_ii_b2_report")
            return 1
        print(f"{document_path.name}: {len(TABLES)} generated tables match the artifacts")
        return 0
    if updated != document:
        document_path.write_text(updated, encoding="utf-8", newline="\n")
    print(f"{document_path.name}: {len(TABLES)} generated tables written")
    return 0


if __name__ == "__main__":
    sys.exit(main())
