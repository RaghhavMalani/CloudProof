'use strict';

/**
 * Deterministic reducer for Raft-backed agent executions.
 *
 * This module deliberately contains no clocks, randomness, I/O, or provider
 * calls. Every mutation is a pure consequence of the committed command and
 * its log index, so replaying a committed prefix reconstructs byte-equivalent
 * execution checkpoints on every replica.
 */

const EFFECT_STATUS = Object.freeze({
    INTENT_RECORDED: 'INTENT_RECORDED',
    RECONCILIATION_REQUIRED: 'RECONCILIATION_REQUIRED',
    RESULT_RECORDED: 'RESULT_RECORDED',
    EFFECT_COMMITTED: 'EFFECT_COMMITTED',
});

const EXECUTION_STATUS = Object.freeze({
    RUNNING: 'RUNNING',
    PAUSED_SEMANTIC_CONFLICT: 'PAUSED_SEMANTIC_CONFLICT',
    COMPLETE: 'COMPLETE',
});

function stable(value) {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
    }
    return value;
}

function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(stable(value)));
}

function same(left, right) {
    return JSON.stringify(stable(left)) === JSON.stringify(stable(right));
}

// Kept inside the replica runtime because its production image intentionally
// has the replica directory as its complete Docker build context. The shared
// package exposes the same small operation language to search tooling.
const RESOURCE_OPERATIONS = new Set(['set', 'increment', 'append-unique']);

function safeField(field) {
    return typeof field === 'string' && field.length > 0
        && !['__proto__', 'constructor', 'prototype'].includes(field);
}

function normalizeReadSet(readSet) {
    if (!Array.isArray(readSet) || readSet.length === 0) {
        throw new TypeError('readSet must be a non-empty array');
    }
    const seen = new Set();
    return readSet.map((entry) => {
        if (!entry || typeof entry.resourceId !== 'string' || entry.resourceId.length === 0) {
            throw new TypeError('readSet resourceId must be a non-empty string');
        }
        if (!Number.isInteger(entry.version) || entry.version < 0) {
            throw new TypeError('readSet version must be a non-negative integer');
        }
        if (seen.has(entry.resourceId)) throw new TypeError(`duplicate readSet resource: ${entry.resourceId}`);
        seen.add(entry.resourceId);
        return { resourceId: entry.resourceId, version: entry.version };
    }).sort((left, right) => left.resourceId.localeCompare(right.resourceId));
}

function normalizeWriteSet(writeSet) {
    if (!Array.isArray(writeSet) || writeSet.length === 0) {
        throw new TypeError('writeSet must be a non-empty array');
    }
    const seen = new Set();
    return writeSet.map((entry) => {
        if (!entry || typeof entry.resourceId !== 'string' || entry.resourceId.length === 0) {
            throw new TypeError('writeSet resourceId must be a non-empty string');
        }
        if (seen.has(entry.resourceId)) throw new TypeError(`duplicate writeSet resource: ${entry.resourceId}`);
        seen.add(entry.resourceId);
        if (!Array.isArray(entry.operations) || entry.operations.length === 0) {
            throw new TypeError('writeSet operations must be a non-empty array');
        }
        const operations = entry.operations.map((operation) => {
            if (!operation || !RESOURCE_OPERATIONS.has(operation.op)) {
                throw new TypeError(`unsupported resource operation: ${operation && operation.op}`);
            }
            if (!safeField(operation.field)) throw new TypeError('resource operation field is invalid');
            if (operation.op === 'increment'
                && (typeof operation.value !== 'number' || !Number.isFinite(operation.value))) {
                throw new TypeError('increment operation value must be finite');
            }
            return clone(operation);
        });
        return { resourceId: entry.resourceId, operations };
    }).sort((left, right) => left.resourceId.localeCompare(right.resourceId));
}

