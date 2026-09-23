'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { INCIDENT_CLASS, MESH_ACTION, MESH_FAULT, RELATION } = require('./constants');
const { createMeshState, step } = require('./engine');
const { generateWorld, naturalSchedule, TEMPLATES } = require('./generator');
const { comparePairGraphs, degreeAwareSummary, pooledSummary, serviceGraph } = require('./graph');
const { PAIR_FAMILIES, SWAPPED_RELATION, buildPair, evaluatePair } = require('./pairs');
const { meshSchedule, runMeshSchedule } = require('./runner');
const { clone, validateWorld, worldDigest } = require('./world');

function api(id, replicas, minHealthy, podCapacityRps, startupMs = 500) {
    return { id, kind: 'api', replicas, minHealthy, podCapacityRps, startupMs, role: null, volume: null, queueCapacity: null };
}

function database(id, role, volume, podCapacityRps, replicas = 1) {
    return { id, kind: 'database', replicas, minHealthy: 1, podCapacityRps, startupMs: 500, role, volume, queueCapacity: null };
}

function world({ services, volumes = [], routes, dependencies, placement, rps = 100 }) {
    return {
        schemaVersion: 1,
        kind: 'cloudproof.mesh-world',
        template: 'unit',
        zones: [{ id: 'zone-a' }, { id: 'zone-b' }],
        nodes: [
            { id: 'node-01', zone: 'zone-a', slots: 8 },
            { id: 'node-02', zone: 'zone-b', slots: 8 },
            { id: 'node-03', zone: 'zone-a', slots: 8 },
        ],
        services,
        volumes,
        routes,
        dependencies,
        placement,
        traffic: { rps },
        errorBudgetPct: 20,
    };
}

function run(state, actions) {
    let current = state;
    let first = null;
    for (const action of actions) {
        const result = step(current, action);
        current = result.state;
        first = first || result.violation;
    }
    return { state: current, violation: first };
}

const advance = (ms) => ({ type: MESH_ACTION.ADVANCE_TIME, ms });

test('world validation rejects cycles, missing volumes, bad shares and cross-zone database pods', () => {
    const base = world({
        services: [api('svc-a', 2, 1, 100), api('svc-b', 2, 1, 100), database('svc-db', 'primary', 'vol-1', 100)],
        volumes: [{ id: 'vol-1', zone: 'zone-a', service: 'svc-db' }],
        routes: [{ id: 'route-1', sharePct: 100, entry: 'svc-a' }],
        dependencies: [{ type: RELATION.CALLS, from: 'svc-a', to: 'svc-b' }, { type: RELATION.WRITES, from: 'svc-b', to: 'svc-db' }],
        placement: { 'svc-a': ['node-01', 'node-02'], 'svc-b': ['node-01', 'node-02'], 'svc-db': ['node-03'] },
    });
    assert.equal(validateWorld(base), true);
    const cycle = clone(base);
    cycle.dependencies.push({ type: RELATION.CALLS, from: 'svc-b', to: 'svc-a' });
    assert.throws(() => validateWorld(cycle), /acyclic/);
    const shares = clone(base);
    shares.routes[0].sharePct = 90;
    assert.throws(() => validateWorld(shares), /sum to 100/);
    const zone = clone(base);
    zone.placement['svc-db'] = ['node-02'];
    assert.throws(() => validateWorld(zone), /volume zone/);
    const volume = clone(base);
    volume.services[2].volume = null;
    assert.throws(() => validateWorld(volume), /own volume/);
});

