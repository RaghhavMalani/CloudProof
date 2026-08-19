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
    assert.equal(browser.miniRaft.workloads.WORKLOADS.length, 7);
    for (const workload of browser.miniRaft.workloads.WORKLOADS) {
        const result = browser.miniRaft.workloads.runWorkload(workload, { seed: 42 });
        assert.ok(result.events.length > 0, `${workload.id} should produce a trace`);
        assert.ok(result.visualization.nodes.length > 0, `${workload.id} should visualize nodes`);
    }
});

test('Flight Deck boots, explains a payment, and wires its primary controls', () => {
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
    const body = get('body');
    const document = {
        body,
        createElement: () => new FakeElement(),
        getElementById: get,
        querySelector(selector) {
            if (selector === 'meta[name="theme-color"]') return get('theme-meta');
            if (selector === '.flight') return get('flight');
            if (selector === '.quick-start') return get('quick-start');
            if (selector === '.journey-step.active') return null;
            return get(`selector:${selector}`);
        },
        querySelectorAll: () => [],
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
    vm.runInNewContext(deck, context, { filename: 'flight-deck.js' });

    assert.equal(get('workload-name').textContent, 'Idempotent job & payment processor');
    assert.match(get('workload-tabs').innerHTML, /Payments/);
    assert.match(get('plain-step-copy').textContent, /stable request ID pay-7/);
    assert.notEqual(get('metric-events').textContent, '0');
    assert.match(get('system-nodes').innerHTML, /system-node/);

    get('theme-select').onchange({ target: { value: 'qatar', selectedOptions: [{ text: 'Qatar Airways' }] } });
    assert.equal(body.dataset.theme, 'qatar');
    get('open-guide').onclick();
    assert.equal(get('guide-dialog').open, true);
    get('next').onclick();
    assert.equal(get('plain-step-number').textContent, 2);
    get('run-example').onclick();
    assert.equal(get('play-pause').textContent, 'PAUSE EXAMPLE');
    assert.equal(get('quick-start').classList.contains('is-hidden'), true);
});
