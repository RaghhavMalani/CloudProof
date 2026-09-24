'use strict';

// Hand-authored CloudProof Mesh worlds for the Operations Console.
//
// Each scenario is an ordinary `cloudproof.mesh-world` (validated by
// packages/cloudproof-mesh/world.js) plus presentation metadata: readable
// labels, the version each deployment runs, and the demo changes that the
// one-click cards configure. Nothing here changes simulator semantics; the
// numbers below are the static parameters the simulator reads.

const { validateWorld } = require('../cloudproof-mesh/world');

const MESH_WORLD = 'cloudproof.mesh-world';

function service(id, kind, replicas, minHealthy, podCapacityRps, startupMs, extra = {}) {
    return {
        id,
        kind,
        replicas,
        minHealthy,
        podCapacityRps,
        startupMs,
        role: extra.role || null,
        volume: extra.volume || null,
        queueCapacity: kind === 'queue' ? extra.queueCapacity : null,
    };
}

function sixNodes(slots = 8) {
    return ['a', 'b', 'c'].flatMap((zone) => [1, 2].map((index) => ({
        id: `node-${zone}${index}`, zone: `zone-${zone}`, slots,
    })));
}

// Checkout stack: the topology the console opens on. Three routes enter three
// independent APIs so that one failing tier costs one route's share of traffic,
// not all of it. Payment runs five replicas with two in zone-b: losing zone-b
// alone leaves three, which is exactly its minimum.
function checkoutWorld() {
    return {
        schemaVersion: 1,
        kind: MESH_WORLD,
        template: 'ops-checkout',
        zones: [{ id: 'zone-a' }, { id: 'zone-b' }, { id: 'zone-c' }],
        nodes: sixNodes(),
        services: [
            service('storefront', 'api', 3, 2, 300, 800),
            service('product-cache', 'cache', 3, 2, 250, 600),
            service('catalog-db', 'database', 1, 1, 450, 1500, { role: 'primary', volume: 'vol-catalog' }),
            service('checkout', 'api', 3, 2, 200, 900),
            service('payment', 'api', 5, 3, 120, 1200),
            service('ledger-db', 'database', 2, 1, 800, 1500, { role: 'primary', volume: 'vol-ledger' }),
            service('ledger-replica', 'database', 1, 1, 1000, 1500, { role: 'replica', volume: 'vol-ledger-replica' }),
            service('order-queue', 'queue', 3, 1, 400, 600, { queueCapacity: 1600 }),
            service('fulfillment', 'worker', 3, 1, 175, 900),
            service('account', 'api', 2, 1, 150, 700),
        ],
        volumes: [
            { id: 'vol-catalog', zone: 'zone-c', service: 'catalog-db' },
            { id: 'vol-ledger', zone: 'zone-a', service: 'ledger-db' },
            { id: 'vol-ledger-replica', zone: 'zone-c', service: 'ledger-replica' },
        ],
        routes: [
            { id: 'browse', sharePct: 50, entry: 'storefront' },
            { id: 'checkout', sharePct: 35, entry: 'checkout' },
            { id: 'account', sharePct: 15, entry: 'account' },
        ],
        dependencies: [
            { type: 'READS_THROUGH', from: 'storefront', to: 'product-cache' },
            { type: 'BACKED_BY', from: 'product-cache', to: 'catalog-db' },
            { type: 'CALLS', from: 'checkout', to: 'payment' },
            { type: 'PUBLISHES', from: 'checkout', to: 'order-queue' },
            { type: 'WRITES', from: 'payment', to: 'ledger-db' },
            { type: 'REPLICATES', from: 'ledger-db', to: 'ledger-replica' },
            { type: 'CONSUMES', from: 'fulfillment', to: 'order-queue' },
            { type: 'WRITES', from: 'fulfillment', to: 'ledger-db' },
            { type: 'READS', from: 'account', to: 'ledger-replica' },
        ],
        placement: {
            storefront: ['node-a1', 'node-b1', 'node-c1'],
            'product-cache': ['node-a2', 'node-b2', 'node-c2'],
            'catalog-db': ['node-c1'],
            checkout: ['node-a1', 'node-b2', 'node-c2'],
            payment: ['node-a1', 'node-b1', 'node-b2', 'node-c1', 'node-c2'],
            'ledger-db': ['node-a1', 'node-a2'],
            'ledger-replica': ['node-c2'],
            'order-queue': ['node-a1', 'node-b1', 'node-c1'],
            fulfillment: ['node-a2', 'node-b2', 'node-c1'],
            account: ['node-b1', 'node-c2'],
        },
        traffic: { rps: 1000 },
        errorBudgetPct: 20,
    };
}

