'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { TextDecoder, TextEncoder } = require('node:util');
const vm = require('node:vm');

test('browser bundle exposes every runnable workload', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'web', 'bundle.js'), 'utf8');
    const browser = {};
    vm.runInNewContext(source, { window: browser, TextDecoder, TextEncoder }, { filename: 'bundle.js' });

    // Kept in step with packages/workloads deliberately: the browser bundle
    // silently shipping fewer workloads than the source defines is exactly the
    // drift this test exists to catch.
    assert.equal(browser.cloudProof.workloads.WORKLOADS.length, 11);
    for (const workload of browser.cloudProof.workloads.WORKLOADS) {
        const result = browser.cloudProof.workloads.runWorkload(workload, { seed: 42 });
        assert.ok(result.events.length > 0, `${workload.id} should produce a trace`);
        assert.ok(result.visualization.nodes.length > 0, `${workload.id} should visualize nodes`);
    }
});

test('browser entry point distinguishes simulation, Docker, and Kubernetes', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'apps', 'systems', 'index.html'), 'utf8');
    assert.match(html, /Deterministic simulator/);
    assert.match(html, /Docker Compose cluster/);
    assert.match(html, /Local kind \/ production Kubernetes/);
    assert.match(html, /http:\/\/localhost:4000/);
    assert.match(html, /bash tools\/kind-up\.sh/);
    assert.match(html, /saved artifact, not a live Docker stream/);
});

test('Kubernetes manifest protects consensus and gateway availability', () => {
    const manifest = fs.readFileSync(path.join(__dirname, '..', 'k8s', 'cloudproof-raft.yaml'), 'utf8');
    assert.match(manifest, /kind: StatefulSet/);
    assert.match(manifest, /volumeClaimTemplates:/);
    assert.match(manifest, /name: raft-quorum[\s\S]*minAvailable: 2/);
    assert.match(manifest, /name: gateway-availability[\s\S]*minAvailable: 1/);
});

test('reality harness scopes idempotency to one persistent-cluster run', () => {
    const harness = fs.readFileSync(path.join(__dirname, 'reality-harness.js'), 'utf8');
    assert.doesNotMatch(harness, /clientId: 'reality-harness'/);
    assert.match(harness, /write\([^\n]+recorder\.runId, 1\)/);
});