function applyResourceOperations(state, operations) {
    const next = clone(state || {});
    for (const operation of operations) {
        if (operation.op === 'set') {
            next[operation.field] = clone(operation.value);
        } else if (operation.op === 'increment') {
            const current = next[operation.field] === undefined ? 0 : next[operation.field];
            if (typeof current !== 'number' || !Number.isFinite(current)) {
                throw new TypeError(`cannot increment non-numeric field: ${operation.field}`);
            }
            next[operation.field] = current + operation.value;
        } else if (operation.op === 'append-unique') {
            const current = next[operation.field] === undefined ? [] : next[operation.field];
            if (!Array.isArray(current)) {
                throw new TypeError(`cannot append to non-array field: ${operation.field}`);
            }
            const candidate = clone(operation.value);
            if (!current.some((value) => same(value, candidate))) current.push(candidate);
            next[operation.field] = current;
        }
    }
    return clone(next);
}

function fail(error, details = {}) {
    return { ok: false, error, mutated: false, ...details };
}

function requireText(value, field) {
    return typeof value === 'string' && value.length > 0
        ? null
        : fail('INVALID_AGENT_COMMAND', { message: `${field} must be a non-empty string` });
}

class AgentState {
    constructor() {
        this.executions = new Map();
        this.resources = new Map();
    }

    get(executionId) {
        const execution = this.executions.get(executionId);
        return execution ? clone(execution) : null;
    }

    list() {
        return [...this.executions.keys()].sort().map((executionId) => this.get(executionId));
    }

    getResource(resourceId) {
        const resource = this.resources.get(resourceId);
        return resource ? clone(resource) : null;
    }

    listResources() {
        return [...this.resources.keys()].sort().map((resourceId) => this.getResource(resourceId));
    }

    snapshot() {
        return { executions: this.list(), resources: this.listResources() };
    }

    apply(command, { index = -1 } = {}) {
        switch (command.op) {
            case 'agent.execution.create':
                return this._create(command, index);
            case 'agent.execution.advance':
                return this._advance(command, index);
            case 'agent.execution.complete':
                return this._complete(command, index);
            case 'agent.execution.plan':
                return this._plan(command, index);
            case 'agent.resource.create':
                return this._createResource(command, index);
            case 'agent.effect.authorize-resource':
                return this._authorizeResourceEffect(command, index);
            case 'agent.effect.intent':
                return this._intent(command, index);
            case 'agent.effect.dispatch':
                return this._dispatch(command, index);
            case 'agent.effect.reconciliation-required':
                return this._requireReconciliation(command, index);
            case 'agent.effect.result':
                return this._recordResult(command, index);
            case 'agent.effect.commit':
                return this._commitEffect(command, index);
            case 'agent.semantic-conflict.detect':
                return this._detectSemanticConflict(command, index);
            case 'agent.snapshot.transition':
                return this._transitionSnapshot(command, index);
            default:
                return fail('UNKNOWN_AGENT_COMMAND', { message: `unknown op: ${command.op}` });
        }
    }

    _execution(command) {
        const invalid = requireText(command.executionId, 'executionId');
        if (invalid) return invalid;
        const execution = this.executions.get(command.executionId);
        return execution || fail('EXECUTION_NOT_FOUND', { executionId: command.executionId });
    }

    _effect(command) {
        const execution = this._execution(command);
        if (execution.ok === false) return execution;
        const invalid = requireText(command.effectId, 'effectId');
        if (invalid) return invalid;
        const effect = execution.effects.find((candidate) => candidate.effectId === command.effectId);
        return effect
            ? { execution, effect }
            : fail('EFFECT_NOT_FOUND', {
                executionId: command.executionId,
                effectId: command.effectId,
            });
    }

    _mutated(execution, event) {
        execution.version += 1;
        execution.history.push(clone(event));
        return execution;
    }

