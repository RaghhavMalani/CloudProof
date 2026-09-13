'use strict';

const { DecisionStreams } = require('./decision-tape');
const { createFlagshipState } = require('../packages/cloudproof/state');
const {
    ACTION_TYPES,
    CLOUD_ACTION,
    CLOUD_FAULT,
    CLOUD_SCHEDULE_SCHEMA_VERSION,
    CONTROLLER_ACTION,
    CONTROLLER_TYPES,
    FAULT_TYPES,
    reindexCloudActions,
    validateCloudSchedule,
} = require('./cloud-actions');

const COVERAGE_TARGETS = Object.freeze([...ACTION_TYPES, ...FAULT_TYPES, ...CONTROLLER_TYPES]);

function addNoise(actions, stream, count, { riskScorer = null, stateHint = null } = {}) {
    const vocabulary = [
        CONTROLLER_ACTION.DEPLOYMENT,
        CONTROLLER_ACTION.SCHEDULER,
        CONTROLLER_ACTION.KUBELET,
        CONTROLLER_ACTION.ENDPOINTS,
        CONTROLLER_ACTION.HPA,
        CONTROLLER_ACTION.PDB,
        CONTROLLER_ACTION.YIELD,
    ];
    for (let index = 0; index < count; index += 1) {
        const candidates = vocabulary.map((type) => (type === CONTROLLER_ACTION.YIELD
            ? { type, label: `interleaving-${index + 1}` }
            : { type }));
        const selectedType = riskScorer ? null
            : stream.pick(vocabulary, 'cloud-noise-action', { index });
        const candidate = riskScorer
            ? orderCandidates(candidates, riskScorer, stateHint)[index % candidates.length]
            : candidates.find((item) => item.type === selectedType);
        actions.push(candidate);
    }
}

function flagshipActions(noise, noiseCount, guidance) {
    const actions = [
        { type: CLOUD_ACTION.TRAFFIC_SPIKE, cpuPercent: 91, requestsPerSecond: 480 },
        { type: CLOUD_FAULT.HPA_STALE_METRIC, metric: 55, durationMs: 500 },
        { type: CONTROLLER_ACTION.HPA },
        { type: CLOUD_ACTION.ROLL_OUT, version: 'v42' },
        { type: CLOUD_FAULT.READINESS_DELAY, delayMs: 900 },
        { type: CLOUD_FAULT.IMAGE_PULL_DELAY, delayMs: 700 },
        { type: CLOUD_FAULT.ENDPOINT_PROPAGATION_DELAY, delayMs: 800 },
        { type: CONTROLLER_ACTION.DEPLOYMENT },
        { type: CONTROLLER_ACTION.SCHEDULER },
        { type: CLOUD_ACTION.ADVANCE_TIME, ms: 120 },
        { type: CLOUD_ACTION.DRAIN_NODE, nodeId: 'node-b' },
        { type: CONTROLLER_ACTION.DEPLOYMENT },
        { type: CONTROLLER_ACTION.SCHEDULER },
    ];
    addNoise(actions, noise, noiseCount, guidance);
    actions.push(
        { type: CLOUD_FAULT.NODE_CRASH, nodeId: 'node-a' },
        { type: CONTROLLER_ACTION.ENDPOINTS },
        { type: CLOUD_ACTION.ADVANCE_TIME, ms: 900 },
        { type: CONTROLLER_ACTION.DEPLOYMENT },
        { type: CONTROLLER_ACTION.SCHEDULER },
        { type: CONTROLLER_ACTION.KUBELET },
        { type: CLOUD_ACTION.ADVANCE_TIME, ms: 1300 },
        { type: CONTROLLER_ACTION.ENDPOINTS },
        { type: CLOUD_ACTION.ADVANCE_TIME, ms: 900 },
    );
    return actions;
}

function safeActions(structure, noise, noiseCount, guidance) {
    const rollOut = structure.chance(0.5, 'safe-rollout');
    const scaleTo = structure.range(6, 8, 'safe-scale');
    const actions = [];
    if (rollOut) actions.push({ type: CLOUD_ACTION.ROLL_OUT, version: 'v42' });
    else actions.push({ type: CLOUD_ACTION.SCALE, replicas: scaleTo });
    for (let cycle = 0; cycle < 8; cycle += 1) {
        actions.push({ type: CONTROLLER_ACTION.DEPLOYMENT });
        actions.push({ type: CONTROLLER_ACTION.SCHEDULER });
        actions.push({ type: CLOUD_ACTION.ADVANCE_TIME, ms: 400 });
        actions.push({ type: CONTROLLER_ACTION.ENDPOINTS });
        actions.push({ type: CLOUD_ACTION.ADVANCE_TIME, ms: 120 });
    }
    addNoise(actions, noise, noiseCount, guidance);
    return actions;
}

