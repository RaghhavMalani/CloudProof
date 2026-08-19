'use strict';

const { SimCluster } = require('./cluster');
const { DecisionStreams } = require('./decision-tape');
const { LinearizabilityChecker, HistoryRecorder, registerModel } = require('./linearizability');

const SCHEDULE_SCHEMA_VERSION = 1;
const DEFAULTS = Object.freeze({
    ops: 40,
    clients: 4,
    nodes: 3,
    spares: 2,
    drop: 0.05,
    membership: true,
    rounds: 14,
    settleMs: 9000,
});

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function materializeSchedule(seed, options = {}) {
    const config = { ...DEFAULTS, ...options };
    const decisions = new DecisionStreams({ seed });
    const workloadRng = decisions.stream('workload');
    const faultRng = decisions.stream('fault');
    const membershipRng = decisions.stream('membership');
    const timingRng = decisions.stream('timing');
    const keys = ['x', 'y', 'z'];
    const actions = [];
    const activeMembers = new Set(Array.from({ length: config.nodes }, (_, index) => index));
    let atMs = 0;
    let issued = 0;
    let crashed = null;
    let sequence = 0;

    const add = (action) => actions.push({ id: 'action-' + (++sequence), atMs, ...action });

    for (let round = 0; round < config.rounds && issued < config.ops; round += 1) {
        for (let client = 1; client <= config.clients && issued < config.ops; client += 1) {
            issued += 1;
            const key = workloadRng.pick(keys, 'client-key', { round, client, issued });
            const roll = workloadRng.float('client-operation', { round, client, issued });
            const op = roll < 0.45
                ? { kind: 'write', key, value: 'v' + issued }
                : roll < 0.8
                    ? { kind: 'read', key }
                    : { kind: 'cas', key, expected: null, value: 'c' + issued };
            add({ type: 'client', client, process: issued, op });
        }

        atMs += timingRng.range(120, 400, 'before-fault-gap', { round });
        const roll = faultRng.float('fault-kind', { round });
        if (crashed !== null && roll < 0.4) {
            add({ type: 'fault', kind: 'restart', node: crashed });
            crashed = null;
        } else if (roll < 0.25) {
            add({
                type: 'fault',
                kind: 'isolate',
                node: faultRng.int(config.nodes, 'isolate-node', { round }),
            });
        } else if (roll < 0.45) {
            add({ type: 'fault', kind: 'heal' });
        } else if (config.membership && roll < 0.52) {
            const spare = Array.from(
                { length: config.spares },
                (_, index) => config.nodes + index,
            ).find((index) => !activeMembers.has(index));
            if (spare !== undefined && membershipRng.chance(0.6, 'prefer-add', { round })) {
                activeMembers.add(spare);
                add({ type: 'membership', kind: 'add', node: spare });
            } else if (activeMembers.size > 2) {
                const removable = [...activeMembers].filter((index) => index !== 0);
                const victim = membershipRng.pick(removable, 'remove-node', { round });
                activeMembers.delete(victim);
                add({ type: 'membership', kind: 'remove', node: victim });
            }
        } else if (roll < 0.6 && crashed === null) {
            crashed = faultRng.int(config.nodes, 'crash-node', { round });
            add({ type: 'fault', kind: 'crash', node: crashed });
        }
        atMs += timingRng.range(200, 600, 'after-fault-gap', { round });
    }

    // Coverage feedback is itself materialized. Replay never consults the
    // tracker; it sees only the concrete action selected here.
    if (config.coverageHint) {
        const [type, kind] = config.coverageHint.split(':');
        if (type === 'client') {
            const action = actions.find((candidate) => candidate.type === 'client');
            if (action) {
                if (kind === 'read') action.op = { kind, key: action.op.key };
                else if (kind === 'cas') action.op = {
                    kind, key: action.op.key, expected: null, value: action.op.value || 'c1',
                };
                else action.op = { kind: 'write', key: action.op.key, value: action.op.value || 'v1' };
            }
        } else if (type === 'fault') {
            const action = actions.find((candidate) => candidate.type === 'fault');
            if (action) {
                action.kind = kind;
                action.node = Number.isInteger(action.node) ? action.node : 0;
                delete action.groups;
            } else {
                add({ type: 'fault', kind, node: 0 });
            }
        } else if (type === 'membership') {
            const action = actions.find((candidate) => candidate.type === 'membership');
            const node = kind === 'add' ? config.nodes : Math.max(1, config.nodes - 1);
            if (action) Object.assign(action, { kind, node });
            else add({ type: 'membership', kind, node });
        } else if (config.coverageHint === 'invariant:quorum-availability:watch') {
            add({ type: 'fault', kind: 'crash', node: Math.min(1, config.nodes - 1) });
            add({ type: 'fault', kind: 'crash', node: Math.min(2, config.nodes - 1) });
    }
    }

    add({ type: 'control', kind: 'recover-all' });
    return {
        schemaVersion: SCHEDULE_SCHEMA_VERSION,
        kind: 'miniraft.materialized-schedule',
        seed,
        config,
        actions,
        decisions: { generation: decisions.export(), runtime: null },
        metadata: { generatedOperations: issued, generatedAtMs: atMs, coverageHint: config.coverageHint || null },
    };
}

