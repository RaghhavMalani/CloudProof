'use strict';

// GNN Observatory: the page is static, pinned and honest about where its numbers
// come from. The Python suite validates the replay schema at export time; these
// checks run in CI (which has no PyTorch) against the committed replay.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');
const replay = () => JSON.parse(read('web/observatory/replay.json'));

function loadCore() {
    // Without a document the script only defines its pure helpers and returns.
    const context = { window: {}, console };
    vm.runInNewContext(read('apps/observatory/observatory.js'), context, { filename: 'observatory.js' });
    return context.window.ObservatoryCore;
}

test('the page pins three.js through an import map and adds no npm dependency', () => {
    const html = read('apps/observatory/observatory.html');
    const map = JSON.parse(/<script type="importmap">([\s\S]*?)<\/script>/.exec(html)[1]);
    const version = /three@(\d+\.\d+\.\d+)\/build\/three\.module\.js$/.exec(map.imports.three);
    assert.ok(version, 'three is pinned to an exact release');
    assert.equal(map.imports['three/addons/'], `https://cdn.jsdelivr.net/npm/three@${version[1]}/examples/jsm/`);
    assert.ok(html.indexOf('type="importmap"') < html.indexOf('type="module"'), 'the import map precedes the module');
    const script = read('apps/observatory/observatory.js');
    assert.doesNotMatch(script, /^\s*import\s/m, 'dynamic import() only, so the file also parses as a classic script');
    for (const manifest of ['replica/package.json', 'serving/package.json']) {
        const pkg = JSON.parse(read(manifest));
        assert.ok(!('three' in { ...pkg.dependencies, ...pkg.devDependencies }), manifest);
    }
    assert.match(JSON.parse(read('vercel.json')).installCommand, /^echo/);
});

test('the console navigation links the observatory', () => {
    assert.match(read('apps/systems/index.html'), /<nav aria-label="Product">[\s\S]*<a href="observatory\.html">GNN OBSERVATORY<\/a>[\s\S]*?<\/nav>/);
});

test('the committed replay resolves everything the page draws, in every mode', () => {
    const core = loadCore();
    const data = replay();
    const index = core.indexReplay(data);
    assert.equal(index.graphs.length, 2);
    assert.deepEqual([...index.modes].sort(), [...data.meta.tap.modes].sort());
    assert.equal(index.modes[0], 'full');
    const layout = core.computeLayout(index);
    assert.ok(layout.bounds.radius > 0);
    index.graphs.forEach((graph, position) => {
        for (const node of graph.nodes) {
            assert.ok(core.positionAt(layout.graphs[position], node.id, 1.5).every(Number.isFinite), node.id);
        }
        for (const mode of index.modes) {
            const aligned = graph.aligned[mode];
            assert.equal(aligned.length, graph.edges.length, mode);
            if (mode === 'no-edges') assert.ok(aligned.every((edge) => edge === null));
            else assert.ok(aligned.every((edge) => edge && graph.byId.has(edge.from) && graph.byId.has(edge.to)), mode);
        }
    });
    for (const frame of index.frames) {
        for (const mode of index.modes) {
            const states = core.modeStates(frame, mode);
            assert.equal(states.layers.length, index.layers);
            for (const graph of index.graphs) {
                for (const node of graph.nodes) {
                    assert.ok(Number.isFinite(frame.embed[node.type][node.batchIndex]));
                    assert.ok(Number.isFinite(states.layers[index.layers - 1][node.type][node.batchIndex]));
                }
                for (const edge of graph.aligned[mode].filter(Boolean)) {
                    for (let layer = 0; layer < index.layers; layer += 1) {
                        assert.ok(Number.isFinite(states.msg[layer][edge.rel].forward[edge.slot]), `${mode} ${edge.rel}#${edge.slot}`);
                        assert.ok(Number.isFinite(states.msg[layer][edge.rel].reverse[edge.slot]));
                    }
                }
            }
            assert.equal(frame.risk[mode].length, 2);
        }
        // With no edges the pair members are the same input, so they must tie.
        assert.equal(frame.risk['no-edges'][0], frame.risk['no-edges'][1]);
    }
    const { node, msg, weight } = index.scales;
    assert.ok(node.embed > 0 && node.layers.every((value) => value > 0) && msg.every((value) => value > 0));
    assert.ok(weight[1] > weight[0]);
    for (const [relation, routed] of Object.entries(data.meta.vocabulary.randomRelationLabels)) {
        assert.equal(core.relationColor('random-relation-labels', relation, data.meta.vocabulary), core.RELATION_COLORS[routed]);
    }
    const plan = core.cycle(index.layers);
    assert.ok(plan.phases.some((phase) => phase.readout));
    assert.equal(plan.phases.filter((phase) => phase.direction).length, 2 * index.layers);
});

test('the footer status line has the documented shape', () => {
    const core = loadCore();
    const index = core.indexReplay(replay());
    const last = index.frames.length - 1;
    assert.match(core.statusLine(index, last), /^● REPLAY — HeterogeneousRiskGNN — seed \d+ — step \d+\/\d+ — loss (\d+\.\d{3}|n\/a) — corpus sha [0-9a-f]{4}…$/);
    assert.match(core.statusLine(index, 0), /loss n\/a/);
    assert.equal(core.formatP(7.4272517562084805e-25), '7.4 × 10⁻²⁵');
});

test('the replay quotes the published results and the claim instead of restating them', () => {
    const data = replay();
    assert.equal(data.meta.run, 'demo');
    assert.match(data.meta.notice, /short demo run/);
    assert.match(data.meta.notice, /five-seed ensemble/);
    const ranking = JSON.parse(read('artifacts/cloudproof/phase-ii-b2/counterfactual-ranking.json'));
    for (const row of data.final.rows) {
        const source = ranking.artifacts[row.artifact][row.mode].relationalOnly;
        assert.deepEqual(
            [row.correct, row.ties, row.pairs, row.tieAwareAccuracy, row.bootstrap95],
            [source.correct, source.ties, source.pairs, source.tieAwareAccuracy, [source.bootstrap95TieAware.lower, source.bootstrap95TieAware.upper]],
            `${row.artifact} ${row.mode}`,
        );
    }
    const tests = JSON.parse(read('artifacts/cloudproof/phase-ii-b2/statistical-tests.json'));
    assert.equal(data.final.graphAttribution, tests.attribution.graphAttribution);
    const readme = read('README.md').replace(/\s+/g, ' ');
    assert.ok(readme.includes(`**The supported claim is exactly this:** *${data.final.supportedClaim}*`), 'claim quoted verbatim from README.md');

    // The page renders `final`; it must not carry its own copy of the numbers or the claim.
    const page = read('apps/observatory/observatory.js') + read('apps/observatory/observatory.html');
    for (const literal of ['87.3', '151/173', '0.8728', '7.4 × 10', 'relational message passing provides predictive information']) {
        assert.ok(!page.includes(literal), `page hardcodes ${literal}`);
    }
    for (const overclaim of [/GNNs? (beat|outperform)s?/i, /proves? (that )?topology/i, /safety oracle/i, /guarantee/i, /learned (the )?causal/i]) {
        assert.doesNotMatch(page, overclaim);
    }
});
