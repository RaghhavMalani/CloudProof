'use strict';

const { Rng } = require('./simulator');
const {
    MULTI_AGENT_ACTION,
    MULTI_AGENT_SCHEDULE_SCHEMA_VERSION,
    validateMultiAgentSchedule,
} = require('./multi-agent-actions');
const { AGENT_IDS } = require('./multi-agent-scenario');

function agentAction(type, agentId) {
    return { type, agentId };
}

function agentSequence(agentId) {
    return [
        agentAction(MULTI_AGENT_ACTION.READ, agentId),
        agentAction(MULTI_AGENT_ACTION.DECIDE, agentId),
        agentAction(MULTI_AGENT_ACTION.COMMIT, agentId),
    ];
}

function interleave(rng, queues, noise) {
    const actions = [];
    let yields = noise;
    while (yields > 0 || [...queues.values()].some((queue) => queue.length > 0)) {
        const choices = [...queues.entries()]
            .filter(([, queue]) => queue.length > 0)
            .map(([agentId]) => agentId);
        if (yields > 0) choices.push('yield');
        const selected = rng.pick(choices);
        if (selected === 'yield') {
            actions.push({ type: MULTI_AGENT_ACTION.YIELD, label: `scheduler-noise-${yields}` });
            yields -= 1;
        } else {
            actions.push(queues.get(selected).shift());
        }
    }
    return actions;
}

function coveragePrefix(targetAgents) {
    const [winner, stale] = targetAgents;
    return [
        agentAction(MULTI_AGENT_ACTION.READ, winner),
        agentAction(MULTI_AGENT_ACTION.READ, stale),
        agentAction(MULTI_AGENT_ACTION.DECIDE, winner),
        agentAction(MULTI_AGENT_ACTION.DECIDE, stale),
        agentAction(MULTI_AGENT_ACTION.COMMIT, winner),
        agentAction(MULTI_AGENT_ACTION.COMMIT, stale),
    ];
}

function materializeMultiAgentSchedule(seed, options = {}) {
    const strategy = options.strategy || 'random';
    const runtime = options.runtime || 'correct';
    const noise = Number.isInteger(options.noise) ? Math.max(0, options.noise) : 20;
    const targetAgents = options.targetAgents || ['refund-agent', 'customer-recovery-agent'];
    const rng = new Rng(seed);
    let actions;

    if (strategy === 'coverage') {
        const prefix = coveragePrefix(targetAgents);
        const used = new Set(targetAgents);
        const queues = new Map(AGENT_IDS
            .filter((agentId) => !used.has(agentId))
            .map((agentId) => [agentId, agentSequence(agentId)]));
        actions = [...prefix, ...interleave(rng, queues, noise)];
    } else if (strategy === 'random') {
        const queues = new Map(AGENT_IDS.map((agentId) => [agentId, agentSequence(agentId)]));
        actions = interleave(rng, queues, noise);
    } else {
        throw new TypeError(`unknown multi-agent search strategy: ${strategy}`);
    }

    const schedule = {
        schemaVersion: MULTI_AGENT_SCHEDULE_SCHEMA_VERSION,
        kind: 'cloudproof.multi-agent-schedule',
        seed,
        scenario: 'shared-order-financial-resolution',
        runtime,
        strategy,
        actions: actions.map((action, index) => ({
            ...action,
            id: `multi-agent-${index + 1}`,
            atMs: index,
        })),
    };
    validateMultiAgentSchedule(schedule);
    return schedule;
}

class MultiAgentCoverageTracker {
    constructor() {
        this.actionTypes = new Set();
        this.agents = new Set();
        this.outcomes = new Set();
    }

    observe(result) {
        for (const action of result.schedule.actions) {
            this.actionTypes.add(action.type);
            if (action.agentId) this.agents.add(action.agentId);
        }
        if (result.failure) this.outcomes.add(`violation:${result.failure.violationClass}`);
        if (result.finalState.conflicts.length > 0) this.outcomes.add('resource-version-conflict');
        if (result.ok) this.outcomes.add('safe');
    }

    snapshot() {
        return {
            actionTypes: [...this.actionTypes].sort(),
            agents: [...this.agents].sort(),
            outcomes: [...this.outcomes].sort(),
        };
    }
}

module.exports = {
    MultiAgentCoverageTracker,
    materializeMultiAgentSchedule,
};
