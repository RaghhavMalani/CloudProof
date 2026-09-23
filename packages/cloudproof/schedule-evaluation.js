'use strict';

const { Rng } = require('../../sim/simulator');
const { CloudCoverageTracker } = require('../../sim/cloud-schedule');
const { heuristicRiskScore } = require('./transition-dataset');
const { stable } = require('./state');

const DEFAULT_VERIFICATION_BUDGETS = Object.freeze([100, 500, 1000, 5000]);

function stableTieBreak(left, right) {
    return left.scenarioId.localeCompare(right.scenarioId);
}

function randomRanking(candidates, seed) {
    const rng = new Rng(seed);
    return candidates.map((candidate) => ({ candidate, score: rng.float() }))
        .sort((left, right) => right.score - left.score
            || stableTieBreak(left.candidate, right.candidate))
        .map((item) => item.candidate);
}

function coverageRanking(candidates) {
    const remaining = candidates.slice().sort(stableTieBreak);
    const ordered = [];
    const covered = new Set();
    while (remaining.length > 0) {
        let bestIndex = -1;
        let bestGain = 0;
        for (let index = 0; index < remaining.length; index += 1) {
            const types = new Set(remaining[index].schedule.actions.map((action) => action.type));
            const gain = [...types].filter((type) => !covered.has(type)).length;
            if (gain > bestGain) { bestGain = gain; bestIndex = index; }
        }
        if (bestIndex === -1 || bestGain === 0) break;
        const [selected] = remaining.splice(bestIndex, 1);
        selected.schedule.actions.forEach((action) => covered.add(action.type));
        ordered.push(selected);
    }
    return [...ordered, ...remaining];
}

function scheduleRisk(candidate, scorer) {
    const state = candidate.initialState || candidate.result?.graphTransitions?.[0]?.state;
    if (!state) return 0;
    return candidate.schedule.actions.reduce((maximum, action) => (
        Math.max(maximum, scorer.score(state, action))
    ), 0);
}

function riskRanking(candidates, scorer) {
    return candidates.map((candidate) => ({ candidate, score: scheduleRisk(candidate, scorer) }))
        .sort((left, right) => right.score - left.score
            || stableTieBreak(left.candidate, right.candidate))
        .map((item) => item.candidate);
}

function checkpointMetrics({ budget, evaluated, totalFailures, failures, classes, coverage,
    firstFailure, elapsedMs, counterexampleLengths }) {
    return stable({
        requestedBudget: budget,
        evaluatedSchedules: evaluated,
        failuresFound: failures,
        failureRecall: totalFailures === 0 ? null : failures / totalFailures,
        schedulesToFirstCounterexample: firstFailure?.scheduleIndex ?? null,
        timeToFirstCounterexampleMs: firstFailure?.elapsedMs ?? null,
        uniqueFailureClasses: [...classes].sort(),
        uniqueFailureClassCount: classes.size,
        controllerStateCoverage: coverage.export(),
        counterexampleLength: counterexampleLengths.length === 0 ? null : {
            minimumActions: Math.min(...counterexampleLengths),
            meanActions: counterexampleLengths.reduce((sum, value) => sum + value, 0)
                / counterexampleLengths.length,
        },
        verificationWallTimeMs: elapsedMs,
    });
}

function evaluateRanking(ordered, budgets) {
    const totalFailures = ordered.filter((candidate) => !candidate.result.ok).length;
    const maximum = Math.min(ordered.length, Math.max(...budgets));
    const coverage = new CloudCoverageTracker();
    const classes = new Set();
    const counterexampleLengths = [];
    const checkpoints = {};
    let failures = 0;
    let elapsedMs = 0;
    let firstFailure = null;
    let cursor = 0;
    for (const budget of budgets) {
        const limit = Math.min(maximum, budget);
        while (cursor < limit) {
            const candidate = ordered[cursor];
            coverage.observe(candidate.result);
            elapsedMs += candidate.verificationWallTimeMs || 0;
            if (!candidate.result.ok) {
                failures += 1;
                classes.add(candidate.result.failure.violationClass);
                counterexampleLengths.push(candidate.schedule.actions.length);
                if (!firstFailure) firstFailure = { scheduleIndex: cursor + 1, elapsedMs };
            }
            cursor += 1;
        }
        checkpoints[String(budget)] = checkpointMetrics({
            budget, evaluated: cursor, totalFailures, failures, classes, coverage,
            firstFailure, elapsedMs, counterexampleLengths,
        });
    }
    return stable({
        candidateSchedules: ordered.length,
        totalCounterexamples: totalFailures,
        budgets: checkpoints,
    });
}

function evaluateSchedulePrioritizers(candidates, model, options = {}) {
    if (!Array.isArray(candidates) || candidates.length === 0) {
        throw new TypeError('schedule candidates are required');
    }
    if (!model || typeof model.score !== 'function') throw new TypeError('a trained risk model is required');
    const budgets = (options.budgets || DEFAULT_VERIFICATION_BUDGETS).slice()
        .filter((value) => Number.isInteger(value) && value > 0)
        .sort((left, right) => left - right);
    if (budgets.length === 0) throw new TypeError('at least one positive verification budget is required');
    const heuristic = { score: heuristicRiskScore };
    const methods = {
        random: evaluateRanking(randomRanking(candidates, options.randomSeed ?? 1337), budgets),
        coverageGuided: evaluateRanking(coverageRanking(candidates), budgets),
        heuristic: evaluateRanking(riskRanking(candidates, heuristic), budgets),
        logistic: evaluateRanking(riskRanking(candidates, model), budgets),
    };
    for (const [name, scorer] of Object.entries(options.additionalScorers || {})
        .sort(([left], [right]) => left.localeCompare(right))) {
        if (Object.hasOwn(methods, name)) throw new TypeError(`risk scorer name is reserved: ${name}`);
        if (!scorer || typeof scorer.score !== 'function') {
            throw new TypeError(`additional risk scorer ${name} must implement score()`);
        }
        methods[name] = evaluateRanking(riskRanking(candidates, scorer), budgets);
    }
    return stable({
        kind: 'cloudproof.schedule-prioritizer-evaluation',
        schemaVersion: 1,
        verificationBudgets: budgets,
        methods,
    });
}

module.exports = {
    DEFAULT_VERIFICATION_BUDGETS,
    coverageRanking,
    evaluateSchedulePrioritizers,
    randomRanking,
    riskRanking,
    scheduleRisk,
};
