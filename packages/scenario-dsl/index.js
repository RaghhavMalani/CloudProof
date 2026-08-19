'use strict';

const { EVENT_TYPES } = require('../protocol/events');

class ScenarioSyntaxError extends Error {
    constructor(message, line = null) {
        super(line ? `line ${line}: ${message}` : message);
        this.name = 'ScenarioSyntaxError';
        this.line = line;
    }
}

function splitArguments(source, line) {
    if (!source.trim()) return [];
    const parts = [];
    let start = 0;
    let depth = 0;
    let quote = null;
    let escaped = false;
    for (let i = 0; i < source.length; i += 1) {
        const char = source[i];
        if (escaped) { escaped = false; continue; }
        if (char === '\\' && quote) { escaped = true; continue; }
        if (quote) {
            if (char === quote) quote = null;
            continue;
        }
        if (char === '"' || char === "'") { quote = char; continue; }
        if (char === '[' || char === '{' || char === '(') depth += 1;
        if (char === ']' || char === '}' || char === ')') depth -= 1;
        if (depth < 0) throw new ScenarioSyntaxError('unbalanced brackets', line);
        if (char === ',' && depth === 0) {
            parts.push(source.slice(start, i).trim());
            start = i + 1;
        }
    }
    if (quote || depth !== 0) throw new ScenarioSyntaxError('unterminated string or bracket', line);
    parts.push(source.slice(start).trim());
    return parts;
}

