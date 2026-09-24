'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const ops = require('.');
const { createMeshState } = require('../cloudproof-mesh/engine');
const { runMeshSchedule } = require('../cloudproof-mesh/runner');
const { validateWorld } = require('../cloudproof-mesh/world');

function demoConfig(id, overrides = {}) {
    const demo = ops.demoById(id);
    const scenario = ops.loadScenario(demo.scenario);
    return {
        scenario,
        config: {
            scenarioId: scenario.id,
            world: scenario.world,
            versions: scenario.versions,
            labels: scenario.labels,
            change: { ...demo.change, ...(overrides.change || {}) },
            invariants: scenario.invariants,
            faults: demo.faults,
            maxFaults: overrides.maxFaults || 1,
            budget: overrides.budget || demo.budget,
            seed: overrides.seed ?? 1337,
        },
    };
}

test('the portable SHA-256 matches node:crypto, including non-ASCII text', () => {
    for (const text of ['', 'abc', 'x'.repeat(1000), 'maxUnavailable 1 → 0 · ×1.6 · ✓', JSON.stringify({ a: [1, 2, { b: 'é' }] })]) {
        assert.equal(ops.sha256Hex(text), crypto.createHash('sha256').update(text, 'utf8').digest('hex'));
    }
    assert.equal(ops.canonicalDigest({ b: 1, a: 2 }), ops.canonicalDigest({ a: 2, b: 1 }), 'key order does not matter');
});

test('every scenario is a valid CloudProof Mesh world that is healthy at rest', () => {
    for (const { id } of ops.listScenarios()) {
        const scenario = ops.loadScenario(id);
        assert.equal(validateWorld(scenario.world), true);
        assert.equal(createMeshState(scenario.world).derived.violating, false, `${id} violates at rest`);
        ops.validateInvariants(scenario.world, scenario.invariants);
    }
    for (const demo of ops.DEMOS) {
        const scenario = ops.loadScenario(demo.scenario);
        assert.equal(ops.validateChange(scenario.world, demo.change), true, demo.id);
    }
});

test('same configuration and seed give the same search, however it is chunked', () => {
    const { config } = demoConfig('rollout-payment', { change: { maxUnavailable: 0 }, budget: 'quick' });
    const whole = ops.verifyChange(config);
    const search = ops.createVerification(config);
    while (!search.done) search.run({ maxSchedules: 3 });
    const chunked = search.result();
    assert.equal(ops.evidence.searchDigest(whole), ops.evidence.searchDigest(chunked));
    assert.equal(ops.evidence.searchDigest(whole), ops.evidence.searchDigest(ops.verifyChange(config)));
    assert.notEqual(
        ops.evidence.searchDigest(ops.verifyChange({ ...config, seed: 7 })),
        ops.evidence.searchDigest(whole),
        'a different seed explores in a different order',
    );
});

test('a PASS and a FAIL differ by one safety-sensitive parameter', () => {
    const fail = ops.verifyChange(demoConfig('rollout-payment').config);
    assert.equal(fail.status, 'counterexample');
    const pass = ops.verifyChange(demoConfig('rollout-payment', { change: { maxUnavailable: 0 } }).config);
    assert.equal(pass.status, 'verified');
    assert.equal(pass.counters.schedulesChecked, pass.space.singles + 1, 'the whole single-fault space plus the quiet run');
});

test('every demo finds a counterexample the change is responsible for, with distinct mechanisms', () => {
    const classes = new Set();
    for (const demo of ops.DEMOS) {
        const { config } = demoConfig(demo.id);
        const result = ops.verifyChange(config);
        assert.equal(result.status, 'counterexample', demo.id);
        const counterexample = result.counterexample;
        // The verdict is the simulator's: replaying the trace reproduces the violation.
        const replay = ops.replayTrace(counterexample.world, counterexample.trace, config.invariants);
        assert.deepEqual(replay.violations.map((item) => item.invariant), counterexample.violations.map((item) => item.invariant));
        // Attribution: the same faults without the change do not violate it.
        assert.ok(!counterexample.withoutChange.includes(counterexample.primary.invariant), demo.id);
        classes.add(counterexample.cause.incidentClass);
    }
    assert.ok(classes.size >= 4, `mechanisms: ${[...classes].join(', ')}`);
});

