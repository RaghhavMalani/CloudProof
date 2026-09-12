'use strict';

/**
 * Durable execution primitives for autonomous agents.
 *
 * The runtime deliberately keeps cognition outside the consistency boundary:
 * an LLM proposes logical actions, while this module owns their durable
 * identity, semantic context, execution state, and observable effects.
 */

const crypto = require('crypto');

const EFFECT_STATUS = Object.freeze({
    INTENT_RECORDED: 'INTENT_RECORDED',
    RECONCILIATION_REQUIRED: 'RECONCILIATION_REQUIRED',
    RESULT_RECORDED: 'RESULT_RECORDED',
    EFFECT_COMMITTED: 'EFFECT_COMMITTED',
});

const RESUME_DECISION = Object.freeze({
    CONTINUE: 'continue',
    REVALIDATE: 'revalidate',
    RESTART: 'restart',
    REQUIRE_APPROVAL: 'require-approval',
    ABORT: 'abort',
});

function stable(value) {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
    }
    return value;
}

function digest(value) {
    const encoded = JSON.stringify(stable(value));
    return crypto.createHash('sha256').update(encoded === undefined ? 'undefined' : encoded).digest('hex');
}

function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

const RESOURCE_OPERATION = Object.freeze({
    SET: 'set',
    INCREMENT: 'increment',
    APPEND_UNIQUE: 'append-unique',
});

function validResourceField(field) {
    return typeof field === 'string'
        && field.length > 0
        && !['__proto__', 'constructor', 'prototype'].includes(field);
}

function normalizeReadSet(readSet) {
    if (!Array.isArray(readSet) || readSet.length === 0) {
        throw new TypeError('readSet must be a non-empty array');
    }
    const seen = new Set();
    const normalized = readSet.map((entry) => {
        if (!entry || typeof entry.resourceId !== 'string' || entry.resourceId.length === 0) {
            throw new TypeError('readSet resourceId must be a non-empty string');
        }
        if (!Number.isInteger(entry.version) || entry.version < 0) {
            throw new TypeError('readSet version must be a non-negative integer');
        }
        if (seen.has(entry.resourceId)) throw new TypeError(`duplicate readSet resource: ${entry.resourceId}`);
        seen.add(entry.resourceId);
        return { resourceId: entry.resourceId, version: entry.version };
    });
    return normalized.sort((left, right) => left.resourceId.localeCompare(right.resourceId));
}

function normalizeWriteSet(writeSet) {
    if (!Array.isArray(writeSet) || writeSet.length === 0) {
        throw new TypeError('writeSet must be a non-empty array');
    }
    const seen = new Set();
    const normalized = writeSet.map((entry) => {
        if (!entry || typeof entry.resourceId !== 'string' || entry.resourceId.length === 0) {
            throw new TypeError('writeSet resourceId must be a non-empty string');
        }
        if (seen.has(entry.resourceId)) throw new TypeError(`duplicate writeSet resource: ${entry.resourceId}`);
        seen.add(entry.resourceId);
        if (!Array.isArray(entry.operations) || entry.operations.length === 0) {
            throw new TypeError('writeSet operations must be a non-empty array');
        }
        const operations = entry.operations.map((operation) => {
            if (!operation || !Object.values(RESOURCE_OPERATION).includes(operation.op)) {
                throw new TypeError(`unsupported resource operation: ${operation && operation.op}`);
            }
            if (!validResourceField(operation.field)) {
                throw new TypeError('resource operation field must be a safe non-empty string');
            }
            if (operation.op === RESOURCE_OPERATION.INCREMENT
                && (typeof operation.value !== 'number' || !Number.isFinite(operation.value))) {
                throw new TypeError('increment operation value must be finite');
            }
            return clone(stable(operation));
        });
        return { resourceId: entry.resourceId, operations };
    });
    return normalized.sort((left, right) => left.resourceId.localeCompare(right.resourceId));
}

function applyResourceOperations(state, operations) {
    const next = clone(stable(state || {}));
    for (const operation of operations) {
        if (!operation || !Object.values(RESOURCE_OPERATION).includes(operation.op)
            || !validResourceField(operation.field)) {
            throw new TypeError('invalid resource operation');
        }
        if (operation.op === RESOURCE_OPERATION.SET) {
            next[operation.field] = clone(stable(operation.value));
        } else if (operation.op === RESOURCE_OPERATION.INCREMENT) {
            if (typeof operation.value !== 'number' || !Number.isFinite(operation.value)) {
                throw new TypeError('increment operation value must be finite');
            }
            const current = next[operation.field] === undefined ? 0 : next[operation.field];
            if (typeof current !== 'number' || !Number.isFinite(current)) {
                throw new TypeError(`cannot increment non-numeric field: ${operation.field}`);
            }
            next[operation.field] = current + operation.value;
        } else if (operation.op === RESOURCE_OPERATION.APPEND_UNIQUE) {
            const current = next[operation.field] === undefined ? [] : next[operation.field];
            if (!Array.isArray(current)) {
                throw new TypeError(`cannot append to non-array field: ${operation.field}`);
            }
            const candidate = clone(stable(operation.value));
            if (!current.some((value) => digest(value) === digest(candidate))) current.push(candidate);
            next[operation.field] = current;
        }
    }
    return clone(stable(next));
}

function makeEffectId(executionId, logicalAction, parameters) {
    return `effect:${digest({ executionId, logicalAction, parameters })}`;
}

