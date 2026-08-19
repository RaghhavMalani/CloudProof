'use strict';

const { runSchedule, validateSchedule } = require('./schedule');

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function failureSignature(result) {
    return result && result.failure ? result.failure.signature : null;
}

class ScheduleShrinker {
    constructor({ run = runSchedule, maxEvaluations = 500, onProgress = null } = {}) {
        this.run = run;
        this.maxEvaluations = maxEvaluations;
        this.onProgress = onProgress;
        this.evaluations = 0;
        this.accepted = 0;
        this.passes = [];
        this.target = null;
        this.result = null;
    }

    async _try(candidate, pass) {
        if (this.evaluations >= this.maxEvaluations) return false;
        candidate.actions.sort((a, b) => a.atMs - b.atMs);
        validateSchedule(candidate);
        this.evaluations += 1;
        const result = await this.run(candidate, { recording: false });
        const accepted = failureSignature(result) === this.target;
        if (accepted) {
            this.result = result;
            this.accepted += 1;
            if (this.onProgress) this.onProgress({
                pass,
                evaluations: this.evaluations,
                actions: candidate.actions.length,
            });
        }
        return accepted;
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
                if (await this._try(candidate, 'remove-contiguous-chunks')) {
                    current = candidate;
                    granularity = Math.max(2, granularity - 1);
                    reduced = true;
                    break;
                }
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
            if (await this._try(candidate, pass)) current = candidate;
        }
        return current;
    }

    async _reduceClients(schedule) {
        let current = schedule;
        const clients = [...new Set(current.actions
            .filter((action) => action.type === 'client')
            .map((action) => action.client))].sort((a, b) => b - a);
        for (const client of clients) {
            const candidate = clone(current);
            candidate.actions = candidate.actions.filter(
                (action) => action.type !== 'client' || action.client !== client,
            );
            candidate.config.clients = Math.max(1, client - 1);
            if (await this._try(candidate, 'reduce-client-count')) current = candidate;
        }
        return current;
    }

    async _shortenPartitions(schedule) {
        let current = schedule;
        for (let index = 0; index < current.actions.length; index += 1) {
            const start = current.actions[index];
            if (start.type !== 'fault' || !['isolate', 'partition'].includes(start.kind)) continue;
            const healIndex = current.actions.findIndex(
                (action, candidateIndex) => candidateIndex > index
                    && action.type === 'fault' && action.kind === 'heal',
            );
            if (healIndex < 0) continue;
            let gap = current.actions[healIndex].atMs - start.atMs;
            while (gap > 1 && this.evaluations < this.maxEvaluations) {
                const candidate = clone(current);
                candidate.actions[healIndex].atMs = start.atMs + Math.floor(gap / 2);
                if (!(await this._try(candidate, 'shorten-partition-duration'))) break;
                current = candidate;
                gap = current.actions[healIndex].atMs - start.atMs;
            }
        }
        return current;
    }

    async _reducePacketLoss(schedule) {
        let current = schedule;
        const original = Number(current.config.drop || 0);
        const attempts = [0];
        for (let rate = original / 2; rate > 0.0001; rate /= 2) attempts.push(rate);
        for (const rate of attempts) {
            const candidate = clone(current);
            candidate.config.drop = rate;
            for (const action of candidate.actions) {
                if (action.type === 'fault' && action.kind === 'packet-loss') {
                    action.rate = Math.min(action.rate, rate);
                }
            }
            if (await this._try(candidate, 'reduce-packet-loss')) current = candidate;
        }
        return current;
    }

    async _simplifyPartitions(schedule) {
        let current = schedule;
        for (let index = 0; index < current.actions.length; index += 1) {
            const action = current.actions[index];
            if (action.type !== 'fault' || action.kind !== 'partition') continue;
            const groups = action.groups || [];
            const smallest = groups.filter((group) => group.length > 0)
                .sort((a, b) => a.length - b.length)[0];
            if (!smallest) continue;
            const candidate = clone(current);
            candidate.actions[index] = {
                ...candidate.actions[index],
                kind: 'isolate',
                node: smallest[0],
            };
            delete candidate.actions[index].groups;
            if (await this._try(candidate, 'partition-to-isolated-node')) current = candidate;
        }
        return current;
    }

    async _reducePayloadsAndKeys(schedule) {
        let current = schedule;
        const all = clone(current);
        for (const action of all.actions) {
            if (action.type !== 'client') continue;
            action.op.key = 'k';
            if (Object.hasOwn(action.op, 'value')) action.op.value = 'v';
        }
        if (await this._try(all, 'reduce-payloads-and-keys')) current = all;
        for (let index = 0; index < current.actions.length; index += 1) {
            if (current.actions[index].type !== 'client') continue;
            const candidate = clone(current);
            candidate.actions[index].op.key = 'k';
            if (Object.hasOwn(candidate.actions[index].op, 'value')) {
                candidate.actions[index].op.value = 'v';
            }
            if (await this._try(candidate, 'reduce-payloads-and-keys')) current = candidate;
        }
        return current;
    }

    async _normalizeNodes(schedule) {
        const current = schedule;
        const initial = [...new Set(current.actions
            .map((action) => action.node)
            .filter((node) => Number.isInteger(node) && node < current.config.nodes))].sort((a, b) => a - b);
        const spares = [...new Set(current.actions
            .map((action) => action.node)
            .filter((node) => Number.isInteger(node) && node >= current.config.nodes))].sort((a, b) => a - b);
        const mapping = new Map();
        initial.forEach((node, index) => mapping.set(node, index));
        spares.forEach((node, index) => mapping.set(node, current.config.nodes + index));
        if ([...mapping].every(([before, after]) => before === after)) return current;
        const candidate = clone(current);
        for (const action of candidate.actions) {
            if (mapping.has(action.node)) action.node = mapping.get(action.node);
            if (action.groups) action.groups = action.groups.map(
                (group) => group.map((node) => mapping.has(node) ? mapping.get(node) : node),
            );
        }
        return await this._try(candidate, 'normalize-node-identities') ? candidate : current;
    }

    async _minimizeTiming(schedule) {
        let current = schedule;
        for (let index = 0; index < current.actions.length; index += 1) {
            const previous = index === 0 ? 0 : current.actions[index - 1].atMs;
            let gap = current.actions[index].atMs - previous;
            while (gap > 0 && this.evaluations < this.maxEvaluations) {
                const candidate = clone(current);
                candidate.actions[index].atMs = previous + Math.floor(gap / 2);
                if (!(await this._try(candidate, 'minimize-timing-gaps'))) break;
                current = candidate;
                gap = current.actions[index].atMs - previous;
            }
        }
        return current;
    }

    async shrink(input, baseline = null) {
        validateSchedule(input);
        const initial = baseline || await this.run(input, { recording: false });
        this.target = failureSignature(initial);
        if (!this.target) throw new Error('schedule does not fail; there is no exact failure predicate to shrink');
        this.result = initial;
        let schedule = clone(initial.schedule || input);

        schedule = await this._pass('remove-contiguous-chunks', schedule, (value) => this._removeChunks(value));
        schedule = await this._pass('remove-individual-actions', schedule, (value) => this._removeIndividuals(value));
        schedule = await this._pass('reduce-client-count', schedule, (value) => this._reduceClients(value));
        schedule = await this._pass('remove-irrelevant-writes', schedule, (value) => this._removeIndividuals(
            value,
            (action) => action.type === 'client' && action.op.kind === 'write',
            'remove-irrelevant-writes',
        ));
        schedule = await this._pass('shorten-partition-duration', schedule, (value) => this._shortenPartitions(value));
        schedule = await this._pass('reduce-packet-loss', schedule, (value) => this._reducePacketLoss(value));
        schedule = await this._pass('partition-to-isolated-node', schedule, (value) => this._simplifyPartitions(value));
        schedule = await this._pass('reduce-membership-churn', schedule, (value) => this._removeIndividuals(
            value,
            (action) => action.type === 'membership',
            'reduce-membership-churn',
        ));
        schedule = await this._pass('reduce-payloads-and-keys', schedule, (value) => this._reducePayloadsAndKeys(value));
        schedule = await this._pass('normalize-node-identities', schedule, (value) => this._normalizeNodes(value));
        schedule = await this._pass('minimize-timing-gaps', schedule, (value) => this._minimizeTiming(value));

        return {
            schedule,
            result: this.result,
            target: this.target,
            stats: {
                evaluations: this.evaluations,
                accepted: this.accepted,
                actionsBefore: input.actions.length,
                actionsAfter: schedule.actions.length,
                exhausted: this.evaluations >= this.maxEvaluations,
            },
            passes: this.passes,
        };
    }
}

module.exports = { ScheduleShrinker, failureSignature };
