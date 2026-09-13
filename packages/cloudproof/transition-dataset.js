'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Rng } = require('../../sim/simulator');
const { stable } = require('./state');

const STATE_FEATURE_NAMES = Object.freeze([
    'readyReplicas',
    'pendingReplicas',
    'zoneConcentration',
    'cpuPressure',
    'rolloutActive',
    'hpaActive',
    'pdbHeadroom',
    'degradedNodes',
]);
const FEATURE_NAMES = Object.freeze([...STATE_FEATURE_NAMES, 'candidateActionRisk']);

function graphNode(graph, type) {
    return graph.nodes.find((node) => node.type === type) || null;
}

function featuresFromGraph(graph) {
    const deployment = graphNode(graph, 'Deployment')?.features || {};
    const hpa = graphNode(graph, 'HPA')?.features || {};
    const pdb = graphNode(graph, 'PDB')?.features || {};
    const podNodes = graph.nodes.filter((node) => node.type === 'Pod');
    const nodeNodes = graph.nodes.filter((node) => node.type === 'Node');
    const runsOn = new Map(graph.edges.filter((edge) => edge.type === 'RUNS_ON')
        .map((edge) => [edge.from, edge.to]));
    const nodeZones = new Map(nodeNodes.map((node) => [node.id, node.features.zone]));
    const zoneCounts = new Map();
    for (const pod of podNodes.filter((node) => node.features.phase !== 'FAILED')) {
        const zone = nodeZones.get(runsOn.get(pod.id));
        if (zone) zoneCounts.set(zone, (zoneCounts.get(zone) || 0) + 1);
    }
    const total = [...zoneCounts.values()].reduce((sum, value) => sum + value, 0);
    const concentration = total === 0 ? 0 : Math.max(...zoneCounts.values()) / total;
    const ready = deployment.observed?.ready || 0;
    return {
        readyReplicas: ready,
        pendingReplicas: deployment.observed?.pending || 0,
        zoneConcentration: concentration,
        cpuPressure: (hpa.currentMetric || 0) / Math.max(1, hpa.targetMetric || 70),
        rolloutActive: deployment.rolloutActive ? 1 : 0,
        hpaActive: hpa.active ? 1 : 0,
        pdbHeadroom: ready - (pdb.minAvailable || 0),
        degradedNodes: nodeNodes.filter((node) => !node.features.ready).length,
    };
}

function featuresFromState(state) {
    const deployment = state.resources.deployments[0];
    const hpa = state.resources.hpas[0];
    const pdb = state.resources.pdbs[0];
    const zoneCounts = new Map();
    for (const pod of state.resources.pods.filter((item) => item.nodeId && item.phase !== 'FAILED')) {
        const node = state.resources.nodes.find((item) => item.id === pod.nodeId);
        if (node) zoneCounts.set(node.zoneId, (zoneCounts.get(node.zoneId) || 0) + 1);
    }
    const total = [...zoneCounts.values()].reduce((sum, value) => sum + value, 0);
    return {
        readyReplicas: deployment.observed.ready,
        pendingReplicas: deployment.observed.pending,
        zoneConcentration: total === 0 ? 0 : Math.max(...zoneCounts.values()) / total,
        cpuPressure: state.traffic.cpuPercent / Math.max(1, hpa.desired.targetMetric),
        rolloutActive: deployment.rollout.active ? 1 : 0,
        hpaActive: hpa.active ? 1 : 0,
        pdbHeadroom: deployment.observed.ready - pdb.desired.minAvailable,
        degradedNodes: state.resources.nodes.filter((node) => !node.ready).length,
    };
}

function extractRiskFeatures(value, candidateAction = null) {
    const source = value?.state || value;
    const features = source?.kind === 'cloudproof.infrastructure-graph'
        ? featuresFromGraph(source)
        : featuresFromState(source);
    return [...STATE_FEATURE_NAMES.map((name) => features[name]), actionRisk(candidateAction || value?.action)];
}

function normalized(values) {
    return [
        values[0] / 12,
        values[1] / 12,
        values[2],
        values[3],
        values[4],
        values[5],
        values[6] / 8,
        values[7] / 3,
        values[8],
    ];
}

