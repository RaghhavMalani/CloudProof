'use strict';

// Nuisance control for the Phase II-A.2 causal corpus.
//
// A nuisance is any quantity that describes how a trajectory was generated or
// how long it ran rather than what the cluster looked like: schedule length,
// virtual runtime, fault and operation histograms, warm-up, hazards, seeds.
// Phase II-A let these determine the label. Here they are (1) summarised per
// trajectory, (2) balanced between safe and unsafe trajectories by stratified
// matching, and (3) handed to a probe that must fail to predict the label.

const { Rng } = require('../../sim/simulator');
const { stable } = require('./state');
const { areaUnderRoc } = require('./transition-dataset');

const NUISANCE_FEATURE_NAMES = Object.freeze([
    'actions',
    'transitions',
    'virtualRuntimeMs',
    'warmupActions',
    'faultHazard',
    'operationRate',
    'faultCount',
    'operationCount',
    'controllerTickCount',
    'advanceTimeCount',
    'timerFraction',
    'faults.node-crash',
    'faults.zone-degraded',
    'faults.readiness-delay',
    'faults.image-pull-delay',
    'faults.hpa-stale-metric',
    'faults.endpoint-propagation-delay',
    'faults.controller-restart',
    'operations.scale',
    'operations.roll-out',
    'operations.roll-back',
    'operations.drain-node',
    'operations.recover-node',
    'operations.traffic-spike',
    'hpaScaleEventsPer100',
    'rolloutActiveFraction',
    'pdbDecisionsPer100',
    'initialCpuPercent',
    'initialReadyReplicas',
    'initialPendingReplicas',
    'initialPdbHeadroom',
    'replicas',
    'zones',
    'nodes',
]);

// Reported per outcome but deliberately kept out of the probe and the matching
// vector: they summarise cluster *state* over the trace, so a probe that saw
// them would be measuring causal signal the model is entitled to, not a
// construction shortcut.
const REPORT_ONLY_NUISANCE_NAMES = Object.freeze([
    'timerCount',
    'hpaScaleEvents',
    'rolloutActiveTransitions',
    'pdbDecisions',
    'degradedNodeTransitions',
    'meaningfulTransitions',
    'researchWindowTransitions',
]);

const NUISANCE_CATEGORICAL_NAMES = Object.freeze(['runtime', 'trafficRegime', 'seedBucket', 'scenarioFamily']);

const TRANSITION_NUISANCE_NAMES = Object.freeze([
    'sequence',
    'relativeSequence',
    'atMs',
    'relativeAtMs',
    'hpaClockMs',
]);

function nuisanceVector(summary) {
    return NUISANCE_FEATURE_NAMES.map((name) => {
        const [group, key] = name.split('.');
        const value = key === undefined ? summary[group] : (summary[group] || {})[key];
        return Number(value) || 0;
    });
}

function standardizer(vectors) {
    const dimensions = vectors[0]?.length || 0;
    const mean = Array(dimensions).fill(0);
    const deviation = Array(dimensions).fill(0);
    for (const vector of vectors) vector.forEach((value, index) => { mean[index] += value; });
    mean.forEach((sum, index) => { mean[index] = sum / Math.max(1, vectors.length); });
    for (const vector of vectors) {
        vector.forEach((value, index) => { deviation[index] += (value - mean[index]) ** 2; });
    }
    deviation.forEach((sum, index) => {
        deviation[index] = Math.sqrt(sum / Math.max(1, vectors.length)) || 1;
    });
    return {
        mean,
        deviation,
        apply: (vector) => vector.map((value, index) => (value - mean[index]) / deviation[index]),
    };
}

// Distance weights emphasise the nuisances pilots showed to be most entangled
// with the outcome after exact stratification.
const DISTANCE_WEIGHTS = Object.freeze({
    transitions: 2,
    timerFraction: 2,
    operationCount: 2,
    'operations.roll-out': 2,
    'operations.scale': 1.5,
    'operations.drain-node': 1.5,
    hpaScaleEventsPer100: 2,
    rolloutActiveFraction: 3,
    pdbDecisionsPer100: 1.5,
});

