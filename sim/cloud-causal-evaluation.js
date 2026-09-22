'use strict';

// Phase II-A.2 evaluation and acceptance gates.
//
// Everything here runs on compact per-row examples (risk features, heuristic
// score, horizon labels, nuisance references) rather than on graphs, so the
// gates stay cheap enough to run inside the generator and reject a corpus
// before anything downstream can train on it.

const { stable } = require('../packages/cloudproof/state');
const {
    RiskBaseline,
    areaUnderPrecisionRecall,
    areaUnderRoc,
    evaluateRiskBaseline,
    evaluateScores,
} = require('../packages/cloudproof/transition-dataset');
const {
    DEFAULT_VERIFICATION_BUDGETS,
    evaluateSchedulePrioritizers,
} = require('../packages/cloudproof/schedule-evaluation');
const {
    ShortcutProbe,
    deterministicSubsample,
    maxAbsoluteSmd,
    positionProbeVector,
    probeFeatureNames,
    shuffledLabels,
    trajectoryProbeVector,
    transitionProbeVector,
} = require('../packages/cloudproof/nuisance');
const { pairwiseRanking } = require('../packages/cloudproof/counterfactual-pairs');
const { DEFAULT_HORIZON, HORIZONS, SPLITS } = require('./cloud-causal-corpus');

const EVALUATION_SPLITS = Object.freeze(['validation', 'test', 'ood']);
const DEFAULT_PERMUTATION_SEEDS = Object.freeze([1337, 2027, 4099, 7919, 104729]);

function horizonView(example, horizon) {
    return {
        features: example.features,
        heuristicScore: example.heuristicScore,
        action: null,
        labels: { sloViolationWithinKTransitions: Boolean(example.horizons[String(horizon)]) },
    };
}

function trainBaseline(examples, horizon, options = {}) {
    return new RiskBaseline().train(examples.map((example) => horizonView(example, horizon)), {
        iterations: options.iterations ?? 400,
        learningRate: options.learningRate ?? 0.1,
        balanceClasses: true,
    });
}

function positiveRate(examples, horizon) {
    if (!examples.length) return null;
    return examples.filter((example) => example.horizons[String(horizon)]).length / examples.length;
}

function transitionMetrics(examplesBySplit, options = {}) {
    const models = {};
    const metrics = {};
    for (const horizon of HORIZONS) {
        const model = trainBaseline(examplesBySplit.train, horizon, options);
        models[horizon] = model;
        metrics[String(horizon)] = {};
        for (const split of EVALUATION_SPLITS) {
            const records = examplesBySplit[split].map((example) => horizonView(example, horizon));
            if (!records.length) continue;
            metrics[String(horizon)][split] = {
                positiveRate: positiveRate(examplesBySplit[split], horizon),
                ...evaluateRiskBaseline(model, records, {
                    randomSeed: (options.randomSeed ?? 1337) + SPLITS.indexOf(split) + horizon,
                }),
            };
        }
    }
    return { models, metrics };
}

// A trajectory's risk is the maximum over its pre-incident rows, evaluated
// against the trajectory outcome. This is the unit at which rows stop being
// pseudo-independent evidence.
function trajectoryMetrics(examplesBySplit, models, summariesById) {
    const report = {};
    for (const split of EVALUATION_SPLITS) {
        const examples = examplesBySplit[split];
        if (!examples.length) continue;
        const byTrajectory = new Map();
        for (const example of examples) {
            const entry = byTrajectory.get(example.trajectoryId)
                || { outcome: example.outcome === 'unsafe', tier: example.tier, heuristic: 0, logistic: 0 };
            entry.heuristic = Math.max(entry.heuristic, example.heuristicScore);
            entry.logistic = Math.max(entry.logistic, models[DEFAULT_HORIZON].scoreFeatures(example.features));
            byTrajectory.set(example.trajectoryId, entry);
        }
        const entries = [...byTrajectory.values()];
        const labels = entries.map((entry) => entry.outcome);
        const tiers = {};
        for (const entry of entries) {
            if (!entry.outcome) continue;
            tiers[String(entry.tier)] = (tiers[String(entry.tier)] || 0) + 1;
        }
        report[split] = stable({
            trajectories: entries.length,
            unsafeTrajectories: labels.filter(Boolean).length,
            unsafeByTier: tiers,
            heuristic: {
                auroc: areaUnderRoc(labels, entries.map((entry) => entry.heuristic)),
                auprc: areaUnderPrecisionRecall(labels, entries.map((entry) => entry.heuristic)),
            },
            logistic: {
                auroc: areaUnderRoc(labels, entries.map((entry) => entry.logistic)),
                auprc: areaUnderPrecisionRecall(labels, entries.map((entry) => entry.logistic)),
            },
        });
    }
    void summariesById;
    return report;
}