test('shrinking keeps the same invariant, keeps the change necessary, and is minimal', () => {
    const { config } = demoConfig('cache-rollout');
    const counterexample = ops.verifyChange(config).counterexample;
    const shrink = ops.shrinkTrace({ world: counterexample.world, trace: counterexample.trace, invariants: config.invariants, target: counterexample.primary.invariant });
    assert.equal(shrink.status, 'minimal');
    assert.ok(shrink.minimal.actions < shrink.original.actions);
    assert.equal(shrink.steps[0].actions, counterexample.trace.length, 'the first step is the trace as found');
    for (let index = 1; index < shrink.steps.length; index += 1) {
        assert.ok(shrink.steps[index].transitions <= shrink.steps[index - 1].transitions, 'reductions never grow');
    }
    const replay = ops.replayTrace(counterexample.world, shrink.minimal.trace, config.invariants);
    assert.ok(replay.violations.some((item) => item.invariant === counterexample.primary.invariant));
    const faultsOnly = shrink.minimal.trace.filter((entry) => entry.origin !== 'change');
    const without = ops.replayTrace(counterexample.world, faultsOnly, config.invariants, { stopOnViolation: false });
    assert.ok(!without.violatedIds.has(counterexample.primary.invariant), 'without the change it holds');
    // One-action removals of the minimal trace no longer reproduce (1-minimality).
    for (let index = 0; index < shrink.minimal.trace.length; index += 1) {
        const entry = shrink.minimal.trace[index];
        if (entry.origin === 'time') continue;
        const smaller = shrink.minimal.trace.filter((_, position) => position !== index);
        let reproduces = true;
        try {
            ops.createShrinker({ world: counterexample.world, trace: smaller, invariants: config.invariants, target: counterexample.primary.invariant });
        } catch (_) {
            reproduces = false;
        }
        assert.equal(reproduces, false, `removing ${entry.label || entry.action.type} still reproduces`);
    }
});

test('the counterexample timeline matches the minimal trace and ends at the violation', () => {
    const { config } = demoConfig('rollout-payment');
    const counterexample = ops.verifyChange(config).counterexample;
    const shrink = ops.shrinkTrace({ world: counterexample.world, trace: counterexample.trace, invariants: config.invariants, target: counterexample.primary.invariant });
    const replay = ops.explainTrace({ world: counterexample.world, trace: shrink.minimal.trace, invariants: config.invariants, labels: config.labels, target: counterexample.primary.invariant });
    const events = replay.timeline.events;
    assert.equal(events.length, shrink.minimal.trace.length);
    events.forEach((event, index) => assert.equal(event.type, shrink.minimal.trace[index].action.type));
    assert.ok(events[events.length - 1].violations.some((item) => item.invariant === shrink.minimal.primary.invariant));
    assert.ok(events.slice(0, -1).every((event) => event.violations.length === 0), 'only the last step violates');
    assert.equal(replay.explanation.root, 'payment');
    assert.equal(replay.explanation.incidentClass, 'OVERLOAD');
    assert.match(replay.explanation.narrative.join(' '), /560 rps against 480 rps/);
    assert.equal(replay.explanation.path[replay.explanation.path.length - 1].kind, 'invariant');
});

test('graph data is canonical: stable layout, every service placed, no hidden state', () => {
    const scenario = ops.loadScenario('checkout');
    const first = ops.initialGraph(scenario.world, { labels: scenario.labels, versions: scenario.versions });
    const second = ops.initialGraph(scenario.world, { labels: scenario.labels, versions: scenario.versions });
    assert.equal(ops.canonicalDigest(first), ops.canonicalDigest(second));
    assert.equal(first.kind, 'cloudproof.ops-graph');
    assert.equal(first.services.length, scenario.world.services.length);
    assert.equal(first.edges.length, scenario.world.dependencies.length);
    for (const service of first.services) {
        assert.ok(service.position && Number.isFinite(service.position.x) && Number.isFinite(service.position.y), service.id);
        assert.equal(service.up, true);
    }
    const payment = first.services.find((service) => service.id === 'payment');
    const checkout = first.services.find((service) => service.id === 'checkout');
    assert.ok(payment.position.y > checkout.position.y, 'callees sit below callers');
});

test('the change diff is deterministic and marks the risky rows', () => {
    const scenario = ops.loadScenario('checkout');
    const change = { type: 'rollout', service: 'payment', toVersion: 'v42', maxSurge: 1, maxUnavailable: 1 };
    const first = ops.describeChange(scenario.world, change, scenario.versions);
    assert.deepEqual(first, ops.describeChange(scenario.world, change, scenario.versions));
    assert.deepEqual(first.rows.map((row) => [row.field, row.before, row.after]), [
        ['version', 'v41', 'v42'], ['replicas', 5, 5], ['maxSurge', 1, 1], ['maxUnavailable', 1, 1], ['minHealthy', 3, 3],
    ]);
    assert.equal(first.rows.find((row) => row.field === 'maxUnavailable').sensitive, true);
    const scaleDown = ops.describeChange(scenario.world, { type: 'scale', service: 'fulfillment', replicas: 2 }, scenario.versions);
    assert.equal(scaleDown.rows[0].sensitive, true);
});