test('Flight Deck boots into the refund agent and wires its primary controls', () => {
    class FakeClassList {
        constructor() { this.values = new Set(); }
        add(...names) { names.forEach((name) => this.values.add(name)); }
        remove(...names) { names.forEach((name) => this.values.delete(name)); }
        contains(name) { return this.values.has(name); }
        toggle(name, force) {
            const enabled = force == null ? !this.values.has(name) : force;
            if (enabled) this.values.add(name); else this.values.delete(name);
            return enabled;
        }
    }

    class FakeElement {
        constructor(id = '') {
            this.id = id;
            this.classList = new FakeClassList();
            this.dataset = {};
            this.style = {};
            this.hidden = false;
            this.innerHTML = '';
            this.textContent = '';
            this.value = '';
            this.nextElementSibling = { textContent: '' };
        }
        addEventListener() {}
        after() {}
        append() {}
        prepend() {}
        querySelector() { return null; }
        querySelectorAll() { return []; }
        scrollIntoView() {}
        setAttribute(name, value) { this[name] = value; }
        showModal() { this.open = true; }
    }

    const elements = new Map();
    const get = (id) => {
        if (!elements.has(id)) elements.set(id, new FakeElement(id));
        return elements.get(id);
    };
    const tabButtons = new Map();
    const tabFor = (workloadId) => {
        if (!tabButtons.has(workloadId)) {
            const button = new FakeElement(`tab:${workloadId}`);
            button.dataset.workload = workloadId;
            tabButtons.set(workloadId, button);
        }
        return tabButtons.get(workloadId);
    };
    const body = get('body');
    const document = {
        body,
        createElement: () => new FakeElement(),
        getElementById: get,
        querySelector(selector) {
            if (selector === 'meta[name="theme-color"]') return get('theme-meta');
            if (selector === '.flight') return get('flight');
            if (selector === '.quick-start') return get('quick-start');
            if (selector === '.operations-launchpad') return get('quick-start');
            if (selector === '.systems-deck') return get('systems-deck');
            if (selector === '.journey-step.active') return null;
            return get(`selector:${selector}`);
        },
        querySelectorAll(selector) {
            // renderTabs wires its click handlers through this selector. Returning
            // [] here (as this fake used to) meant the test could never switch
            // workloads, so every assertion below only ever saw the payment tab.
            if (selector === '[data-workload]') return [...tabButtons.values()];
            return [];
        },
    };
    const browser = {};
    const context = {
        window: browser,
        document,
        location: { href: 'http://localhost:4173/' },
        history: { replaceState() {} },
        navigator: { clipboard: { writeText: async () => {} } },
        performance,
        console,
        TextDecoder,
        TextEncoder,
        URL,
        URLSearchParams,
        addEventListener() {},
        clearInterval() {},
        setInterval: () => 1,
        setTimeout(callback) { callback(); return 1; },
        fetch: async () => ({ ok: false, json: async () => null }),
    };
    const bundle = fs.readFileSync(path.join(__dirname, '..', 'web', 'bundle.js'), 'utf8');
    const deck = fs.readFileSync(path.join(__dirname, '..', 'apps', 'systems', 'flight-deck.js'), 'utf8');
    vm.runInNewContext(bundle, context, { filename: 'bundle.js' });
    // The tab buttons must exist before the deck boots, because renderTabs wires
    // its handlers once through querySelectorAll('[data-workload]').
    for (const workload of browser.cloudProof.workloads.WORKLOADS) tabFor(workload.id);
    vm.runInNewContext(deck, context, { filename: 'flight-deck.js' });

    assert.equal(get('workload-name').textContent, 'Autonomous refund agent');
    assert.match(get('workload-tabs').innerHTML, /Payments/);
    assert.match(get('workload-tabs').innerHTML, /Feed/);
    assert.match(get('workload-tabs').innerHTML, /CRDT editing/);
    assert.match(get('workload-tabs').innerHTML, /Settlement/);
    assert.notEqual(get('metric-events').textContent, '0');
    assert.match(get('system-nodes').innerHTML, /system-node/);

    // The briefing panel leads with the failure a reader would recognise, not
    // with the formal question. Asserted against the module rather than a
    // pinned phrase so rewording the copy is not a test failure.
    const brief = browser.cloudProof.plainEnglish.briefFor('agent-refund');
    assert.equal(get('workload-headline').textContent, brief.headline);
    assert.equal(get('workload-symptom').textContent, brief.symptom);
    assert.equal(get('workload-rule').textContent, brief.rule);
    assert.equal(get('plain-step-safety').textContent, brief.rule);

    get('theme-select').onchange({ target: { value: 'qatar', selectedOptions: [{ text: 'Qatar Airways' }] } });
    assert.equal(body.dataset.theme, 'qatar');
    get('open-guide').onclick();
    assert.equal(get('guide-dialog').open, true);
    get('next').onclick();
    assert.equal(get('plain-step-number').textContent, 2);
    get('run-example').onclick();
    assert.equal(get('play-pause').textContent, 'PAUSE EXAMPLE');
    get('toggle-inspector').onclick();
    assert.equal(get('systems-deck').classList.contains('inspector-collapsed'), true);
    assert.equal(get('toggle-inspector').textContent, 'SHOW PROTOCOL X-RAY');

    // The real regression this guards: the deck used to fall back to the raw
    // engineering detail string whenever plain copy was missing, so most
    // workloads silently rendered jargon inside a box headed "IN PLAIN
    // ENGLISH". Walk every event of every workload through the actual UI code
    // path and require a sentence at each step.
    for (const workload of browser.cloudProof.workloads.WORKLOADS) {
        tabFor(workload.id).onclick();

        const workloadBrief = browser.cloudProof.plainEnglish.briefFor(workload.id);
        assert.equal(get('workload-headline').textContent, workloadBrief.headline,
            `${workload.id} did not render its brief`);

        // Walk the journey to its end. The bound is the step counter rather than
        // metric-events, which also counts invariant checks and so overruns.
        let steps = 0;
        let previous = -1;
        while (Number(get('plain-step-number').textContent) !== previous && steps < 60) {
            previous = Number(get('plain-step-number').textContent);
            const copy = get('plain-step-copy').textContent;
            assert.ok(typeof copy === 'string' && copy.length > 20,
                `${workload.id} step ${previous} has no plain-English explanation`);
            assert.doesNotMatch(copy, /\bdeterministic step\b/,
                `${workload.id} step ${previous} fell back to filler copy`);
            get('next').onclick();
            steps += 1;
        }
        assert.ok(steps >= 9, `${workload.id} only walked ${steps} steps`);
    }

});

function browserOps() {
    const source = fs.readFileSync(path.join(__dirname, '..', 'web', 'bundle.js'), 'utf8');
    const browser = {};
    vm.runInNewContext(source, { window: browser, TextDecoder, TextEncoder }, { filename: 'bundle.js' });
    return browser.cloudProof;
}

test('the browser bundle exposes the Operations Console API and the mesh simulator', () => {
    const cloudProof = browserOps();
    const ops = cloudProof.ops;
    for (const name of ['listScenarios', 'loadScenario', 'createVerification', 'verifyChange', 'createShrinker', 'explainTrace',
        'remediationsFor', 'applyRemediation', 'replayEnvironment', 'initialGraph', 'describeChange']) {
        assert.equal(typeof ops[name], 'function', name);
    }
    for (const name of ['architecture', 'incidents', 'topology', 'evidence']) assert.equal(typeof ops[name], 'object', name);
    assert.equal(typeof cloudProof.mesh.engine.createMeshState, 'function');
    assert.equal(typeof cloudProof.mesh.pairs.buildPair, 'function');
    assert.ok(ops.DEMOS.length >= 5);
    assert.equal(ops.USE_CASES.length, 6);
});