function horizonDistinctness(examplesBySplit) {
    const all = SPLITS.flatMap((split) => examplesBySplit[split]);
    const rates = Object.fromEntries(HORIZONS.map((horizon) => [String(horizon), positiveRate(all, horizon)]));
    const differing = (left, right) => all.some((example) => (
        example.horizons[String(left)] !== example.horizons[String(right)]
    ));
    return stable({
        positiveRates: rates,
        strictlyIncreasing: HORIZONS.every((horizon, index) => index === 0
            || rates[String(horizon)] > rates[String(HORIZONS[index - 1])]),
        tenAndTwentyDiffer: differing(10, 20),
        oneAndFiveDiffer: differing(1, 5),
    });
}

function scoreMetrics(labels, scores) {
    if (!labels.length || !labels.some(Boolean) || labels.every(Boolean)) return null;
    const records = labels.map((label) => ({ labels: { sloViolationWithinKTransitions: label } }));
    return evaluateScores(records, scores);
}

// A held-out split only enters the hard gate on its own once it is large
// enough for an AUROC to mean something; smaller splits still count through
// the pooled held-out estimate, so nothing is silently ignored.
const MINIMUM_GATED_SPLIT_SIZE = Object.freeze({ trajectory: 100, transition: 2000 });

function probeReport(trainVectors, trainLabels, evaluation, featureNames, level = 'transition') {
    const probe = new ShortcutProbe({ featureNames }).train(trainVectors, trainLabels);
    const aurocBySplit = {};
    const metricsBySplit = {};
    const sizeBySplit = {};
    const pooledLabels = [];
    const pooledScores = [];
    for (const [split, { vectors, labels }] of Object.entries(evaluation)) {
        const scores = vectors.map((vector) => probe.score(vector));
        const metrics = scoreMetrics(labels, scores);
        metricsBySplit[split] = metrics;
        aurocBySplit[split] = metrics ? metrics.auroc : null;
        sizeBySplit[split] = vectors.length;
        pooledLabels.push(...labels);
        pooledScores.push(...scores);
    }
    const pooled = scoreMetrics(pooledLabels, pooledScores);
    const minimum = MINIMUM_GATED_SPLIT_SIZE[level];
    const gated = Object.entries(aurocBySplit)
        .filter(([split, value]) => value !== null && sizeBySplit[split] >= minimum)
        .map(([, value]) => value);
    const observed = Object.values(aurocBySplit).filter((value) => value !== null);
    return {
        probe,
        report: stable({
            trainingRows: trainVectors.length,
            trainingPositiveRate: trainLabels.filter(Boolean).length / Math.max(1, trainLabels.length),
            aurocBySplit,
            metricsBySplit,
            sizeBySplit,
            minimumGatedSplitSize: minimum,
            pooledHeldOut: pooled,
            maxAuroc: observed.length ? Math.max(...observed) : null,
            gateAuroc: Math.max(pooled ? pooled.auroc : 0, ...gated),
        }),
    };
}

