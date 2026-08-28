'use strict';

const { DecisionStreams } = require('./decision-tape');
const {
    ACTION_TYPES,
    AGENT_ACTION,
    AGENT_FAULT,
    AGENT_SCHEDULE_SCHEMA_VERSION,
    FAULT_TYPES,
    clone,
    reindexActions,
    validateAgentSchedule,
} = require('./agent-actions');

const COVERAGE_TARGETS = Object.freeze([...ACTION_TYPES, ...FAULT_TYPES]);

function materializeAgentSchedule(seed, options = {}) {
    const workflow = options.workflow || 'refund';
    const coverageHint = options.coverageHint || null;
    const decisions = new DecisionStreams({ seed });
    const structure = decisions.stream('agent-structure');
    const noise = decisions.stream('agent-noise');
    const actions = [];
    const add = (type, details = {}) => actions.push({ type, ...details });

    const preIntentDispatch = coverageHint === 'interaction:dispatch-before-intent'
        || structure.chance(0.22, 'pre-intent-dispatch');
    const racingWorker = coverageHint === AGENT_FAULT.START_RACING_WORKER
        || structure.chance(0.38, 'start-racing-worker');
    const staleRaceAdvance = racingWorker && structure.chance(0.72, 'advance-racing-worker');
    const responseRoll = structure.float('tool-response-outcome');
    const dropResponse = coverageHint === AGENT_FAULT.DROP_TOOL_RESPONSE || responseRoll < 0.48;
    const delayResponse = !dropResponse
        && (coverageHint === AGENT_FAULT.DELAY_TOOL_RESPONSE || responseRoll < 0.66);
    const crashAfterAmbiguity = dropResponse && (
        coverageHint === AGENT_FAULT.CRASH_WORKER || structure.chance(0.68, 'crash-after-ambiguity')
    );
    const retryAmbiguous = dropResponse && structure.chance(0.78, 'retry-ambiguous-effect');
    const crashAfterResult = !dropResponse && (
        coverageHint === 'interaction:result-recovery' || structure.chance(0.42, 'crash-after-result')
    );
    const deployPolicy = coverageHint === AGENT_FAULT.DEPLOY_POLICY
        || structure.chance(0.46, 'deploy-policy');
    const crashLeader = deployPolicy && (
        coverageHint === AGENT_FAULT.CRASH_LEADER || structure.chance(0.58, 'crash-leader-after-policy')
    );
    const approveSnapshot = deployPolicy && (
        coverageHint === AGENT_ACTION.APPROVE_SNAPSHOT || structure.chance(0.44, 'approve-snapshot')
    );

    if (preIntentDispatch) add(AGENT_ACTION.DISPATCH_EFFECT, { effectKey: 'refund' });
    if (racingWorker) add(AGENT_FAULT.START_RACING_WORKER);
    add(AGENT_ACTION.AUTHORIZE_EFFECT, { effectKey: 'refund' });

    if (racingWorker) {
        add(AGENT_ACTION.ADVANCE, { workerId: 'worker-1', label: 'primary-worker-progress' });
        if (staleRaceAdvance) add(AGENT_ACTION.ADVANCE, { workerId: 'worker-2', label: 'racing-worker-progress' });
    }

    add(AGENT_ACTION.DISPATCH_EFFECT, { effectKey: 'refund' });
    if (dropResponse) add(AGENT_FAULT.DROP_TOOL_RESPONSE, { effectKey: 'refund' });
    if (delayResponse) add(AGENT_FAULT.DELAY_TOOL_RESPONSE, { effectKey: 'refund' });

    if (crashAfterAmbiguity) add(AGENT_FAULT.CRASH_WORKER);
    if (retryAmbiguous) add(AGENT_ACTION.DISPATCH_EFFECT, { effectKey: 'refund' });
    if (dropResponse) add(AGENT_ACTION.RECONCILE_EFFECT, { effectKey: 'refund' });
    add(AGENT_ACTION.RECORD_RESULT, { effectKey: 'refund' });
    if (delayResponse && structure.chance(0.75, 'record-after-delay')) {
        add(AGENT_ACTION.RECORD_RESULT, { effectKey: 'refund' });
    }
    if (crashAfterResult) add(AGENT_FAULT.CRASH_WORKER);
    add(AGENT_ACTION.COMMIT_EFFECT, { effectKey: 'refund' });

    if (deployPolicy) {
        add(AGENT_FAULT.DEPLOY_POLICY);
        if (crashLeader) add(AGENT_FAULT.CRASH_LEADER);
        if (approveSnapshot) add(AGENT_ACTION.APPROVE_SNAPSHOT);
    }
    add(AGENT_ACTION.ADVANCE, { workerId: 'worker-1', label: 'workflow-progress' });

    const loseQuorum = coverageHint === AGENT_FAULT.LOSE_QUORUM
        || structure.chance(0.2, 'lose-quorum');
    if (loseQuorum) {
        add(AGENT_FAULT.LOSE_QUORUM);
        add(AGENT_ACTION.ADVANCE, { workerId: 'worker-1', label: 'advance-without-quorum' });
        if (coverageHint === AGENT_FAULT.RESTORE_QUORUM || structure.chance(0.85, 'restore-quorum')) {
            add(AGENT_FAULT.RESTORE_QUORUM);
        }
    }

    const noiseCount = options.noise === 0 ? 0 : noise.range(1, options.noise ?? 5, 'noise-count');
    const vocabulary = [...ACTION_TYPES, ...FAULT_TYPES];
    for (let index = 0; index < noiseCount; index += 1) {
        const type = noise.pick(vocabulary, 'noise-action-type', { index });
        const details = {};
        if (type.startsWith('agent.effect.') || type.startsWith('fault.tool.')) {
            details.effectKey = noise.pick(['refund', 'crm', 'email'], 'noise-effect', { index });
        }
        if (type === AGENT_ACTION.ADVANCE) {
            details.workerId = noise.chance(0.25, 'noise-racing-worker', { index }) ? 'worker-2' : 'worker-1';
            details.label = `noise-step-${index + 1}`;
        }
        add(type, details);
    }

    if (coverageHint && [...ACTION_TYPES, ...FAULT_TYPES].includes(coverageHint)
        && !actions.some((action) => action.type === coverageHint)) {
        add(coverageHint, coverageHint.startsWith('agent.effect.') ? { effectKey: 'refund' } : {});
    }

    const schedule = {
        schemaVersion: AGENT_SCHEDULE_SCHEMA_VERSION,
        kind: 'miniraft.agent-schedule',
        seed,
        workflow,
        runtime: options.runtime || 'correct',
        actions: reindexActions(actions),
        decisions: { generation: decisions.export() },
        metadata: {
            coverageHint,
            generatedActions: actions.length,
            strategy: options.strategy || 'random',
        },
    };
    validateAgentSchedule(schedule);
    return schedule;
}

