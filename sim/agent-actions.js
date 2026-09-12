'use strict';

const AGENT_SCHEDULE_SCHEMA_VERSION = 1;

const AGENT_ACTION = Object.freeze({
    ADVANCE: 'agent.advance',
    AUTHORIZE_EFFECT: 'agent.effect.authorize',
    DISPATCH_EFFECT: 'agent.effect.dispatch',
    RECONCILE_EFFECT: 'agent.effect.reconcile',
    RECORD_RESULT: 'agent.effect.result',
    COMMIT_EFFECT: 'agent.effect.commit',
    APPROVE_SNAPSHOT: 'agent.snapshot.approve',
});

const AGENT_FAULT = Object.freeze({
    CRASH_WORKER: 'fault.worker.crash',
    CRASH_LEADER: 'fault.leader.crash',
    DROP_TOOL_RESPONSE: 'fault.tool.response.drop',
    DELAY_TOOL_RESPONSE: 'fault.tool.response.delay',
    START_RACING_WORKER: 'fault.worker.race',
    DEPLOY_POLICY: 'fault.policy.deploy',
    LOSE_QUORUM: 'fault.quorum.lose',
    RESTORE_QUORUM: 'fault.quorum.restore',
});

const ACTION_TYPES = Object.freeze(Object.values(AGENT_ACTION));
const FAULT_TYPES = Object.freeze(Object.values(AGENT_FAULT));
const SCHEDULE_TYPES = new Set([...ACTION_TYPES, ...FAULT_TYPES]);

function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function validateAgentSchedule(schedule) {
    if (!schedule || schedule.schemaVersion !== AGENT_SCHEDULE_SCHEMA_VERSION) {
        throw new TypeError('unsupported or missing agent schedule schemaVersion');
    }
    if (schedule.kind !== 'miniraft.agent-schedule') {
        throw new TypeError('schedule kind must be miniraft.agent-schedule');
    }
    if (!Number.isInteger(schedule.seed)) throw new TypeError('schedule seed must be an integer');
    if (typeof schedule.workflow !== 'string' || schedule.workflow.length === 0) {
        throw new TypeError('schedule workflow must be a non-empty string');
    }
    if (!Array.isArray(schedule.actions)) throw new TypeError('schedule actions must be an array');

    const ids = new Set();
    let previous = -Infinity;
    for (const action of schedule.actions) {
        if (!action || !SCHEDULE_TYPES.has(action.type)) {
            throw new TypeError(`unknown agent schedule action: ${action && action.type}`);
        }
        if (typeof action.id !== 'string' || action.id.length === 0 || ids.has(action.id)) {
            throw new TypeError('schedule action ids must be unique non-empty strings');
        }
        if (!Number.isFinite(action.atMs) || action.atMs < previous) {
            throw new TypeError('schedule actions must have nondecreasing finite atMs values');
        }
        ids.add(action.id);
        previous = action.atMs;
    }
    return true;
}

function reindexActions(actions) {
    return actions.map((action, index) => ({
        ...clone(action),
        id: `agent-action-${index + 1}`,
        atMs: index * 10,
    }));
}

module.exports = {
    ACTION_TYPES,
    AGENT_ACTION,
    AGENT_FAULT,
    AGENT_SCHEDULE_SCHEMA_VERSION,
    FAULT_TYPES,
    clone,
    reindexActions,
    validateAgentSchedule,
};