const DISTANCE_WEIGHT_VECTOR = NUISANCE_FEATURE_NAMES.map((name) => DISTANCE_WEIGHTS[name] || 1);
const DISTANCE_WEIGHT_TOTAL = DISTANCE_WEIGHT_VECTOR.reduce((sum, value) => sum + value, 0);

function distance(left, right) {
    let total = 0;
    for (let index = 0; index < left.length; index += 1) {
        total += DISTANCE_WEIGHT_VECTOR[index] * (left[index] - right[index]) ** 2;
    }
    return Math.sqrt(total / DISTANCE_WEIGHT_TOTAL);
}

function quartileCutpoints(values) {
    const sorted = values.slice().sort((left, right) => left - right);
    const at = (fraction) => sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))];
    return [at(0.25), at(0.5), at(0.75)];
}

function lengthBucket(value, cutpoints) {
    return cutpoints.findIndex((cutpoint) => value < cutpoint) === -1
        ? cutpoints.length
        : cutpoints.findIndex((cutpoint) => value < cutpoint);
}

// Strata are hierarchical: an unsafe trajectory first looks for a safe partner
// with the same topology, runtime, traffic regime, and length quartile, then
// progressively drops the finest keys. The coarsest level still pins the split
// so no held-out trajectory can be paired across the holdout boundary, and the
// standardized caliper still applies at every level.
// Fault, crash, and roll-out counts are the nuisances most entangled with the
// outcome (they are causes, not artefacts), so they are matched exactly and
// dropped last; the standardized caliper on the full vector still applies.
const STRATUM_LEVELS = Object.freeze([
    ['topologyId', 'runtime', 'trafficRegime', 'capacityLoss', 'faultCount', 'rollOuts', 'lengthBucket'],
    ['topologyId', 'runtime', 'trafficRegime', 'capacityLoss', 'faultCount', 'rollOuts'],
    ['topologyId', 'runtime', 'capacityLoss', 'faultCount', 'rollOuts'],
    ['topologyId', 'runtime', 'capacityLoss', 'faultBucket', 'rollOuts'],
    ['split', 'runtime', 'capacityLoss', 'faultBucket', 'rollOuts'],
]);


function stratumValue(summary, key, cutpoints) {
    switch (key) {
        case 'lengthBucket': return `len${lengthBucket(summary.actions, cutpoints)}`;
        case 'capacityLoss': return `loss${(summary.faults?.['node-crash'] || 0) + (summary.faults?.['zone-degraded'] || 0)}`;
        case 'faultCount': return `faults${summary.faultCount}`;
        case 'faultBucket': return `faults${Math.min(3, Math.floor(summary.faultCount / 2))}`;
        case 'rollOuts': return `rollouts${Math.min(3, summary.operations?.['roll-out'] || 0)}`;
        default: return String(summary[key]);
    }
}

function stratumKey(summary, cutpoints, level = 0) {
    return STRATUM_LEVELS[level].map((key) => stratumValue(summary, key, cutpoints)).join('|');
}

// Standardised mean difference per nuisance feature, unsafe minus safe. The
// conventional balance threshold is |SMD| <= 0.1; the gate is applied to the
// matched set, and the unmatched value is kept as the "before" column.
function standardizedMeanDifferences(summaries) {
    const unsafe = summaries.filter((item) => item.outcome === 'unsafe').map(nuisanceVector);
    const safe = summaries.filter((item) => item.outcome === 'safe').map(nuisanceVector);
    const moments = (vectors, index) => {
        const values = vectors.map((vector) => vector[index]);
        const mean = values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
        const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, values.length);
        return { mean, variance };
    };
    const report = {};
    NUISANCE_FEATURE_NAMES.forEach((name, index) => {
        const u = moments(unsafe, index);
        const s = moments(safe, index);
        const pooled = Math.sqrt((u.variance + s.variance) / 2);
        report[name] = {
            unsafeMean: u.mean,
            safeMean: s.mean,
            smd: pooled === 0 ? 0 : (u.mean - s.mean) / pooled,
        };
    });
    return stable(report);
}

