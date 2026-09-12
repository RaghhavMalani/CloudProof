'use strict';

const MULTI_AGENT_SCHEDULE_SCHEMA_VERSION = 1;

const MULTI_AGENT_ACTION = Object.freeze({
    READ: 'multi-agent.read',
    DECIDE: 'multi-agent.decide',
    COMMIT: 'multi-agent.commit',
    YIELD: 'multi-agent.yield',
});

const ACTION_TYPES = Object.freeze(Object.values(MULTI_AGENT_ACTION));
const ACTION_TYPE_SET = new Set(ACTION_TYPES);

function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function validateMultiAgentSchedule(schedule) {
    if (!schedule || schedule.schemaVersion !== MULTI_AGENT_SCHEDULE_SCHEMA_VERSION) {
        throw new TypeError('unsupported or missing multi-agent schedule schemaVersion');
    }
    if (schedule.kind !== 'miniraft.multi-agent-schedule') {
        throw new TypeError('schedule kind must be miniraft.multi-agent-schedule');
    }
    if (!Number.isInteger(schedule.seed)) throw new TypeError('schedule seed must be an integer');
    if (!Array.isArray(schedule.actions)) throw new TypeError('schedule actions must be an array');

    const ids = new Set();
    let previousAt = -Infinity;
    for (const action of schedule.actions) {
        if (!action || !ACTION_TYPE_SET.has(action.type)) {
            throw new TypeError(`unknown multi-agent action: ${action && action.type}`);
        }
        if (typeof action.id !== 'string' || action.id.length === 0 || ids.has(action.id)) {
            throw new TypeError('schedule action ids must be unique non-empty strings');
        }
        if (!Number.isFinite(action.atMs) || action.atMs < previousAt) {
            throw new TypeError('schedule actions must have nondecreasing finite atMs values');
        }
        if (action.type !== MULTI_AGENT_ACTION.YIELD
            && (typeof action.agentId !== 'string' || action.agentId.length === 0)) {
            throw new TypeError('read, decide, and commit actions require agentId');
        }
        ids.add(action.id);
        previousAt = action.atMs;
    }
    return schedule;
}

function reindexMultiAgentActions(actions) {
    return actions.map((action, index) => ({ ...clone(action), atMs: index }));
}

module.exports = {
    ACTION_TYPES,
    MULTI_AGENT_ACTION,
    MULTI_AGENT_SCHEDULE_SCHEMA_VERSION,
    clone,
    reindexMultiAgentActions,
    validateMultiAgentSchedule,
};