    _create(command, index) {
        const executionError = requireText(command.executionId, 'executionId');
        if (executionError) return executionError;
        const workflowError = requireText(command.workflow, 'workflow');
        if (workflowError) return workflowError;
        if (!command.snapshot || requireText(command.snapshot.id, 'snapshot.id')) {
            return fail('INVALID_AGENT_COMMAND', { message: 'snapshot with an id is required' });
        }

        const candidate = {
            executionId: command.executionId,
            workflow: command.workflow,
            snapshot: clone(command.snapshot),
            step: 0,
            version: 1,
            state: clone(command.initialState || {}),
            status: EXECUTION_STATUS.RUNNING,
            semanticConflict: null,
            readSet: [],
            writeSet: [],
            history: [{
                type: 'EXECUTION_CREATED',
                index,
                step: 0,
                snapshotId: command.snapshot.id,
            }],
            effects: [],
        };
        const existing = this.executions.get(command.executionId);
        if (existing) {
            const sameIdentity = existing.workflow === candidate.workflow
                && same(existing.snapshot, candidate.snapshot)
                && same(existing.state, candidate.state);
            return sameIdentity
                ? { ok: true, mutated: false, duplicate: true, execution: clone(existing) }
                : fail('EXECUTION_ID_CONFLICT', { executionId: command.executionId });
        }

        this.executions.set(command.executionId, candidate);
        return { ok: true, mutated: true, execution: clone(candidate) };
    }

    _createResource(command, index) {
        const resourceError = requireText(command.resourceId, 'resourceId');
        if (resourceError) return resourceError;
        if (command.state !== undefined
            && (!command.state || Array.isArray(command.state) || typeof command.state !== 'object')) {
            return fail('INVALID_AGENT_COMMAND', { message: 'resource state must be an object' });
        }
        const version = command.version === undefined ? 1 : command.version;
        if (!Number.isInteger(version) || version < 0) {
            return fail('INVALID_AGENT_COMMAND', { message: 'resource version must be a non-negative integer' });
        }
        const candidate = {
            resourceId: command.resourceId,
            version,
            state: clone(command.state || {}),
            lastMutation: { type: 'RESOURCE_CREATED', index },
        };
        const existing = this.resources.get(command.resourceId);
        if (existing) {
            const sameIdentity = existing.version === candidate.version
                && same(existing.state, candidate.state);
            return sameIdentity
                ? { ok: true, mutated: false, duplicate: true, resource: clone(existing) }
                : fail('RESOURCE_ID_CONFLICT', { resourceId: command.resourceId });
        }
        this.resources.set(command.resourceId, candidate);
        return { ok: true, mutated: true, resource: clone(candidate) };
    }

    _plan(command, index) {
        const execution = this._execution(command);
        if (execution.ok === false) return execution;
        if (execution.status !== EXECUTION_STATUS.RUNNING) {
            return fail('EXECUTION_NOT_RUNNING', { status: execution.status });
        }
        let readSet;
        let writeSet;
        try {
            readSet = normalizeReadSet(command.readSet);
            writeSet = normalizeWriteSet(command.writeSet);
        } catch (error) {
            return fail('INVALID_AGENT_COMMAND', { message: error.message });
        }
        const readResources = new Set(readSet.map((entry) => entry.resourceId));
        const unobserved = writeSet.find((entry) => !readResources.has(entry.resourceId));
        if (unobserved) {
            return fail('UNOBSERVED_RESOURCE_WRITE', { resourceId: unobserved.resourceId });
        }
        const missing = readSet.find((entry) => !this.resources.has(entry.resourceId));
        if (missing) return fail('RESOURCE_NOT_FOUND', { resourceId: missing.resourceId });

        execution.readSet = clone(readSet);
        execution.writeSet = clone(writeSet);
        this._mutated(execution, {
            type: 'RESOURCE_PLAN_RECORDED',
            index,
            step: execution.step,
            readSet,
            writeSet,
        });
        return {
            ok: true,
            mutated: true,
            executionId: execution.executionId,
            readSet: clone(readSet),
            writeSet: clone(writeSet),
            version: execution.version,
        };
    }