function categoricalOverlap(summaries) {
    const report = {};
    for (const name of NUISANCE_CATEGORICAL_NAMES) {
        const counts = {};
        for (const item of summaries) {
            const value = String(item[name]);
            counts[value] = counts[value] || { safe: 0, unsafe: 0 };
            counts[value][item.outcome] += 1;
        }
        report[name] = counts;
    }
    return stable(report);
}

/**
 * Greedy 1:1 nearest-neighbour matching of unsafe to safe trajectories inside
 * strata. Ordering is by trajectory ID so the result is a pure function of the
 * pool. Placement is deliberately absent from the strata and the vector: it is
 * the causal variable under test and must not be balanced away.
 */
function matchTrajectories(summaries, options = {}) {
    const caliper = options.caliper ?? 0.8;
    const cutpoints = quartileCutpoints(summaries.map((item) => item.actions));
    const scale = standardizer(summaries.map(nuisanceVector));
    const ordered = summaries.slice().sort((left, right) => left.trajectoryId.localeCompare(right.trajectoryId))
        .map((item) => ({ item, vector: scale.apply(nuisanceVector(item)), taken: false }));
    const safeByKey = STRATUM_LEVELS.map(() => new Map());
    for (const entry of ordered) {
        if (entry.item.outcome !== 'safe') continue;
        STRATUM_LEVELS.forEach((_, level) => {
            const key = stratumKey(entry.item, cutpoints, level);
            if (!safeByKey[level].has(key)) safeByKey[level].set(key, []);
            safeByKey[level].get(key).push(entry);
        });
    }
    const pairs = [];
    const matchedByLevel = STRATUM_LEVELS.map(() => 0);
    let unmatchedUnsafe = 0;
    for (const candidate of ordered) {
        if (candidate.item.outcome !== 'unsafe') continue;
        let matched = false;
        for (let level = 0; level < STRATUM_LEVELS.length && !matched; level += 1) {
            const key = stratumKey(candidate.item, cutpoints, level);
            const pool = safeByKey[level].get(key) || [];
            let best = null;
            let bestDistance = Infinity;
            for (const safe of pool) {
                if (safe.taken) continue;
                const value = distance(candidate.vector, safe.vector);
                if (value < bestDistance) { bestDistance = value; best = safe; }
            }
            if (best === null || bestDistance > caliper) continue;
            best.taken = true;
            matched = true;
            matchedByLevel[level] += 1;
            pairs.push({
                matchId: `match-${String(pairs.length + 1).padStart(6, '0')}`,
                stratum: key,
                stratumLevel: level,
                unsafeTrajectoryId: candidate.item.trajectoryId,
                safeTrajectoryId: best.item.trajectoryId,
                distance: bestDistance,
            });
        }
        if (!matched) unmatchedUnsafe += 1;
    }
    const unmatchedSafe = ordered.filter((entry) => entry.item.outcome === 'safe' && !entry.taken).length;
    const selected = new Map();
    for (const pair of pairs) {
        selected.set(pair.unsafeTrajectoryId, pair.matchId);
        selected.set(pair.safeTrajectoryId, pair.matchId);
    }
    const matched = summaries.filter((item) => selected.has(item.trajectoryId));
    return stable({
        caliper,
        lengthCutpoints: cutpoints,
        stratumLevels: STRATUM_LEVELS,
        matchedByLevel,
        pairs,
        selected: Object.fromEntries(selected),
        counts: {
            pool: summaries.length,
            poolSafe: summaries.filter((item) => item.outcome === 'safe').length,
            poolUnsafe: summaries.filter((item) => item.outcome === 'unsafe').length,
            matchedPairs: pairs.length,
            selectedTrajectories: matched.length,
            unmatchedUnsafe,
            unmatchedSafe,
        },
        balance: {
            before: standardizedMeanDifferences(summaries),
            after: standardizedMeanDifferences(matched),
            categoricalAfter: categoricalOverlap(matched),
        },
    });
}