test('a hard dependency propagates an outage to the route; an optional one does not', () => {
    const state = createMeshState(world({
        services: [api('svc-gw', 2, 1, 1000), api('svc-hard', 2, 1, 1000), api('svc-soft', 2, 1, 1000), api('svc-other', 2, 1, 1000)],
        routes: [{ id: 'route-1', sharePct: 60, entry: 'svc-gw' }, { id: 'route-2', sharePct: 40, entry: 'svc-other' }],
        dependencies: [
            { type: RELATION.CALLS, from: 'svc-gw', to: 'svc-hard' },
            { type: RELATION.CALLS_OPTIONAL, from: 'svc-gw', to: 'svc-soft' },
        ],
        placement: { 'svc-gw': ['node-01', 'node-02'], 'svc-hard': ['node-03', 'node-03'],
            'svc-soft': ['node-02', 'node-02'], 'svc-other': ['node-01', 'node-02'] },
    }));
    const soft = step(state, { type: MESH_FAULT.NODE_CRASH, nodeId: 'node-02' });
    assert.equal(soft.violation, null);
    assert.equal(soft.state.derived.health['svc-soft'].up, false);
    assert.equal(soft.state.derived.health['svc-gw'].up, true);

    const hard = step(state, { type: MESH_FAULT.NODE_CRASH, nodeId: 'node-03' });
    assert.equal(hard.violation.errorSharePct, 60);
    assert.equal(hard.violation.rootService, 'svc-hard');
    assert.equal(hard.violation.incidentClass, INCIDENT_CLASS.INSTANCE_LOSS);
    const recovered = run(hard.state, [advance(1500)]);
    assert.equal(recovered.state.derived.violating, false, 'rescheduled pods restore the route');
    assert.ok(recovered.state.pods.filter((pod) => pod.service === 'svc-hard').every((pod) => pod.node !== 'node-03'));
});

test('a cache flush overloads the backing store (stampede) until the cache is warm again', () => {
    const state = createMeshState(world({
        services: [api('svc-reader', 2, 1, 1000), api('svc-writer', 2, 1, 1000),
            { ...api('svc-cache', 2, 1, 1000), kind: 'cache' }, database('svc-db', 'primary', 'vol-1', 60)],
        volumes: [{ id: 'vol-1', zone: 'zone-a', service: 'svc-db' }],
        routes: [{ id: 'route-1', sharePct: 70, entry: 'svc-reader' }, { id: 'route-2', sharePct: 30, entry: 'svc-writer' }],
        dependencies: [
            { type: RELATION.READS_THROUGH, from: 'svc-reader', to: 'svc-cache' },
            { type: RELATION.BACKED_BY, from: 'svc-cache', to: 'svc-db' },
            { type: RELATION.WRITES, from: 'svc-writer', to: 'svc-db' },
        ],
        placement: { 'svc-reader': ['node-01', 'node-02'], 'svc-writer': ['node-01', 'node-02'],
            'svc-cache': ['node-01', 'node-02'], 'svc-db': ['node-03'] },
    }));
    assert.equal(state.derived.health['svc-db'].load, 0.2 * 70 + 30);
    const flushed = step(state, { type: MESH_FAULT.CACHE_FLUSH, serviceId: 'svc-cache' });
    assert.equal(flushed.violation.incidentClass, INCIDENT_CLASS.CACHE_STAMPEDE);
    assert.equal(flushed.violation.rootService, 'svc-db');
    assert.deepEqual(flushed.violation.failingRoutes, ['route-2']);
    assert.equal(flushed.state.derived.health['svc-reader'].up, true, 'a cold cache still serves');
    assert.equal(run(flushed.state, [advance(3100)]).state.derived.violating, false);
});