test('compare mode replays the counterexample\'s exact exogenous schedule', () => {
    const { config } = demoConfig('rollout-payment');
    const result = ops.verifyChange(config);
    const counterexample = result.counterexample;
    const same = ops.replayEnvironment({
        world: config.world, change: config.change, versions: config.versions, invariants: config.invariants,
        placements: counterexample.placements, readiness: counterexample.readiness, faults: config.faults, horizonMs: result.horizonMs,
    });
    assert.deepEqual(same.faultActions, counterexample.faultActions, 'identical fault actions and times');
    assert.equal(same.atMs, counterexample.atMs);
    assert.deepEqual(same.attributable.map((item) => item.invariant), counterexample.violations.map((item) => item.invariant));
    const candidates = ops.remediationsFor({ world: config.world, change: config.change, labels: config.labels }, counterexample.cause);
    const fix = candidates.find((item) => item.id === 'rollout-max-unavailable-0');
    const applied = ops.applyRemediation({ world: config.world, change: config.change }, fix);
    assert.equal(applied.change.maxUnavailable, 0);
    const fixed = ops.replayEnvironment({
        world: applied.world, change: applied.change, versions: config.versions, invariants: config.invariants,
        placements: counterexample.placements, readiness: counterexample.readiness, faults: config.faults, horizonMs: result.horizonMs,
    });
    assert.deepEqual(fixed.faultActions, counterexample.faultActions);
    assert.equal(fixed.attributable.length, 0, 'the fix survives the same environment');
});

test('evidence bundles hash, replay and re-run; tampering is detected', () => {
    const { scenario, config } = demoConfig('rollout-payment');
    const result = ops.verifyChange(config);
    const counterexample = result.counterexample;
    const shrink = ops.shrinkTrace({ world: counterexample.world, trace: counterexample.trace, invariants: config.invariants, target: counterexample.primary.invariant });
    const bundle = JSON.parse(JSON.stringify(ops.evidence.buildEvidence({ scenario, config, result, shrink, exportedAt: '2026-09-24T00:00:00.000Z' })));
    const later = ops.evidence.buildEvidence({ scenario, config, result, shrink, exportedAt: '2027-01-01T00:00:00.000Z' });
    assert.equal(later.digests.bundle, bundle.digests.bundle, 'the export time is not part of the digest');
    // Fault families are a set: the page (sorted) and the CLI (demo order) must record the same bundle.
    const reordered = { ...config, faults: config.faults.slice().reverse() };
    const reorderedResult = ops.verifyChange(reordered);
    assert.equal(ops.evidence.buildEvidence({ scenario, config: reordered, result: reorderedResult, shrink, exportedAt: null }).digests.bundle, bundle.digests.bundle);
    const verdict = ops.evidence.verifyEvidence(bundle, { rerunSearch: true });
    assert.equal(verdict.ok, true, JSON.stringify(verdict.checks));
    assert.equal(bundle.verdict.status, 'counterexample');
    const tampered = JSON.parse(JSON.stringify(bundle));
    tampered.counterexample.minimal.trace[0].action.podId = 'pod/payment-1';
    const check = ops.evidence.verifyEvidence(tampered);
    assert.equal(check.ok, false);
    assert.ok(check.checks.some((item) => !item.ok && item.name === 'bundle digest'));
});

test('the committed evidence fixture still verifies against today\'s simulator', () => {
    const bundle = require('../../apps/ops/fixtures/rollout-payment.evidence.json');
    const verdict = ops.evidence.verifyEvidence(bundle, { rerunSearch: true });
    assert.equal(verdict.ok, true, JSON.stringify(verdict.checks));
});

test('PASS language is bounded; nothing claims universal safety', () => {
    const { scenario, config } = demoConfig('rollout-payment', { change: { maxUnavailable: 0 }, budget: 'quick' });
    const result = ops.verifyChange(config);
    const bundle = ops.evidence.buildEvidence({ scenario, config, result, exportedAt: null });
    assert.equal(bundle.verdict.status, 'verified-within-bound');
    assert.match(bundle.verdict.statement, /No modeled invariant violation found across \d+ explored schedules/);
    assert.match(bundle.verdict.statement, /within this bound/);
    assert.doesNotMatch(JSON.stringify(bundle.verdict), /\bsafe\b|guarantee|certified|proved/i);
});