function foldOf(pairId, folds) {
    let hash = 2166136261;
    for (let index = 0; index < pairId.length; index += 1) {
        hash ^= pairId.charCodeAt(index);
        hash = Math.imul(hash, 16777619) >>> 0;
    }
    return hash % folds;
}

/**
 * Shortcut pruning (AFLite-style) on matched pairs. Each round fits the
 * nuisance-only probe with cross-fitting, scores how predictable every pair's
 * outcome is from nuisance alone, and drops the most predictable pairs. It
 * stops when the cross-fitted AUROC reaches the target or the size floor is
 * hit. Pairs are dropped whole, so the 1:1 balance and the strata survive.
 * Everything removed is reported: this is post-hoc selection on the label,
 * permitted because generation never saw it, and it must stay auditable.
 */
function pruneShortcutPairs(pairs, summariesById, options = {}) {
    const target = options.targetAuroc ?? 0.55;
    const fraction = options.dropFraction ?? 0.1;
    const maxRounds = options.maxRounds ?? 15;
    const minimumPairs = Math.max(options.minimumPairs ?? 0, Math.floor(pairs.length * (options.floorFraction ?? 0.4)));
    const folds = options.folds ?? 4;
    const featureNames = probeFeatureNames('trajectory');
    let current = pairs.slice().sort((left, right) => left.matchId.localeCompare(right.matchId));
    const rounds = [];
    let finalAuroc = null;
    for (let round = 0; round <= maxRounds; round += 1) {
        const items = [];
        for (const pair of current) {
            const fold = foldOf(pair.matchId, folds);
            for (const id of [pair.unsafeTrajectoryId, pair.safeTrajectoryId]) {
                const summary = summariesById.get(id);
                items.push({ pair, id, fold, vector: trajectoryProbeVector(summary), label: summary.outcome === 'unsafe' });
            }
        }
        const scores = new Map();
        for (let fold = 0; fold < folds; fold += 1) {
            const training = items.filter((item) => item.fold !== fold);
            const held = items.filter((item) => item.fold === fold);
            if (!training.length || !held.length) continue;
            const probe = new ShortcutProbe({ featureNames })
                .train(training.map((item) => item.vector), training.map((item) => item.label));
            for (const item of held) scores.set(item.id, probe.score(item.vector));
        }
        const labels = items.map((item) => item.label);
        const values = items.map((item) => scores.get(item.id) ?? 0.5);
        finalAuroc = areaUnderRoc(labels, values);
        const entry = { round, pairs: current.length, crossFitAuroc: finalAuroc, dropped: 0 };
        rounds.push(entry);
        if (finalAuroc <= target || round === maxRounds || current.length <= minimumPairs) break;
        const predictability = current.map((pair) => {
            const unsafeScore = scores.get(pair.unsafeTrajectoryId) ?? 0.5;
            const safeScore = scores.get(pair.safeTrajectoryId) ?? 0.5;
            return { pair, value: (unsafeScore + (1 - safeScore)) / 2 };
        }).sort((left, right) => right.value - left.value || left.pair.matchId.localeCompare(right.pair.matchId));
        const dropCount = Math.min(Math.max(1, Math.floor(current.length * fraction)), current.length - minimumPairs);
        if (dropCount <= 0) break;
        const dropped = new Set(predictability.slice(0, dropCount).map((item) => item.pair.matchId));
        entry.dropped = dropped.size;
        current = current.filter((pair) => !dropped.has(pair.matchId));
    }
    return stable({
        targetAuroc: target,
        dropFraction: fraction,
        folds,
        minimumPairs,
        initialPairs: pairs.length,
        keptPairs: current.length,
        droppedPairs: pairs.length - current.length,
        finalCrossFitAuroc: finalAuroc,
        reachedTarget: finalAuroc !== null && finalAuroc <= target,
        rounds,
        pairs: current,
    });
}

function maxAbsoluteSmd(report) {
    return Math.max(0, ...Object.values(report).map((entry) => Math.abs(entry.smd)));
}

function sigmoid(value) {
    if (value >= 0) return 1 / (1 + Math.exp(-value));
    const exp = Math.exp(value);
    return exp / (1 + exp);
}