test('a stalled consumer fills the queue until publishers fail by backpressure', () => {
    const queueWorld = world({
        services: [api('svc-producer', 2, 1, 1000), { ...api('svc-queue', 1, 1, 1000), kind: 'queue', queueCapacity: 150 },
            { ...api('svc-worker', 2, 1, 100), kind: 'worker' }],
        routes: [{ id: 'route-1', sharePct: 100, entry: 'svc-producer' }],
        dependencies: [
            { type: RELATION.PUBLISHES, from: 'svc-producer', to: 'svc-queue' },
            { type: RELATION.CONSUMES, from: 'svc-worker', to: 'svc-queue' },
        ],
        placement: { 'svc-producer': ['node-01', 'node-02'], 'svc-queue': ['node-03'], 'svc-worker': ['node-01', 'node-02'] },
    });
    const state = createMeshState(queueWorld);
    const short = run(state, [{ type: MESH_FAULT.CONSUMER_STALL, serviceId: 'svc-worker', durationMs: 1000 }, advance(2000)]);
    assert.equal(short.violation, null, 'a 1 s stall leaves the backlog under capacity');
    const long = run(state, [{ type: MESH_FAULT.CONSUMER_STALL, serviceId: 'svc-worker', durationMs: 3000 }, advance(2000)]);
    assert.equal(long.violation.incidentClass, INCIDENT_CLASS.QUEUE_BACKPRESSURE);
    assert.equal(long.violation.rootService, 'svc-queue');
    assert.equal(long.violation.atMs, 1500, 'inflow 100/s fills 150 messages in 1.5 s');
});

test('a degraded zone makes its zonal volume unavailable; database pods cannot leave the zone', () => {
    const state = createMeshState(world({
        services: [api('svc-writer', 2, 1, 1000), database('svc-db', 'primary', 'vol-1', 1000)],
        volumes: [{ id: 'vol-1', zone: 'zone-a', service: 'svc-db' }],
        routes: [{ id: 'route-1', sharePct: 100, entry: 'svc-writer' }],
        dependencies: [{ type: RELATION.WRITES, from: 'svc-writer', to: 'svc-db' }],
        placement: { 'svc-writer': ['node-02', 'node-02'], 'svc-db': ['node-01'] },
    }));
    const degraded = step(state, { type: MESH_FAULT.ZONE_DEGRADED, zoneId: 'zone-a' });
    assert.equal(degraded.violation.incidentClass, INCIDENT_CLASS.STORAGE_UNAVAILABLE);
    const later = run(degraded.state, [advance(5000)]);
    assert.equal(later.state.derived.violating, true, 'the zone-bound database cannot move to zone-b');
    assert.ok(later.state.pods.filter((pod) => pod.service === 'svc-db').every((pod) => pod.node === null));
    const back = run(later.state, [{ type: MESH_ACTION.RECOVER_ZONE, zoneId: 'zone-a' }, advance(1500)]);
    assert.equal(back.state.derived.violating, false);
});

test('a replica is promoted after the failover delay and takes the write path', () => {
    const state = createMeshState(world({
        services: [api('svc-writer', 2, 1, 1000), { ...database('svc-primary', 'primary', 'vol-1', 1000), startupMs: 9000 },
            database('svc-replica', 'replica', 'vol-2', 1000)],
        volumes: [{ id: 'vol-1', zone: 'zone-a', service: 'svc-primary' }, { id: 'vol-2', zone: 'zone-b', service: 'svc-replica' }],
        routes: [{ id: 'route-1', sharePct: 100, entry: 'svc-writer' }],
        dependencies: [
            { type: RELATION.WRITES, from: 'svc-writer', to: 'svc-primary' },
            { type: RELATION.REPLICATES, from: 'svc-primary', to: 'svc-replica' },
        ],
        placement: { 'svc-writer': ['node-02', 'node-02'], 'svc-primary': ['node-01'], 'svc-replica': ['node-02'] },
    }));
    const crashed = step(state, { type: MESH_FAULT.NODE_CRASH, nodeId: 'node-01' });
    assert.ok(crashed.violation);
    const early = run(crashed.state, [advance(1000)]);
    assert.equal(early.state.services['svc-primary'].promoted, false);
    const promoted = run(crashed.state, [advance(1700)]);
    assert.equal(promoted.state.services['svc-primary'].promoted, true);
    assert.equal(promoted.state.derived.health['svc-writer'].up, true);
    assert.equal(promoted.state.derived.health['svc-replica'].load, 100);
});

test('generated worlds and natural schedules replay byte-identically', () => {
    for (const templateEntry of TEMPLATES) {
        const first = generateWorld(11, templateEntry.id);
        const second = generateWorld(11, templateEntry.id);
        assert.equal(worldDigest(first.world), worldDigest(second.world));
        const schedule = meshSchedule({ seed: 11, world: first.world, actions: naturalSchedule(11, first.world).actions });
        assert.equal(runMeshSchedule(schedule).fingerprint, runMeshSchedule(clone(schedule)).fingerprint);
    }
});