test('topology import accepts the documented format and rejects malformed input with sentences', () => {
    const scenario = ops.loadScenario('checkout');
    const example = ops.topology.toSimplified(scenario.world, 'example');
    const parsed = ops.topology.parseTopology(JSON.stringify(example));
    assert.equal(parsed.ok, true, parsed.errors.join('; '));
    assert.equal(parsed.world.services.length, scenario.world.services.length);
    assert.equal(ops.topology.parseTopology(JSON.stringify(scenario.world)).ok, true, 'a raw mesh world is accepted');
    const cases = [
        ['{"kind": "cloudproof.topology", oops}', /Not valid JSON at line 1/],
        ['apiVersion: apps/v1\nkind: Deployment', /Kubernetes YAML, which is not supported/],
        ['{"kind": "something-else"}', /Unrecognised document/],
        [JSON.stringify({ ...example, routes: [{ id: 'r', sharePct: 90, entry: 'storefront' }] }), /route shares must sum to 100, not 90/],
        [JSON.stringify({ ...example, services: example.services.map((item) => (item.id === 'payment' ? { ...item, kind: 'lambda' } : item)) }), /kind must be one of/],
        [JSON.stringify({ ...example, dependencies: [...example.dependencies, ['payment', 'CALLS', 'checkout']] }), /cycle/],
        [JSON.stringify({ ...example, services: example.services.map((item) => (item.id === 'payment' ? { ...item, capacityRps: 10 } : item)) }), /already fails/],
    ];
    for (const [text, pattern] of cases) {
        const result = ops.topology.parseTopology(text);
        assert.equal(result.ok, false, text.slice(0, 60));
        assert.match(result.errors.join(' '), pattern);
    }
});

test('incidents replay deterministically, shrink, and report recovery', () => {
    for (const item of ops.incidents.listIncidents()) {
        const incident = ops.incidents.loadIncident(item.id);
        const outline = ops.incidents.incidentOutline(incident.world, incident.trace, incident.invariants);
        assert.ok(outline.firstViolation, item.id);
        const prefix = ops.incidents.incidentPrefix(incident.world, incident.trace, incident.invariants);
        assert.equal(prefix.violation.atMs, outline.firstViolation.atMs);
        const shrink = ops.shrinkTrace({ world: incident.world, trace: prefix.trace, invariants: incident.invariants, target: prefix.violation.invariant, requireChange: false });
        assert.ok(shrink.minimal.actions < prefix.trace.length, item.id);
        // The committed incident is the Phase III runner's own schedule outcome.
        const phase3 = runMeshSchedule({ schemaVersion: 1, kind: 'cloudproof.mesh-schedule', seed: 0, world: incident.world, actions: incident.trace.map((entry) => entry.action), metadata: {} });
        assert.equal(phase3.outcome.unsafe, true);
        assert.equal(phase3.outcome.failure.atMs, outline.firstViolation.atMs);
    }
});

test('architecture pairs come from the Phase III generator and disagree only in one relation', () => {
    for (const family of ops.architecture.families()) {
        const found = ops.architecture.findDecisivePair({ family: family.id, templateId: 'T1', seed: 1 });
        assert.ok(found, family.id);
        const replay = ops.architecture.pairReplay(found);
        assert.ok(Object.values(replay.assertions).every(Boolean), `${family.id}: ${JSON.stringify(replay.assertions)}`);
        assert.notEqual(replay.members.A.violated, replay.members.B.violated, 'decisive');
        assert.equal(replay.differing.A.length, 2);
        assert.equal(replay.differing.B.length, 2);
        const prefix = family.relation === 'ENTERS' ? 'ENTERS:' : `${family.relation}:`;
        assert.ok([...replay.differing.A, ...replay.differing.B].every((id) => id.startsWith(prefix)), family.id);
    }
});

test('remediations for incidents without a change only edit the world', () => {
    const incident = ops.incidents.loadIncident('natural-T2-108');
    const prefix = ops.incidents.incidentPrefix(incident.world, incident.trace, incident.invariants);
    const replay = ops.explainTrace({ world: incident.world, trace: prefix.trace, invariants: incident.invariants, labels: incident.labels, requireChange: false });
    const candidates = ops.remediationsFor({ world: incident.world, change: null, labels: incident.labels }, replay.explanation);
    assert.ok(candidates.length > 0);
    for (const candidate of candidates) {
        assert.equal(candidate.changeEdit, undefined);
        const applied = ops.applyRemediation({ world: incident.world, change: null }, candidate);
        assert.equal(validateWorld(applied.world), true);
    }
});