/**
 * Nuisance-only logistic classifier. It never sees cluster state, the graph,
 * resource features, or the candidate action. Its only job is to be bad: a
 * corpus is accepted only when this model stays near chance on held-out splits.
 */
class ShortcutProbe {
    constructor({ featureNames, weights = null, bias = 0, mean = null, deviation = null } = {}) {
        this.featureNames = featureNames.slice();
        this.weights = weights ? weights.slice() : Array(featureNames.length).fill(0);
        this.bias = bias;
        this.mean = mean;
        this.deviation = deviation;
    }

    _standardize(vector) {
        return vector.map((value, index) => (value - this.mean[index]) / this.deviation[index]);
    }

    train(vectors, labels, { iterations = 250, learningRate = 0.15, l2 = 0.001 } = {}) {
        if (!vectors.length || vectors.length !== labels.length) throw new TypeError('vectors and labels are required');
        const scale = standardizer(vectors);
        this.mean = scale.mean;
        this.deviation = scale.deviation;
        const rows = vectors.map((vector) => this._standardize(vector));
        for (let iteration = 0; iteration < iterations; iteration += 1) {
            const gradient = Array(this.weights.length).fill(0);
            let biasGradient = 0;
            rows.forEach((x, rowIndex) => {
                const error = sigmoid(this.bias + x.reduce((sum, value, index) => sum + value * this.weights[index], 0))
                    - (labels[rowIndex] ? 1 : 0);
                biasGradient += error;
                for (let index = 0; index < gradient.length; index += 1) gradient[index] += error * x[index];
            });
            this.bias -= learningRate * biasGradient / rows.length;
            for (let index = 0; index < this.weights.length; index += 1) {
                this.weights[index] -= learningRate * (gradient[index] / rows.length + l2 * this.weights[index]);
            }
        }
        return this;
    }

    score(vector) {
        const x = this._standardize(vector);
        return sigmoid(this.bias + x.reduce((sum, value, index) => sum + value * this.weights[index], 0));
    }

    auroc(vectors, labels) {
        return areaUnderRoc(labels.map(Boolean), vectors.map((vector) => this.score(vector)));
    }

    export() {
        return stable({
            kind: 'cloudproof.shortcut-probe',
            featureNames: this.featureNames,
            bias: this.bias,
            weights: this.weights,
            mean: this.mean,
            deviation: this.deviation,
        });
    }
}

function oneHot(value, vocabulary) {
    return vocabulary.map((item) => (String(item) === String(value) ? 1 : 0));
}

const CATEGORICAL_VOCABULARY = Object.freeze({
    runtime: ['correct', 'endpoint-includes-unready', 'rollout-ignores-terminating', 'hpa-stale-indefinitely'],
    trafficRegime: ['low', 'normal', 'high'],
    seedBucket: [0, 1, 2, 3, 4, 5, 6, 7],
    scenarioFamily: ['causal'],
});

function probeFeatureNames(level) {
    if (level === 'position') return [...TRANSITION_NUISANCE_NAMES];
    const names = [...NUISANCE_FEATURE_NAMES];
    for (const name of NUISANCE_CATEGORICAL_NAMES) {
        for (const value of CATEGORICAL_VOCABULARY[name]) names.push(`${name}=${value}`);
    }
    if (level === 'transition') names.push(...TRANSITION_NUISANCE_NAMES);
    return names;
}

function trajectoryProbeVector(summary) {
    const vector = nuisanceVector(summary);
    for (const name of NUISANCE_CATEGORICAL_NAMES) vector.push(...oneHot(summary[name], CATEGORICAL_VOCABULARY[name]));
    return vector;
}

function positionProbeVector(summary, row) {
    return [
        row.sequence,
        row.sequence / Math.max(1, summary.transitions),
        row.atMs,
        row.atMs / Math.max(1, summary.virtualRuntimeMs),
        row.hpaClockMs ?? 0,
    ];
}