function featureVector(value, candidateAction = null) {
    if (Array.isArray(value?.features)) return normalized(value.features);
    return normalized(extractRiskFeatures(value, candidateAction));
}

function sigmoid(value) {
    if (value >= 0) return 1 / (1 + Math.exp(-value));
    const exp = Math.exp(value);
    return exp / (1 + exp);
}

function actionRisk(action = {}) {
    const type = action.type || '';
    if (type.includes('node-crash') || type.includes('zone-degraded')) return 0.6;
    if (type.includes('drain-node') || type.includes('roll-out')) return 0.25;
    if (type.includes('readiness-delay') || type.includes('image-pull-delay')) return 0.2;
    return 0;
}

function riskLabel(row) {
    return Boolean(row.labels.sloViolationWithinKTransitions
        ?? row.labels.sloViolationWithin1000ms);
}

function heuristicRiskScore(state, candidateAction = null) {
    const values = normalized(extractRiskFeatures(state, candidateAction));
    const [ready, pending, concentration, pressure, rollout, hpa, pdbHeadroom, degraded, action] = values;
    const scarcity = Math.max(0, 0.5 - ready) * 1.5;
    const risk = 0.04
        + 0.20 * pending
        + 0.22 * concentration
        + 0.20 * Math.max(0, pressure - 0.7)
        + 0.12 * rollout
        + 0.05 * hpa
        + 0.25 * Math.max(0, -pdbHeadroom)
        + 0.30 * degraded
        + 0.35 * action
        + scarcity;
    return Math.max(0.001, Math.min(0.999, risk));
}

class RiskBaseline {
    constructor({ weights = null, bias = 0 } = {}) {
        this.weights = weights ? weights.slice(0, FEATURE_NAMES.length) : [];
        while (this.weights.length < FEATURE_NAMES.length) this.weights.push(0);
        this.bias = bias;
    }

    score(state, candidateAction = null) {
        const values = featureVector(state, candidateAction);
        const logit = this.bias + values.reduce((sum, value, index) => (
            sum + value * this.weights[index]
        ), 0);
        return sigmoid(logit);
    }

    scoreFeatures(features) {
        return this.score({ features });
    }

    train(records, { iterations = 300, learningRate = 0.08, l2 = 0.001 } = {}) {
        if (!Array.isArray(records) || records.length === 0) throw new TypeError('records are required');
        for (let iteration = 0; iteration < iterations; iteration += 1) {
            const gradient = Array(this.weights.length).fill(0);
            let biasGradient = 0;
            for (const row of records) {
                const x = featureVector(row, row.action);
                const y = riskLabel(row) ? 1 : 0;
                const prediction = sigmoid(this.bias + x.reduce((sum, value, index) => (
                    sum + value * this.weights[index]
                ), 0));
                const error = prediction - y;
                biasGradient += error;
                for (let index = 0; index < gradient.length; index += 1) gradient[index] += error * x[index];
            }
            const count = records.length;
            this.bias -= learningRate * biasGradient / count;
            for (let index = 0; index < this.weights.length; index += 1) {
                this.weights[index] -= learningRate * (gradient[index] / count + l2 * this.weights[index]);
            }
        }
        return this;
    }

    export() {
        return stable({ kind: 'cloudproof.risk-baseline', featureNames: FEATURE_NAMES, bias: this.bias,
            weights: this.weights });
    }

    static from(value) {
        return new RiskBaseline({ weights: value.weights, bias: value.bias });
    }
}

function areaUnderRoc(labels, scores) {
    const positives = labels.filter(Boolean).length;
    const negatives = labels.length - positives;
    if (positives === 0 || negatives === 0) return null;
    const ordered = scores.map((score, index) => ({ score, label: labels[index] }))
        .sort((left, right) => left.score - right.score);
    let positiveRankSum = 0;
    for (let start = 0; start < ordered.length;) {
        let end = start + 1;
        while (end < ordered.length && ordered[end].score === ordered[start].score) end += 1;
        const averageRank = ((start + 1) + end) / 2;
        for (let index = start; index < end; index += 1) {
            if (ordered[index].label) positiveRankSum += averageRank;
        }
        start = end;
    }
    return (positiveRankSum - positives * (positives + 1) / 2) / (positives * negatives);
}