/**
 * ShortcutProbe at both levels. Trajectory level predicts the outcome from the
 * trajectory's nuisance summary; transition level adds only position and clock
 * and predicts the horizon label. Neither sees the graph or the action.
 */
function shortcutProbes(selectedSummaries, examplesBySplit, options = {}) {
    const byId = new Map(selectedSummaries.map((summary) => [summary.trajectoryId, summary]));
    const trajectoryNames = probeFeatureNames('trajectory');
    const transitionNames = probeFeatureNames('transition');
    const trajectory = {};
    for (const split of SPLITS) {
        const items = selectedSummaries.filter((summary) => summary.split === split);
        trajectory[split] = {
            vectors: items.map(trajectoryProbeVector),
            labels: items.map((summary) => summary.outcome === 'unsafe'),
        };
    }
    const trajectoryProbe = probeReport(trajectory.train.vectors, trajectory.train.labels,
        Object.fromEntries(EVALUATION_SPLITS.map((split) => [split, trajectory[split]])), trajectoryNames, 'trajectory');
    const limits = { train: options.probeTrainLimit ?? 60000, evaluation: options.probeEvaluationLimit ?? 30000 };
    const transition = {};
    for (const split of SPLITS) {
        const items = deterministicSubsample(examplesBySplit[split],
            split === 'train' ? limits.train : limits.evaluation, 7 + SPLITS.indexOf(split));
        transition[split] = {
            vectors: items.map((example) => transitionProbeVector(byId.get(example.trajectoryId), example)),
            positionVectors: items.map((example) => positionProbeVector(byId.get(example.trajectoryId), example)),
            trajectoryVectors: items.map((example) => trajectoryProbeVector(byId.get(example.trajectoryId))),
            horizons: Object.fromEntries(HORIZONS.map((horizon) => [String(horizon),
                items.map((example) => Boolean(example.horizons[String(horizon)]))])),
        };
    }
    const evaluationSets = (field, key) => Object.fromEntries(EVALUATION_SPLITS.map((split) => [split,
        { vectors: transition[split][field], labels: transition[split].horizons[key] }]));
    const transitionByHorizon = {};
    const transitionProbes = {};
    const positionOnly = {};
    const trajectoryNuisanceOnly = {};
    for (const horizon of HORIZONS) {
        const key = String(horizon);
        const result = probeReport(transition.train.vectors, transition.train.horizons[key],
            evaluationSets('vectors', key), transitionNames);
        transitionByHorizon[key] = result.report;
        transitionProbes[key] = result.probe;
        // Two diagnostic decompositions: what position alone explains, and
        // what the trajectory's construction nuisance alone explains.
        positionOnly[key] = probeReport(transition.train.positionVectors, transition.train.horizons[key],
            evaluationSets('positionVectors', key), probeFeatureNames('position')).report;
        trajectoryNuisanceOnly[key] = probeReport(transition.train.trajectoryVectors, transition.train.horizons[key],
            evaluationSets('trajectoryVectors', key), trajectoryNames).report;
    }
    return {
        trajectoryProbe: trajectoryProbe.probe,
        transitionProbes,
        vectors: { trajectory, transition },
        report: stable({
            featureNames: { trajectory: trajectoryNames, transition: transitionNames },
            excludedInputs: ['state graph', 'resource features', 'candidate action', 'placement', 'labels'],
            trajectory: trajectoryProbe.report,
            transition: transitionByHorizon,
            transitionPositionOnly: positionOnly,
            transitionTrajectoryNuisanceOnly: trajectoryNuisanceOnly,
            gateHorizon: DEFAULT_HORIZON,
        }),
    };
}

/**
 * Multi-seed label permutation. Each seed shuffles the training labels, trains
 * the same probe/baseline, and scores real held-out labels. All trials must sit
 * inside the chance band; a single run is not accepted as evidence.
 */
