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
        this.step = checkpoint?.step || 0;
        this.state = clone(checkpoint?.state || {});
        this.status = checkpoint?.status || 'RUNNING';
        this.history = clone(checkpoint?.history || []);
    }

    advance(label, patch = {}) {
        this.step += 1;
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
    RESUME_DECISION,
    changedResources,
    decideResume,
    digest,
    makeEffectId,
    makeSemanticSnapshot,
};
