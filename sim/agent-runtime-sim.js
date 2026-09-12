'use strict';

const { AgentState, EFFECT_STATUS } = require('../replica/agent-state');
const { digest } = require('../packages/agent-runtime');
const { evaluateAgentInvariants } = require('../packages/simulator/agent-invariants');
const { AGENT_ACTION, AGENT_FAULT, clone, validateAgentSchedule } = require('./agent-actions');
const { getMutant } = require('./agent-mutants');
const { getAgentWorkflow } = require('./agent-workflows');

function mapObject(map) {
    return Object.fromEntries([...map.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

class AgentRuntimeSimulation {
    constructor({ workflow = 'refund', mutant = 'correct' } = {}) {
        this.workflow = getAgentWorkflow(workflow);
        this.mutant = getMutant(mutant);
        this.agentState = new AgentState();
        this.index = 0;
        this.sequence = 0;
        this.currentAction = null;
        this.quorum = true;
        this.availableSnapshot = this.workflow.snapshot;
        this.authorizedSnapshots = new Set([this.workflow.snapshot.id]);
        this.workers = new Map([['worker-1', { workerId: 'worker-1', expectedStep: 0, generation: 1 }]]);
        this.providerKeys = new Set();
        this.providerResults = new Map();
        this.providerCalls = 0;
        this.observations = [];
        this.semanticMutations = [];
        this.staleAdvances = [];
        this.lostResults = [];
        this.recoveredAmbiguousEffects = new Set();
        this.recoveries = 0;
        this.pendingResponses = new Map();
        this.delayedResponses = new Set();
        this.dropNextResponse = false;
        this.delayNextResponse = false;
        this.volatileConflict = null;
        this.semanticCheckComplete = false;
        this.trace = [];

        this._apply({
            op: 'agent.execution.create',
            executionId: this.workflow.executionId,
            workflow: this.workflow.workflow,
            snapshot: this.workflow.snapshot,
            initialState: { orderId: 4821 },
        }, { force: true });
        this._record('agent.execution.created', {
            executionId: this.workflow.executionId,
            snapshotId: this.workflow.snapshot.id,
        });
    }

    execution() {
        return this.agentState.get(this.workflow.executionId);
    }

    effect(key = 'refund') {
        return this.workflow.effects.find((candidate) => candidate.key === key) || this.workflow.effects[0];
    }

    durableEffect(effectId) {
        return this.execution()?.effects.find((candidate) => candidate.effectId === effectId) || null;
    }

    _record(type, data = {}, status = 'ok') {
        const event = {
            sequence: ++this.sequence,
            type,
            status,
            actionId: this.currentAction?.id || null,
            atMs: this.currentAction?.atMs ?? 0,
            data: clone(data),
        };
        this.trace.push(event);
        return event;
    }

    _apply(command, { force = false } = {}) {
        if (!force && !this.quorum) {
            const rejected = { ok: false, mutated: false, error: 'NO_QUORUM' };
            this._record('raft.command.rejected', { op: command.op, error: rejected.error }, 'blocked');
            return rejected;
        }
        const result = this.agentState.apply(command, { index: ++this.index });
        this._record('raft.command.applied', {
            index: this.index,
            op: command.op,
            ok: result.ok,
            error: result.error || null,
            mutated: Boolean(result.mutated),
        }, result.ok ? 'committed' : 'rejected');
        return result;
    }

    _semanticAuthorized(snapshotId) {
        return snapshotId === this.availableSnapshot.id && this.authorizedSnapshots.has(snapshotId);
    }

    _ensureSemanticBoundary() {
        const execution = this.execution();
        if (!execution || execution.snapshot.id === this.availableSnapshot.id) return true;

        if (this.mutant.flags.volatileSemanticConflict) {
            if (this.volatileConflict) {
                this._record('agent.semantic-conflict.blocked', this.volatileConflict, 'blocked');
                return false;
            }
            if (this.semanticCheckComplete) return true;
            this.volatileConflict = {
                fromSnapshotId: execution.snapshot.id,
                availableSnapshotId: this.availableSnapshot.id,
            };
            this.semanticCheckComplete = true;
            this._record('agent.semantic-conflict.detected-volatile', this.volatileConflict, 'warning');
            return false;
        }

        if (!execution.semanticConflict) {
            const detected = this._apply({
                op: 'agent.semantic-conflict.detect',
                executionId: this.workflow.executionId,
                availableSnapshot: this.availableSnapshot,
                decision: 'require-approval',
                changed: ['policy'],
            });
            if (!detected.ok) return false;
        }
        this._record('agent.semantic-conflict.blocked', {
            fromSnapshotId: execution.snapshot.id,
            availableSnapshotId: this.availableSnapshot.id,
        }, 'blocked');
        return false;
    }

    _providerCall(effect, { intentCommitted, snapshotId, retry = false } = {}) {
        this.providerCalls += 1;
        let providerKey = effect.effectId;
        if (!intentCommitted) providerKey = `untracked:${this.providerCalls}`;
        if (retry && this.mutant.flags.blindRetry) providerKey = `${effect.effectId}:attempt:${this.providerCalls}`;

        const firstForKey = !this.providerKeys.has(providerKey);
        if (firstForKey) this.providerKeys.add(providerKey);
        const result = this.providerResults.get(effect.effectId) || clone(effect.result);
        this.providerResults.set(effect.effectId, result);
        this.pendingResponses.set(effect.effectId, clone(result));

        if (firstForKey) {
            const observation = {
                actionId: this.currentAction?.id || null,
                effectId: effect.effectId,
                logicalAction: effect.logicalAction,
                providerOperationId: `${effect.key}:operation:${this.observations.length + 1}`,
                providerKey,
                intentCommitted: Boolean(intentCommitted),
                snapshotId,
                snapshotAuthorized: this._semanticAuthorized(snapshotId),
            };
            this.observations.push(observation);
            this.semanticMutations.push({
                ...observation,
                availableSnapshotId: this.availableSnapshot.id,
                semanticAuthorized: this._semanticAuthorized(snapshotId),
            });
            this._record('tool.effect.observed', observation, 'observable');
        } else {
            this._record('tool.effect.idempotent-replay', {
                effectId: effect.effectId,
                providerKey,
            }, 'suppressed');
        }

        if (this.dropNextResponse) {
            this.dropNextResponse = false;
            this._dropResponse(effect.effectId);
        } else if (this.delayNextResponse) {
            this.delayNextResponse = false;
            this.delayedResponses.add(effect.effectId);
        }
        return result;
    }

    _dropResponse(effectId) {
        const existed = this.pendingResponses.delete(effectId);
        this.delayedResponses.delete(effectId);
        const durable = this.durableEffect(effectId);
        if (durable && ![EFFECT_STATUS.RESULT_RECORDED, EFFECT_STATUS.EFFECT_COMMITTED].includes(durable.status)) {
            this._apply({
                op: 'agent.effect.reconciliation-required',
                executionId: this.workflow.executionId,
                effectId,
            });
        }
        this._record('fault.tool.response.dropped', { effectId, responseWasPending: existed }, 'fault');
    }

    _authorize(action) {
        if (!this._ensureSemanticBoundary()) return;
        const effect = this.effect(action.effectKey);
        const execution = this.execution();
        const result = this._apply({
            op: 'agent.effect.intent',
            executionId: this.workflow.executionId,
            effectId: effect.effectId,
            logicalAction: effect.logicalAction,
            parameters: effect.parameters,
            snapshotId: execution.snapshot.id,
        });
        if (result.ok) this.authorizedSnapshots.add(execution.snapshot.id);
    }

    _dispatch(action) {
        const effect = this.effect(action.effectKey);
        const durable = this.durableEffect(effect.effectId);
        if (!durable) {
            if (this.mutant.flags.dispatchBeforeIntent) {
                this._providerCall(effect, {
                    intentCommitted: false,
                    snapshotId: this.execution().snapshot.id,
                });
            } else {
                this._record('agent.effect.dispatch-blocked', {
                    effectId: effect.effectId,
                    reason: 'intent-not-committed',
                }, 'blocked');
            }
            return;
        }
        if (!this._ensureSemanticBoundary()) return;
        if ([EFFECT_STATUS.RESULT_RECORDED, EFFECT_STATUS.EFFECT_COMMITTED].includes(durable.status)) {
            this._record('agent.effect.dispatch-suppressed', {
                effectId: effect.effectId,
                status: durable.status,
            }, 'suppressed');
            return;
        }
        const retry = durable.status === EFFECT_STATUS.RECONCILIATION_REQUIRED;
        if (retry && !this.mutant.flags.blindRetry) {
            this._record('agent.effect.dispatch-blocked', {
                effectId: effect.effectId,
                reason: 'reconciliation-required',
            }, 'blocked');
            return;
        }
        if (retry && this.mutant.flags.blindRetry
            && !this.recoveredAmbiguousEffects.has(effect.effectId)) {
            this._record('agent.effect.dispatch-blocked', {
                effectId: effect.effectId,
                reason: 'ambiguity-not-recovered',
            }, 'blocked');
            return;
        }
        const predecessorsCommitted = effect.predecessors.every((logicalAction) => {
            const predecessor = this.workflow.effects.find((candidate) => candidate.logicalAction === logicalAction);
            return this.durableEffect(predecessor.effectId)?.status === EFFECT_STATUS.EFFECT_COMMITTED;
        });
        if (!predecessorsCommitted) {
            this._record('agent.effect.dispatch-blocked', {
                effectId: effect.effectId,
                reason: 'causal-predecessor-uncommitted',
            }, 'blocked');
            return;
        }
        const dispatched = this._apply({
            op: 'agent.effect.dispatch',
            executionId: this.workflow.executionId,
            effectId: effect.effectId,
        });
        if (!dispatched.ok) return;
        this._providerCall(effect, {
            intentCommitted: true,
            snapshotId: durable.snapshotId,
            retry,
        });
    }

    _recordResult(action) {
        const effect = this.effect(action.effectKey);
        if (this.delayedResponses.has(effect.effectId)) {
            this.delayedResponses.delete(effect.effectId);
            this._record('tool.response.delay-expired', { effectId: effect.effectId }, 'delayed');
            return;
        }
        const result = this.pendingResponses.get(effect.effectId);
        if (!result) {
            this._record('agent.effect.result-blocked', { effectId: effect.effectId, reason: 'no-result' }, 'blocked');
            return;
        }
        const recorded = this._apply({
            op: 'agent.effect.result',
            executionId: this.workflow.executionId,
            effectId: effect.effectId,
            result,
        });
        if (recorded.ok) this.pendingResponses.delete(effect.effectId);
    }

    _reconcile(action) {
        const effect = this.effect(action.effectKey);
        const durable = this.durableEffect(effect.effectId);
        if (!durable) {
            this._record('agent.effect.reconcile-blocked', { effectId: effect.effectId, reason: 'no-intent' }, 'blocked');
            return;
        }
        if ([EFFECT_STATUS.RESULT_RECORDED, EFFECT_STATUS.EFFECT_COMMITTED].includes(durable.status)) {
            this._record('agent.effect.reconcile-suppressed', { effectId: effect.effectId, status: durable.status }, 'suppressed');
            return;
        }
        const result = this.providerResults.get(effect.effectId);
        if (!result) {
            this._record('agent.effect.reconciled-absent', { effectId: effect.effectId }, 'not-found');
            return;
        }
        this.pendingResponses.set(effect.effectId, clone(result));
        this._record('agent.effect.reconciled', { effectId: effect.effectId }, 'found');
    }

    _commitEffect(action) {
        const effect = this.effect(action.effectKey);
        this._apply({
            op: 'agent.effect.commit',
            executionId: this.workflow.executionId,
            effectId: effect.effectId,
        });
    }

    _advance(action) {
        if (!this._ensureSemanticBoundary()) return;
        const workerId = action.workerId || 'worker-1';
        const worker = this.workers.get(workerId);
        if (!worker) {
            this._record('agent.worker.advance-blocked', { workerId, reason: 'worker-not-running' }, 'blocked');
            return;
        }
        const execution = this.execution();
        const actualBefore = execution.step;
        const expectedBefore = worker.expectedStep;
        const submittedExpected = this.mutant.flags.noWorkerFence ? actualBefore : expectedBefore;
        const result = this._apply({
            op: 'agent.execution.advance',
            executionId: this.workflow.executionId,
            expectedStep: submittedExpected,
            label: action.label || `step-${actualBefore + 1}`,
            patch: { lastWorkerId: workerId },
        });
        if (!result.ok) return;
        if (expectedBefore !== actualBefore) {
            this.staleAdvances.push({
                actionId: action.id,
                workerId,
                expectedStep: expectedBefore,
                actualStep: actualBefore,
                acceptedStep: result.step,
            });
        }
        worker.expectedStep = result.step;
        this.semanticMutations.push({
            actionId: action.id,
            kind: 'execution-advance',
            workerId,
            snapshotId: execution.snapshot.id,
            availableSnapshotId: this.availableSnapshot.id,
            semanticAuthorized: this._semanticAuthorized(execution.snapshot.id),
        });
    }

    _approveSnapshot() {
        const execution = this.execution();
        if (this.mutant.flags.volatileSemanticConflict && this.volatileConflict) {
            const internal = this.agentState.executions.get(this.workflow.executionId);
            internal.snapshot = clone(this.availableSnapshot);
            internal.version += 1;
            internal.history.push({
                type: 'SNAPSHOT_TRANSITIONED',
                index: ++this.index,
                step: internal.step,
                fromSnapshotId: execution.snapshot.id,
                toSnapshotId: this.availableSnapshot.id,
                approval: { approved: true, approvedBy: 'search-harness' },
            });
            this.volatileConflict = null;
            this.authorizedSnapshots.add(this.availableSnapshot.id);
            this._record('agent.snapshot.transitioned-volatile', { toSnapshotId: this.availableSnapshot.id }, 'mutant');
            return;
        }
        if (!execution.semanticConflict) {
            this._record('agent.snapshot.approval-blocked', { reason: 'no-conflict' }, 'blocked');
            return;
        }
        const result = this._apply({
            op: 'agent.snapshot.transition',
            executionId: this.workflow.executionId,
            fromSnapshotId: execution.snapshot.id,
            toSnapshot: this.availableSnapshot,
            approval: { approved: true, approvedBy: 'search-harness' },
        });
        if (result.ok) this.authorizedSnapshots.add(this.availableSnapshot.id);
    }

    _crashWorker() {
        const execution = this.execution();
        if (this.mutant.flags.forgetResultOnResume) {
            const internal = this.agentState.executions.get(this.workflow.executionId);
            for (const effect of internal.effects) {
                if (effect.status !== EFFECT_STATUS.RESULT_RECORDED) continue;
                this.lostResults.push({
                    actionId: this.currentAction?.id || null,
                    effectId: effect.effectId,
                    recordedResult: clone(effect.result),
                    statusBeforeCrash: effect.status,
                });
                effect.result = null;
                effect.status = EFFECT_STATUS.RECONCILIATION_REQUIRED;
            }
        }
        for (const effect of this.execution().effects) {
            if (effect.status === EFFECT_STATUS.RECONCILIATION_REQUIRED) {
                this.recoveredAmbiguousEffects.add(effect.effectId);
            }
        }
        this.pendingResponses.clear();
        this.delayedResponses.clear();
        this.recoveries += 1;
        const prior = this.workers.get('worker-1');
        this.workers.set('worker-1', {
            workerId: 'worker-1',
            expectedStep: this.execution().step,
            generation: (prior?.generation || 0) + 1,
        });
        this._record('fault.worker.recovered', { step: execution.step, recoveries: this.recoveries }, 'fault');
    }

    _fault(action) {
        switch (action.type) {
            case AGENT_FAULT.CRASH_WORKER:
                this._crashWorker();
                break;
            case AGENT_FAULT.CRASH_LEADER:
                this.volatileConflict = null;
                this._record('fault.leader.failover', { durableIndex: this.index }, 'fault');
                break;
            case AGENT_FAULT.DROP_TOOL_RESPONSE: {
                const effect = this.effect(action.effectKey);
                if (this.pendingResponses.has(effect.effectId)) this._dropResponse(effect.effectId);
                else this.dropNextResponse = true;
                break;
            }
            case AGENT_FAULT.DELAY_TOOL_RESPONSE: {
                const effect = this.effect(action.effectKey);
                if (this.pendingResponses.has(effect.effectId)) this.delayedResponses.add(effect.effectId);
                else this.delayNextResponse = true;
                this._record('fault.tool.response.delayed', { effectId: effect.effectId }, 'fault');
                break;
            }
            case AGENT_FAULT.START_RACING_WORKER: {
                const execution = this.execution();
                this.workers.set('worker-2', { workerId: 'worker-2', expectedStep: execution.step, generation: 1 });
                this._record('fault.worker.racing', { workerId: 'worker-2', expectedStep: execution.step }, 'fault');
                break;
            }
            case AGENT_FAULT.DEPLOY_POLICY:
                this.availableSnapshot = this.workflow.nextSnapshot;
                this.semanticCheckComplete = false;
                this._record('fault.policy.deployed', {
                    fromSnapshotId: this.execution().snapshot.id,
                    toSnapshotId: this.availableSnapshot.id,
                }, 'fault');
                this._ensureSemanticBoundary();
                break;
            case AGENT_FAULT.LOSE_QUORUM:
                this.quorum = false;
                this._record('fault.quorum.lost', {}, 'fault');
                break;
            case AGENT_FAULT.RESTORE_QUORUM:
                this.quorum = true;
                this._record('fault.quorum.restored', {}, 'recovered');
                break;
            default:
                break;
        }
    }

    execute(action) {
        this.currentAction = action;
        this._record('schedule.action', action, 'scheduled');
        if (Object.values(AGENT_FAULT).includes(action.type)) {
            this._fault(action);
            this.currentAction = null;
            return;
        }
        switch (action.type) {
            case AGENT_ACTION.ADVANCE: this._advance(action); break;
            case AGENT_ACTION.AUTHORIZE_EFFECT: this._authorize(action); break;
            case AGENT_ACTION.DISPATCH_EFFECT: this._dispatch(action); break;
            case AGENT_ACTION.RECONCILE_EFFECT: this._reconcile(action); break;
            case AGENT_ACTION.RECORD_RESULT: this._recordResult(action); break;
            case AGENT_ACTION.COMMIT_EFFECT: this._commitEffect(action); break;
            case AGENT_ACTION.APPROVE_SNAPSHOT: this._approveSnapshot(); break;
            default: break;
        }
        this.currentAction = null;
    }

    invariantWorld() {
        return {
            executionId: this.workflow.executionId,
            observations: clone(this.observations),
            semanticMutations: clone(this.semanticMutations),
            staleAdvances: clone(this.staleAdvances),
            lostResults: clone(this.lostResults),
            recoveries: this.recoveries,
            workers: mapObject(this.workers),
        };
    }

    export() {
        return {
            agentState: this.agentState.snapshot(),
            availableSnapshot: clone(this.availableSnapshot),
            authorizedSnapshots: [...this.authorizedSnapshots].sort(),
            workers: mapObject(this.workers),
            providerResults: mapObject(this.providerResults),
            providerCalls: this.providerCalls,
            observations: clone(this.observations),
            recoveries: this.recoveries,
            quorum: this.quorum,
        };
    }
}

function runAgentSchedule(input, options = {}) {
    validateAgentSchedule(input);
    const schedule = clone(input);
    const simulation = new AgentRuntimeSimulation({
        workflow: schedule.workflow,
        mutant: options.mutant || schedule.runtime || 'correct',
    });
    for (const action of schedule.actions) simulation.execute(action);

    const specification = simulation.workflow;
    const evaluated = evaluateAgentInvariants(simulation.invariantWorld(), specification);
    const finalState = simulation.export();
    const trace = { schemaVersion: 1, kind: 'miniraft.agent-trace', events: clone(simulation.trace) };
    const replayFingerprint = digest({
        failure: evaluated.failure?.fingerprint || null,
        finalState,
        trace,
    });
    return {
        ok: evaluated.ok,
        failure: evaluated.failure,
        checks: evaluated.checks,
        schedule,
        trace,
        finalState,
        replayFingerprint,
        metrics: {
            actions: schedule.actions.length,
            events: trace.events.length,
            providerCalls: simulation.providerCalls,
            observableEffects: simulation.observations.length,
            recoveries: simulation.recoveries,
        },
        mutant: simulation.mutant.id,
    };
}

module.exports = { AgentRuntimeSimulation, runAgentSchedule };