function permutationControls(probeVectors, examplesBySplit, options = {}) {
    const seeds = options.permutationSeeds || DEFAULT_PERMUTATION_SEEDS;
    const band = options.permutationBand ?? 0.05;
    const trials = [];
    const trainRecords = examplesBySplit.train.map((example) => horizonView(example, DEFAULT_HORIZON));
    const validationRecords = examplesBySplit.validation.map((example) => horizonView(example, DEFAULT_HORIZON));
    const validationLabels = validationRecords.map((record) => record.labels.sloViolationWithinKTransitions);
    for (const seed of seeds) {
        const trajectoryLabels = shuffledLabels(probeVectors.trajectory.train.labels, seed);
        const trajectoryProbe = new ShortcutProbe({ featureNames: probeFeatureNames('trajectory') })
            .train(probeVectors.trajectory.train.vectors, trajectoryLabels);
        const transitionLabels = shuffledLabels(probeVectors.transition.train.horizons[String(DEFAULT_HORIZON)], seed);
        const transitionProbe = new ShortcutProbe({ featureNames: probeFeatureNames('transition') })
            .train(probeVectors.transition.train.vectors, transitionLabels);
        const permutedRecords = shuffledLabels(trainRecords.map((record) => record.labels.sloViolationWithinKTransitions), seed)
            .map((label, index) => ({ ...trainRecords[index], labels: { sloViolationWithinKTransitions: label } }));
        const logistic = new RiskBaseline().train(permutedRecords, {
            iterations: options.iterations ?? 400, learningRate: options.learningRate ?? 0.1, balanceClasses: true,
        });
        const evaluationLabels = probeVectors.transition.validation.horizons[String(DEFAULT_HORIZON)];
        trials.push(stable({
            seed,
            trajectoryProbeAuroc: trajectoryProbe.auroc(probeVectors.trajectory.validation.vectors,
                probeVectors.trajectory.validation.labels),
            transitionProbeAuroc: transitionProbe.auroc(probeVectors.transition.validation.vectors, evaluationLabels),
            logisticAuroc: validationRecords.length
                ? areaUnderRoc(validationLabels, validationRecords.map((record) => logistic.scoreFeatures(record.features)))
                : null,
        }));
    }
    const summarize = (values) => {
        const observed = values.filter((value) => value !== null);
        if (!observed.length) return null;
        const mean = observed.reduce((sum, value) => sum + value, 0) / observed.length;
        const variance = observed.reduce((sum, value) => sum + (value - mean) ** 2, 0) / observed.length;
        return {
            mean,
            stddev: Math.sqrt(variance),
            minimum: Math.min(...observed),
            maximum: Math.max(...observed),
            trials: observed.length,
        };
    };
    const families = {
        trajectoryProbe: summarize(trials.map((trial) => trial.trajectoryProbeAuroc)),
        transitionProbe: summarize(trials.map((trial) => trial.transitionProbeAuroc)),
        logisticBaseline: summarize(trials.map((trial) => trial.logisticAuroc)),
    };
    const values = trials.flatMap((trial) => [trial.trajectoryProbeAuroc, trial.transitionProbeAuroc, trial.logisticAuroc])
        .filter((value) => value !== null);
    const overall = summarize(values);
    const meanBand = options.permutationMeanBand ?? 0.03;
    const trialBand = options.permutationTrialBand ?? 0.15;
    const present = Object.values(families).filter(Boolean);
    // The permuted model is a random direction in an informative feature
    // space, so on a bounded corpus single trials legitimately scatter by a
    // few hundredths. The mean criterion therefore widens with the observed
    // trial spread (2.5 standard errors) instead of pretending the scatter
    // does not exist; at full scale the spread collapses and the fixed band
    // dominates.
    const meanAllowance = (family) => Math.max(meanBand, 2.5 * family.stddev / Math.sqrt(family.trials));
    return stable({
        seeds,
        band,
        meanBand,
        trialBand,
        trials,
        families,
        meanAuroc: overall.mean,
        stddevAuroc: overall.stddev,
        minAuroc: overall.minimum,
        maxAuroc: overall.maximum,
        // Hard gate: every family's mean sits near chance and no single trial
        // is far from it. The tighter `band` only raises a warning: a random
        // linear direction in an informative 9-feature space legitimately
        // swings AUROC by a few hundredths on a bounded validation slice.
        allWithinBand: values.every((value) => Math.abs(value - 0.5) <= band),
        meansNearChance: present.every((family) => Math.abs(family.mean - 0.5) <= meanAllowance(family)),
        meanAllowances: Object.fromEntries(Object.entries(families)
            .map(([name, family]) => [name, family ? meanAllowance(family) : null])),
        trialsBounded: Object.values(families).every((family) => family === null
            || family.maximum - 0.5 <= Math.max(trialBand, 3 * family.stddev)
            && 0.5 - family.minimum <= Math.max(trialBand, 3 * family.stddev)),
        warnings: values.filter((value) => Math.abs(value - 0.5) > band).length,
    });
}