// Async order pipeline: the write path is decoupled by a queue, so a database
// failover shows up as queue backlog before it shows up as failed requests.
function ordersWorld() {
    return {
        schemaVersion: 1,
        kind: MESH_WORLD,
        template: 'ops-orders',
        zones: [{ id: 'zone-a' }, { id: 'zone-b' }, { id: 'zone-c' }],
        nodes: sixNodes(),
        services: [
            service('orders-api', 'api', 3, 2, 350, 800),
            service('order-queue', 'queue', 2, 1, 600, 600, { queueCapacity: 2400 }),
            service('order-worker', 'worker', 4, 1, 200, 900),
            service('orders-db', 'database', 1, 1, 900, 1500, { role: 'primary', volume: 'vol-orders' }),
            service('orders-replica', 'database', 1, 1, 900, 1500, { role: 'replica', volume: 'vol-orders-replica' }),
            service('status-api', 'api', 2, 1, 400, 700),
        ],
        volumes: [
            { id: 'vol-orders', zone: 'zone-a', service: 'orders-db' },
            { id: 'vol-orders-replica', zone: 'zone-b', service: 'orders-replica' },
        ],
        routes: [
            { id: 'place-order', sharePct: 60, entry: 'orders-api' },
            { id: 'order-status', sharePct: 40, entry: 'status-api' },
        ],
        dependencies: [
            { type: 'PUBLISHES', from: 'orders-api', to: 'order-queue' },
            { type: 'CONSUMES', from: 'order-worker', to: 'order-queue' },
            { type: 'WRITES', from: 'order-worker', to: 'orders-db' },
            { type: 'REPLICATES', from: 'orders-db', to: 'orders-replica' },
            { type: 'READS', from: 'status-api', to: 'orders-replica' },
        ],
        placement: {
            'orders-api': ['node-a1', 'node-b1', 'node-c1'],
            'order-queue': ['node-b2', 'node-c2'],
            'order-worker': ['node-a1', 'node-b1', 'node-c1', 'node-c2'],
            'orders-db': ['node-a2'],
            'orders-replica': ['node-b2'],
            'status-api': ['node-a1', 'node-c2'],
        },
        traffic: { rps: 1000 },
        errorBudgetPct: 20,
    };
}

const LABELS = {
    storefront: 'Storefront API',
    'product-cache': 'Product cache',
    'catalog-db': 'Catalog DB',
    checkout: 'Checkout API',
    payment: 'Payment API',
    'ledger-db': 'Ledger DB (primary)',
    'ledger-replica': 'Ledger DB (replica)',
    'order-queue': 'Order queue',
    fulfillment: 'Fulfillment worker',
    account: 'Account API',
    'orders-api': 'Orders API',
    'order-worker': 'Order worker',
    'orders-db': 'Orders DB (primary)',
    'orders-replica': 'Orders DB (replica)',
    'status-api': 'Order status API',
};

// Invariants are parameters of the observation functions in invariants.js;
// every value maps onto state the simulator already computes.
const SCENARIOS = [
    {
        id: 'checkout',
        name: 'Checkout stack',
        summary: 'Storefront reads through a product cache; checkout calls payment and publishes orders to a queue; payment and fulfillment write a replicated ledger.',
        build: checkoutWorld,
        versions: {
            storefront: 'v18', 'product-cache': 'v7', checkout: 'v33', payment: 'v41',
            fulfillment: 'v12', account: 'v9', 'order-queue': 'v3', 'catalog-db': 'pg15', 'ledger-db': 'pg15', 'ledger-replica': 'pg15',
        },
        criticalRoute: 'checkout',
        invariants: [
            { id: 'route-checkout', kind: 'route-available', route: 'checkout' },
            { id: 'error-budget', kind: 'error-budget', maxPct: 20 },
            { id: 'payment-healthy', kind: 'min-healthy', service: 'payment', min: 3 },
            { id: 'queue-backlog', kind: 'queue-backlog', queue: 'order-queue', max: 1000 },
            { id: 'ledger-failover', kind: 'failover-deadline', database: 'ledger-db', maxMs: 2000 },
        ],
    },
    {
        id: 'orders',
        name: 'Async order pipeline',
        summary: 'Orders are accepted into a queue and written by workers to a replicated orders database; order status reads the replica.',
        build: ordersWorld,
        versions: { 'orders-api': 'v27', 'order-queue': 'v3', 'order-worker': 'v15', 'orders-db': 'pg15', 'orders-replica': 'pg15', 'status-api': 'v6' },
        criticalRoute: 'place-order',
        invariants: [
            { id: 'route-place-order', kind: 'route-available', route: 'place-order' },
            { id: 'error-budget', kind: 'error-budget', maxPct: 20 },
            { id: 'queue-backlog', kind: 'queue-backlog', queue: 'order-queue', max: 1500 },
            { id: 'orders-failover', kind: 'failover-deadline', database: 'orders-db', maxMs: 2000 },
        ],
    },
];