/**
 * Label-blind cap on research rows per trajectory. Safe trajectories run to
 * the end of their schedule while unsafe ones stop at the incident, so without
 * a cap long safe trajectories flood the negatives and "long schedule" turns
 * into a row-level shortcut even after trajectory-level matching. Each
 * trajectory above the cap keeps a seeded uniform sample of its rows; the
 * label is never consulted, so P(label | state) inside a trajectory is
 * unchanged and every trajectory contributes at most `cap` rows.
 */
function capRowsPerTrajectory(examples, { cap = null, quantile = 0.5, seed = 9001 } = {}) {
    const byTrajectory = new Map();
    for (const example of examples) {
        if (!byTrajectory.has(example.trajectoryId)) byTrajectory.set(example.trajectoryId, []);
        byTrajectory.get(example.trajectoryId).push(example);
    }
    const sizes = [...byTrajectory.values()].map((rows) => rows.length).sort((left, right) => left - right);
    const effectiveCap = cap ?? (sizes.length ? sizes[Math.min(sizes.length - 1, Math.floor(quantile * sizes.length))] : 0);
    const rng = new Rng(seed);
    const kept = new Set();
    let capped = 0;
    for (const trajectoryId of [...byTrajectory.keys()].sort()) {
        const rows = byTrajectory.get(trajectoryId).slice().sort((left, right) => left.recordId.localeCompare(right.recordId));
        if (rows.length <= effectiveCap) { rows.forEach((row) => kept.add(row.recordId)); continue; }
        capped += 1;
        rows.map((row) => ({ row, roll: rng.float() }))
            .sort((left, right) => left.roll - right.roll || left.row.recordId.localeCompare(right.row.recordId))
            .slice(0, effectiveCap)
            .forEach(({ row }) => kept.add(row.recordId));
    }
    const result = stable({
        cap: effectiveCap,
        quantile,
        seed,
        trajectories: byTrajectory.size,
        cappedTrajectories: capped,
        rowsBefore: examples.length,
        rowsAfter: kept.size,
    });
    result.keep = kept;
    return result;
}

const POSITION_CELL = Object.freeze({ sequenceWidth: 20, sequenceBuckets: 8, relativeBuckets: 10 });

function positionCell(example) {
    const sequenceBucket = Math.min(POSITION_CELL.sequenceBuckets - 1,
        Math.floor(example.sequence / POSITION_CELL.sequenceWidth));
    const relativeBucket = Math.min(POSITION_CELL.relativeBuckets - 1,
        Math.floor((example.sequence / Math.max(1, example.transitions)) * POSITION_CELL.relativeBuckets));
    return `s${sequenceBucket}|r${relativeBucket}`;
}

/**
 * Post-hoc position balancing of research rows. Rows are truncated at the
 * first incident and incidents are not exponentially timed, so the K-horizon
 * positive rate rises with position: a row's index alone predicted the label
 * at 0.60-0.65 AUROC in pilots. Within each (absolute, relative) position cell
 * the rate is raised to a common target by dropping negatives with a seeded
 * coin; positives are never dropped and no cell is emptied. Selection inside a
 * cell is independent of state, so P(label | state, cell) is unchanged; only
 * the mixture over cells is reweighted, and every drop is reported.
 */