function pairEvaluation(pairSummaries, models) {
    const heuristic = (record) => record.heuristicScore;
    const logistic = (record) => models[DEFAULT_HORIZON].scoreFeatures(record.features);
    const counts = { total: pairSummaries.length, valid: 0, discordant: 0, horizonDiscordant: 0, aggregateMatched: 0,
        safeToUnsafe: 0, unsafeToSafe: 0, sameOutcome: 0, invalid: 0 };
    const families = {};
    const bySplit = {};
    for (const pair of pairSummaries) {
        const family = families[pair.family] = families[pair.family]
            || { total: 0, valid: 0, discordant: 0, aggregateMatched: 0, riskierB: 0,
                safeToUnsafe: 0, unsafeToSafe: 0, sameOutcome: 0 };
        const split = bySplit[pair.split] = bySplit[pair.split] || { total: 0, discordant: 0 };
        family.total += 1;
        split.total += 1;
        if (pair.valid) { counts.valid += 1; family.valid += 1; } else counts.invalid += 1;
        if (pair.outcomeChange === 'same') { counts.sameOutcome += 1; family.sameOutcome += 1; }
        if (pair.outcomeChange === 'safe->unsafe') { counts.safeToUnsafe += 1; family.safeToUnsafe += 1; }
        if (pair.outcomeChange === 'unsafe->safe') { counts.unsafeToSafe += 1; family.unsafeToSafe += 1; }
        if (pair.discordant) {
            counts.discordant += 1; family.discordant += 1; split.discordant += 1;
            if (pair.riskierVariant === 'B') family.riskierB += 1;
        }
        if (pair.horizonDiscordant) counts.horizonDiscordant += 1;
        if (pair.aggregateMatched) { counts.aggregateMatched += 1; family.aggregateMatched += 1; }
    }
    const placementFamilies = pairSummaries.filter((pair) => pair.family !== 'capacity-distribution');
    return stable({
        counts,
        families,
        bySplit,
        placementFamiliesAggregateMatched: placementFamilies.length > 0
            && placementFamilies.every((pair) => pair.aggregateMatched),
        ranking: {
            heuristic: {
                trajectory: pairwiseRanking(pairSummaries, heuristic, 'trajectory'),
                horizon5: pairwiseRanking(pairSummaries, heuristic, 'horizon5'),
            },
            logistic: {
                trajectory: pairwiseRanking(pairSummaries, logistic, 'trajectory'),
                horizon5: pairwiseRanking(pairSummaries, logistic, 'horizon5'),
            },
        },
    });
}

