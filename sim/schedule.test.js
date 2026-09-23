'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { SimCluster } = require('./cluster');
const { materializeSchedule, runSchedule } = require('./schedule');
const { ScheduleShrinker } = require('./shrinker');
const { explainFailure } = require('../packages/simulator/explain');
const { CoverageTracker } = require('../packages/simulator/coverage');

const { regressionTestSource } = require('./search');
test('schedule generation materializes every workload, fault, membership, and timing choice', () => {
    const first = materializeSchedule(91, { ops: 10, clients: 2, rounds: 5 });
    const again = materializeSchedule(91, { ops: 10, clients: 2, rounds: 5 });
    const different = materializeSchedule(92, { ops: 10, clients: 2, rounds: 5 });

    assert.deepEqual(first, again);
    assert.notDeepEqual(first.actions, different.actions);
    assert.ok(first.actions.every((action) => Number.isFinite(action.atMs)));
    assert.ok(first.decisions.generation.workload.length > 0);
    assert.ok(first.decisions.generation.fault.length > 0);
    assert.ok(first.decisions.generation.timing.length > 0);
});

test('coverage feedback steers the next generated schedule and remains concrete', () => {
    const tracker = new CoverageTracker({ targets: ['client:write', 'fault:crash'] });
    const first = materializeSchedule(3, {
        ops: 2, clients: 1, rounds: 2, coverageHint: tracker.nextHint(),
    });
    assert.equal(first.metadata.coverageHint, 'client:write');
    assert.ok(first.actions.some((action) => action.type === 'client' && action.op.kind === 'write'));

    tracker.observe({
        schedule: {
            actions: first.actions.filter((action) => action.type === 'client'),
        },
        trace: { events: [] },
        failure: null,
    });
    const second = materializeSchedule(4, {
        ops: 2, clients: 1, rounds: 2, coverageHint: tracker.nextHint(),
    });
    assert.equal(second.metadata.coverageHint, 'fault:crash');
    assert.ok(second.actions.some((action) => action.type === 'fault' && action.kind === 'crash'));

    tracker.observe({
        schedule: { actions: second.actions.filter((action) => action.type === 'fault') },
        trace: { events: [] },
        failure: null,
    });
    assert.deepEqual(tracker.targetCoverage(), { covered: 2, total: 2, ratio: 1 });
    assert.equal(tracker.nextHint(), null);
});

test('a recorded runtime decision tape replays without sampling new randomness', async () => {
    const schedule = materializeSchedule(17, {
        ops: 6,
        clients: 2,
        rounds: 3,
        spares: 0,
        membership: false,
        drop: 0.02,
        settleMs: 2000,
    });
    const first = await runSchedule(schedule, { recording: false });
    const runtime = first.schedule.decisions.runtime;
    const electionChoices = Object.entries(runtime)
        .filter(([name]) => name.startsWith('election.'))
        .flatMap(([, items]) => items)
        .filter((item) => item.label === 'election-timeout-ms');
    assert.ok(electionChoices.length > 0);
    assert.ok(electionChoices.every((item) => Number.isInteger(item.value)));
    assert.ok(runtime['network.request-drop'].every((item) => typeof item.value === 'boolean'));

    const replay = await runSchedule(first.schedule, { recording: false });

    assert.equal(replay.ok, first.ok);
    assert.deepEqual(replay.failure, first.failure);
    assert.deepEqual(replay.history, first.history);
    assert.deepEqual(replay.states, first.states);
    assert.deepEqual(replay.network, first.network);
    assert.ok(Object.values(replay.decisionDiagnostics).every((item) => item.exact));
});