test('a verification in the browser bundle is byte-identical to the same one in Node', () => {
    const nodeOps = require('../packages/cloudproof-ops');
    const run = (ops) => {
        const demo = ops.demoById('rollout-payment');
        const scenario = ops.loadScenario(demo.scenario);
        const config = {
            scenarioId: scenario.id, world: scenario.world, versions: scenario.versions, labels: scenario.labels,
            change: demo.change, invariants: scenario.invariants, faults: demo.faults, maxFaults: 1, budget: 'standard', seed: 1337,
        };
        const result = ops.verifyChange(config);
        const counterexample = result.counterexample;
        const shrink = ops.shrinkTrace({ world: counterexample.world, trace: counterexample.trace, invariants: config.invariants, target: counterexample.primary.invariant });
        return ops.evidence.buildEvidence({ scenario, config, result, shrink, exportedAt: null });
    };
    const inBrowser = JSON.parse(JSON.stringify(run(browserOps().ops)));
    const inNode = run(nodeOps);
    assert.equal(inBrowser.digests.bundle, inNode.digests.bundle);
    assert.equal(inBrowser.counterexample.minimal.replayDigest, inNode.counterexample.minimal.replayDigest);
    // And an export made in the page verifies in Node.
    assert.equal(nodeOps.evidence.verifyEvidence(inBrowser).ok, true);
});

test('the graph renderer draws canonical graph data and wires selection', () => {
    const ops = require('../packages/cloudproof-ops');
    const scenario = ops.loadScenario('checkout');
    const model = ops.initialGraph(scenario.world, { labels: scenario.labels, versions: scenario.versions });
    const window = {};
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'apps', 'ops', 'cloud-graph.js'), 'utf8'), { window }, { filename: 'cloud-graph.js' });
    const listeners = {};
    const host = {
        id: 'graph', innerHTML: '', dataset: {},
        classList: { toggle() {} },
        addEventListener(type, handler) { listeners[type] = handler; },
        contains: () => true,
    };
    const picked = [];
    for (const view of ['logical', 'placement', 'failure']) {
        window.CloudGraph.render(host, model, { view, onSelect: (selection) => picked.push(selection), highlight: { services: ['payment'] } });
        assert.match(host.innerHTML, /^<svg class="cg-svg/);
        for (const service of model.services) {
            if (view === 'placement') assert.match(host.innerHTML, new RegExp(`data-id="${service.id}"`));
            else assert.match(host.innerHTML, new RegExp(`data-kind="service" data-id="${service.id}"`), service.id);
        }
    }
    assert.match(host.innerHTML, /class="cg-service [^"]*dim/, 'the failure view dims what is off the path');
    assert.match(host.innerHTML, /tabindex="0" role="button"/, 'elements are keyboard-operable');
    listeners.click({ target: { closest: () => ({ dataset: { kind: 'service', id: 'payment' } }) } });
    assert.deepEqual(JSON.parse(JSON.stringify(picked)), [{ kind: 'service', id: 'payment' }]);
});

test('console copy stays within what a bounded, modeled search can claim', () => {
    const files = ['apps/ops/cloud-ops.js', 'apps/ops/cloud-graph.js', 'apps/systems/index.html', 'packages/cloudproof-ops/evidence.js'];
    const text = files.map((file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8')).join('\n');
    for (const forbidden of [/guarantees? production safety/i, /100% safe/i, /production[- ]certified/i, /AI (says|proved)/i, /proves your cloud safe/i]) {
        assert.doesNotMatch(text, forbidden);
    }
    const console = fs.readFileSync(path.join(__dirname, '..', 'apps', 'ops', 'cloud-ops.js'), 'utf8');
    assert.match(console, /VERIFIED WITHIN BOUND/);
    assert.match(console, /No modeled invariant violation found across/);
    assert.doesNotMatch(console, /'SAFE'|"SAFE"/);
    const html = fs.readFileSync(path.join(__dirname, '..', 'apps', 'systems', 'index.html'), 'utf8');
    assert.match(html, /Verify the cloud change<br><em>before production does\.<\/em>/);
    assert.match(html, /modeled invariants and failure semantics/);
    for (const mode of ['verify', 'incident', 'architecture', 'agent', 'research']) assert.match(html, new RegExp(`data-mode-target="${mode}"`));
});

test('the web bundle build is deterministic and the committed bundle is current', () => {
    const { bundle } = require('./build-web');
    const first = bundle();
    assert.equal(first, bundle());
    // Compare modulo line endings, as Git does: a Windows checkout with
    // core.autocrlf rewrites the committed bundle (and the sources inside it)
    // with CRLF, which is not staleness.
    const lf = (text) => text.replace(/\r\n/g, '\n');
    const committed = fs.readFileSync(path.join(__dirname, '..', 'web', 'bundle.js'), 'utf8');
    assert.equal(lf(first), lf(committed), 'run node tools/build-web.js');
});