    _authorizeResourceEffect(command, index) {
        const execution = this._execution(command);
        if (execution.ok === false) return execution;
        if (execution.status !== EXECUTION_STATUS.RUNNING) {
            return fail('EXECUTION_NOT_RUNNING', { status: execution.status });
        }
        const effectError = requireText(command.effectId, 'effectId');
        if (effectError) return effectError;
        const actionError = requireText(command.logicalAction, 'logicalAction');
        if (actionError) return actionError;
        if (command.snapshotId !== execution.snapshot.id) {
            return fail('SEMANTIC_SNAPSHOT_MISMATCH', {
                expectedSnapshotId: execution.snapshot.id,
                actualSnapshotId: command.snapshotId,
            });
        }
        if (execution.readSet.length === 0 || execution.writeSet.length === 0) {
            return fail('RESOURCE_PLAN_REQUIRED', { executionId: execution.executionId });
        }

        const existing = execution.effects.find((effect) => effect.effectId === command.effectId);
        if (existing) {
            const sameIntent = existing.logicalAction === command.logicalAction
                && existing.snapshotId === command.snapshotId
                && same(existing.parameters, command.parameters || {})
                && same(existing.resourceAuthorization?.readSet, execution.readSet)
                && same(existing.resourceAuthorization?.writeSet, execution.writeSet);
            return sameIntent
                ? { ok: true, mutated: false, duplicate: true, effect: clone(existing) }
                : fail('EFFECT_ID_CONFLICT', { effectId: command.effectId });
        }

        const conflicts = execution.readSet.map((expected) => {
            const resource = this.resources.get(expected.resourceId);
            return !resource || resource.version !== expected.version
                ? {
                    resourceId: expected.resourceId,
                    expectedVersion: expected.version,
                    actualVersion: resource?.version ?? null,
                }
                : null;
        }).filter(Boolean);
        if (conflicts.length > 0) {
            return fail('RESOURCE_VERSION_CONFLICT', {
                executionId: execution.executionId,
                resourceId: conflicts[0].resourceId,
                expectedVersion: conflicts[0].expectedVersion,
                actualVersion: conflicts[0].actualVersion,
                conflicts,
                decision: 'REVALIDATE',
            });
        }

        const projected = new Map();
        try {
            for (const intent of execution.writeSet) {
                const resource = this.resources.get(intent.resourceId);
                projected.set(intent.resourceId, applyResourceOperations(resource.state, intent.operations));
            }
        } catch (error) {
            return fail('INVALID_AGENT_COMMAND', { message: error.message });
        }

        const resultingVersions = {};
        for (const intent of execution.writeSet) {
            const resource = this.resources.get(intent.resourceId);
            resource.state = projected.get(intent.resourceId);
            resource.version += 1;
            resource.lastMutation = {
                type: 'RESOURCE_EFFECT_AUTHORIZED',
                index,
                executionId: execution.executionId,
                effectId: command.effectId,
            };
            resultingVersions[intent.resourceId] = resource.version;
        }

        const effect = {
            effectId: command.effectId,
            executionId: command.executionId,
            logicalAction: command.logicalAction,
            parameters: clone(command.parameters || {}),
            snapshotId: command.snapshotId,
            atStep: execution.step,
            status: EFFECT_STATUS.INTENT_RECORDED,
            attempts: 0,
            result: null,
            resourceAuthorization: {
                readSet: clone(execution.readSet),
                writeSet: clone(execution.writeSet),
                resultingVersions: clone(resultingVersions),
                committedAtIndex: index,
            },
        };
        execution.effects.push(effect);
        execution.effects.sort((left, right) => left.effectId.localeCompare(right.effectId));
        this._mutated(execution, {
            type: 'RESOURCE_EFFECT_AUTHORIZED',
            index,
            step: execution.step,
            effectId: command.effectId,
            readSet: clone(execution.readSet),
            resultingVersions: clone(resultingVersions),
        });
        return {
            ok: true,
            mutated: true,
            effect: clone(effect),
            resources: execution.writeSet.map((entry) => this.getResource(entry.resourceId)),
            version: execution.version,
        };
    }

