'use strict';

const TARGET_FEATURES = Object.freeze([
    'client:write',
    'client:read',
    'client:cas',
    'fault:isolate',
    'fault:heal',
    'fault:crash',
    'fault:restart',
    'membership:add',
    'membership:remove',
    'rpc:pre-vote',
    'rpc:vote',
    'rpc:append',
    'rpc:blocked:partition',
    'rpc:blocked:dropped',
    'role:leader',
    'invariant:quorum-availability:watch',
]);

class CoverageTracker {
    constructor({ targets = TARGET_FEATURES } = {}) {
        this.targets = [...targets];
        this.counts = new Map();
        this.runs = 0;
    }

    _hit(feature) {
        this.counts.set(feature, (this.counts.get(feature) || 0) + 1);
    }

    observe(result) {
        const before = new Set(this.counts.keys());
        this.runs += 1;
        for (const action of result.schedule?.actions || []) {
            if (action.type === 'client') this._hit('client:' + action.op.kind);
            else if (action.type === 'fault') this._hit('fault:' + action.kind);
            else if (action.type === 'membership') this._hit('membership:' + action.kind);
        }
        for (const event of result.trace?.events || []) {
            if (event.type === 'rpc.sent') this._hit('rpc:' + (event.data.kind || 'unknown'));
            if (event.type === 'rpc.blocked') this._hit('rpc:blocked:' + (event.data.reason || 'unknown'));
            if (event.type === 'node.role.changed') this._hit('role:' + String(event.data.to).toLowerCase());
            if (event.type === 'invariant.checked') {
                this._hit('invariant:' + event.data.id + ':' + event.data.status);
            }
        }
        if (result.failure) this._hit('failure:' + result.failure.signature);
        const added = [...this.counts.keys()].filter((feature) => !before.has(feature));
        return { added, total: this.counts.size, target: this.targetCoverage() };
    }

    nextHint() {
        return this.targets.find((feature) => !this.counts.has(feature)) || null;
    }

    targetCoverage() {
        const covered = this.targets.filter((feature) => this.counts.has(feature)).length;
        return { covered, total: this.targets.length, ratio: covered / Math.max(1, this.targets.length) };
    }

    export() {
        return {
            runs: this.runs,
            target: this.targetCoverage(),
            counts: Object.fromEntries([...this.counts].sort(([a], [b]) => a.localeCompare(b))),
            missing: this.targets.filter((feature) => !this.counts.has(feature)),
        };
    }
}

module.exports = { CoverageTracker, TARGET_FEATURES };