function areaUnderPrecisionRecall(labels, scores) {
    const positives = labels.filter(Boolean).length;
    if (positives === 0) return null;
    const order = scores.map((score, index) => ({ score, label: labels[index] }))
        .sort((left, right) => right.score - left.score);
    let truePositives = 0;
    let falsePositives = 0;
    let previousRecall = 0;
    let area = 0;
    for (let start = 0; start < order.length;) {
        let end = start + 1;
        while (end < order.length && order[end].score === order[start].score) end += 1;
        for (let index = start; index < end; index += 1) {
            if (order[index].label) truePositives += 1;
            else falsePositives += 1;
        }
        const recall = truePositives / positives;
        const precision = truePositives / (truePositives + falsePositives);
        area += (recall - previousRecall) * precision;
        previousRecall = recall;
        start = end;
    }
    return area;
}

function evaluateScores(records, scores) {
    if (!Array.isArray(records) || records.length === 0 || records.length !== scores.length) {
        throw new TypeError('records and equally-sized scores are required');
    }
    if (scores.some((score) => !Number.isFinite(score) || score < 0 || score > 1)) {
        throw new TypeError('scores must be finite probabilities in [0, 1]');
    }
    const labels = records.map(riskLabel);
    const brier = scores.reduce((sum, score, index) => (
        sum + (score - (labels[index] ? 1 : 0)) ** 2
    ), 0) / scores.length;
    const bins = Array.from({ length: 5 }, (_, index) => ({
        lower: index / 5, upper: (index + 1) / 5, count: 0, predicted: 0, observed: 0,
    }));
    scores.forEach((score, index) => {
        const bin = bins[Math.min(4, Math.floor(score * 5))];
        bin.count += 1;
        bin.predicted += score;
        bin.observed += labels[index] ? 1 : 0;
    });
    const calibration = bins.map((bin) => ({
        lower: bin.lower,
        upper: bin.upper,
        count: bin.count,
        meanPredicted: bin.count ? bin.predicted / bin.count : null,
        observedRate: bin.count ? bin.observed / bin.count : null,
    }));
    const expectedCalibrationError = calibration.reduce((sum, bin) => (
        sum + (bin.count / records.length)
            * (bin.count ? Math.abs(bin.meanPredicted - bin.observedRate) : 0)
    ), 0);
    return stable({
        auroc: areaUnderRoc(labels, scores),
        auprc: areaUnderPrecisionRecall(labels, scores),
        brierScore: brier,
        expectedCalibrationError,
        calibration,
    });
}

function evaluateRiskBaseline(model, records, { randomSeed = 1337 } = {}) {
    const rng = new Rng(randomSeed);
    const randomScores = records.map(() => rng.float());
    const heuristicScores = records.map((row) => row.heuristicScore
        ?? heuristicRiskScore(row.state, row.action));
    const logisticScores = records.map((row) => Array.isArray(row.features)
        ? model.scoreFeatures(row.features)
        : model.score(row.state, row.action));
    return stable({
        random: evaluateScores(records, randomScores),
        heuristic: evaluateScores(records, heuristicScores),
        logistic: evaluateScores(records, logisticScores),
    });
}

function modelInput(row) {
    if (!row?.state || !row?.action) throw new TypeError('row must contain state and action');
    return stable({ state: row.state, action: row.action });
}

function exportTransitionDataset(records, file) {
    const resolved = path.resolve(file);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    const contents = records.map((row) => JSON.stringify(stable(row))).join('\n');
    fs.writeFileSync(resolved, `${contents}${contents ? '\n' : ''}`, 'utf8');
    return resolved;
}

module.exports = {
    FEATURE_NAMES,
    RiskBaseline,
    evaluateScores,
    evaluateRiskBaseline,
    exportTransitionDataset,
    extractRiskFeatures,
    featureVector,
    heuristicRiskScore,
    modelInput,
    riskLabel,
};
