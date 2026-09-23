"""Dependency-light uncertainty estimates for Phase II-B.2 reporting.

Everything here is exact or resampling based so the numbers do not depend on an
optional SciPy install: an exact two-sided binomial test, Wilson intervals,
percentile bootstraps over pairs and over trajectory clusters, and a
vectorized tie-aware AUROC that matches :func:`ml.cloudproof.metrics.auroc`.
"""

from __future__ import annotations

import math
from typing import Callable, Iterable, Sequence

import numpy as np


Z_95 = 1.959963984540054


def _log_binomial_pmf(k: int, n: int, p: float) -> float:
    return (
        math.lgamma(n + 1)
        - math.lgamma(k + 1)
        - math.lgamma(n - k + 1)
        + k * math.log(p)
        + (n - k) * math.log1p(-p)
    )


def binomial_two_sided(successes: int, trials: int, probability: float = 0.5) -> float | None:
    """Exact two-sided binomial p-value (sum of outcomes no more likely than the observed one)."""
    if trials <= 0:
        return None
    if not 0 <= successes <= trials:
        raise ValueError("successes must lie in [0, trials]")
    if not 0.0 < probability < 1.0:
        raise ValueError("probability must lie strictly inside (0, 1)")
    observed = _log_binomial_pmf(successes, trials, probability)
    total = 0.0
    for value in range(trials + 1):
        candidate = _log_binomial_pmf(value, trials, probability)
        if candidate <= observed + 1e-12:
            total += math.exp(candidate)
    return float(min(1.0, total))


def wilson_interval(successes: float, trials: int, z: float = Z_95) -> tuple[float, float] | None:
    """Wilson score interval; ``successes`` may be fractional for tie-aware counts."""
    if trials <= 0:
        return None
    proportion = successes / trials
    denominator = 1.0 + z * z / trials
    centre = (proportion + z * z / (2 * trials)) / denominator
    half_width = z * math.sqrt(proportion * (1 - proportion) / trials + z * z / (4 * trials * trials)) / denominator
    return (max(0.0, centre - half_width), min(1.0, centre + half_width))


def bootstrap_mean(
    values: Sequence[float],
    *,
    resamples: int = 10_000,
    seed: int = 20260922,
    alpha: float = 0.05,
) -> dict:
    """Percentile bootstrap of the mean over independent units (e.g. pairs)."""
    array = np.asarray(list(values), dtype=np.float64)
    if array.size == 0:
        return {"mean": None, "lower": None, "upper": None, "resamples": resamples, "seed": seed}
    generator = np.random.default_rng(seed)
    indices = generator.integers(0, array.size, size=(resamples, array.size))
    means = array[indices].mean(axis=1)
    lower, upper = np.quantile(means, [alpha / 2, 1 - alpha / 2])
    return {
        "mean": float(array.mean()),
        "lower": float(lower),
        "upper": float(upper),
        "resamples": resamples,
        "seed": seed,
        "units": int(array.size),
    }


def paired_bootstrap_difference(
    left: Sequence[float],
    right: Sequence[float],
    *,
    resamples: int = 10_000,
    seed: int = 20260922,
    alpha: float = 0.05,
) -> dict:
    """Bootstrap of ``mean(left - right)`` resampling the same units for both arms."""
    a = np.asarray(list(left), dtype=np.float64)
    b = np.asarray(list(right), dtype=np.float64)
    if a.shape != b.shape:
        raise ValueError("paired arms must have the same number of units")
    result = bootstrap_mean(a - b, resamples=resamples, seed=seed, alpha=alpha)
    result["excludesZero"] = (
        result["lower"] is not None and (result["lower"] > 0.0 or result["upper"] < 0.0)
    )
    return result


def mcnemar_exact(left_only: int, right_only: int) -> dict:
    """Exact McNemar test on discordant units (left correct/right wrong versus the reverse)."""
    discordant = left_only + right_only
    return {
        "leftOnly": int(left_only),
        "rightOnly": int(right_only),
        "discordant": int(discordant),
        "pValue": binomial_two_sided(left_only, discordant) if discordant else None,
    }


def fast_auroc(labels: np.ndarray, scores: np.ndarray) -> float | None:
    """Rank-based AUROC with tie-averaged ranks (vectorized; equals ``metrics.auroc``)."""
    y = np.asarray(labels, dtype=np.float64)
    p = np.asarray(scores, dtype=np.float64)
    positives = int(y.sum())
    negatives = int(y.size - positives)
    if positives == 0 or negatives == 0:
        return None
    order = np.argsort(p, kind="mergesort")
    sorted_scores = p[order]
    _unique, inverse, counts = np.unique(sorted_scores, return_inverse=True, return_counts=True)
    starts = np.concatenate([[0], np.cumsum(counts)[:-1]])
    average_ranks = starts + (counts + 1) / 2.0
    ranks = np.empty(y.size, dtype=np.float64)
    ranks[order] = average_ranks[inverse]
    positive_rank_sum = float(ranks[y == 1].sum())
    return (positive_rank_sum - positives * (positives + 1) / 2.0) / (positives * negatives)


def cluster_bootstrap(
    labels: Sequence[float],
    scores: Sequence[float],
    clusters: Sequence[str],
    statistic: Callable[[np.ndarray, np.ndarray], float | None] = fast_auroc,
    *,
    resamples: int = 1_000,
    seed: int = 20260922,
    alpha: float = 0.05,
) -> dict:
    """Percentile bootstrap that resamples whole clusters (trajectories), not rows."""
    y = np.asarray(list(labels), dtype=np.float64)
    p = np.asarray(list(scores), dtype=np.float64)
    keys = np.asarray(list(clusters))
    if not (y.size == p.size == keys.size):
        raise ValueError("labels, scores and clusters must align")
    unique_clusters, membership = np.unique(keys, return_inverse=True)
    cluster_rows = [np.flatnonzero(membership == index) for index in range(unique_clusters.size)]
    generator = np.random.default_rng(seed)
    values = []
    for _ in range(resamples):
        chosen = generator.integers(0, unique_clusters.size, size=unique_clusters.size)
        rows = np.concatenate([cluster_rows[index] for index in chosen])
        value = statistic(y[rows], p[rows])
        if value is not None:
            values.append(value)
    point = statistic(y, p)
    if not values:
        return {"value": point, "lower": None, "upper": None, "resamples": resamples, "seed": seed}
    lower, upper = np.quantile(np.asarray(values), [alpha / 2, 1 - alpha / 2])
    return {
        "value": point,
        "lower": float(lower),
        "upper": float(upper),
        "resamples": resamples,
        "completedResamples": len(values),
        "seed": seed,
        "clusters": int(unique_clusters.size),
    }


def summarize_margins(margins: Iterable[float]) -> dict:
    array = np.asarray(list(margins), dtype=np.float64)
    if array.size == 0:
        return {"mean": None, "median": None, "minimum": None, "maximum": None}
    return {
        "mean": float(array.mean()),
        "median": float(np.median(array)),
        "minimum": float(array.min()),
        "maximum": float(array.max()),
    }