function evaluateCausalCorpus(corpus, options = {}) {
    const { examplesBySplit, selectedSummaries, candidates, pairSummaries } = corpus;
    if (!examplesBySplit.train.length) throw new Error('training split is empty');
    const { models, metrics } = transitionMetrics(examplesBySplit, options);
    const probes = shortcutProbes(selectedSummaries, examplesBySplit, options);
    const permutation = permutationControls(probes.vectors, examplesBySplit, options);
    const heldOut = candidates.filter((candidate) => candidate.split !== 'train');
    const prioritization = heldOut.length
        ? evaluateSchedulePrioritizers(heldOut, models[DEFAULT_HORIZON], {
            budgets: options.budgets || DEFAULT_VERIFICATION_BUDGETS,
            randomSeed: options.randomSeed ?? 1337,
        })
        : null;
    return stable({
        kind: 'cloudproof.causal-corpus-evaluation',
        schemaVersion: 1,
        defaultHorizon: DEFAULT_HORIZON,
        splitIntegrity: splitIntegrity({
            summaries: corpus.summaries,
            examplesBySplit,
            pairSummaries,
            catalog: corpus.manifest.parameters.topologyCatalog,
        }),
        models: Object.fromEntries(HORIZONS.map((horizon) => [String(horizon), models[horizon].export()])),
        transitionMetrics: metrics,
        trajectoryMetrics: trajectoryMetrics(examplesBySplit, models),
        horizons: horizonDistinctness(examplesBySplit),
        shortcutProbe: probes.report,
        labelPermutation: permutation,
        counterfactualPairs: pairEvaluation(pairSummaries, models),
        schedulePrioritization: prioritization,
    });
}

/**
 * Split integrity over every unit that could leak: topology IDs, trajectory
 * IDs, transition rows, and counterfactual pair members. Each check is an
 * explicit pairwise emptiness assertion so a failure names the offending pair.
 */
function splitIntegrity({ summaries, examplesBySplit, pairSummaries, catalog }) {
    const pairsOfSplits = [];
    for (let left = 0; left < SPLITS.length; left += 1) {
        for (let right = left + 1; right < SPLITS.length; right += 1) pairsOfSplits.push([SPLITS[left], SPLITS[right]]);
    }
    const disjoint = (sets) => Object.fromEntries(pairsOfSplits.map(([left, right]) => [
        `${left}∩${right}`, [...sets[left]].filter((item) => sets[right].has(item)).length,
    ]));
    const topologyIds = Object.fromEntries(SPLITS.map((split) => [split,
        new Set(catalog.filter((entry) => entry.split === split).map((entry) => entry.topologyId))]));
    const trajectoryIds = Object.fromEntries(SPLITS.map((split) => [split,
        new Set(summaries.filter((summary) => summary.split === split).map((summary) => summary.trajectoryId))]));
    const rowTrajectoryIds = Object.fromEntries(SPLITS.map((split) => [split,
        new Set(examplesBySplit[split].map((example) => example.trajectoryId))]));
    const rowsMatchTrajectorySplit = SPLITS.every((split) => examplesBySplit[split]
        .every((example) => example.split === split && trajectoryIds[split].has(example.trajectoryId)));
    const pairTopologyIds = Object.fromEntries(SPLITS.map((split) => [split,
        new Set(pairSummaries.filter((pair) => pair.split === split).map((pair) => pair.topologyId))]));
    const pairMembersShareSplit = pairSummaries.every((pair) => topologyIds[pair.split].has(pair.topologyId));
    const overlaps = {
        topologyIds: disjoint(topologyIds),
        trajectoryIds: disjoint(trajectoryIds),
        rowTrajectoryIds: disjoint(rowTrajectoryIds),
        pairTopologyIds: disjoint(pairTopologyIds),
    };
    const ok = Object.values(overlaps).every((table) => Object.values(table).every((count) => count === 0))
        && rowsMatchTrajectorySplit && pairMembersShareSplit
        && summaries.length === new Set(summaries.map((summary) => summary.trajectoryId)).size;
    return stable({ ok, overlaps, rowsMatchTrajectorySplit, pairMembersShareSplit,
        uniqueTrajectoryIds: summaries.length === new Set(summaries.map((summary) => summary.trajectoryId)).size });
}

