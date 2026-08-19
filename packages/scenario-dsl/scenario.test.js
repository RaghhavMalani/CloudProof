'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseScenario, branchScenario, serializeScenario, ScenarioRunner } = require('./index');

const SOURCE = `
0.0s start cluster(3)
0.4s write("model/current", v1)
0.8s partition(node0, [node1,node2])
1.2s heal-all()
`;

test('parses the timeline DSL into ordered typed actions', () => {
    const actions = parseScenario(SOURCE);
    assert.equal(actions.length, 4);
    assert.deepEqual(actions[2].args, ['node0', ['node1', 'node2']]);
    assert.equal(actions[3].atMs, 1200);
    assert.match(serializeScenario(actions), /partition\(node0, \[node1,node2\]\)/);
});

test('branches history by retaining the prefix and shifting new actions', () => {
    const branch = branchScenario(SOURCE, 600, '0.1s crash(node1)\n0.5s heal-all()');
    assert.deepEqual(branch.map((action) => action.atMs), [0, 400, 700, 1100]);
    assert.equal(branch[2].name, 'crash');
});

test('executes writes and faults against the real deterministic cluster', async () => {
    const runner = new ScenarioRunner({ clusterOptions: { seed: 91 } });
    const result = await runner.run(SOURCE);
    assert.equal(result.results.length, 4);
    assert.equal(result.results.every((entry) => entry.ok), true);
    assert.ok(result.trace.events.some((event) => event.type === 'rpc.sent'));
    assert.ok(result.trace.events.some((event) => event.type === 'fault.applied'));
    result.cluster.stop();
});
