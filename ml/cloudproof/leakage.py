"""Audit scenario-construction and state/action duplication leakage in a CloudProof corpus."""

from __future__ import annotations

import argparse
from collections import Counter, defaultdict
import hashlib
import json
from pathlib import Path
from statistics import mean
from typing import Any, Iterator

from .constants import SPLIT_NAMES
from .dataset import CorpusManifest, iter_jsonl
from .runtime import json_dump


def _summary(values: list[int | float]) -> dict[str, float | int | None]:
    if not values:
        return {"count": 0, "minimum": None, "maximum": None, "mean": None}
    return {
        "count": len(values),
        "minimum": min(values),
        "maximum": max(values),
        "mean": mean(values),
    }


def _fingerprint(record: dict[str, Any]) -> str:
    encoded = json.dumps(
        {"state": record.get("state"), "action": record.get("action")},
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _counter(counter: Counter) -> dict[str, int]:
    return dict(sorted((str(key), value) for key, value in counter.items()))


def _numeric_leaves(value: Any, prefix: str = "") -> Iterator[tuple[str, float]]:
    if isinstance(value, bool):
        yield prefix, float(value)
    elif isinstance(value, (int, float)) and not isinstance(value, bool):
        yield prefix, float(value)
    elif isinstance(value, dict):
        for key, item in sorted(value.items()):
            child = f"{prefix}.{key}" if prefix else str(key)
            yield from _numeric_leaves(item, child)
    elif isinstance(value, list):
        yield f"{prefix}.length", float(len(value))


def _schedule_action_presence(selected: list[dict[str, Any]]) -> dict[str, dict[str, float | int]]:
    counts = Counter()
    for item in selected:
        present = {
            action.get("type")
            for action in ((item.get("schedule") or {}).get("actions") or [])
            if action.get("type")
        }
        counts.update(present)
    total = len(selected)
    return {
        action: {"schedules": count, "percent": 100.0 * count / total if total else 0.0}
        for action, count in sorted(counts.items())
    }


def audit_corpus(dataset_directory: str | Path) -> dict:
    manifest = CorpusManifest(dataset_directory)
    schedules = list(iter_jsonl(manifest.directory / "schedules.jsonl"))
    schedules_by_id = {item["scenarioId"]: item for item in schedules}
    schedule_stats: dict[str, dict[str, Any]] = {}
    for outcome in ("safe", "unsafe"):
        selected = [item for item in schedules if item.get("outcome") == outcome]
        schedule_stats[outcome] = {
            "count": len(selected),
            "length": _summary([len((item.get("schedule") or {}).get("actions") or []) for item in selected]),
            "runtime": _counter(Counter((item.get("schedule") or {}).get("runtime") for item in selected)),
            "faultCombination": _counter(Counter(
                ",".join(((item.get("schedule") or {}).get("scenarioParameters") or {}).get("faultCombination") or [])
                or "none"
                for item in selected
            )),
            "actionPresence": _schedule_action_presence(selected),
        }

    outcome_actions = {name: Counter() for name in ("safe", "unsafe")}
    outcome_resources = {name: defaultdict(list) for name in ("safe", "unsafe")}
    state_features = {name: defaultdict(lambda: [0.0, 0]) for name in ("safe", "unsafe")}
    split_outcomes = {split: Counter() for split in SPLIT_NAMES}
    fingerprints: dict[str, dict[str, Any]] = {}
    transition_count = 0
    missing_actions = 0
    metadata_mismatches = 0
    for split in SPLIT_NAMES:
        for record in iter_jsonl(manifest.path_for(split)):
            transition_count += 1
            metadata = record.get("metadata") or {}
            outcome = metadata.get("trajectoryOutcome")
            if outcome not in outcome_actions:
                raise ValueError(f"unexpected trajectory outcome: {outcome}")
            split_outcomes[split][outcome] += 1
            action_type = (record.get("action") or {}).get("type")
            if action_type is None:
                missing_actions += 1
            else:
                outcome_actions[outcome][action_type] += 1
            nodes = ((record.get("state") or {}).get("nodes") or [])
            resource_counts = Counter(node.get("type") for node in nodes)
            for resource_type, count in resource_counts.items():
                outcome_resources[outcome][resource_type].append(count)
            for node in nodes:
                resource_type = str(node.get("type"))
                for feature, value in _numeric_leaves(node.get("features") or {}):
                    accumulator = state_features[outcome][f"{resource_type}.{feature}"]
                    accumulator[0] += value
                    accumulator[1] += 1
            schedule = schedules_by_id.get(record.get("scenarioId"))
            if schedule is None or schedule.get("split") != split or schedule.get("outcome") != outcome:
                metadata_mismatches += 1
            label = bool((record.get("labels") or {}).get("sloViolationWithinKTransitions"))
            fingerprint = _fingerprint(record)
            entry = fingerprints.setdefault(
                fingerprint,
                {"count": 0, "labels": set(), "splits": set(), "outcomes": set()},
            )
            entry["count"] += 1
            entry["labels"].add(label)
            entry["splits"].add(split)
            entry["outcomes"].add(outcome)

    cross_split = [value for value in fingerprints.values() if len(value["splits"]) > 1]
    conflicting = [value for value in fingerprints.values() if len(value["labels"]) > 1]
    duplicate_fingerprints = [value for value in fingerprints.values() if value["count"] > 1]
    action_types = sorted(set(outcome_actions["safe"]) | set(outcome_actions["unsafe"]))
    action_table = {
        action: {
            "safeTransitions": outcome_actions["safe"][action],
            "unsafeTransitions": outcome_actions["unsafe"][action],
            "presentInBoth": outcome_actions["safe"][action] > 0 and outcome_actions["unsafe"][action] > 0,
        }
        for action in action_types
    }
    resource_table = {
        outcome: {
            resource: _summary(values)
            for resource, values in sorted(outcome_resources[outcome].items())
        }
        for outcome in ("safe", "unsafe")
    }
    feature_table = {
        feature: {
            outcome: {
                "mean": state_features[outcome][feature][0] / state_features[outcome][feature][1],
                "observations": state_features[outcome][feature][1],
            }
            for outcome in ("safe", "unsafe")
            if feature in state_features[outcome]
        }
        for feature in sorted(set(state_features["safe"]) | set(state_features["unsafe"]))
    }
    unique_fingerprints = len(fingerprints)
    return {
        "kind": "cloudproof.scenario-construction-leakage-audit",
        "schemaVersion": 1,
        "dataset": str(manifest.directory),
        "schedules": schedule_stats,
        "transitions": {
            "count": transition_count,
            "missingActions": missing_actions,
            "metadataScheduleMismatches": metadata_mismatches,
            "bySplitAndOutcome": {split: _counter(values) for split, values in split_outcomes.items()},
        },
        "actionByTrajectoryOutcome": action_table,
        "resourceCountsByTrajectoryOutcome": resource_table,
        "numericStateFeaturesByTrajectoryOutcome": feature_table,
        "stateActionFingerprints": {
            "unique": unique_fingerprints,
            "duplicateFingerprints": len(duplicate_fingerprints),
            "duplicateOccurrences": transition_count - unique_fingerprints,
            "crossSplitFingerprints": len(cross_split),
            "conflictingLabelFingerprints": len(conflicting),
        },
        "findings": {
            "allActionsPresent": missing_actions == 0,
            "allActionTypesAppearInBothOutcomes": all(row["presentInBoth"] for row in action_table.values()),
            "scheduleMetadataConsistent": metadata_mismatches == 0,
            "noCrossSplitStateActionDuplicates": len(cross_split) == 0,
            "noConflictingStateActionLabels": len(conflicting) == 0,
        },
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", required=True)
    parser.add_argument("--out", required=True)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    result = audit_corpus(args.dataset)
    json_dump(args.out, result)
    print(json.dumps(result, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
