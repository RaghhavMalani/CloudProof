'use strict';

/**
 * The causal event envelope shared by the simulator, browser lab, fuzzing, and
 * (eventually) live replicas. Keep this module dependency-free and browser-safe.
 */
const EVENT_SCHEMA_VERSION = 1;

const EVENT_TYPES = Object.freeze({
    RUN_STARTED: 'run.started',
    RUN_FINISHED: 'run.finished',
    RPC_SENT: 'rpc.sent',
    RPC_REPLY: 'rpc.reply',
    RPC_DELIVERED: 'rpc.delivered',
    RPC_BLOCKED: 'rpc.blocked',
    NODE_ROLE_CHANGED: 'node.role.changed',
    NODE_TERM_CHANGED: 'node.term.changed',
    LOG_APPENDED: 'log.appended',
    LOG_COMMITTED: 'log.committed',
    FAULT_APPLIED: 'fault.applied',
    FAULT_HEALED: 'fault.healed',
    SCENARIO_ACTION: 'scenario.action',
    CLUSTER_SNAPSHOT: 'cluster.snapshot',
    INVARIANT_CHECKED: 'invariant.checked',
});

function jsonSafe(value, seen = new WeakSet()) {
    if (value === undefined) return null;
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
    if (typeof value === 'bigint') return value.toString();
    if (typeof value === 'function' || typeof value === 'symbol') return String(value);
    if (ArrayBuffer.isView(value)) return Array.from(value);
    if (value instanceof ArrayBuffer) return Array.from(new Uint8Array(value));
    if (value instanceof Error) return { name: value.name, message: value.message };
    if (typeof value !== 'object') return String(value);
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    if (Array.isArray(value)) return value.map((item) => jsonSafe(item, seen));
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = jsonSafe(value[key], seen);
    return out;
}

function createEvent({
    runId,
    sequence,
    epochMs,
    startedAt,
    type,
    source = { component: 'simulator' },
    subject = {},
    data = {},
    correlationId = null,
    causationId = null,
}) {
    if (!runId || !Number.isInteger(sequence) || sequence < 1) {
        throw new TypeError('event requires a runId and positive integer sequence');
    }
    if (typeof type !== 'string' || !/^[a-z][a-z0-9]*(?:\.[a-z0-9]+)+$/.test(type)) {
        throw new TypeError(`invalid event type: ${type}`);
    }
    if (!Number.isFinite(epochMs) || !Number.isFinite(startedAt)) {
        throw new TypeError('event time must be finite');
    }

    return Object.freeze({
        schemaVersion: EVENT_SCHEMA_VERSION,
        id: `${runId}:${String(sequence).padStart(8, '0')}`,
        runId,
        sequence,
        time: Object.freeze({
            kind: 'virtual',
            epochMs,
            elapsedMs: Math.max(0, epochMs - startedAt),
        }),
        type,
        source: jsonSafe(source),
        subject: jsonSafe(subject),
        correlationId,
        causationId,
        data: jsonSafe(data),
    });
}

function validateEvent(event) {
    const errors = [];
    if (!event || typeof event !== 'object') return { ok: false, errors: ['event must be an object'] };
    if (event.schemaVersion !== EVENT_SCHEMA_VERSION) errors.push('unsupported schemaVersion');
    if (!event.id || typeof event.id !== 'string') errors.push('id must be a string');
    if (!event.runId || typeof event.runId !== 'string') errors.push('runId must be a string');
    if (!Number.isInteger(event.sequence) || event.sequence < 1) errors.push('sequence must be positive');
    if (typeof event.type !== 'string') errors.push('type must be a string');
    if (!event.time || !Number.isFinite(event.time.epochMs) || !Number.isFinite(event.time.elapsedMs)) {
        errors.push('time must contain finite epochMs and elapsedMs');
    }
    return { ok: errors.length === 0, errors };
}

module.exports = {
    EVENT_SCHEMA_VERSION,
    EVENT_TYPES,
    createEvent,
    validateEvent,
    jsonSafe,
};
