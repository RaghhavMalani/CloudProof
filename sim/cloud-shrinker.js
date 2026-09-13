'use strict';

const { sameCloudFailure } = require('../packages/cloudproof/invariants');
const { clone, reindexCloudActions, validateCloudSchedule } = require('./cloud-actions');
const { runCloudSchedule } = require('./cloud-runtime');

class CloudScheduleShrinker {
    constructor({ run = runCloudSchedule, mutant = 'correct', maxEvaluations = 500 } = {}) {
        this.run = run;
        this.mutant = mutant;
        this.maxEvaluations = maxEvaluations;
        this.target = null;
        this.evaluations = 0;
        this.accepted = 0;
        this.passes = [];
    }

    _candidate(schedule, actions) {
        const candidate = { ...clone(schedule), actions: reindexCloudActions(actions) };
        validateCloudSchedule(candidate);
        return candidate;
    }

    async _preserves(schedule) {
        if (this.evaluations >= this.maxEvaluations) return null;
        this.evaluations += 1;
        const result = await this.run(schedule, { mutant: this.mutant });
        if (!sameCloudFailure(this.target, result)) return null;
        this.accepted += 1;
        return { schedule, result };
    }

    async _removeChunks(schedule) {
        let current = schedule;
        let granularity = 2;
        while (current.actions.length >= 2 && this.evaluations < this.maxEvaluations) {
            const size = Math.ceil(current.actions.length / granularity);
            let reduced = false;
            for (let start = 0; start < current.actions.length; start += size) {
                const actions = current.actions.slice(0, start).concat(current.actions.slice(start + size));
                const kept = await this._preserves(this._candidate(current, actions));
                if (!kept) continue;
                current = kept.schedule;
                reduced = true;
                granularity = Math.max(2, granularity - 1);
                break;
            }
            if (reduced) continue;
            if (granularity >= current.actions.length) break;
            granularity = Math.min(current.actions.length, granularity * 2);
        }
        return current;
    }

    async _removeIndividuals(schedule) {
        let current = schedule;
        let index = 0;
        while (index < current.actions.length && this.evaluations < this.maxEvaluations) {
            const actions = current.actions.filter((_, candidate) => candidate !== index);
            const kept = await this._preserves(this._candidate(current, actions));
            if (kept) current = kept.schedule;
            else index += 1;
        }
        return current;
    }

    async shrink(input, original = null) {
        const initialSchedule = clone(input.schedule || input);
        const initial = original || await this.run(initialSchedule, { mutant: this.mutant });
        if (!initial.failure) throw new Error('cannot shrink a passing cloud schedule');
        this.target = initial;
        let schedule = initialSchedule;
        let before = schedule.actions.length;
        schedule = await this._removeChunks(schedule);
        this.passes.push({ name: 'remove-contiguous-chunks', before, after: schedule.actions.length });
        before = schedule.actions.length;
        schedule = await this._removeIndividuals(schedule);
        this.passes.push({ name: 'remove-individual-actions', before, after: schedule.actions.length });
        const result = await this.run(schedule, { mutant: this.mutant });
        if (!sameCloudFailure(initial, result)) throw new Error('cloud shrink changed the exact failure fingerprint');
        return {
            target: clone(initial.failure.fingerprint),
            schedule,
            result,
            passes: clone(this.passes),
            stats: {
                actionsBefore: initialSchedule.actions.length,
                actionsAfter: schedule.actions.length,
                transitionsBefore: initial.graphTransitions.length,
                transitionsAfter: result.graphTransitions.length,
                evaluations: this.evaluations,
                accepted: this.accepted,
            },
        };
    }
}

module.exports = { CloudScheduleShrinker };