    _checkStep(execution, expectedStep) {
        if (!Number.isInteger(expectedStep) || expectedStep < 0) {
            return fail('INVALID_AGENT_COMMAND', { message: 'expectedStep must be a non-negative integer' });
        }
        if (execution.step !== expectedStep) {
            return fail('STALE_EXECUTION_VERSION', {
                executionId: execution.executionId,
                expectedStep,
                actualStep: execution.step,
                actualVersion: execution.version,
            });
        }
        return null;
    }

    _advance(command, index) {
        const execution = this._execution(command);
        if (execution.ok === false) return execution;
        const stepError = this._checkStep(execution, command.expectedStep);
        if (stepError) return stepError;
        const labelError = requireText(command.label, 'label');
        if (labelError) return labelError;
        if (execution.status !== EXECUTION_STATUS.RUNNING) {
            return fail('EXECUTION_NOT_RUNNING', {
                executionId: execution.executionId,
                status: execution.status,
            });
        }
        if (command.patch !== undefined
            && (!command.patch || Array.isArray(command.patch) || typeof command.patch !== 'object')) {
            return fail('INVALID_AGENT_COMMAND', { message: 'patch must be an object' });
        }

        execution.step += 1;
        execution.state = clone({ ...execution.state, ...(command.patch || {}) });
        this._mutated(execution, {
            type: 'STEP_ADVANCED',
            index,
            step: execution.step,
            label: command.label,
            patch: clone(command.patch || {}),
        });
        return {
            ok: true,
            mutated: true,
            executionId: execution.executionId,
            step: execution.step,
            version: execution.version,
        };
    }

    _intent(command, index) {
        const execution = this._execution(command);
        if (execution.ok === false) return execution;
        if (execution.status !== EXECUTION_STATUS.RUNNING) {
            return fail('EXECUTION_NOT_RUNNING', { status: execution.status });
        }
        const effectError = requireText(command.effectId, 'effectId');
        if (effectError) return effectError;
        const actionError = requireText(command.logicalAction, 'logicalAction');
        if (actionError) return actionError;
        if (command.snapshotId !== execution.snapshot.id) {
            return fail('SEMANTIC_SNAPSHOT_MISMATCH', {
                expectedSnapshotId: execution.snapshot.id,
                actualSnapshotId: command.snapshotId,
            });
        }

        const candidate = {
            effectId: command.effectId,
            executionId: command.executionId,
            logicalAction: command.logicalAction,
            parameters: clone(command.parameters || {}),
            snapshotId: command.snapshotId,
            atStep: execution.step,
            status: EFFECT_STATUS.INTENT_RECORDED,
            attempts: 0,
            result: null,
        };
        const existing = execution.effects.find((effect) => effect.effectId === command.effectId);
        if (existing) {
            const sameIntent = existing.logicalAction === candidate.logicalAction
                && existing.snapshotId === candidate.snapshotId
                && same(existing.parameters, candidate.parameters);
            return sameIntent
                ? { ok: true, mutated: false, duplicate: true, effect: clone(existing) }
                : fail('EFFECT_ID_CONFLICT', { effectId: command.effectId });
        }

        execution.effects.push(candidate);
        execution.effects.sort((left, right) => (
            left.effectId < right.effectId ? -1 : left.effectId > right.effectId ? 1 : 0
        ));
        this._mutated(execution, {
            type: 'EFFECT_INTENT_RECORDED', index, step: execution.step, effectId: command.effectId,
        });
        return { ok: true, mutated: true, effect: clone(candidate), version: execution.version };
    }