function validateSchedule(schedule) {
    if (!schedule || schedule.schemaVersion !== SCHEDULE_SCHEMA_VERSION) {
        throw new TypeError('unsupported or missing schedule schemaVersion');
    }
    if (!Number.isInteger(schedule.seed)) throw new TypeError('schedule seed must be an integer');
    if (!Array.isArray(schedule.actions)) throw new TypeError('schedule actions must be an array');
    let previous = -Infinity;
    for (const action of schedule.actions) {
        if (!Number.isFinite(action.atMs) || action.atMs < previous) {
            throw new TypeError('schedule actions must have nondecreasing finite atMs values');
        }
        previous = action.atMs;
    }
    return true;
}

function rolloutVersionInvariant(cluster) {
    const source = cluster.leader?.node || [...cluster.nodes.values()][0];
    const voters = new Set(source ? source.members : []);
    const nodes = [...cluster.nodes.entries()]
        .filter(([url]) => voters.has(url))
        .map(([, node]) => node);
    if (nodes.length < 2) return { ok: true, versions: {} };
    const sameFrontier = nodes.every((node) => node.commitIndex === nodes[0].commitIndex);
    const versions = Object.fromEntries(nodes.map((node) => {
        const record = node.stateMachine.get('model/current');
        return [node.replicaId, record ? record.value : null];
    }));
    return {
        ok: !sameFrontier || new Set(Object.values(versions).map(JSON.stringify)).size <= 1,
        comparable: sameFrontier,
        versions,
        reason: sameFrontier ? 'replicas at one commit frontier expose different rollout versions' : undefined,
    };
}

function classifyFailure({ phase = null, reason = null, linear, logs, prefix, overlap, rollout }) {
    if (phase) return { kind: 'runner', id: phase, signature: 'runner:' + phase, reason };
    if (linear && !linear.linearizable && !linear.exhausted) {
        return {
            kind: 'history',
            id: 'linearizability',
            signature: 'history:non-linearizable',
            reason: linear.reason,
        };
    }
    if (logs && !logs.ok) return { kind: 'invariant', id: 'log-matching', signature: 'invariant:log-matching', reason: logs.reason };
    if (prefix && !prefix.ok) return { kind: 'invariant', id: 'state-machine-safety', signature: 'invariant:state-machine-safety', reason: prefix.reason };
    if (overlap && !overlap.ok) return { kind: 'invariant', id: 'configuration-overlap', signature: 'invariant:configuration-overlap', reason: overlap.reason };
    if (rollout && !rollout.ok) return { kind: 'rollout', id: 'version-skew', signature: 'rollout:version-skew', reason: rollout.reason };
    return null;
}