test('the shrinker preserves the exact failure signature while deleting noise', async () => {
    const schedule = {
        schemaVersion: 1,
        kind: 'cloudproof.materialized-schedule',
        seed: 1,
        config: { nodes: 3, spares: 0, clients: 2, drop: 0.2 },
        decisions: { generation: {}, runtime: {} },
        actions: [
            { id: 'noise-a', atMs: 10, type: 'fault', kind: 'heal' },
            { id: 'trigger', atMs: 20, type: 'control', kind: 'trigger' },
            { id: 'noise-b', atMs: 30, type: 'client', client: 2, process: 1, op: { kind: 'write', key: 'large-key', value: 'large-value' } },
        ],
    };
    const run = async (candidate) => ({
        ok: !candidate.actions.some((action) => action.id === 'trigger'),
        failure: candidate.actions.some((action) => action.id === 'trigger')
            ? { kind: 'invariant', id: 'test', signature: 'invariant:test' }
            : null,
        schedule: candidate,
    });
    const shrinker = new ScheduleShrinker({ run, maxEvaluations: 100 });
    const shrunk = await shrinker.shrink(schedule);

    assert.equal(shrunk.target, 'invariant:test');
    assert.deepEqual(shrunk.schedule.actions.map((action) => action.id), ['trigger']);
    assert.ok(shrunk.stats.actionsAfter < shrunk.stats.actionsBefore);
    assert.deepEqual(
        shrunk.passes.map((pass) => pass.name),
        [
            'remove-contiguous-chunks',
            'remove-individual-actions',
            'reduce-client-count',
            'remove-irrelevant-writes',
            'shorten-partition-duration',
            'reduce-packet-loss',
            'partition-to-isolated-node',
            'reduce-membership-churn',
            'reduce-payloads-and-keys',
            'normalize-node-identities',
            'minimize-timing-gaps',
        ],
    );
});

test('causal explanation names the preserved predicate and relevant prior events', () => {
    const result = {
        failure: {
            kind: 'invariant',
            id: 'state-machine-safety',

            signature: 'invariant:state-machine-safety',
            reason: 'committed entry differs',
        },
        trace: {
            events: [
                { id: '1', sequence: 1, type: 'fault.applied', time: { elapsedMs: 10 }, data: { fault: 'partition' } },
                { id: '2', sequence: 2, type: 'rpc.blocked', time: { elapsedMs: 20 }, data: { rpcId: 'rpc-7', from: 'n1', to: 'n2', reason: 'partition' } },
                { id: '3', sequence: 3, type: 'invariant.checked', time: { elapsedMs: 30 }, data: { id: 'state-machine-safety', status: 'fail' } },
            ],
        },
    };
    const explanation = explainFailure(result);

    assert.match(explanation.summary, /state-machine-safety/);
    assert.equal(explanation.failure.signature, 'invariant:state-machine-safety');
    assert.ok(explanation.causalChain.some((item) => item.statement.includes('rpc-7')));
    assert.match(explanation.regression.assertion, /invariant:state-machine-safety/);
});

test('failure artifacts carry a runnable regression test', () => {
    const source = regressionTestSource({
        artifactName: 'seed-7.json',
        scheduleModule: '../../sim/schedule',
        signature: 'history:non-linearizable',
    });

    assert.doesNotThrow(() => new Function(source));
    assert.match(source, /seed-7\.json/);
    assert.match(source, /history:non-linearizable/);
});

test('an isolated follower cannot inflate its term through failed PreVotes', async () => {
    const cluster = new SimCluster({ size: 3, seed: 33, dropRate: 0 });
    const leader = await cluster.awaitLeader(4000);
    assert.ok(leader);
    const followerIndex = cluster.urls.findIndex((url) => url !== leader.url);
    const follower = cluster.nodes.get(cluster.urls[followerIndex]);
    const term = follower.currentTerm;

    cluster.isolate(followerIndex);
    await cluster.tick(2500);

    assert.equal(follower.currentTerm, term);
    assert.ok(follower.metrics.preVotesTotal > 0);
    cluster.stop();
});

test('quorum-aware serving fences an isolated leader without claiming CheckQuorum demotion', async () => {
    const cluster = new SimCluster({ size: 3, seed: 44, dropRate: 0 });
    const elected = await cluster.awaitLeader(4000);
    assert.ok(elected);
    const isolatedLeader = elected.node;
    const leaderIndex = cluster.urls.indexOf(elected.url);

    cluster.isolate(leaderIndex);
    await cluster.tick(isolatedLeader.electionTimeoutMax * 4);

    assert.equal(isolatedLeader.isLeader(), true, 'role is retained until a higher term is observed');
    assert.equal(isolatedLeader.isReady(), false, 'readiness is fenced after quorum contact expires');
    assert.throws(
        () => isolatedLeader.read((stateMachine) => stateMachine.get('x')),
        /Stale leader lease/,
    );
    cluster.stop();
});
