'use strict';

const { sameMultiAgentFailure } = require('../packages/simulator/multi-agent-invariants');
const { clone, reindexMultiAgentActions, validateMultiAgentSchedule } = require('./multi-agent-actions');
const { runMultiAgentSchedule } = require('./multi-agent-runtime-sim');

class MultiAgentScheduleShrinker {
    constructor({ mutant }) {
        this.mutant = mutant;
        this.target = null;
        this.attempts = 0;
        this.accepted = 0;
        this.passes = [];
    }

    _candidate(schedule, actions) {
        const candidate = { ...clone(schedule), actions: reindexMultiAgentActions(actions) };
        validateMultiAgentSchedule(candidate);
        return candidate;
    }

    _preserves(schedule) {
        this.attempts += 1;
        const result = runMultiAgentSchedule(schedule, { mutant: this.mutant });
        if (!sameMultiAgentFailure(this.target, result)) return null;
        this.accepted += 1;
        return { schedule, result };
    }

    _removeChunks(schedule) {
        let current = schedule;
        for (let size = Math.max(1, Math.floor(current.actions.length / 2)); size >= 1; size = Math.floor(size / 2)) {
            let changed = true;
            while (changed) {
                changed = false;
                for (let start = 0; start < current.actions.length; start += size) {
                    const actions = current.actions.slice(0, start)
                        .concat(current.actions.slice(start + size));
                    const kept = this._preserves(this._candidate(current, actions));
                    if (!kept) continue;
                    current = kept.schedule;
                    changed = true;
                    break;
                }
            }
            if (size === 1) break;
        }
        return current;
    }

    _removeIndividuals(schedule) {
        let current = schedule;
        let index = 0;
        while (index < current.actions.length) {
            const actions = current.actions.filter((_, candidateIndex) => candidateIndex !== index);
            const kept = this._preserves(this._candidate(current, actions));
            if (kept) current = kept.schedule;
            else index += 1;
        }
        return current;
    }

    shrink(input, initial = null) {
        const originalSchedule = clone(input.schedule || input);
        const original = initial || runMultiAgentSchedule(originalSchedule, { mutant: this.mutant });
        if (original.ok || !original.failure) {
            throw new Error('multi-agent schedule does not fail; there is no predicate to shrink');
        }
        this.target = original;
        let schedule = originalSchedule;

        let before = schedule.actions.length;
        schedule = this._removeChunks(schedule);
        this.passes.push({ name: 'remove-contiguous-chunks', before, after: schedule.actions.length });

        before = schedule.actions.length;
        schedule = this._removeIndividuals(schedule);
        this.passes.push({ name: 'remove-individual-actions', before, after: schedule.actions.length });

        const result = runMultiAgentSchedule(schedule, { mutant: this.mutant });
        if (!sameMultiAgentFailure(original, result)) {
            throw new Error('multi-agent shrink changed the exact failure fingerprint');
        }
        return {
            target: clone(original.failure.fingerprint),
            schedule,
            result,
            stats: {
                attempts: this.attempts,
                accepted: this.accepted,
                actionsBefore: originalSchedule.actions.length,
                actionsAfter: schedule.actions.length,
                passes: clone(this.passes),
            },
        };
    }
}

module.exports = { MultiAgentScheduleShrinker };
