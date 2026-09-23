"""Dependency-light binary risk metrics and calibration summaries."""

from __future__ import annotations

import math
from typing import Iterable

import numpy as np


def _arrays(labels: Iterable[float], probabilities: Iterable[float]) -> tuple[np.ndarray, np.ndarray]:
    y = np.asarray(list(labels), dtype=np.float64)
    p = np.asarray(list(probabilities), dtype=np.float64)
    if y.ndim != 1 or p.ndim != 1 or y.size == 0 or y.size != p.size:
        raise ValueError("equally-sized, non-empty label and probability vectors are required")
    if not np.isin(y, [0.0, 1.0]).all():
        raise ValueError("labels must be binary")
    if not np.isfinite(p).all() or (p < 0).any() or (p > 1).any():
        raise ValueError("probabilities must be finite values in [0, 1]")
    return y, p


def auroc(labels: Iterable[float], probabilities: Iterable[float]) -> float | None:
    y, p = _arrays(labels, probabilities)
    positives = int(y.sum())
    negatives = int(y.size - positives)
    if positives == 0 or negatives == 0:
        return None
    order = np.argsort(p, kind="mergesort")
    ranks = np.empty(y.size, dtype=np.float64)
    start = 0
    while start < y.size:
        end = start + 1
        while end < y.size and p[order[end]] == p[order[start]]:
            end += 1
        ranks[order[start:end]] = ((start + 1) + end) / 2.0
        start = end
    positive_rank_sum = float(ranks[y == 1].sum())
    return (positive_rank_sum - positives * (positives + 1) / 2.0) / (positives * negatives)


def auprc(labels: Iterable[float], probabilities: Iterable[float]) -> float | None:
    y, p = _arrays(labels, probabilities)
    positives = int(y.sum())
    if positives == 0:
        return None
    order = np.argsort(-p, kind="mergesort")
    true_positives = 0
    false_positives = 0
    previous_recall = 0.0
    area = 0.0
    start = 0
    while start < y.size:
        end = start + 1
        while end < y.size and p[order[end]] == p[order[start]]:
            end += 1
        group = y[order[start:end]]
        true_positives += int(group.sum())
        false_positives += int(group.size - group.sum())
        recall = true_positives / positives
        precision = true_positives / (true_positives + false_positives)
        area += (recall - previous_recall) * precision
        previous_recall = recall
        start = end
    return area


def threshold_for_f1(labels: Iterable[float], probabilities: Iterable[float]) -> dict[str, float]:
    y, p = _arrays(labels, probabilities)
    order = np.argsort(-p, kind="mergesort")
    positives = int(y.sum())
    true_positive = 0
    false_positive = 0
    best = {"threshold": 1.0, "f1": 0.0}
    start = 0
    while start < y.size:
        end = start + 1
        while end < y.size and p[order[end]] == p[order[start]]:
            end += 1
        group = y[order[start:end]]
        true_positive += int(group.sum())
        false_positive += int(group.size - group.sum())
        false_negative = positives - true_positive
        denominator = 2 * true_positive + false_positive + false_negative
        f1 = 0.0 if denominator == 0 else 2 * true_positive / denominator
        threshold = float(p[order[start]])
        if f1 > best["f1"] or (f1 == best["f1"] and threshold < best["threshold"]):
            best = {"threshold": threshold, "f1": float(f1)}
        start = end
    all_positive_f1 = 2 * positives / (y.size + positives)
    if all_positive_f1 >= best["f1"]:
        best = {"threshold": 0.0, "f1": float(all_positive_f1)}
    return best


def evaluate_binary_risk(
    labels: Iterable[float],
    probabilities: Iterable[float],
    *,
    bins: int = 10,
) -> dict:
    y, p = _arrays(labels, probabilities)
    clipped = np.clip(p, 1e-7, 1.0 - 1e-7)
    calibration = []
    ece = 0.0
    for index in range(bins):
        lower = index / bins
        upper = (index + 1) / bins
        mask = (p >= lower) & ((p < upper) if index < bins - 1 else (p <= upper))
        count = int(mask.sum())
        predicted = float(p[mask].mean()) if count else None
        observed = float(y[mask].mean()) if count else None
        if count:
            ece += (count / y.size) * abs(predicted - observed)
        calibration.append(
            {
                "lower": lower,
                "upper": upper,
                "count": count,
                "meanPredicted": predicted,
                "observedRate": observed,
            }
        )
    return {
        "count": int(y.size),
        "positiveRate": float(y.mean()),
        "auroc": auroc(y, p),
        "auprc": auprc(y, p),
        "brier": float(np.mean((p - y) ** 2)),
        "ece": float(ece),
        "nll": float(-np.mean(y * np.log(clipped) + (1.0 - y) * np.log(1.0 - clipped))),
        "calibration": calibration,
    }


def finite_metrics(value: dict) -> bool:
    for key in ("auroc", "auprc", "brier", "ece", "nll"):
        metric = value.get(key)
        if metric is not None and not math.isfinite(metric):
            return False
    return True