// One-click demos. Each configures a real scenario, change, fault model and
// budget; the verdict is whatever the search finds.
const DEMOS = [
    {
        id: 'rollout-payment',
        title: 'Roll out payment v42',
        caption: 'maxSurge 1 · maxUnavailable 1 · zone, node and traffic faults',
        scenario: 'checkout',
        change: { type: 'rollout', service: 'payment', toVersion: 'v42', maxSurge: 1, maxUnavailable: 1 },
        faults: ['zone-degraded', 'readiness-delay', 'traffic-spike'],
        budget: 'standard',
        useCase: 'before-deploy',
    },
    {
        id: 'drain-zone-b',
        title: 'Drain zone B',
        caption: 'maintenance drain, one node every 1.5 s',
        scenario: 'checkout',
        change: { type: 'drain-zone', zone: 'zone-b', intervalMs: 1500 },
        faults: ['node-crash', 'traffic-spike'],
        budget: 'standard',
        useCase: 'before-maintenance',
    },
    {
        id: 'fail-primary-db',
        title: 'Fail over the orders database',
        caption: 'planned primary failover · async writes absorb it, until they don\'t',
        scenario: 'orders',
        change: { type: 'db-failover', database: 'orders-db' },
        faults: ['node-crash', 'traffic-spike', 'consumer-stall'],
        budget: 'standard',
        useCase: 'before-maintenance',
    },
    {
        id: 'spike-checkout',
        title: 'Spike checkout traffic',
        caption: 'cost cut: fulfillment workers 3 → 2 before an order surge',
        scenario: 'checkout',
        change: { type: 'scale', service: 'fulfillment', replicas: 2 },
        faults: ['traffic-spike', 'consumer-stall', 'node-crash'],
        budget: 'standard',
        useCase: 'before-deploy',
    },
    {
        id: 'cache-rollout',
        title: 'Break cache during rollout',
        caption: 'product-cache v7 → v8 while a cache node can fail',
        scenario: 'checkout',
        change: { type: 'rollout', service: 'product-cache', toVersion: 'v8', maxSurge: 0, maxUnavailable: 1 },
        faults: ['node-crash', 'cache-loss', 'traffic-spike'],
        budget: 'standard',
        useCase: 'chaos-regression',
    },
];

const USE_CASES = [
    { id: 'before-deploy', title: 'Before deploy', copy: 'Verify rollout + traffic + infrastructure failure combinations.', demo: 'rollout-payment', mode: 'verify' },
    { id: 'before-maintenance', title: 'Before maintenance', copy: 'Test node and zone drains against availability invariants.', demo: 'drain-zone-b', mode: 'verify' },
    { id: 'during-incident', title: 'During incident', copy: 'Reproduce the failure and shrink it to its causal core.', mode: 'incident' },
    { id: 'architecture-review', title: 'Architecture review', copy: 'Compare equivalent-looking dependency graphs under identical faults.', mode: 'architecture' },
    { id: 'sre-guardrail', title: 'Autonomous SRE guardrail', copy: 'Verify a proposed remediation before allowing execution.', demo: 'rollout-payment', mode: 'verify', remediate: true },
    { id: 'chaos-regression', title: 'Chaos regression', copy: 'Turn every discovered failure into a deterministic replay test.', demo: 'cache-rollout', mode: 'verify' },
];

function scenarioById(id) {
    return SCENARIOS.find((scenario) => scenario.id === id) || null;
}

function listScenarios() {
    return SCENARIOS.map(({ id, name, summary, criticalRoute }) => ({ id, name, summary, criticalRoute }));
}

/** A fresh, validated copy of a scenario's world and metadata. */
function loadScenario(id) {
    const scenario = scenarioById(id);
    if (!scenario) throw new TypeError(`unknown scenario: ${id}`);
    const world = scenario.build();
    validateWorld(world);
    return {
        id: scenario.id,
        name: scenario.name,
        summary: scenario.summary,
        world,
        versions: { ...scenario.versions },
        labels: Object.fromEntries(world.services.map((item) => [item.id, LABELS[item.id] || item.id])),
        criticalRoute: scenario.criticalRoute,
        invariants: scenario.invariants.map((item) => ({ ...item })),
    };
}

function demoById(id) {
    return DEMOS.find((demo) => demo.id === id) || null;
}

module.exports = {
    DEMOS,
    LABELS,
    SCENARIOS,
    USE_CASES,
    demoById,
    listScenarios,
    loadScenario,
    scenarioById,
};