async function runSchedule(input, options = {}) {
    validateSchedule(input);
    const schedule = clone(input);
    const config = { ...DEFAULTS, ...schedule.config };
    const runtimeTape = schedule.decisions && schedule.decisions.runtime;
    const cluster = new SimCluster({
        size: config.nodes + config.spares,
        voters: config.nodes,
        seed: schedule.seed,
        dropRate: config.drop,
        minLatency: config.minLatency || 1,
        maxLatency: config.maxLatency || 20,
        recording: options.recording !== false,
        decisionTrace: runtimeTape || null,
    });
    for (let index = config.nodes; index < config.nodes + config.spares; index += 1) {
        cluster.crash(index);
    }

    const history = new HistoryRecorder(cluster.clock);
    const checker = new LinearizabilityChecker(registerModel, { maxSteps: 400000 });
    const inFlight = new Map();
    const membershipWork = [];
    let bootstrapFailure = null;

    const leader = await cluster.awaitLeader(8000);
    if (!leader) bootstrapFailure = 'no leader was elected during bootstrap';
    const origin = cluster.clock.now();

    const complete = (process, type, value) => {
        if (!inFlight.has(process)) return;
        if (type === 'ok') history.ok(process, value);
        else if (type === 'info') history.info(process);
        else history.fail(process);
        inFlight.delete(process);
    };

    const issueClient = (action) => {
        const process = action.process;
        const op = clone(action.op);
        history.invoke(process, op);
        inFlight.set(process, op);
        const current = cluster.leader;
        if (!current) { complete(process, 'fail'); return; }
        if (op.kind === 'read') {
            current.node.readLinearizable((sm) => sm.get(op.key)).then((record) => {
                complete(process, 'ok', record ? record.value : null);
            }).catch(() => complete(process, 'fail'));
            return;
        }
        const command = op.kind === 'cas'
            ? { op: 'cas', key: op.key, expectRev: 0, value: op.value }
            : { op: 'set', key: op.key, value: op.value };
        current.node.clientAppend(command).then((outcome) => {
            if (!outcome.committed) complete(process, 'info');
            else if (op.kind === 'cas') complete(process, 'ok', Boolean(outcome.result && outcome.result.ok));
            else complete(process, 'ok', true);
        }).catch(() => complete(process, 'fail'));
    };

    const execute = (action) => {
        if (action.type === 'client') { issueClient(action); return; }
        if (action.type === 'fault') {
            if (action.kind === 'isolate') cluster.isolate(action.node);
            else if (action.kind === 'partition') cluster.partition(action.groups);
            else if (action.kind === 'heal') cluster.heal();
            else if (action.kind === 'crash' && cluster.nodes.has(cluster.urls[action.node])) cluster.crash(action.node);
            else if (action.kind === 'restart' && !cluster.nodes.has(cluster.urls[action.node])) cluster.restart(action.node);
            else if (action.kind === 'packet-loss') cluster.network.dropRate = action.rate;
            return;
        }
        if (action.type === 'membership') {
            const work = action.kind === 'add'
                ? cluster.addMember(action.node, { catchUpTimeoutMs: 2500 })
                : cluster.removeMember(action.node);
            membershipWork.push(Promise.resolve(work).catch(() => null));
            return;
        }
        if (action.type === 'control' && action.kind === 'recover-all') {
            cluster.heal();
            cluster.network.dropRate = config.drop;
            for (let index = 0; index < config.nodes + config.spares; index += 1) {
                if (!cluster.nodes.has(cluster.urls[index])) cluster.restart(index);
            }
        }
    };

    if (!bootstrapFailure) {
        for (const action of schedule.actions) {
            const target = origin + action.atMs;
            if (cluster.clock.now() < target) await cluster.tick(target - cluster.clock.now());
            execute(action);
            cluster.recorder?.record('scenario.action', {
                source: { component: 'schedule-runner' },
                subject: { kind: 'schedule-action', id: action.id },
                data: action,
            });
            cluster.recorder?.captureCluster(cluster);
        }
        await cluster.tick(config.settleMs);
        await Promise.allSettled(membershipWork);
        await cluster.tick(1000);
    }

    for (const process of [...inFlight.keys()]) complete(process, 'info');
    const linear = checker.check(history.events);
    const logs = cluster.checkLogConsistency();
    const prefix = cluster.checkCommittedPrefix();
    const overlap = cluster.checkConfigurationOverlap();
    const rollout = rolloutVersionInvariant(cluster);
    const failure = classifyFailure({
        phase: bootstrapFailure ? 'bootstrap' : null,
        reason: bootstrapFailure,
        linear,
        logs,
        prefix,
        overlap,
        rollout,
    });
    const states = cluster.states();
    cluster.recorder?.finish({ failure, actions: schedule.actions.length });
    const trace = cluster.recorder ? cluster.recorder.export() : null;
    const runtime = cluster.exportDecisionTrace();
    const decisionDiagnostics = cluster.decisionDiagnostics();
    const network = { ...cluster.network.stats };
    const virtualMs = cluster.clock.now() - origin;
    cluster.stop();

    schedule.decisions = { ...(schedule.decisions || {}), runtime };
    return {
        ok: failure === null,
        failure,
        schedule,
        trace,
        history: history.events,
        linear,
        logs,
        prefix,
        overlap,
        rollout,
        states,
        network,
        virtualMs,
        operations: history.summary(),
        decisionDiagnostics,
    };
}

module.exports = {
    SCHEDULE_SCHEMA_VERSION,
    DEFAULTS,
    materializeSchedule,
    validateSchedule,
    runSchedule,
    classifyFailure,
    rolloutVersionInvariant,
};