    _dispatch(command, index) {
        const found = this._effect(command);
        if (found.ok === false) return found;
        const { execution, effect } = found;
        if (execution.status !== EXECUTION_STATUS.RUNNING) {
            return fail('EXECUTION_NOT_RUNNING', { status: execution.status });
        }
        if (![EFFECT_STATUS.INTENT_RECORDED, EFFECT_STATUS.RECONCILIATION_REQUIRED]
            .includes(effect.status)) {
            return fail('EFFECT_NOT_DISPATCHABLE', { effectId: effect.effectId, status: effect.status });
        }
        effect.attempts += 1;
        this._mutated(execution, {
            type: 'EFFECT_DISPATCH_AUTHORIZED', index, step: execution.step,
            effectId: effect.effectId, attempt: effect.attempts,
        });
        return { ok: true, mutated: true, effect: clone(effect), version: execution.version };
    }

    _requireReconciliation(command, index) {
        const found = this._effect(command);
        if (found.ok === false) return found;
        const { execution, effect } = found;
        if ([EFFECT_STATUS.RESULT_RECORDED, EFFECT_STATUS.EFFECT_COMMITTED].includes(effect.status)) {
            return { ok: true, mutated: false, duplicate: true, effect: clone(effect) };
        }
        if (effect.status === EFFECT_STATUS.RECONCILIATION_REQUIRED) {
            return { ok: true, mutated: false, duplicate: true, effect: clone(effect) };
        }
        effect.status = EFFECT_STATUS.RECONCILIATION_REQUIRED;
        this._mutated(execution, {
            type: 'EFFECT_RECONCILIATION_REQUIRED', index, step: execution.step,
            effectId: effect.effectId,
        });
        return { ok: true, mutated: true, effect: clone(effect), version: execution.version };
    }

    _recordResult(command, index) {
        const found = this._effect(command);
        if (found.ok === false) return found;
        const { execution, effect } = found;
        if (command.result === undefined || command.result === null) {
            return fail('INVALID_AGENT_COMMAND', { message: 'result is required' });
        }
        if ([EFFECT_STATUS.RESULT_RECORDED, EFFECT_STATUS.EFFECT_COMMITTED].includes(effect.status)) {
            return same(effect.result, command.result)
                ? { ok: true, mutated: false, duplicate: true, effect: clone(effect) }
                : fail('EFFECT_RESULT_CONFLICT', { effectId: effect.effectId, recorded: clone(effect.result) });
        }
        effect.result = clone(command.result);
        effect.status = EFFECT_STATUS.RESULT_RECORDED;
        this._mutated(execution, {
            type: 'EFFECT_RESULT_RECORDED', index, step: execution.step, effectId: effect.effectId,
        });
        return { ok: true, mutated: true, effect: clone(effect), version: execution.version };
    }

    _commitEffect(command, index) {
        const found = this._effect(command);
        if (found.ok === false) return found;
        const { execution, effect } = found;
        if (effect.status === EFFECT_STATUS.EFFECT_COMMITTED) {
            return { ok: true, mutated: false, duplicate: true, effect: clone(effect) };
        }
        if (effect.status !== EFFECT_STATUS.RESULT_RECORDED || effect.result === null) {
            return fail('EFFECT_RESULT_REQUIRED', { effectId: effect.effectId, status: effect.status });
        }
        effect.status = EFFECT_STATUS.EFFECT_COMMITTED;
        this._mutated(execution, {
            type: 'EFFECT_COMMITTED', index, step: execution.step, effectId: effect.effectId,
        });
        return { ok: true, mutated: true, effect: clone(effect), version: execution.version };
    }

