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