function parseValue(source, line) {
    const value = source.trim();
    if (!value) throw new ScenarioSyntaxError('empty argument', line);
    if (value.startsWith('[') && value.endsWith(']')) {
        return splitArguments(value.slice(1, -1), line).map((part) => parseValue(part, line));
    }
    if ((value.startsWith('"') && value.endsWith('"'))
        || (value.startsWith("'") && value.endsWith("'"))) {
        if (value[0] === '"') {
            try { return JSON.parse(value); } catch (_) { throw new ScenarioSyntaxError('invalid quoted string', line); }
        }
        return value.slice(1, -1).replace(/\\'/g, "'").replace(/\\\\/g, '\\');
    }
    if (/^-?(?:\d+\.?\d*|\.\d+)$/.test(value)) return Number(value);
    if (value === 'true') return true;
    if (value === 'false') return false;
    if (value === 'null') return null;
    if (/^[a-zA-Z_][a-zA-Z0-9_./:@-]*$/.test(value)) return value;
    throw new ScenarioSyntaxError(`cannot parse argument ${value}`, line);
}

function parseScenario(source) {
    if (typeof source !== 'string') throw new TypeError('scenario source must be a string');
    const actions = [];
    const lines = source.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
        const raw = lines[i];
        const stripped = raw.replace(/\s+#.*$/, '').trim();
        if (!stripped || stripped.startsWith('#')) continue;
        const match = stripped.match(/^(\d+(?:\.\d+)?)\s*(ms|s)\s+(.+)$/i);
        if (!match) throw new ScenarioSyntaxError('expected: <time>s command(arguments)', i + 1);
        const atMs = Number(match[1]) * (match[2].toLowerCase() === 's' ? 1000 : 1);
        const expression = match[3].replace(/^start\s+/i, '').trim();
        const command = expression.match(/^([a-z][a-z0-9-]*)\s*\((.*)\)$/i);
        if (!command) throw new ScenarioSyntaxError('expected command(arguments)', i + 1);
        const name = command[1].toLowerCase();
        const args = splitArguments(command[2], i + 1).map((arg) => parseValue(arg, i + 1));
        actions.push({ atMs, name, args, line: i + 1, source: raw.trim() });
    }
    actions.sort((a, b) => a.atMs - b.atMs || a.line - b.line);
    return actions;
}

function nodeIndex(value) {
    if (Number.isInteger(value) && value >= 0) return value;
    const match = String(value).match(/^node(\d+)$/i);
    if (!match) throw new Error(`expected a node reference, received ${value}`);
    return Number(match[1]);
}

function serializeValue(value) {
    if (Array.isArray(value)) return `[${value.map(serializeValue).join(',')}]`;
    if (typeof value === 'string' && /^[a-zA-Z_][a-zA-Z0-9_./:@-]*$/.test(value)) return value;
    return JSON.stringify(value);
}

function serializeScenario(actions) {
    return actions.map((action) => {
        const time = `${(action.atMs / 1000).toFixed(3).replace(/0+$/, '').replace(/\.$/, '')}s`;
        return `${time} ${action.name}(${action.args.map(serializeValue).join(', ')})`;
    }).join('\n');
}

function branchScenario(sourceOrActions, atMs, additions) {
    const original = typeof sourceOrActions === 'string' ? parseScenario(sourceOrActions) : sourceOrActions;
    const branch = typeof additions === 'string' ? parseScenario(additions) : additions;
    const prefix = original.filter((action) => action.atMs <= atMs);
    const shifted = branch.map((action) => ({ ...action, atMs: atMs + action.atMs }));
    return [...prefix, ...shifted].sort((a, b) => a.atMs - b.atMs || a.line - b.line);
}

class ScenarioRunner {
    constructor({ ClusterClass = null, clusterOptions = {}, recorderOptions = {} } = {}) {
        // Lazy to keep the parser usable in tooling that does not load Raft.
        this.ClusterClass = ClusterClass || require('../../sim/cluster').SimCluster;
        this.clusterOptions = clusterOptions;
        this.recorderOptions = recorderOptions;
        this.cluster = null;
        this.actions = [];
        this.results = [];
    }

    _makeCluster(actions) {
        const declaration = actions.find((action) => action.name === 'cluster');
        const size = declaration ? Number(declaration.args[0]) : (this.clusterOptions.size || 3);
        if (!Number.isInteger(size) || size < 1 || size > 9) throw new Error(`invalid cluster size: ${size}`);
        return new this.ClusterClass({
            ...this.clusterOptions,
            size,
            recording: true,
            recorderOptions: this.recorderOptions,
        });
    }

    async _waitFor(promise, timeoutMs = 5000) {
        let settled = false;
        let result;
        let error;
        promise.then((value) => { settled = true; result = value; }, (reason) => { settled = true; error = reason; });
        const deadline = this.cluster.clock.now() + timeoutMs;
        while (!settled && this.cluster.clock.now() < deadline) {
            if (!this.cluster.clock.advance()) break;
            await this.cluster.clock.drain();
            this.cluster.recorder?.captureCluster(this.cluster, { snapshot: false });
        }
        if (!settled) throw new Error(`scenario action timed out after ${timeoutMs}ms virtual time`);
        if (error) throw error;
        return result;
    }

    async _leader() {
        if (this.cluster.leader) return this.cluster.leader;
        const leader = await this.cluster.awaitLeader(5000);
        if (!leader) throw new Error('scenario needs a leader, but no election completed');
        return leader;
    }

    async execute(action) {
        const { name, args } = action;
        const record = (data = {}) => this.cluster.recorder?.record(EVENT_TYPES.SCENARIO_ACTION, {
            source: { component: 'scenario-runner' },
            subject: { kind: 'scenario-action', id: `${action.line}:${name}` },
            data: { command: name, args, scheduledAtMs: action.atMs, ...data },
        });

        if (name === 'cluster') { record({ outcome: 'already-started' }); return { ok: true }; }
        if (name === 'isolate') { this.cluster.isolate(nodeIndex(args[0])); record(); return { ok: true }; }
        if (name === 'crash') { this.cluster.crash(nodeIndex(args[0])); record(); return { ok: true }; }
        if (name === 'restart') { this.cluster.restart(nodeIndex(args[0])); record(); return { ok: true }; }
        if (name === 'heal' || name === 'heal-all') { this.cluster.heal(); record(); return { ok: true }; }
        if (name === 'partition') {
            const left = Array.isArray(args[0]) ? args[0] : [args[0]];
            const right = Array.isArray(args[1]) ? args[1] : [args[1]];
            this.cluster.partition([left.map(nodeIndex), right.map(nodeIndex)]);
            record(); return { ok: true };
        }
        if (name === 'latency') {
            const min = Number(args.length > 1 ? args[0] : 0);
            const max = Number(args.length > 1 ? args[1] : args[0]);
            if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max < min) throw new Error('latency requires min,max milliseconds');
            this.cluster.network.minLatency = min;
            this.cluster.network.maxLatency = max;
            record({ min, max }); return { ok: true };
        }
        if (name === 'packet-loss') {
            const rate = Number(args[0]);
            if (!Number.isFinite(rate) || rate < 0 || rate > 1) throw new Error('packet-loss requires a rate from 0 to 1');
            this.cluster.network.dropRate = rate;
            record({ rate }); return { ok: true };
        }
        if (name === 'write') {
            const leader = await this._leader();
            const outcome = await this._waitFor(leader.node.clientAppend({ op: 'set', key: String(args[0]), value: args[1] }));
            record({ outcome }); return outcome;
        }
        if (name === 'rollout') {
            const leader = await this._leader();
            const outcome = await this._waitFor(leader.node.clientAppend({ op: 'set', key: 'model/current', value: args[0] }));
            record({ outcome }); return outcome;
        }
        if (name === 'corrupt-artifact') {
            record({ outcome: 'injected-marker', artifact: args[0], shard: args[1] ?? null });
            return { ok: true, markerOnly: true };
        }
        throw new Error(`unsupported scenario command: ${name}`);
    }

    async run(sourceOrActions, { untilMs = Infinity } = {}) {
        this.actions = typeof sourceOrActions === 'string' ? parseScenario(sourceOrActions) : sourceOrActions;
        this.cluster = this._makeCluster(this.actions);
        const origin = this.cluster.clock.now();
        for (const action of this.actions) {
            if (action.atMs > untilMs) break;
            const target = origin + action.atMs;
            if (this.cluster.clock.now() < target) await this.cluster.tick(target - this.cluster.clock.now());
            try {
                const value = await this.execute(action);
                this.results.push({ action, ok: true, value });
            } catch (error) {
                this.cluster.recorder?.record(EVENT_TYPES.SCENARIO_ACTION, {
                    source: { component: 'scenario-runner' },
                    data: { command: action.name, args: action.args, error: error.message },
                });
                this.results.push({ action, ok: false, error: error.message });
                throw error;
            }
            this.cluster.recorder?.captureCluster(this.cluster);
        }
        this.cluster.recorder?.finish({ actions: this.results.length });
        return { cluster: this.cluster, results: this.results, trace: this.cluster.recorder?.export() };
    }
}

module.exports = {
    ScenarioSyntaxError,
    parseScenario,
    serializeScenario,
    branchScenario,
    ScenarioRunner,
};