function mutantActions(mutant) {
    if (mutant === 'endpoint-includes-unready') {
        return [
            { type: CLOUD_ACTION.ROLL_OUT, version: 'v42' },
            { type: CLOUD_FAULT.READINESS_DELAY, delayMs: 1000 },
            { type: CONTROLLER_ACTION.DEPLOYMENT },
            { type: CONTROLLER_ACTION.SCHEDULER },
            { type: CONTROLLER_ACTION.ENDPOINTS },
            { type: CLOUD_ACTION.ADVANCE_TIME, ms: 150 },
        ];
    }
    if (mutant === 'rollout-ignores-terminating') {
        return [
            { type: CLOUD_ACTION.ROLL_OUT, version: 'v42' },
            { type: CLOUD_FAULT.READINESS_DELAY, delayMs: 1000 },
            { type: CONTROLLER_ACTION.DEPLOYMENT },
            { type: CONTROLLER_ACTION.DEPLOYMENT },
        ];
    }
    if (mutant === 'hpa-stale-indefinitely') {
        return [
            { type: CLOUD_ACTION.TRAFFIC_SPIKE, cpuPercent: 91 },
            { type: CLOUD_FAULT.HPA_STALE_METRIC, metric: 55, durationMs: 500 },
            { type: CLOUD_ACTION.ADVANCE_TIME, ms: 600 },
            { type: CONTROLLER_ACTION.HPA },
            { type: CLOUD_ACTION.ADVANCE_TIME, ms: 1100 },
        ];
    }
    throw new TypeError(`no probe schedule for cloud mutant: ${mutant}`);
}

function orderCandidates(candidates, riskScorer, stateHint = null) {
    if (!riskScorer || typeof riskScorer.score !== 'function') return candidates;
    return candidates.slice().sort((left, right) => (
        riskScorer.score(stateHint, right) - riskScorer.score(stateHint, left)
        || left.type.localeCompare(right.type)
    ));
}

function materializeCloudSchedule(seed, options = {}) {
    const scenario = options.scenario || 'flagship';
    const runtime = options.runtime || 'correct';
    const decisions = new DecisionStreams({ seed });
    const structure = decisions.stream('cloud-structure');
    const noise = decisions.stream('cloud-noise');
    const noiseCount = options.noise === undefined ? 12 : Math.max(0, options.noise);
    const stateHint = options.stateHint || (options.riskScorer ? createFlagshipState({ seed }) : null);
    const guidance = { riskScorer: options.riskScorer || null, stateHint };
    let actions;
    if (scenario === 'flagship') actions = flagshipActions(noise, noiseCount, guidance);
    else if (scenario === 'safe') actions = safeActions(structure, noise, noiseCount, guidance);
    else if (scenario === 'mutant') actions = mutantActions(runtime);
    else throw new TypeError(`unknown cloud scenario: ${scenario}`);

    if (options.coverageHint && !actions.some((action) => action.type === options.coverageHint)) {
        const candidates = orderCandidates([{ type: options.coverageHint }], options.riskScorer, stateHint);
        actions.push(candidates[0]);
    }
    const schedule = {
        schemaVersion: CLOUD_SCHEDULE_SCHEMA_VERSION,
        kind: 'cloudproof.schedule',
        seed,
        scenario,
        runtime,
        strategy: options.strategy || (options.riskScorer ? 'risk-guided' : 'coverage'),
        actions: reindexCloudActions(actions),
        decisions: { generation: decisions.export() },
        topology: { zones: 3, initialReplicas: 6, service: 'api' },
    };
    validateCloudSchedule(schedule);
    return schedule;
}

class CloudCoverageTracker {
    constructor() {
        this.actionTypes = new Set();
        this.transitionTypes = new Set();
        this.failureClasses = new Set();
    }

    nextHint() {
        return COVERAGE_TARGETS.find((target) => !this.actionTypes.has(target)) || null;
    }

    observe(result) {
        result.schedule.actions.forEach((action) => this.actionTypes.add(action.type));
        result.graphTransitions.forEach((row) => this.transitionTypes.add(row.action.type));
        if (result.failure) this.failureClasses.add(result.failure.violationClass);
    }

    export() {
        const covered = COVERAGE_TARGETS.filter((target) => this.actionTypes.has(target));
        return {
            target: { covered: covered.length, total: COVERAGE_TARGETS.length,
                ratio: covered.length / COVERAGE_TARGETS.length },
            missing: COVERAGE_TARGETS.filter((target) => !this.actionTypes.has(target)),
            actionTypes: [...this.actionTypes].sort(),
            transitionTypes: [...this.transitionTypes].sort(),
            failureClasses: [...this.failureClasses].sort(),
        };
    }
}

module.exports = { COVERAGE_TARGETS, CloudCoverageTracker, materializeCloudSchedule, orderCandidates };