function makeSemanticSnapshot(resources) {
    const normalized = clone(stable(resources));
    return Object.freeze({
        id: `snapshot:${digest(normalized)}`,
        resources: Object.freeze(normalized),
    });
}

function changedResources(before, after) {
    const left = before?.resources || before || {};
    const right = after?.resources || after || {};
    return [...new Set([...Object.keys(left), ...Object.keys(right)])]
        .filter((key) => digest(left[key]) !== digest(right[key]))
        .sort();
}

function decideResume({ pinned, available, compatibility = {} }) {
    const changed = changedResources(pinned, available);
    if (changed.length === 0) return { decision: RESUME_DECISION.CONTINUE, changed };

    const dispositions = changed.map((name) => compatibility[name] || RESUME_DECISION.REVALIDATE);
    const precedence = [
        RESUME_DECISION.ABORT,
        RESUME_DECISION.REQUIRE_APPROVAL,
        RESUME_DECISION.RESTART,
        RESUME_DECISION.REVALIDATE,
        RESUME_DECISION.CONTINUE,
    ];
    return {
        decision: precedence.find((candidate) => dispositions.includes(candidate)),
        changed,
        dispositions: Object.fromEntries(changed.map((name, index) => [name, dispositions[index]])),
    };
}

class EffectLedger {
    constructor(records = []) {
        this.records = new Map(records.map((record) => [record.effectId, clone(record)]));
    }

    get(effectId) {
        const record = this.records.get(effectId);
        return record ? clone(record) : null;
    }

    recordIntent({ executionId, logicalAction, parameters, snapshotId, atStep = null }) {
        const effectId = makeEffectId(executionId, logicalAction, parameters);
        const existing = this.records.get(effectId);
        if (existing) return { record: clone(existing), duplicate: true };

        const record = {
            effectId,
            executionId,
            logicalAction,
            parameters: clone(stable(parameters)),
            snapshotId,
            atStep,
            status: EFFECT_STATUS.INTENT_RECORDED,
            attempts: 0,
            result: null,
        };
        this.records.set(effectId, record);
        return { record: clone(record), duplicate: false };
    }

    markDispatched(effectId) {
        const record = this._require(effectId);
        if (record.status === EFFECT_STATUS.EFFECT_COMMITTED) return clone(record);
        record.attempts += 1;
        return clone(record);
    }

    requireReconciliation(effectId) {
        const record = this._require(effectId);
        if (record.status !== EFFECT_STATUS.EFFECT_COMMITTED) {
            record.status = EFFECT_STATUS.RECONCILIATION_REQUIRED;
        }
        return clone(record);
    }

    recordResult(effectId, result) {
        const record = this._require(effectId);
        if (record.status === EFFECT_STATUS.EFFECT_COMMITTED) return clone(record);
        record.result = clone(result);
        record.status = EFFECT_STATUS.RESULT_RECORDED;
        return clone(record);
    }

    commit(effectId) {
        const record = this._require(effectId);
        if (record.result === null) throw new Error(`cannot commit ${effectId} without a recorded result`);
        record.status = EFFECT_STATUS.EFFECT_COMMITTED;
        return clone(record);
    }

    resolve(effectId) {
        const record = this.records.get(effectId);
        if (!record) return { action: 'execute', record: null };
        if (record.status === EFFECT_STATUS.EFFECT_COMMITTED) {
            return { action: 'return-recorded-result', record: clone(record) };
        }
        return { action: 'reconcile', record: clone(record) };
    }

    export() {
        return [...this.records.values()].map(clone);
    }

    _require(effectId) {
        const record = this.records.get(effectId);
        if (!record) throw new Error(`unknown effect ${effectId}`);
        return record;
    }
}

class AgentExecution {
    constructor({ executionId, workflow, snapshot, checkpoint = null, ledger = null }) {
        if (!executionId || !workflow || !snapshot) throw new TypeError('executionId, workflow, and snapshot are required');
        this.executionId = executionId;
        this.workflow = workflow;
        this.snapshot = snapshot.id ? snapshot : makeSemanticSnapshot(snapshot);
        this.ledger = ledger || new EffectLedger(checkpoint?.effects || []);
        this.version = checkpoint?.version ?? 1;
        this.semanticConflict = clone(checkpoint?.semanticConflict || null);
        this.step = checkpoint?.step || 0;
        this.state = clone(checkpoint?.state || {});
        this.status = checkpoint?.status || 'RUNNING';
        this.history = clone(checkpoint?.history || []);
    }

    advance(label, patch = {}) {
        this.step += 1;
        this.version += 1;
        Object.assign(this.state, clone(patch));
        this.history.push({ step: this.step, label, patch: clone(patch) });
        return this.step;
    }

    checkpoint() {
        return clone({
            executionId: this.executionId,
            workflow: this.workflow,
            snapshot: this.snapshot,
            step: this.step,
            version: this.version,
            semanticConflict: this.semanticConflict,
            state: this.state,
            status: this.status,
            history: this.history,
            effects: this.ledger.export(),
        });
    }

    static resume(checkpoint) {
        return new AgentExecution({
            executionId: checkpoint.executionId,
            workflow: checkpoint.workflow,
            snapshot: checkpoint.snapshot,
            checkpoint,
        });
    }
}

module.exports = {
    AgentExecution,
    EffectLedger,
    EFFECT_STATUS,
    RESOURCE_OPERATION,
    RESUME_DECISION,
    applyResourceOperations,
    changedResources,
    decideResume,
    digest,
    makeEffectId,
    makeSemanticSnapshot,
    normalizeReadSet,
    normalizeWriteSet,
};