test('horizon labels count transitions to the first incident, which ends the rows', () => {
    const state = world({
        services: [api('svc-gw', 1, 1, 1000)],
        routes: [{ id: 'route-1', sharePct: 100, entry: 'svc-gw' }],
        dependencies: [],
        placement: { 'svc-gw': ['node-01'] },
    });
    const actions = [advance(100), advance(100), advance(100), { type: MESH_FAULT.NODE_CRASH, nodeId: 'node-01' }, advance(100)];
    const result = runMeshSchedule(meshSchedule({ seed: 1, world: state, actions }));
    assert.equal(result.outcome.failure.transition, 3);
    assert.equal(result.rows.length, 4);
    assert.deepEqual(result.rows.map((row) => row.labels['1']), [false, false, false, true]);
    assert.deepEqual(result.rows.map((row) => row.labels['5']), [true, true, true, true]);
});

test('the graph export carries no identifiers, request load or absolute clock', () => {
    const { world: generated } = generateWorld(5, 'X1');
    const graph = serviceGraph(createMeshState(generated));
    const keys = new Set(graph.nodes.flatMap((node) => Object.keys(node.features)));
    for (const key of keys) {
        assert.ok(!/id$|Id$|load|atMs|AtMs|clock|Until|Since/i.test(key) || key === 'startupMs', `feature ${key} leaks`);
    }
    assert.ok(!keys.has('load'));
    for (const node of graph.nodes) {
        for (const value of Object.values(node.features)) {
            assert.ok(typeof value !== 'string' || !value.includes('svc-'), 'no service identifier in features');
        }
    }
});

test('pair members are identical to pooled and degree-aware summaries and differ in one relation', () => {
    for (const family of PAIR_FAMILIES) {
        for (const seed of [1, 2]) {
            const pair = buildPair({ seed, family, templateId: 'T5' });
            const result = evaluatePair(pair);
            assert.equal(result.valid, true, `${family} seed ${seed}: ${JSON.stringify(result.assertions)}`);
            assert.equal(pair.swappedRelation, SWAPPED_RELATION[family]);
            if (result.decisive) assert.equal(result.riskierIsExposed, true);
        }
    }
});

test('the degree-aware check detects a change that does not preserve degrees', () => {
    const { world: generated } = generateWorld(3, 'T2');
    const changed = clone(generated);
    const index = changed.dependencies.findIndex((edge) => edge.type === RELATION.CALLS_OPTIONAL || edge.type === RELATION.CALLS);
    changed.dependencies[index] = { ...changed.dependencies[index],
        type: changed.dependencies[index].type === RELATION.CALLS ? RELATION.CALLS_OPTIONAL : RELATION.CALLS };
    const left = serviceGraph(createMeshState(generated));
    const right = serviceGraph(createMeshState(changed));
    const comparison = comparePairGraphs(left, right, null);
    assert.equal(comparison.degreeAwareIdentical, false);
    assert.deepEqual(pooledSummary(left), pooledSummary(right), 'a relation-type change is invisible to pooled features');
    assert.notDeepEqual(degreeAwareSummary(left), degreeAwareSummary(right));
});

test('pair construction balances which wiring is riskier', () => {
    let decisive = 0;
    let canonical = 0;
    for (const family of PAIR_FAMILIES) {
        for (let seed = 1; seed <= 12; seed += 1) {
            const result = evaluatePair(buildPair({ seed, family, templateId: 'T4' }));
            if (!result.decisive) continue;
            decisive += 1;
            canonical += Number(result.canonicalRiskier);
        }
    }
    assert.ok(decisive >= 20);
    const share = canonical / decisive;
    assert.ok(share > 0.25 && share < 0.75, `canonical wiring riskier in ${share} of decisive pairs`);
});