class AgentCoverageTracker {
    constructor({ targets = COVERAGE_TARGETS } = {}) {
        this.targets = targets.slice();
        this.actionTypes = new Set();
        this.transitions = new Set();
        this.checks = new Set();
        this.failureClasses = new Set();
    }

    nextHint() {
        return this.targets.find((target) => !this.actionTypes.has(target)) || null;
    }

    observe(result) {
        const before = this.actionTypes.size + this.transitions.size + this.checks.size + this.failureClasses.size;
        for (const action of result.schedule.actions) this.actionTypes.add(action.type);
        for (const event of result.trace.events) this.transitions.add(event.type);
        for (const check of result.checks) this.checks.add(`${check.id}:${check.status}`);
        if (result.failure) this.failureClasses.add(result.failure.violationClass);
        const after = this.actionTypes.size + this.transitions.size + this.checks.size + this.failureClasses.size;
        return { added: after - before };
    }

    export() {
        const covered = this.targets.filter((target) => this.actionTypes.has(target));
        return {
            target: { covered: covered.length, total: this.targets.length, ratio: covered.length / this.targets.length },
            missing: this.targets.filter((target) => !this.actionTypes.has(target)),
            actionTypes: [...this.actionTypes].sort(),
            transitions: [...this.transitions].sort(),
            checks: [...this.checks].sort(),
            failureClasses: [...this.failureClasses].sort(),
        };
    }
}

module.exports = {
    AgentCoverageTracker,
    COVERAGE_TARGETS,
    materializeAgentSchedule,
    validateAgentSchedule,
};
