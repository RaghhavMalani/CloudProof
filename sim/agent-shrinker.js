'use strict';

const { sameFailure } = require('../packages/simulator/agent-invariants');
const { AGENT_ACTION, AGENT_FAULT, clone, reindexActions, validateAgentSchedule } = require('./agent-actions');
const { runAgentSchedule } = require('./agent-runtime-sim');
const { getAgentWorkflow } = require('./agent-workflows');

class AgentScheduleShrinker {
    constructor({ run = runAgentSchedule, mutant = 'correct', maxEvaluations = 500, onProgress = null } = {}) {
        this.run = run;
        this.mutant = mutant;
        this.maxEvaluations = maxEvaluations;
        this.onProgress = onProgress;
        this.evaluations = 0;
        this.accepted = 0;
        this.passes = [];
        this.target = null;
        this.result = null;
    }

    _normalize(schedule) {
        const candidate = clone(schedule);
        candidate.actions = reindexActions(candidate.actions);
        candidate.decisions = { generation: candidate.decisions?.generation || {} };
        validateAgentSchedule(candidate);
        return candidate;
    }

    async _try(input, pass) {
        if (this.evaluations >= this.maxEvaluations) return null;
        const candidate = this._normalize(input);
        this.evaluations += 1;
        const result = await this.run(candidate, { mutant: this.mutant });
        if (!sameFailure(this.target, result)) return null;
        this.result = result;
        this.accepted += 1;
        if (this.onProgress) this.onProgress({
            pass,
            evaluations: this.evaluations,
            actions: candidate.actions.length,
            events: result.trace.events.length,
        });
        return candidate;
    }

    async _pass(name, schedule, work) {
        const before = schedule.actions.length;
        const next = await work(schedule);
        this.passes.push({ name, before, after: next.actions.length });
        return next;
    }

    async _removeChunks(schedule) {
        let current = schedule;
        let granularity = 2;
        while (current.actions.length >= 2 && this.evaluations < this.maxEvaluations) {
            const size = Math.ceil(current.actions.length / granularity);
            let reduced = false;
            for (let start = 0; start < current.actions.length; start += size) {
                const candidate = clone(current);
                candidate.actions.splice(start, size);
                const accepted = await this._try(candidate, 'remove-contiguous-chunks');
                if (!accepted) continue;
                current = accepted;
                granularity = Math.max(2, granularity - 1);
                reduced = true;
                break;
            }
            if (reduced) continue;
            if (granularity >= current.actions.length) break;
            granularity = Math.min(current.actions.length, granularity * 2);
        }
        return current;
    }

    async _removeIndividuals(schedule, predicate = () => true, pass = 'remove-individual-actions') {
        let current = schedule;
        for (let index = current.actions.length - 1; index >= 0; index -= 1) {
            if (!predicate(current.actions[index])) continue;
            const candidate = clone(current);
            candidate.actions.splice(index, 1);
            const accepted = await this._try(candidate, pass);
            if (accepted) current = accepted;
        }
        return current;
    }

    async _removePrefixes(schedule) {
        let current = schedule;
        for (let count = Math.floor(current.actions.length / 2); count >= 1; count -= 1) {
            const candidate = clone(current);
            candidate.actions.splice(0, count);
            const accepted = await this._try(candidate, 'remove-completed-workflow-prefix');
            if (accepted) current = accepted;
        }
        return current;
    }

    async _removeUnrelatedEffects(schedule) {
        const effectId = this.target.fingerprint.effectId;
        if (!effectId) return schedule;
        const workflow = getAgentWorkflow(schedule.workflow);
        const relevant = workflow.effects.find((effect) => effect.effectId === effectId)?.key;
        if (!relevant) return schedule;
        return this._removeIndividuals(
            schedule,
            (action) => action.effectKey && action.effectKey !== relevant,
            'remove-unrelated-effects',
        );
    }

    async _removeUnrelatedWorkers(schedule) {
        const workerId = this.target.fingerprint.workerId;
        return this._removeIndividuals(
            schedule,
            (action) => action.workerId && workerId && action.workerId !== workerId,
            'remove-unrelated-workers',
        );
    }

    async _removePolicyNoise(schedule) {
        if (this.target.violationClass === 'SEMANTIC_ISOLATION_VIOLATION') return schedule;
        return this._removeIndividuals(
            schedule,
            (action) => [AGENT_FAULT.DEPLOY_POLICY, AGENT_FAULT.CRASH_LEADER, AGENT_ACTION.APPROVE_SNAPSHOT]
                .includes(action.type),
            'remove-unnecessary-policy-deployments',
        );
    }

    async _collapseDelays(schedule) {
        return this._removeIndividuals(
            schedule,
            (action) => action.type === AGENT_FAULT.DELAY_TOOL_RESPONSE,
            'collapse-tool-delays',
        );
    }

    async _reduceRetries(schedule) {
        return this._removeIndividuals(
            schedule,
            (action) => action.type === AGENT_ACTION.DISPATCH_EFFECT,
            'reduce-effect-retries',
        );
    }

    async _removeRecoveryNoise(schedule) {
        return this._removeIndividuals(
            schedule,
            (action) => [
                AGENT_FAULT.CRASH_WORKER,
                AGENT_FAULT.CRASH_LEADER,
                AGENT_FAULT.LOSE_QUORUM,
                AGENT_FAULT.RESTORE_QUORUM,
            ].includes(action.type),
            'remove-redundant-recovery-faults',
        );
    }

    async shrink(input, originalResult = null) {
        const schedule = this._normalize(input);
        const initial = originalResult || await this.run(schedule, { mutant: this.mutant });
        if (!initial.failure) throw new Error('cannot shrink a passing agent schedule');
        this.target = initial.failure;
        this.result = initial;
        const beforeEvents = initial.trace.events.length;
        let current = schedule;

        current = await this._pass('remove-contiguous-chunks', current, (value) => this._removeChunks(value));
        current = await this._pass('remove-individual-actions', current,
            (value) => this._removeIndividuals(value));
        current = await this._pass('remove-completed-workflow-prefix', current,
            (value) => this._removePrefixes(value));
        current = await this._pass('remove-unrelated-effects', current,
            (value) => this._removeUnrelatedEffects(value));
        current = await this._pass('remove-unrelated-workers', current,
            (value) => this._removeUnrelatedWorkers(value));
        current = await this._pass('remove-unnecessary-policy-deployments', current,
            (value) => this._removePolicyNoise(value));
        current = await this._pass('collapse-tool-delays', current,
            (value) => this._collapseDelays(value));
        current = await this._pass('reduce-effect-retries', current,
            (value) => this._reduceRetries(value));
        current = await this._pass('remove-redundant-recovery-faults', current,
            (value) => this._removeRecoveryNoise(value));

        const finalResult = await this.run(current, { mutant: this.mutant });
        if (!sameFailure(this.target, finalResult)) throw new Error('agent shrinker lost the target failure');
        this.result = finalResult;
        return {
            target: clone(this.target.fingerprint),
            schedule: current,
            result: finalResult,
            passes: this.passes.slice(),
            stats: {
                actionsBefore: schedule.actions.length,
                actionsAfter: current.actions.length,
                eventsBefore: beforeEvents,
                eventsAfter: finalResult.trace.events.length,
                evaluations: this.evaluations,
                accepted: this.accepted,
                reductionPercent: schedule.actions.length === 0 ? 0
                    : Math.round((1 - current.actions.length / schedule.actions.length) * 100),
            },
        };
    }
}

module.exports = { AgentScheduleShrinker };
