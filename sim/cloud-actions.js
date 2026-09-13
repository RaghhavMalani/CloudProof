'use strict';

const {
    ACTION_TYPES,
    CLOUD_ACTION,
    CLOUD_FAULT,
    CONTROLLER_ACTION,
    CONTROLLER_TYPES,
    FAULT_TYPES,
} = require('../packages/cloudproof/faults');

const CLOUD_SCHEDULE_SCHEMA_VERSION = 1;
const TYPE_SET = new Set([...ACTION_TYPES, ...FAULT_TYPES, ...CONTROLLER_TYPES]);

function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function validateCloudSchedule(schedule) {
    if (!schedule || schedule.schemaVersion !== CLOUD_SCHEDULE_SCHEMA_VERSION) {
        throw new TypeError('unsupported or missing cloud schedule schemaVersion');
    }
    if (schedule.kind !== 'cloudproof.schedule') throw new TypeError('schedule kind must be cloudproof.schedule');
    if (!Number.isInteger(schedule.seed)) throw new TypeError('schedule seed must be an integer');
    if (!Array.isArray(schedule.actions)) throw new TypeError('schedule actions must be an array');
    const ids = new Set();
    let previousAt = -Infinity;
    for (const action of schedule.actions) {
        if (!action || !TYPE_SET.has(action.type)) throw new TypeError(`unknown cloud action: ${action?.type}`);
        if (typeof action.id !== 'string' || action.id.length === 0 || ids.has(action.id)) {
            throw new TypeError('cloud action ids must be unique non-empty strings');
        }
        if (!Number.isFinite(action.atMs) || action.atMs < previousAt) {
            throw new TypeError('cloud actions must have nondecreasing finite atMs values');
        }
        ids.add(action.id);
        previousAt = action.atMs;
    }
    return schedule;
}

function reindexCloudActions(actions) {
    return actions.map((action, index) => ({ ...clone(action), id: `cloud-action-${index + 1}`, atMs: index }));
}

module.exports = {
    ACTION_TYPES,
    CLOUD_ACTION,
    CLOUD_FAULT,
    CLOUD_SCHEDULE_SCHEMA_VERSION,
    CONTROLLER_ACTION,
    CONTROLLER_TYPES,
    FAULT_TYPES,
    clone,
    reindexCloudActions,
    validateCloudSchedule,
};
