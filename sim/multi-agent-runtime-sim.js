'use strict';

const { applyResourceOperations, digest } = require('../packages/agent-runtime');
const { evaluateMultiAgentInvariants } = require('../packages/simulator/multi-agent-invariants');
const {
    MULTI_AGENT_ACTION,
    clone,
    validateMultiAgentSchedule,
} = require('./multi-agent-actions');
const { getMultiAgentMutant } = require('./multi-agent-mutants');
const {
    AGENT_IDS,
    INITIAL_RESOURCE,
    ORDER_RESOURCE_ID,
    decideAgent,
} = require('./multi-agent-scenario');

function mapObject(map) {
    return Object.fromEntries([...map.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

class MultiAgentRaceSimulation {
    constructor({ mutant = 'correct' } = {}) {
        this.mutant = getMultiAgentMutant(mutant);
        this.resources = new Map([[ORDER_RESOURCE_ID, clone(INITIAL_RESOURCE)]]);
        this.agents = new Map(AGENT_IDS.map((agentId) => [agentId, {
            agentId,
            observation: null,
            plan: null,
            commitOutcome: null,
        }]));
        this.appliedCommits = [];
        this.authorizations = [];
        this.conflicts = [];
        this.trace = [];
        this.sequence = 0;
        this.currentAction = null;
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

    _read(action) {
        const agent = this.agents.get(action.agentId);
        if (!agent) {
            this._record('multi-agent.read.rejected', { agentId: action.agentId, reason: 'unknown-agent' }, 'rejected');
            return;
        }
        agent.observation = clone(this.resources.get(ORDER_RESOURCE_ID));
        agent.plan = null;
        agent.commitOutcome = null;
        this._record('multi-agent.resource.read', {
            agentId: action.agentId,
            resourceId: ORDER_RESOURCE_ID,
            version: agent.observation.version,
            state: agent.observation.state,
        }, 'observed');
    }

    _decide(action) {
        const agent = this.agents.get(action.agentId);
        if (!agent?.observation) {
            this._record('multi-agent.decision.blocked', { agentId: action.agentId, reason: 'read-required' }, 'blocked');
            return;
        }
        agent.plan = decideAgent(action.agentId, agent.observation);
        if (!agent.plan) {
            agent.commitOutcome = 'LOCALLY_DECLINED';
            this._record('multi-agent.decision.declined', {
                agentId: action.agentId,
                resourceId: ORDER_RESOURCE_ID,
                observedVersion: agent.observation.version,
            }, 'safe-noop');
            return;
        }
        this._record('multi-agent.decision.recorded', {
            agentId: action.agentId,
            executionId: agent.plan.executionId,
            effectId: agent.plan.effectId,
            logicalAction: agent.plan.logicalAction,
            readSet: agent.plan.readSet,
            writeSet: agent.plan.writeSet,
        }, 'planned');
    }

    _authorization(plan, actualVersion, accepted) {
        const expectedVersion = plan.readSet[0].version;
        const authorization = {
            agentId: plan.executionId.split(':')[0],
            executionId: plan.executionId,
            effectId: plan.effectId,
            resourceId: plan.readSet[0].resourceId,
            expectedVersion,
            actualVersion,
            accepted,
        };
        this.authorizations.push(authorization);
        return authorization;
    }

    _applyPlan(agentId, plan, { stale = false, partial = false } = {}) {
        const resource = this.resources.get(ORDER_RESOURCE_ID);
        const actualVersionBefore = resource.version;
        let operations = plan.writeSet[0].operations;
        if (partial) operations = operations.filter((operation) => operation.field === 'financialOwners');
        resource.state = applyResourceOperations(resource.state, operations);
        resource.version += 1;
        resource.lastMutation = {
            agentId,
            effectId: plan.effectId,
            logicalAction: plan.logicalAction,
            partial,
        };
        this.appliedCommits.push({
            agentId,
            effectId: plan.effectId,
            observedVersion: plan.readSet[0].version,
            actualVersionBefore,
            resultingVersion: resource.version,
            amountCents: partial ? 0 : plan.amountCents,
            terminalStatus: partial ? null : plan.terminalStatus,
            owner: plan.owner,
            stale,
            partial,
        });
        this._record(partial ? 'multi-agent.resource.partial-write' : 'multi-agent.resource.committed', {
            agentId,
            resourceId: resource.resourceId,
            expectedVersion: plan.readSet[0].version,
            actualVersionBefore,
            resultingVersion: resource.version,
            logicalAction: plan.logicalAction,
            partial,
        }, partial ? 'mutant' : 'committed');
    }

    _conflict(agentId, plan, actualVersion) {
        const conflict = {
            error: 'RESOURCE_VERSION_CONFLICT',
            agentId,
            executionId: plan.executionId,
            resourceId: ORDER_RESOURCE_ID,
            expectedVersion: plan.readSet[0].version,
            actualVersion,
            decision: 'REVALIDATE',
        };
        this.conflicts.push(conflict);
        this._record('multi-agent.resource.version-conflict', conflict, 'blocked');
        return conflict;
    }

    _commit(action) {
        const agent = this.agents.get(action.agentId);
        if (!agent?.plan) {
            this._record('multi-agent.commit.blocked', {
                agentId: action.agentId,
                reason: agent?.commitOutcome === 'LOCALLY_DECLINED' ? 'locally-declined' : 'plan-required',
            }, 'blocked');
            return;
        }
        if (agent.commitOutcome) {
            this._record('multi-agent.commit.suppressed', {
                agentId: action.agentId, outcome: agent.commitOutcome,
            }, 'suppressed');
            return;
        }

        const resource = this.resources.get(ORDER_RESOURCE_ID);
        const expectedVersion = agent.plan.readSet[0].version;
        const actualVersion = resource.version;
        if (expectedVersion === actualVersion) {
            this._authorization(agent.plan, actualVersion, true);
            this._applyPlan(action.agentId, agent.plan);
            agent.commitOutcome = 'COMMITTED';
            return;
        }

        if (this.mutant.flags.authorizeStaleRead) {
            const authorization = this._authorization(agent.plan, actualVersion, true);
            this._record('multi-agent.effect.authorized-stale', authorization, 'mutant');
            this._conflict(action.agentId, agent.plan, actualVersion);
            agent.commitOutcome = 'AUTHORIZED_THEN_REVALIDATE';
            return;
        }
        if (this.mutant.flags.applyStaleAgent === action.agentId) {
            this._authorization(agent.plan, actualVersion, true);
            this._applyPlan(action.agentId, agent.plan, { stale: true });
            agent.commitOutcome = 'COMMITTED_STALE';
            return;
        }
        if (this.mutant.flags.partialOwnerBeforeFence === action.agentId) {
            this._authorization(agent.plan, actualVersion, false);
            this._applyPlan(action.agentId, agent.plan, { stale: true, partial: true });
            this._conflict(action.agentId, agent.plan, actualVersion);
            agent.commitOutcome = 'PARTIAL_WRITE_THEN_REVALIDATE';
            return;
        }

        this._authorization(agent.plan, actualVersion, false);
        this._conflict(action.agentId, agent.plan, actualVersion);
        agent.commitOutcome = 'REVALIDATE';
    }

    execute(action) {
        this.currentAction = action;
        this._record('multi-agent.schedule.action', action, 'scheduled');
        if (action.type === MULTI_AGENT_ACTION.READ) this._read(action);
        else if (action.type === MULTI_AGENT_ACTION.DECIDE) this._decide(action);
        else if (action.type === MULTI_AGENT_ACTION.COMMIT) this._commit(action);
        else this._record('multi-agent.scheduler.yield', { label: action.label || null }, 'yield');
        this.currentAction = null;
    }

    invariantWorld() {
        return {
            resourceId: ORDER_RESOURCE_ID,
            resources: mapObject(this.resources),
            appliedCommits: clone(this.appliedCommits),
            authorizations: clone(this.authorizations),
            conflicts: clone(this.conflicts),
        };
    }

    export() {
        return {
            resources: mapObject(this.resources),
            agents: mapObject(this.agents),
            appliedCommits: clone(this.appliedCommits),
            authorizations: clone(this.authorizations),
            conflicts: clone(this.conflicts),
        };
    }
}

function runMultiAgentSchedule(input, options = {}) {
    validateMultiAgentSchedule(input);
    const schedule = clone(input);
    const simulation = new MultiAgentRaceSimulation({
        mutant: options.mutant || schedule.runtime || 'correct',
    });
    for (const action of schedule.actions) simulation.execute(action);

    const evaluated = evaluateMultiAgentInvariants(simulation.invariantWorld());
    const finalState = simulation.export();
    const trace = {
        schemaVersion: 1,
        kind: 'miniraft.multi-agent-trace',
        events: clone(simulation.trace),
    };
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
        mutant: simulation.mutant.id,
        metrics: {
            actions: schedule.actions.length,
            events: trace.events.length,
            authorizations: simulation.authorizations.length,
            conflicts: simulation.conflicts.length,
            committedWrites: simulation.appliedCommits.length,
        },
    };
}

module.exports = { MultiAgentRaceSimulation, runMultiAgentSchedule };
