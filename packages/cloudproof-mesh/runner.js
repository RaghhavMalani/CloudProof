'use strict';

// Schedule execution with replay fingerprints and horizon labels. A row is
// the state before an action plus that action; rows stop at the first SLO
// violation, which is included (pre-incident rows only, section 6).

const { digest } = require('../agent-runtime');
const { ACTION_TYPES } = require('./constants');
const { createMeshState, step } = require('./engine');
const { serviceGraph } = require('./graph');
const { stable } = require('./world');

const SCHEDULE_KIND = 'cloudproof.mesh-schedule';
const HORIZONS = Object.freeze([1, 5, 10, 20]);

function validateSchedule(schedule) {
    if (!schedule || schedule.kind !== SCHEDULE_KIND || schedule.schemaVersion !== 1) {
        throw new TypeError(`expected a ${SCHEDULE_KIND} v1`);
    }
    if (!Array.isArray(schedule.actions) || !schedule.actions.length) throw new TypeError('schedule needs actions');
    for (const action of schedule.actions) {
        if (!ACTION_TYPES.includes(action?.type)) throw new TypeError(`unknown mesh action: ${action?.type}`);
    }
    return true;
}

function meshSchedule({ seed, world, actions, metadata = {} }) {
    const schedule = stable({ schemaVersion: 1, kind: SCHEDULE_KIND, seed, world, actions, metadata });
    validateSchedule(schedule);
    return schedule;
}

function runMeshSchedule(schedule, { includeGraphs = false } = {}) {
    validateSchedule(schedule);
    let state = createMeshState(schedule.world);
    if (state.derived.violating) {
        return stable({ valid: false, reason: 'violates before the first action', rows: [], outcome: null });
    }
    const rows = [];
    let failure = null;
    for (const [index, action] of schedule.actions.entries()) {
        const row = { index, action, atMs: state.clockMs, stateDigest: digest(state) };
        if (includeGraphs) row.graph = serviceGraph(state);
        const result = step(state, action);
        row.violation = Boolean(result.violation);
        rows.push(row);
        state = result.state;
        if (result.violation) {
            failure = { transition: index, ...result.violation };
            break;
        }
    }
    for (const row of rows) {
        row.labels = Object.fromEntries(HORIZONS.map((horizon) => [String(horizon),
            Boolean(failure) && failure.transition - row.index < horizon]));
    }
    const fingerprint = digest({
        rows: rows.map((row) => [row.index, row.stateDigest, row.violation]),
        failure,
        finalState: digest(state),
    });
    return {
        valid: true,
        outcome: stable({ unsafe: Boolean(failure), failure }),
        rows,
        finalState: state,
        fingerprint,
    };
}

module.exports = {
    HORIZONS,
    SCHEDULE_KIND,
    meshSchedule,
    runMeshSchedule,
    validateSchedule,
};