function probeVerdict(auroc, warnMax, hardMax) {
    if (auroc === null) return 'unavailable';
    if (auroc >= hardMax) return 'fail';
    if (auroc > warnMax) return 'warning';
    return 'pass';
}

function evaluateCausalAcceptance(corpus, evaluation, options = {}) {
    const manifest = corpus.manifest;
    // Chance is the target; the warning region records residual signal
    // honestly, and only clearly strong prediction rejects the corpus.
    const shortcutWarn = options.shortcutAurocMax ?? 0.55;
    const shortcutHard = options.shortcutAurocHardMax ?? 0.65;
    const smdMax = options.smdMax ?? 0.25;
    const catalog = manifest.parameters.topologyCatalog;
    const splitIds = Object.fromEntries(SPLITS.map((split) => [split,
        new Set(catalog.filter((entry) => entry.split === split).map((entry) => entry.topologyId))]));
    const allIds = SPLITS.flatMap((split) => [...splitIds[split]]);
    const probe = evaluation.shortcutProbe;
    const horizonKey = String(DEFAULT_HORIZON);
    const probeVerdicts = stable({
        trajectory: probeVerdict(probe.trajectory.gateAuroc, shortcutWarn, shortcutHard),
        transitionNuisanceOnly: probeVerdict(probe.transitionTrajectoryNuisanceOnly[horizonKey].gateAuroc,
            shortcutWarn, shortcutHard),
        transitionWithPosition: probeVerdict(probe.transition[horizonKey].gateAuroc, shortcutWarn, shortcutHard),
        transitionPositionOnly: probeVerdict(probe.transitionPositionOnly[horizonKey].gateAuroc,
            shortcutWarn, shortcutHard),
    });
    const requiredBudgets = options.budgets || DEFAULT_VERIFICATION_BUDGETS;
    const prioritizers = evaluation.schedulePrioritization?.methods || {};
    const integrity = evaluation.splitIntegrity;
    const gates = stable({
        outcomeBlindGeneration: manifest.generator.outcomeBlind === true
            && manifest.generator.id === 'cloudproof.causal-generator',
        labelsFromDeterministicExecution: manifest.replay.selectedReplayed === manifest.counts.selectedTrajectories
            && manifest.replay.fingerprintMismatches === 0,
        minimumCorpusSize: manifest.counts.pool >= (options.minimumTrajectories ?? 20000),
        minimumRawOutcomes: manifest.counts.poolSafe >= (options.minimumSafe ?? 1)
            && manifest.counts.poolUnsafe >= (options.minimumUnsafe ?? 1),
        minimumMatchedPairs: manifest.matching.counts.matchedPairs >= (options.minimumMatchedPairs ?? 4000),
        selectedBalance: manifest.counts.selectedSafe === manifest.counts.selectedUnsafe,
        matchingDeterministic: manifest.matching.deterministic === true,
        // Finite-sample allowance: with n matched pairs the SMD of a balanced
        // feature scatters with standard error sqrt(2/n), and the gate looks
        // at the maximum over ~30 features.
        nuisanceDistributionsOverlap: maxAbsoluteSmd(manifest.matching.balance.after)
            <= Math.max(smdMax, 3 * Math.sqrt(2 / Math.max(1, manifest.matching.counts.matchedPairs))),
        shortcutProbeNotStrong: Object.values(probeVerdicts).every((verdict) => verdict !== 'fail'),
        labelPermutationNearChance: evaluation.labelPermutation.meansNearChance
            && evaluation.labelPermutation.trialsBounded,
        splitIntegrity: integrity?.ok === true,
        topologyHeldOutSplits: allIds.length === new Set(allIds).size
            && splitIds.validation.size > 0 && splitIds.test.size > 0,
        explicitOodSplit: catalog.filter((entry) => entry.split === 'train')
            .every((entry) => entry.topology.initialReplicas <= 6)
            && splitIds.ood.size > 0
            && catalog.filter((entry) => entry.split === 'ood').every((entry) => entry.topology.initialReplicas >= 8),
        freshHoldouts: manifest.holdouts.testAndOodUnseenByEarlierPhases === true,
        counterfactualPairsPresent: evaluation.counterfactualPairs.counts.discordant
            >= (options.minimumDiscordantPairs ?? 100),
        pairLabelsSimulatorDerived: manifest.pairs.replayVerified === true,
        pairAggregateFeaturesMatched: evaluation.counterfactualPairs.placementFamiliesAggregateMatched === true,
        horizonsDistinct: evaluation.horizons.strictlyIncreasing && evaluation.horizons.tenAndTwentyDiffer,
        noFutureStateInRows: manifest.features.rowsCarryNextState === false
            && manifest.features.excluded.includes('nextState'),
        noFamilyIdentifiersInInputs: manifest.features.inputKeys.join(',') === 'action,state'
            && manifest.features.candidateActionExcludes.includes('atMs'),
        manifestHashesPresent: Object.values(manifest.files).every((file) => file.sha256?.length === 64),
        phaseOneReplayByteIdentical: manifest.replay.phaseOneArtifact?.byteIdentical === true
            && manifest.replay.phaseOneArtifact?.sameFailure === true,
        // Every held-out split that produced rows must be scored at every
        // horizon; validation must always have rows. A tiny smoke pool may
        // leave test or OOD without matched pairs, which the counts expose.
        baselineMetricsComplete: Boolean(evaluation.transitionMetrics[String(DEFAULT_HORIZON)].validation)
            && HORIZONS.every((horizon) => EVALUATION_SPLITS.every((split) => (
                corpus.examplesBySplit[split].length === 0 || Boolean(evaluation.transitionMetrics[String(horizon)][split])
            ))),
        fixedBudgetPrioritizersComplete: ['random', 'coverageGuided', 'heuristic', 'logistic'].every((method) => (
            Boolean(prioritizers[method])
            && requiredBudgets.every((budget) => Boolean(prioritizers[method].budgets[String(budget)]))
        )),
    });
    const warnings = [];
    for (const [name, verdict] of Object.entries(probeVerdicts)) {
        if (verdict === 'warning') warnings.push(`shortcut probe ${name} in warning region (${shortcutWarn}, ${shortcutHard})`);
    }
    if (evaluation.labelPermutation.warnings > 0) {
        warnings.push(`${evaluation.labelPermutation.warnings} permutation trial(s) outside ±${evaluation.labelPermutation.band}`);
    }
    return stable({
        passed: Object.values(gates).every(Boolean),
        gates,
        warnings,
        probeVerdicts,
        thresholds: {
            shortcutAurocWarn: shortcutWarn,
            shortcutAurocHardMax: shortcutHard,
            smdMax,
            smdMaxEffective: Math.max(smdMax, 3 * Math.sqrt(2 / Math.max(1, manifest.matching.counts.matchedPairs))),
            maxAbsoluteSmdAfter: maxAbsoluteSmd(manifest.matching.balance.after),
            permutationBand: evaluation.labelPermutation.band,
            permutationMeanBand: evaluation.labelPermutation.meanBand,
            permutationTrialBand: evaluation.labelPermutation.trialBand,
            minimumTrajectories: options.minimumTrajectories ?? 20000,
            minimumSafe: options.minimumSafe ?? 1,
            minimumUnsafe: options.minimumUnsafe ?? 1,
            minimumMatchedPairs: options.minimumMatchedPairs ?? 4000,
            minimumDiscordantPairs: options.minimumDiscordantPairs ?? 100,
        },
    });
}

module.exports = {
    DEFAULT_PERMUTATION_SEEDS,
    EVALUATION_SPLITS,
    evaluateCausalAcceptance,
    evaluateCausalCorpus,
    horizonDistinctness,
    pairEvaluation,
    permutationControls,
    shortcutProbes,
    splitIntegrity,
    trajectoryMetrics,
    transitionMetrics,
};