    _detectSemanticConflict(command, index) {
        const execution = this._execution(command);
        if (execution.ok === false) return execution;
        if (!command.availableSnapshot || requireText(command.availableSnapshot.id, 'availableSnapshot.id')) {
            return fail('INVALID_AGENT_COMMAND', { message: 'availableSnapshot with an id is required' });
        }
        if (command.availableSnapshot.id === execution.snapshot.id) {
            return { ok: true, mutated: false, duplicate: true, conflict: null };
        }
        const conflict = {
            fromSnapshotId: execution.snapshot.id,
            availableSnapshot: clone(command.availableSnapshot),
            decision: command.decision || 'require-approval',
            changed: clone(command.changed || []),
            detectedAtIndex: index,
        };
        if (same(execution.semanticConflict, conflict)) {
            return { ok: true, mutated: false, duplicate: true, conflict: clone(conflict) };
        }
        execution.semanticConflict = conflict;
        execution.status = EXECUTION_STATUS.PAUSED_SEMANTIC_CONFLICT;
        this._mutated(execution, {
            type: 'SEMANTIC_CONFLICT_DETECTED', index, step: execution.step,
            fromSnapshotId: conflict.fromSnapshotId,
            availableSnapshotId: conflict.availableSnapshot.id,
            decision: conflict.decision,
            changed: conflict.changed,
        });
        return { ok: true, mutated: true, conflict: clone(conflict), version: execution.version };
    }

    _transitionSnapshot(command, index) {
        const execution = this._execution(command);
        if (execution.ok === false) return execution;
        if (command.fromSnapshotId !== execution.snapshot.id) {
        if (!execution.semanticConflict
            || execution.status !== EXECUTION_STATUS.PAUSED_SEMANTIC_CONFLICT) {
            return fail('SEMANTIC_CONFLICT_REQUIRED', { executionId: execution.executionId });
        }
            return fail('STALE_SEMANTIC_SNAPSHOT', {
                expectedSnapshotId: command.fromSnapshotId,
                actualSnapshotId: execution.snapshot.id,
            });
        }
        if (!command.toSnapshot || requireText(command.toSnapshot.id, 'toSnapshot.id')) {
            return fail('INVALID_AGENT_COMMAND', { message: 'toSnapshot with an id is required' });
        }
        if (!command.approval || command.approval.approved !== true
            || requireText(command.approval.approvedBy, 'approval.approvedBy')) {
        if (command.toSnapshot.id !== execution.semanticConflict.availableSnapshot.id) {
            return fail('SEMANTIC_TRANSITION_MISMATCH', {
                expectedSnapshotId: execution.semanticConflict.availableSnapshot.id,
                actualSnapshotId: command.toSnapshot.id,
            });
        }
            return fail('SEMANTIC_APPROVAL_REQUIRED', { executionId: execution.executionId });
        }
        const fromSnapshotId = execution.snapshot.id;
        execution.snapshot = clone(command.toSnapshot);
        execution.semanticConflict = null;
        execution.status = EXECUTION_STATUS.RUNNING;
        this._mutated(execution, {
            type: 'SNAPSHOT_TRANSITIONED', index, step: execution.step,
            fromSnapshotId,
            toSnapshotId: command.toSnapshot.id,
            approval: clone(command.approval),
        });
        return {
            ok: true,
            mutated: true,
            snapshot: clone(execution.snapshot),
            version: execution.version,
        };
    }

    _complete(command, index) {
        const execution = this._execution(command);
        if (execution.ok === false) return execution;
        const stepError = this._checkStep(execution, command.expectedStep);
        if (stepError) return stepError;
        if (execution.status === EXECUTION_STATUS.COMPLETE) {
            return { ok: true, mutated: false, duplicate: true, execution: clone(execution) };
        }
        if (execution.status !== EXECUTION_STATUS.RUNNING) {
            return fail('EXECUTION_NOT_RUNNING', { status: execution.status });
        }
        const unfinished = execution.effects.filter(
            (effect) => effect.status !== EFFECT_STATUS.EFFECT_COMMITTED,
        ).map((effect) => effect.effectId);
        if (unfinished.length > 0) return fail('UNFINISHED_EFFECTS', { effectIds: unfinished });

        execution.status = EXECUTION_STATUS.COMPLETE;
        this._mutated(execution, {
            type: 'EXECUTION_COMPLETED', index, step: execution.step,
        });
        return { ok: true, mutated: true, execution: clone(execution) };
    }
}

module.exports = { AgentState, EFFECT_STATUS, EXECUTION_STATUS, stable };