function balancePositions(examples, { horizon = 5, targetQuantile = 0.75, minimumKeepFraction = 0.25, seed = 4242 } = {}) {
    const key = String(horizon);
    const cells = new Map();
    for (const example of examples) {
        const cell = positionCell(example);
        if (!cells.has(cell)) cells.set(cell, { positives: [], negatives: [] });
        cells.get(cell)[example.horizons[key] ? 'positives' : 'negatives'].push(example);
    }
    // Row-weighted quantile of cell rates: small, noisy corner cells must not
    // set the target for everyone else.
    const weighted = [...cells.values()].map((cell) => ({
        rate: cell.positives.length / Math.max(1, cell.positives.length + cell.negatives.length),
        rows: cell.positives.length + cell.negatives.length,
    })).sort((left, right) => left.rate - right.rate);
    const totalRows = weighted.reduce((sum, cell) => sum + cell.rows, 0);
    let cumulative = 0;
    let quantileRate = 0;
    for (const cell of weighted) {
        cumulative += cell.rows;
        quantileRate = cell.rate;
        if (cumulative >= targetQuantile * totalRows) break;
    }
    const globalRate = examples.filter((example) => example.horizons[key]).length / Math.max(1, examples.length);
    const target = Math.max(globalRate, quantileRate);
    const rng = new Rng(seed);
    const kept = new Set();
    const report = {};
    for (const [name, cell] of [...cells.entries()].sort(([left], [right]) => left.localeCompare(right))) {
        const total = cell.positives.length + cell.negatives.length;
        const before = cell.positives.length / Math.max(1, total);
        cell.positives.forEach((example) => kept.add(example.recordId));
        let keepNegatives = cell.negatives.length;
        if (before < target && target > 0) {
            keepNegatives = Math.max(
                Math.ceil(cell.negatives.length * minimumKeepFraction),
                Math.round(cell.positives.length * (1 - target) / target),
            );
        }
        const ordered = cell.negatives.slice().sort((left, right) => left.recordId.localeCompare(right.recordId));
        // Seeded reservoir: consume one roll per negative in a fixed order.
        const scored = ordered.map((example) => ({ example, roll: rng.float() }))
            .sort((left, right) => left.roll - right.roll || left.example.recordId.localeCompare(right.example.recordId));
        scored.slice(0, keepNegatives).forEach(({ example }) => kept.add(example.recordId));
        report[name] = {
            rows: total,
            positives: cell.positives.length,
            rateBefore: before,
            keptNegatives: Math.min(keepNegatives, cell.negatives.length),
            droppedNegatives: cell.negatives.length - Math.min(keepNegatives, cell.negatives.length),
            rateAfter: cell.positives.length / Math.max(1, cell.positives.length + Math.min(keepNegatives, cell.negatives.length)),
        };
    }
    // `stable` would flatten the Set, so the keep-set is attached afterwards.
    const result = stable({
        horizon,
        targetQuantile,
        minimumKeepFraction,
        seed,
        targetRate: target,
        globalRateBefore: globalRate,
        rowsBefore: examples.length,
        rowsAfter: kept.size,
        droppedRows: examples.length - kept.size,
        cells: report,
    });
    result.keep = kept;
    return result;
}

function transitionProbeVector(summary, row) {
    return [...trajectoryProbeVector(summary), ...positionProbeVector(summary, row)];
}

function shuffledLabels(labels, seed) {
    const rng = new Rng(seed);
    const copy = labels.slice();
    for (let index = copy.length - 1; index > 0; index -= 1) {
        const swap = rng.int(index + 1);
        [copy[index], copy[swap]] = [copy[swap], copy[index]];
    }
    return copy;
}

// Deterministic subsample so probes stay bounded on large corpora; the same
// rows are chosen whatever machine runs the gate.
function deterministicSubsample(items, limit, seed) {
    if (items.length <= limit) return items.slice();
    const rng = new Rng(seed);
    const chosen = new Set();
    while (chosen.size < limit) chosen.add(rng.int(items.length));
    return [...chosen].sort((left, right) => left - right).map((index) => items[index]);
}

module.exports = {
    CATEGORICAL_VOCABULARY,
    NUISANCE_CATEGORICAL_NAMES,
    NUISANCE_FEATURE_NAMES,
    REPORT_ONLY_NUISANCE_NAMES,
    STRATUM_LEVELS,
    ShortcutProbe,
    TRANSITION_NUISANCE_NAMES,
    balancePositions,
    capRowsPerTrajectory,
    categoricalOverlap,
    deterministicSubsample,
    lengthBucket,
    matchTrajectories,
    maxAbsoluteSmd,
    nuisanceVector,
    positionCell,
    positionProbeVector,
    probeFeatureNames,
    pruneShortcutPairs,
    quartileCutpoints,
    shuffledLabels,
    standardizedMeanDifferences,
    stratumKey,
    trajectoryProbeVector,
    transitionProbeVector,
};
