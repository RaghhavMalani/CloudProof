'use strict';

/**
 * Ten real workloads over one causal event engine.
 *
 * A workload is intentionally not a page component. It owns the deterministic
 * state transition, its invariants, its measurements, its trace explanation,
 * and a small visual model. The Flight Deck is only a renderer of this
 * contract, which keeps the examples coherent as the lab grows.
 */

const { createEvent } = require('../protocol/events');
const { HnswIndex } = require('../../replica/hnsw');
const { createExtendedWorkloads } = require('./extended');

const REQUIRED_INTERFACE = Object.freeze([
    'actions',
    'applyCommittedEntry',
    'invariants',
    'metrics',
    'explainEvent',
    'visualization',
]);

function pass(id, summary, evidence = {}) {
    return { id, status: 'pass', ok: true, summary, evidence };
}

function fail(id, summary, evidence = {}) {
    return { id, status: 'fail', ok: false, summary, evidence };
}

function watch(id, summary, evidence = {}) {
    return { id, status: 'watch', ok: true, summary, evidence };
}

function validateWorkload(workload) {
    const missing = REQUIRED_INTERFACE.filter((name) => {
        if (name === 'actions') return !Array.isArray(workload?.actions);
        return typeof workload?.[name] !== 'function';
    });
    if (missing.length > 0) throw new TypeError(`workload is missing: ${missing.join(', ')}`);
    if (!workload.id || !workload.name || typeof workload.createState !== 'function') {
        throw new TypeError('workload requires id, name, and createState');
    }
    return workload;
}

function resolve(value, state, context) {
    return typeof value === 'function' ? value(state, context) : value;
}

function runWorkload(workload, { seed = 42, timeKind = 'virtual' } = {}) {
    validateWorkload(workload);
    const state = workload.createState(seed);
    const events = [];
    const eventByKey = new Map();
    const runId = `${timeKind}-${workload.id}-${seed}`;

    for (const [offset, action] of workload.actions.entries()) {
        const context = { seed, events, action, offset };
        const before = workload.visualization(state, { events, action });
        const entry = resolve(action.entry, state, context);
        const effect = entry == null
            ? null
            : workload.applyCommittedEntry(state, entry, { action, events, seed });
        const after = workload.visualization(state, { events, action });
        const data = {
            lane: action.lane || 'commits',
            label: action.label || action.type,
            detail: resolve(action.detail, state, { ...context, effect }),
            actor: action.actor || workload.id,
            target: action.target || null,
            semantic: true,
            process: resolve(action.process, state, context) || null,
            network: resolve(action.network, state, context) || null,
            raftRole: resolve(action.raftRole, state, context) || null,
            entry,
            effect,
            before,
            after,
            ...resolve(action.data, state, { ...context, effect }),
        };
        const cause = action.causedBy ? eventByKey.get(action.causedBy) : events.at(-1);
        const event = createEvent({
            runId,
            sequence: events.length + 1,
            epochMs: Number(action.atMs ?? offset * 40),
            startedAt: 0,
            timeKind,
            type: action.type,
            source: { component: action.actor || workload.id, nodeId: action.nodeId || null },
            subject: { kind: action.subjectKind || 'semantic-step', id: action.key || action.type },
            correlationId: action.correlationId || `${workload.id}-scenario`,
            causationId: cause?.id || null,
            data,
        });
        events.push(event);
        eventByKey.set(action.key || action.type, event);
    }

    const checks = workload.invariants(state, events);
    for (const check of checks) {
        events.push(createEvent({
            runId,
            sequence: events.length + 1,
            epochMs: (events.at(-1)?.time.epochMs || 0) + 1,
            startedAt: 0,
            timeKind,
            type: 'invariant.checked',
            source: { component: 'invariant-checker' },
            subject: { kind: 'invariant', id: check.id },
            correlationId: `${workload.id}-scenario`,
            causationId: events.at(-1)?.id || null,
            data: { ...check, lane: 'invariants', label: check.summary, semantic: true },
        }));
    }

    return {
        workload,
        seed,
        state,
        events,
        invariants: checks,
        metrics: workload.metrics(state, events),
        visualization: workload.visualization(state, { events }),
    };
}

function makeNode(id, process, network, raftRole, detail, accent = 'green') {
    return { id, label: id, process, network, raftRole, detail, accent };
}

// ---------------------------------------------------------------------------
// 1. Configuration and coordination
// ---------------------------------------------------------------------------

function configurationState() {
    return {
        revision: 5,
        commitIndex: 10,
        store: new Map([
            ['desired/api', { value: { image: 'api:v1', replicas: 2 }, rev: 5 }],
        ]),
        leases: new Map(),
        changes: [],
        controller: { connected: true, checkpoint: 0, observed: [], reconciled: [] },
        members: ['node0', 'node1', 'node2'],
        configurationHistory: [['node0', 'node1', 'node2']],
        linearizableReadIndex: -1,
        casResults: [],
    };
}

function applyConfiguration(state, entry) {
    switch (entry.op) {
        case 'lease-acquire': {
            const current = state.leases.get(entry.key);
            const ok = !current || current.holder === entry.holder;
            if (ok) state.leases.set(entry.key, { holder: entry.holder, ttlMs: entry.ttlMs });
            return { ok, holder: ok ? entry.holder : current.holder };
        }
        case 'cas': {
            const current = state.store.get(entry.key) || null;
            const actualRev = current?.rev || 0;
            const ok = actualRev === entry.expectRev;
            if (ok) {
                state.revision += 1;
                state.commitIndex += 1;
                const record = { value: entry.value, rev: state.revision };
                state.store.set(entry.key, record);
                state.changes.push({ key: entry.key, value: entry.value, rev: state.revision });
            }
            state.casResults.push({ key: entry.key, expectRev: entry.expectRev, actualRev, ok });
            return { ok, actualRev, rev: state.revision };
        }
        case 'set': {
            state.revision += 1;
            state.commitIndex += 1;
            const record = { value: entry.value, rev: state.revision };
            state.store.set(entry.key, record);
            state.changes.push({ key: entry.key, value: entry.value, rev: state.revision });
            return { ok: true, key: entry.key, rev: state.revision };
        }
        case 'watch-open':
            state.controller.connected = true;
            state.controller.checkpoint = entry.since;
            return { ok: true, since: entry.since };
        case 'watch-disconnect':
            state.controller.connected = false;
            return { ok: true, checkpoint: state.controller.checkpoint };
        case 'watch-resume': {
            state.controller.connected = true;
            const replayed = state.changes.filter((change) => change.rev > entry.since);
            state.controller.observed.push(...replayed.filter(
                (change) => !state.controller.observed.some((seen) => seen.rev === change.rev),
            ));
            state.controller.checkpoint = replayed.at(-1)?.rev || entry.since;
            return { ok: true, since: entry.since, revisions: replayed.map((change) => change.rev) };
        }
        case 'watch-deliver': {
            const change = state.changes.find((item) => item.rev === entry.revision);
            if (change && !state.controller.observed.some((seen) => seen.rev === change.rev)) {
                state.controller.observed.push(change);
                state.controller.checkpoint = change.rev;
            }
            return { ok: Boolean(change), revision: entry.revision };
        }
        case 'reconcile':
            state.controller.reconciled = state.controller.observed.map((change) => change.rev);
            return { ok: true, revisions: state.controller.reconciled.slice() };
        case 'linearizable-read':
            state.linearizableReadIndex = state.commitIndex;
            return { ok: true, readIndex: state.linearizableReadIndex, value: state.store.get(entry.key)?.value };
        case 'membership':
            state.commitIndex += 1;
            state.members = entry.members.slice();
            state.configurationHistory.push(entry.members.slice());
            return { ok: true, members: state.members.slice() };
        default:
            return { ok: true, observedOnly: true };
    }
}

const configuration = {
    id: 'configuration',
    name: 'Configuration & coordination',
    shortName: 'Coordination',
    question: 'Can a controller disconnect, resume from a revision, and reconcile every desired-state change exactly once?',
    scenario: 'Controller watch disconnect + revision resume',
    createState: configurationState,
    applyCommittedEntry: applyConfiguration,
    actions: [
        { atMs: 0, key: 'lease', type: 'lease.acquired', lane: 'clients', actor: 'controller', target: 'leader', label: 'Controller lock acquired', detail: 'controller-a owns /locks/api for 5 s of logical time.', entry: { op: 'lease-acquire', key: '/locks/api', holder: 'controller-a', ttlMs: 5000 } },
        { atMs: 18, key: 'cas', type: 'client.cas.accepted', lane: 'clients', actor: 'controller', target: 'leader', label: 'CAS establishes desired state', detail: 'expectRev 5 matches; desired/api becomes revision 6.', entry: { op: 'cas', key: 'desired/api', expectRev: 5, value: { image: 'api:v1', replicas: 3 } } },
        { atMs: 32, key: 'watch-open', type: 'watch.stream.opened', lane: 'clients', actor: 'controller', target: 'leader', label: 'Watch starts at revision 6', detail: 'The checkpoint is durable client state, not a socket offset.', entry: { op: 'watch-open', since: 6 } },
        { atMs: 54, key: 'append', type: 'raft.log.appended', lane: 'commits', actor: 'node0', nodeId: 'node0', target: 'node1', label: 'Desired update appended', detail: 'AppendEntries carries one command after index 11.', raftRole: 'leader', data: { rpc: 'AppendEntries', term: 4, index: 12, beforeLog: ['…', '11:t4 CAS desired/api'], afterLog: ['…', '11:t4 CAS desired/api', '12:t4 SET desired/api'] } },
        { atMs: 68, type: 'storage.entry.persisted', lane: 'nodes', actor: 'node1', nodeId: 'node1', target: 'disk-1', label: 'Follower persists index 12', detail: 'The follower acknowledges only after durable append.', raftRole: 'follower' },
        { atMs: 76, type: 'quorum.reached', lane: 'commits', actor: 'node0', target: 'cluster', label: '2 of 3 replicas acknowledge', detail: 'node0 + node1 form the required majority.', data: { live: 3, required: 2, configured: 3, index: 12 } },
        { atMs: 82, key: 'set7', type: 'state.machine.applied', lane: 'commits', actor: 'node0', target: 'kv', label: 'Revision 7 becomes visible', detail: 'image changes to api:v2 at committed index 12.', entry: { op: 'set', key: 'desired/api', value: { image: 'api:v2', replicas: 3 } }, data: (_state, { effect }) => ({ revision: effect.rev, index: 12 }) },
        { atMs: 94, type: 'watch.event.delivered', lane: 'clients', actor: 'leader', target: 'controller', label: 'Controller observes revision 7', detail: 'The watch advances its checkpoint only after delivery.', entry: { op: 'watch-deliver', revision: 7 } },
        { atMs: 126, key: 'disconnect', type: 'network.disconnected', lane: 'faults', actor: 'network', target: 'controller', label: 'Watch transport disconnects', detail: 'The process is healthy; only the controller-to-leader link is unavailable.', entry: { op: 'watch-disconnect' }, process: 'up', network: 'disconnected' },
        { atMs: 164, key: 'set8', type: 'state.machine.applied', lane: 'commits', actor: 'node0', target: 'kv', label: 'Revision 8 commits while offline', detail: 'replicas changes to 4 while the controller is disconnected.', entry: { op: 'set', key: 'desired/api', value: { image: 'api:v2', replicas: 4 } }, data: (_state, { effect }) => ({ revision: effect.rev }) },
        { atMs: 196, key: 'set9', type: 'state.machine.applied', lane: 'commits', actor: 'node0', target: 'kv', label: 'Revision 9 commits while offline', detail: 'image changes to api:v3; the watch socket still does not exist.', entry: { op: 'set', key: 'desired/api', value: { image: 'api:v3', replicas: 4 } }, data: (_state, { effect }) => ({ revision: effect.rev }) },
        { atMs: 244, key: 'resume', type: 'watch.stream.resumed', lane: 'clients', actor: 'controller', target: 'leader', label: 'Resume from revision 7', detail: (_state, { effect }) => `The server replays revisions ${effect.revisions.join(' and ')} from the revisioned history.`, entry: { op: 'watch-resume', since: 7 }, network: 'connected' },
        { atMs: 272, type: 'controller.reconciled', lane: 'clients', actor: 'controller', target: 'deployment/api', label: 'Controller reconciles current intent', detail: 'Observed revisions are coalesced safely; the final desired state is api:v3 × 4.', entry: { op: 'reconcile' } },
        { atMs: 298, type: 'read.index.confirmed', lane: 'commits', actor: 'node0', target: 'quorum', label: 'Linearizable read crosses ReadIndex', detail: 'The leader confirms authority with a quorum before returning revision 9.', entry: { op: 'linearizable-read', key: 'desired/api' }, data: (_state, { effect }) => ({ readIndex: effect.readIndex, value: effect.value }) },
        { atMs: 332, type: 'membership.committed', lane: 'commits', actor: 'node0', target: 'node3', label: 'Learner promoted one server at a time', detail: 'The new 4-node configuration retains majority intersection with the old one.', entry: { op: 'membership', members: ['node0', 'node1', 'node2', 'node3'] } },
    ],
    invariants(state) {
        const delivered = state.controller.observed.map((change) => change.rev);
        const expected = state.changes.filter((change) => change.rev >= 7 && change.rev <= 9).map((change) => change.rev);
        const noMiss = expected.every((rev) => delivered.includes(rev));
        const unique = new Set(delivered).size === delivered.length;
        const overlap = state.configurationHistory.every((members, index, history) => {
            if (index === 0) return true;
            const before = history[index - 1];
            return members.filter((member) => before.includes(member)).length >= 2;
        });
        return [
            noMiss && unique
                ? pass('resumable-watch', 'revisions 7–9 were delivered once across the disconnect', { expected, delivered })
                : fail('resumable-watch', 'the resumed watch missed or duplicated a revision', { expected, delivered }),
            state.casResults.every((result) => !result.ok || result.expectRev === result.actualRev)
                ? pass('cas-safety', 'every successful CAS matched the committed revision', { attempts: state.casResults })
                : fail('cas-safety', 'a CAS succeeded against the wrong revision'),
            state.leases.get('/locks/api')?.holder === 'controller-a'
                ? pass('lease-exclusivity', 'one execution holder owns /locks/api', { holder: 'controller-a' })
                : fail('lease-exclusivity', 'the controller lock has conflicting owners'),
            state.linearizableReadIndex === state.commitIndex - 1
                ? pass('linearizable-read', 'ReadIndex reached the latest data commit before membership changed', { readIndex: state.linearizableReadIndex })
                : fail('linearizable-read', 'the read returned behind its confirmed frontier'),
            overlap
                ? pass('configuration-overlap', 'the observed membership change retains majority intersection')
                : fail('configuration-overlap', 'successive configurations admit disjoint majorities'),
        ];
    },
    metrics(state) {
        return [
            { label: 'revision', value: state.revision, unit: 'committed' },
            { label: 'watch gap', value: 0, unit: 'missed' },
            { label: 'resume batch', value: 2, unit: 'events' },
            { label: 'read frontier', value: state.linearizableReadIndex, unit: 'index' },
        ];
    },
    explainEvent(event) {
        const explanations = {
            'raft.log.appended': 'node0 was the elected leader in term 4, so only it could append the client command. The trace links this append to the successful CAS and to the later follower persistence.',
            'quorum.reached': 'Index 12 became committable when node0 and node1 had both persisted the same term-4 entry. That is 2 live acknowledgements, 2 required, 3 configured.',
            'watch.stream.resumed': 'The controller retained checkpoint 7. The revisioned store selected every change with rev > 7, yielding revisions 8 and 9 with no dependence on the old TCP connection.',
            'membership.committed': 'node3 is added in a single-server change after catching up. The old and new voter majorities intersect, so two disjoint leaders cannot be elected.',
        };
        return explanations[event.type] || event.data.detail;
    },
    visualization(state) {
        const connected = state.controller.connected;
        return {
            title: `desired/api · revision ${state.revision}`,
            subtitle: `${state.members.length} configured voters · controller checkpoint ${state.controller.checkpoint}`,
            nodes: [
                makeNode('node0', 'up', 'connected', 'leader · t4', `commit ${state.commitIndex}`, 'green'),
                makeNode('node1', 'up', 'connected', 'follower · t4', `commit ${Math.max(0, state.commitIndex - 1)}`, 'blue'),
                makeNode('node2', 'up', 'connected', 'follower · t4', `commit ${Math.max(0, state.commitIndex - 1)}`, 'blue'),
                makeNode('controller', 'up', connected ? 'connected' : 'disconnected', 'client', `watch @ rev ${state.controller.checkpoint}`, connected ? 'amber' : 'red'),
            ],
            policy: 'Revision is the resume token; socket lifetime is irrelevant.',
        };
    },
};

// ---------------------------------------------------------------------------
// 2. Idempotent job and payment processing
// ---------------------------------------------------------------------------

function paymentState() {
    return {
        ledgerCents: 0,
        results: new Map(),
        deliveryAttempts: new Map(),
        queueDepth: 0,
        queueLimit: 100,
        responseLost: false,
        deadlinesExceeded: 0,
        deadLetters: [],
        commitIndex: 20,
    };
}

function applyPayment(state, entry) {
    switch (entry.op) {
        case 'deliver': {
            const count = (state.deliveryAttempts.get(entry.requestId) || 0) + 1;
            state.deliveryAttempts.set(entry.requestId, count);
            return { ok: true, attempt: count };
        }
        case 'charge': {
            const prior = state.results.get(entry.requestId);
            if (prior) return { ...prior, duplicate: true };
            state.ledgerCents += entry.amountCents;
            state.commitIndex += 1;
            const result = { ok: true, requestId: entry.requestId, effectId: `ledger-${state.commitIndex}`, amountCents: entry.amountCents };
            state.results.set(entry.requestId, result);
            return { ...result, duplicate: false };
        }
        case 'lose-response':
            state.responseLost = true;
            return { ok: true, lostAfterCommit: state.commitIndex };
        case 'deadline':
            state.deadlinesExceeded += 1;
            return { ok: true, retryable: true };
        case 'enqueue':
            state.queueDepth = entry.depth;
            return { ok: state.queueDepth <= state.queueLimit, depth: state.queueDepth, limit: state.queueLimit };
        case 'dead-letter':
            state.deadLetters.push({ requestId: entry.requestId, reason: entry.reason, attempts: entry.attempts });
            return { ok: true, queue: 'payments.dlq' };
        default:
            return { ok: true };
    }
}

const payment = {
    id: 'payment',
    name: 'Idempotent job & payment processor',
    shortName: 'Payments',
    question: 'Can at-least-once delivery produce exactly-once ledger effects when the reply is lost after commit?',
    scenario: 'Commit succeeds, reply is lost, gateway retries',
    createState: paymentState,
    applyCommittedEntry: applyPayment,
    actions: [
        { atMs: 0, key: 'client', type: 'client.request.started', lane: 'clients', actor: 'checkout', target: 'gateway', label: 'Charge request starts', detail: 'Request pay-7 carries a stable idempotency key and a 900 ms deadline.', correlationId: 'pay-7', data: { requestId: 'pay-7', deadlineMs: 900, amountCents: 4200 } },
        { atMs: 16, key: 'gateway', type: 'gateway.request.accepted', lane: 'clients', actor: 'gateway', target: 'leader', label: 'Gateway accepts pay-7', detail: 'Queue depth is below the admission limit, so work is forwarded.', correlationId: 'pay-7', entry: { op: 'enqueue', depth: 63 }, data: (state) => ({ depth: state.queueDepth, limit: state.queueLimit }) },
        { atMs: 34, key: 'delivery1', type: 'queue.message.delivered', lane: 'clients', actor: 'queue', target: 'worker-a', label: 'At-least-once delivery · attempt 1', detail: 'The queue promises redelivery until it observes an acknowledgement.', correlationId: 'pay-7', entry: { op: 'deliver', requestId: 'pay-7' } },
        { atMs: 48, key: 'append-payment', type: 'raft.log.appended', lane: 'commits', actor: 'node0', nodeId: 'node0', target: 'node1', label: 'Leader appends charge(pay-7)', detail: 'The request ID is part of the replicated command.', correlationId: 'pay-7', raftRole: 'leader', data: { term: 8, index: 21, beforeLog: ['…', '20:t8 NOOP'], afterLog: ['…', '20:t8 NOOP', '21:t8 CHARGE pay-7 ₹42.00'] } },
        { atMs: 62, key: 'persist', type: 'storage.entry.persisted', lane: 'nodes', actor: 'node1', nodeId: 'node1', target: 'disk-1', label: 'Follower fsyncs index 21', detail: 'Persistence precedes the success acknowledgement.', correlationId: 'pay-7', raftRole: 'follower' },
        { atMs: 78, key: 'quorum', type: 'quorum.reached', lane: 'commits', actor: 'node0', target: 'cluster', label: 'Quorum reaches index 21', detail: 'node0 + node1 persisted the entry: 2 live · 2 required · 3 configured.', correlationId: 'pay-7', data: { live: 2, required: 2, configured: 3, index: 21 } },
        { atMs: 84, key: 'commit', type: 'raft.commit.advanced', lane: 'commits', actor: 'node0', target: 'state-machine', label: 'Commit index advances to 21', detail: 'The effect is now durable even if every client connection disappears.', correlationId: 'pay-7', data: { fromIndex: 20, toIndex: 21, term: 8 } },
        { atMs: 91, key: 'effect', type: 'state.machine.applied', lane: 'commits', actor: 'node0', target: 'ledger', label: 'Ledger effect applies once', detail: '₹42.00 is recorded under pay-7 and its result is cached in replicated state.', correlationId: 'pay-7', entry: { op: 'charge', requestId: 'pay-7', amountCents: 4200 }, data: (_state, { effect }) => ({ effectId: effect.effectId, duplicate: effect.duplicate }) },
        { atMs: 108, key: 'lost', type: 'network.response.lost', lane: 'faults', actor: 'network', target: 'gateway', label: 'Success reply is lost', detail: 'The packet disappears after the commit and state-machine effect.', correlationId: 'pay-7', causedBy: 'effect', entry: { op: 'lose-response' }, network: 'packet lost', process: 'up' },
        { atMs: 900, key: 'deadline', type: 'client.deadline.exceeded', lane: 'clients', actor: 'gateway', target: 'queue', label: 'Gateway deadline expires', detail: 'No reply arrived before 900 ms; retry policy reuses request ID pay-7.', correlationId: 'pay-7', causedBy: 'lost', entry: { op: 'deadline' } },
        { atMs: 934, key: 'delivery2', type: 'queue.message.redelivered', lane: 'clients', actor: 'queue', target: 'worker-b', label: 'At-least-once delivery · attempt 2', detail: 'A different worker receives the same logical request.', correlationId: 'pay-7', entry: { op: 'deliver', requestId: 'pay-7' } },
        { atMs: 952, key: 'dedup', type: 'dedup.duplicate.suppressed', lane: 'commits', actor: 'node0', target: 'gateway', label: 'Duplicate is suppressed', detail: 'The replicated result for pay-7 is returned; no second log effect is created.', correlationId: 'pay-7', entry: { op: 'charge', requestId: 'pay-7', amountCents: 4200 }, data: (_state, { effect }) => ({ duplicate: effect.duplicate, effectId: effect.effectId }) },
        { atMs: 966, type: 'client.request.completed', lane: 'clients', actor: 'gateway', target: 'checkout', label: 'Original result is replayed', detail: 'The client receives effect ledger-21 from the deduplication record.', correlationId: 'pay-7' },
        { atMs: 1010, key: 'pressure', type: 'queue.backpressure.applied', lane: 'faults', actor: 'gateway', target: 'producer', label: 'Backpressure rejects excess work', detail: 'Depth 118 exceeds the configured limit 100; the producer receives retry-after.', correlationId: 'pressure-demo', entry: { op: 'enqueue', depth: 118 }, data: (state) => ({ depth: state.queueDepth, limit: state.queueLimit }) },
        { atMs: 1050, type: 'queue.poison.quarantined', lane: 'faults', actor: 'worker-c', target: 'payments.dlq', label: 'Poison message is quarantined', detail: 'bad-json exceeded 5 deterministic attempts and leaves the hot queue.', correlationId: 'poison-1', entry: { op: 'dead-letter', requestId: 'poison-1', reason: 'schema-invalid', attempts: 5 } },
    ],
    invariants(state) {
        const result = state.results.get('pay-7');
        const attempts = state.deliveryAttempts.get('pay-7') || 0;
        return [
            state.ledgerCents === 4200 && state.results.size === 1
                ? pass('exactly-once-effect', '2 deliveries produced 1 ledger mutation', { deliveries: attempts, effects: state.results.size, ledgerCents: state.ledgerCents })
                : fail('exactly-once-effect', 'the retried request changed the ledger more than once'),
            result?.effectId === 'ledger-21'
                ? pass('stable-result', 'the retry returned the original committed effect ID', { effectId: result?.effectId })
                : fail('stable-result', 'the duplicate did not resolve to the original result'),
            state.deadLetters.length === 1
                ? pass('poison-isolation', 'the poison message left the active queue after 5 attempts', state.deadLetters[0])
                : fail('poison-isolation', 'poison work remains in the hot retry loop'),
            state.queueDepth > state.queueLimit
                ? pass('bounded-admission', 'over-limit queue depth activated backpressure', { depth: state.queueDepth, limit: state.queueLimit })
                : watch('bounded-admission', 'the execution did not reach the backpressure threshold'),
        ];
    },
    metrics(state) {
        return [
            { label: 'deliveries', value: state.deliveryAttempts.get('pay-7'), unit: 'attempts' },
            { label: 'ledger effects', value: state.results.size, unit: 'committed' },
            { label: 'deadline', value: state.deadlinesExceeded, unit: 'expired' },
            { label: 'dead letters', value: state.deadLetters.length, unit: 'quarantined' },
        ];
    },
    explainEvent(event) {
        if (event.type === 'raft.commit.advanced') return 'Index 21 was committed because the trace contains durable acknowledgements from node0 and node1 in term 8. Two acknowledgements satisfy the configured majority of three.';
        if (event.type === 'network.response.lost') return 'The causal parent is state.machine.applied, so the loss is strictly after the ledger mutation. The missing reply creates uncertainty for the client, not uncertainty in replicated state.';
        if (event.type === 'dedup.duplicate.suppressed') return 'The retry carries the same request ID pay-7. Replicated dedup state already maps pay-7 to ledger-21, so the leader returns that result without appending another charge.';
        if (event.type === 'queue.backpressure.applied') return 'Admission compares queue depth 118 with limit 100. Rejecting before enqueue bounds memory and prevents retry traffic from starving committed work.';
        return event.data.detail;
    },
    visualization(state) {
        return {
            title: 'pay-7 · ₹42.00',
            subtitle: `${state.deliveryAttempts.get('pay-7') || 0} deliveries · ${state.results.size} durable effect`,
            nodes: [
                makeNode('gateway', 'up', state.responseLost ? 'reply lost' : 'connected', 'client router', `queue ${state.queueDepth}/${state.queueLimit}`, 'amber'),
                makeNode('node0', 'up', 'connected', 'leader · t8', `commit ${state.commitIndex}`, 'green'),
                makeNode('node1', 'up', 'connected', 'follower · t8', 'persisted 21', 'blue'),
                makeNode('worker-b', 'up', 'connected', 'consumer', 'retry pay-7', 'purple'),
            ],
            policy: 'Delivery is at least once; the ledger effect is exactly once by replicated request-ID deduplication.',
        };
    },
};

// ---------------------------------------------------------------------------
// 3. Distributed vector search using the existing HNSW implementation
// ---------------------------------------------------------------------------

function vectorState(seed) {
    const dim = 8;
    const indexes = Array.from({ length: 3 }, () => new HnswIndex({
        dim, M: 4, efConstruction: 24, storage: 'int8', traversal: 'binary', rescoreFactor: 4,
    }));
    const vectors = [
        [1,.1,0,0,0,0,0,0],[.96,.2,0,0,0,0,0,0],[.92,.3,.1,0,0,0,0,0],
        [.86,.4,0,.1,0,0,0,0],[.8,.5,.1,0,0,0,0,0],[.72,.6,0,.1,0,0,0,0],
        [.62,.7,.1,0,0,0,0,0],[.52,.8,0,.1,0,0,0,0],[.42,.9,.1,0,0,0,0,0],
        [.3,.95,0,.1,0,0,0,0],[.2,.98,.1,0,0,0,0,0],[.1,1,0,.1,0,0,0,0],
        [.75,.2,.5,0,0,0,0,0],[.68,.25,.6,0,0,0,0,0],[.6,.3,.7,0,0,0,0,0],
        [.52,.35,.78,0,0,0,0,0],[.46,.4,.82,0,0,0,0,0],[.4,.45,.86,0,0,0,0,0],
    ];
    vectors.forEach((vector, index) => {
        const shard = index % 3;
        indexes[shard].upsert(`doc-${String(index).padStart(2, '0')}`, vector, {
            tenant: index % 5 === 0 ? 'other' : 'acme',
            category: index % 2 ? 'catalog' : 'support',
            shard,
        });
    });
    const query = [1,0,0,0,0,0,0,0];
    const filter = (payload) => payload.tenant === 'acme';
    const shardResults = indexes.map((index) => index.search(query, 4, 12, { filter }));
    const exactResults = indexes.flatMap((index) => index.searchExact(query, 6, { filter }))
        .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, 5);
    return {
        seed,
        indexes,
        query,
        filter,
        shardResults,
        exactResults,
        received: new Map(),
        timedOut: new Set(),
        merged: [],
        policy: 'return-marked',
        deadlineMs: 120,
        candidates: 0,
        latencyMs: 0,
    };
}

function applyVector(state, entry) {
    switch (entry.op) {
        case 'query-start':
            state.received.clear();
            state.timedOut.clear();
            state.merged = [];
            state.candidates = 0;
            return { ok: true, shards: 3, topK: entry.k };
        case 'shard-result': {
            const hits = state.shardResults[entry.shard];
            state.received.set(entry.shard, hits);
            state.candidates += entry.candidates;
            state.latencyMs = Math.max(state.latencyMs, entry.latencyMs);
            return { ok: true, shard: entry.shard, hits: hits.map((hit) => hit.id), candidates: entry.candidates };
        }
        case 'shard-timeout':
            state.timedOut.add(entry.shard);
            state.latencyMs = state.deadlineMs;
            return { ok: false, shard: entry.shard, timeout: true };
        case 'merge':
            state.merged = [...state.received.values()].flat()
                .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
                .slice(0, entry.k);
            return { ok: true, hits: state.merged.map((hit) => hit.id), incomplete: state.timedOut.size > 0 };
        default:
            return { ok: true };
    }
}

const vectorSearch = {
    id: 'vector-search',
    name: 'Distributed vector search',
    shortName: 'Vector search',
    question: 'How should global top-K behave when one filtered HNSW shard misses the deadline?',
    scenario: 'Shard 1 is slow during a filtered global top-K query',
    createState: vectorState,
    applyCommittedEntry: applyVector,
    actions: [
        { atMs: 0, key: 'fanout', type: 'search.fanout.started', lane: 'clients', actor: 'query-router', target: 'shards[0..2]', label: 'Query fans out to 3 shards', detail: 'topK=5, ef=12, tenant=acme, deadline=120 ms.', correlationId: 'search-12', entry: { op: 'query-start', k: 5 }, data: { topK: 5, ef: 12, filter: 'tenant = acme', deadlineMs: 120 } },
        { atMs: 18, key: 'traverse0', type: 'hnsw.traversal.filtered', lane: 'nodes', actor: 'shard0', target: 'hnsw-0', label: 'Shard 0 traverses with filter', detail: 'Non-matching nodes remain graph bridges; admission filtering happens during the walk.', correlationId: 'search-12', data: { shard: 0, filterStage: 'during-traversal', storage: 'int8', traversal: 'binary + rescore' } },
        { atMs: 31, key: 'shard0', type: 'search.shard.completed', lane: 'nodes', actor: 'shard0', target: 'query-router', label: 'Shard 0 returns 4 candidates', detail: (_state, { effect }) => `Candidates: ${effect.hits.join(', ')}.`, correlationId: 'search-12', entry: { op: 'shard-result', shard: 0, candidates: 12, latencyMs: 31 } },
        { atMs: 35, key: 'slow', type: 'fault.latency.injected', lane: 'faults', actor: 'network', target: 'shard1', label: 'Shard 1 becomes slow', detail: 'The process remains up and its HNSW role is unchanged; only response latency is degraded.', correlationId: 'search-12', process: 'up', network: 'slow · 240 ms' },
        { atMs: 42, key: 'traverse2', type: 'hnsw.traversal.filtered', lane: 'nodes', actor: 'shard2', target: 'hnsw-2', label: 'Shard 2 traverses with filter', detail: 'Binary codes drive the walk; int8 vectors rescore the candidate beam.', correlationId: 'search-12', data: { shard: 2, filterStage: 'during-traversal', rescoreFactor: 4 } },
        { atMs: 58, key: 'shard2', type: 'search.shard.completed', lane: 'nodes', actor: 'shard2', target: 'query-router', label: 'Shard 2 returns 4 candidates', detail: (_state, { effect }) => `Candidates: ${effect.hits.join(', ')}.`, correlationId: 'search-12', entry: { op: 'shard-result', shard: 2, candidates: 12, latencyMs: 58 } },
        { atMs: 120, key: 'timeout', type: 'search.shard.timedout', lane: 'faults', actor: 'query-router', target: 'shard1', label: 'Shard 1 misses the deadline', detail: 'The router stops waiting at 120 ms; the late result is not silently merged.', correlationId: 'search-12', causedBy: 'slow', entry: { op: 'shard-timeout', shard: 1 } },
        { atMs: 121, key: 'policy', type: 'search.partial.policy.applied', lane: 'commits', actor: 'query-router', target: 'client', label: 'Return marked partial results', detail: 'Policy=return-marked returns available hits with incomplete=true and missingShards=[1].', correlationId: 'search-12', data: { policy: 'return-marked', incomplete: true, missingShards: [1] } },
        { atMs: 124, key: 'merge', type: 'search.global.topk.merged', lane: 'commits', actor: 'query-router', target: 'client', label: 'Global top-K merges 2 shards', detail: (_state, { effect }) => `Stable score/id ordering selects ${effect.hits.join(', ')}.`, correlationId: 'search-12', entry: { op: 'merge', k: 5 }, data: (_state, { effect }) => ({ hits: effect.hits, incomplete: effect.incomplete }) },
        { atMs: 240, type: 'search.late.result.discarded', lane: 'faults', actor: 'shard1', target: 'query-router', label: 'Late shard result is discarded', detail: 'The response belongs to search-12 but arrives after its deadline and cannot mutate the completed answer.', correlationId: 'search-12' },
    ],
    invariants(state) {
        const unique = new Set(state.merged.map((hit) => hit.id)).size === state.merged.length;
        const allAcme = state.merged.every((hit) => hit.payload.tenant === 'acme');
        const fullTruth = new Set(state.exactResults.map((hit) => hit.id));
        const recalled = state.merged.filter((hit) => fullTruth.has(hit.id)).length;
        return [
            unique && state.merged.length <= 5
                ? pass('global-top-k', 'the merged answer is unique, bounded, and deterministically ordered', { ids: state.merged.map((hit) => hit.id) })
                : fail('global-top-k', 'the global merge duplicated or overfilled top-K'),
            allAcme
                ? pass('filter-safety', 'every returned hit satisfies tenant=acme', { tenant: 'acme' })
                : fail('filter-safety', 'a filtered-out tenant reached the client'),
            state.timedOut.has(1) && state.policy === 'return-marked'
                ? pass('partial-result-disclosure', 'the response names shard 1 as missing', { policy: state.policy, missingShards: [1] })
                : fail('partial-result-disclosure', 'an incomplete answer was presented as complete'),
            recalled < state.exactResults.length
                ? watch('recall-under-partial', 'recall is measured against the complete 3-shard exact answer', { recalled, truth: state.exactResults.length })
                : pass('recall-under-partial', 'partial execution happened to retain the complete exact top-K'),
        ];
    },
    metrics(state) {
        const fullTruth = new Set(state.exactResults.map((hit) => hit.id));
        const recall = state.merged.filter((hit) => fullTruth.has(hit.id)).length / Math.max(1, state.exactResults.length);
        const stats = state.indexes.map((index) => index.stats());
        const bytes = stats.reduce((sum, item) => sum + item.vectorBytes, 0);
        const floatBytes = stats.reduce((sum, item) => sum + item.float32Bytes, 0);
        return [
            { label: 'recall@5', value: `${Math.round(recall * 100)}%`, unit: 'full truth' },
            { label: 'latency', value: state.latencyMs, unit: 'ms deadline' },
            { label: 'candidates', value: state.candidates, unit: 'visited beam' },
            { label: 'vector memory', value: `${bytes} B`, unit: `${(floatBytes / Math.max(1, bytes)).toFixed(1)}× smaller` },
        ];
    },
    explainEvent(event) {
        if (event.type === 'hnsw.traversal.filtered') return 'The existing HNSW implementation traverses through filtered-out nodes but admits only matching payloads to results. This preserves graph connectivity while enforcing tenant filtering during traversal.';
        if (event.type === 'search.shard.timedout') return 'Shard 1 is process-up and reachable, but its sampled 240 ms response exceeds the 120 ms query deadline. The timeout is network/performance state, not a crash.';
        if (event.type === 'search.partial.policy.applied') return 'The policy is explicit in the trace: return available candidates, set incomplete=true, and list missing shard 1. A strict policy could instead fail the whole query.';
        if (event.type === 'search.global.topk.merged') return 'The router merges candidate lists by score, then external ID for stable ties. It does not average shard ranks, because scores share the same replicated vector space.';
        return event.data.detail;
    },
    visualization(state) {
        const stats = state.indexes.map((index) => index.stats());
        return {
            title: 'search-12 · topK 5',
            subtitle: `${state.received.size}/3 shards complete · policy ${state.policy}`,
            nodes: [
                makeNode('router', 'up', 'connected', 'fan-out + merge', `${state.candidates} candidates`, 'amber'),
                makeNode('shard0', 'up', 'connected', 'HNSW replica', `${stats[0].size} vectors · int8`, 'green'),
                makeNode('shard1', 'up', state.timedOut.has(1) ? 'slow · 240 ms' : 'connected', 'HNSW replica', `${stats[1].size} vectors · int8`, state.timedOut.has(1) ? 'red' : 'green'),
                makeNode('shard2', 'up', 'connected', 'HNSW replica', `${stats[2].size} vectors · int8`, 'green'),
            ],
            policy: 'Binary traversal reduces memory bandwidth; int8 rescoring recovers ranking quality. Partial results are always marked.',
        };
    },
};

// ---------------------------------------------------------------------------
// 4. Atomic model rollout
// ---------------------------------------------------------------------------

function rolloutState() {
    return {
        activeVersion: 'v1',
        stagedVersion: 'v2',
        commitIndex: 30,
        barrierOpen: false,
        pods: new Map([
            ['pod0', { process: 'up', network: 'connected', artifact: null, checksum: null, ready: false, active: 'v1' }],
            ['pod1', { process: 'up', network: 'connected', artifact: null, checksum: null, ready: false, active: 'v1' }],
            ['pod2', { process: 'up', network: 'slow', artifact: null, checksum: null, ready: false, active: 'v1' }],
        ]),
        responses: [{ requestId: 'q-before', embeddingVersion: 'v1', indexVersion: 'v1' }],
        corruptRejected: false,
        canaryPassed: false,
        rollbacks: 0,
    };
}

function applyRollout(state, entry) {
    switch (entry.op) {
        case 'download': {
            const pod = state.pods.get(entry.pod);
            pod.artifact = entry.version;
            pod.checksum = entry.checksum;
            pod.network = entry.slow ? 'slow' : 'connected';
            return { ok: true, pod: entry.pod, bytes: entry.bytes };
        }
        case 'checksum': {
            const pod = state.pods.get(entry.pod);
            const ok = pod.checksum === entry.expected;
            if (!ok) {
                pod.artifact = null;
                pod.ready = false;
                state.corruptRejected = true;
            }
            return { ok, expected: entry.expected, actual: pod.checksum };
        }
        case 'shadow-ready': {
            const pod = state.pods.get(entry.pod);
            pod.ready = pod.artifact === entry.version && pod.checksum === entry.checksum;
            return { ok: pod.ready, pod: entry.pod };
        }
        case 'canary':
            state.canaryPassed = entry.passed;
            return { ok: entry.passed, delta: entry.delta };
        case 'barrier': {
            const ready = [...state.pods.values()].filter((pod) => pod.ready).length;
            state.barrierOpen = ready === state.pods.size && state.canaryPassed;
            return { ok: state.barrierOpen, ready, required: state.pods.size, canaryPassed: state.canaryPassed };
        }
        case 'flip':
            if (!state.barrierOpen) return { ok: false, error: 'fleet barrier closed' };
            state.activeVersion = entry.version;
            state.commitIndex += 1;
            for (const pod of state.pods.values()) pod.active = entry.version;
            state.responses.push({ requestId: entry.requestId, embeddingVersion: entry.version, indexVersion: entry.version });
            return { ok: true, version: entry.version, commitIndex: state.commitIndex };
        case 'rollback':
            state.activeVersion = entry.version;
            state.commitIndex += 1;
            state.rollbacks += 1;
            for (const pod of state.pods.values()) pod.active = entry.version;
            state.responses.push({ requestId: entry.requestId, embeddingVersion: entry.version, indexVersion: entry.version });
            return { ok: true, version: entry.version, commitIndex: state.commitIndex };
        default:
            return { ok: true };
    }
}

const rollout = {
    id: 'rollout',
    name: 'Atomic model rollout',
    shortName: 'Model rollout',
    question: 'Can a fleet reject corruption and stragglers without any response mixing model versions?',
    scenario: 'One corrupt artifact, one slow pod, one atomic flip',
    createState: rolloutState,
    applyCommittedEntry: applyRollout,
    actions: [
        { atMs: 0, key: 'manifest', type: 'rollout.manifest.committed', lane: 'commits', actor: 'controller', target: 'consensus', label: 'v2 manifest commits', detail: 'Consensus records version, URI, size, and sha256=sha-v2 before pods download.', correlationId: 'rollout-v2', data: { version: 'v2', checksum: 'sha-v2', commitIndex: 30 } },
        { atMs: 24, type: 'artifact.download.completed', lane: 'nodes', actor: 'pod0', target: 'artifact-store', label: 'pod0 downloads v2', detail: '64 MiB arrives in 24 ms of virtual time.', correlationId: 'rollout-v2', entry: { op: 'download', pod: 'pod0', version: 'v2', checksum: 'sha-v2', bytes: 67108864 } },
        { atMs: 29, type: 'artifact.checksum.verified', lane: 'nodes', actor: 'pod0', target: 'shadow-slot', label: 'pod0 verifies checksum', detail: 'The artifact is eligible for shadow load but is not active.', correlationId: 'rollout-v2', entry: { op: 'checksum', pod: 'pod0', expected: 'sha-v2' } },
        { atMs: 32, key: 'corrupt', type: 'artifact.checksum.rejected', lane: 'faults', actor: 'pod1', target: 'artifact-store', label: 'pod1 rejects corrupt bytes', detail: 'Actual sha-corrupt differs from committed sha-v2; the shadow slot is cleared.', correlationId: 'rollout-v2', entry: { op: 'download', pod: 'pod1', version: 'v2', checksum: 'sha-corrupt', bytes: 67108864 }, data: { expected: 'sha-v2', actual: 'sha-corrupt' } },
        { atMs: 33, type: 'artifact.checksum.failed', lane: 'faults', actor: 'pod1', target: 'controller', label: 'Corruption blocks readiness', detail: 'pod1 cannot acknowledge the fleet barrier with an unverified artifact.', correlationId: 'rollout-v2', causedBy: 'corrupt', entry: { op: 'checksum', pod: 'pod1', expected: 'sha-v2' } },
        { atMs: 38, key: 'slow-pod', type: 'artifact.download.slow', lane: 'faults', actor: 'network', target: 'pod2', label: 'pod2 download is slow', detail: 'pod2 remains process-up; artifact transfer is the only degraded dimension.', correlationId: 'rollout-v2', process: 'up', network: 'slow' },
        { atMs: 51, type: 'shadow.readiness.passed', lane: 'nodes', actor: 'pod0', target: 'controller', label: 'pod0 shadow is ready', detail: 'Warm-up query and index checksum both pass for v2.', correlationId: 'rollout-v2', entry: { op: 'shadow-ready', pod: 'pod0', version: 'v2', checksum: 'sha-v2' } },
        { atMs: 72, type: 'artifact.download.retried', lane: 'nodes', actor: 'pod1', target: 'artifact-store', label: 'pod1 retries clean artifact', detail: 'The retry fetches bytes whose checksum matches the consensus manifest.', correlationId: 'rollout-v2', entry: { op: 'download', pod: 'pod1', version: 'v2', checksum: 'sha-v2', bytes: 67108864 } },
        { atMs: 76, type: 'artifact.checksum.verified', lane: 'nodes', actor: 'pod1', target: 'shadow-slot', label: 'pod1 verifies retry', detail: 'Only verified bytes enter the shadow slot.', correlationId: 'rollout-v2', entry: { op: 'checksum', pod: 'pod1', expected: 'sha-v2' } },
        { atMs: 86, type: 'shadow.readiness.passed', lane: 'nodes', actor: 'pod1', target: 'controller', label: 'pod1 shadow is ready', detail: 'Two of three pods now acknowledge v2.', correlationId: 'rollout-v2', entry: { op: 'shadow-ready', pod: 'pod1', version: 'v2', checksum: 'sha-v2' } },
        { atMs: 92, type: 'canary.evaluation.passed', lane: 'commits', actor: 'controller', target: 'metrics', label: 'Canary evaluation passes', detail: 'Error-rate delta +0.02% is within the committed +0.10% budget.', correlationId: 'rollout-v2', entry: { op: 'canary', passed: true, delta: 0.0002 }, data: { errorRateDelta: 0.0002, budget: 0.001 } },
        { atMs: 100, key: 'barrier-blocked', type: 'fleet.barrier.blocked', lane: 'invariants', actor: 'controller', target: 'consensus', label: 'Fleet barrier remains closed', detail: (_state, { effect }) => `${effect.ready}/${effect.required} pods are ready; pod2 is still downloading.`, correlationId: 'rollout-v2', entry: { op: 'barrier' }, data: (_state, { effect }) => ({ ready: effect.ready, required: effect.required }) },
        { atMs: 184, type: 'artifact.download.completed', lane: 'nodes', actor: 'pod2', target: 'artifact-store', label: 'Slow pod2 finishes download', detail: 'The delayed transfer completes without changing the active v1 pointer.', correlationId: 'rollout-v2', entry: { op: 'download', pod: 'pod2', version: 'v2', checksum: 'sha-v2', bytes: 67108864, slow: false } },
        { atMs: 190, type: 'artifact.checksum.verified', lane: 'nodes', actor: 'pod2', target: 'shadow-slot', label: 'pod2 verifies checksum', detail: 'All three pods now hold identical verified bytes.', correlationId: 'rollout-v2', entry: { op: 'checksum', pod: 'pod2', expected: 'sha-v2' } },
        { atMs: 204, type: 'shadow.readiness.passed', lane: 'nodes', actor: 'pod2', target: 'controller', label: 'pod2 shadow is ready', detail: 'Warm-up and readiness propagation finish at the straggler.', correlationId: 'rollout-v2', entry: { op: 'shadow-ready', pod: 'pod2', version: 'v2', checksum: 'sha-v2' } },
        { atMs: 208, key: 'barrier-open', type: 'fleet.barrier.opened', lane: 'invariants', actor: 'controller', target: 'consensus', label: 'Fleet barrier opens', detail: '3 ready · 3 required · canary passed.', correlationId: 'rollout-v2', entry: { op: 'barrier' }, data: (_state, { effect }) => ({ ready: effect.ready, required: effect.required }) },
        { atMs: 216, key: 'flip-append', type: 'raft.log.appended', lane: 'commits', actor: 'node0', nodeId: 'node0', target: 'node1', label: 'model/current=v2 appended', detail: 'The pointer flip is one consensus entry, not three pod-local writes.', correlationId: 'rollout-v2', raftRole: 'leader', data: { term: 11, index: 31, beforeLog: ['…', '30:t11 STAGE v2'], afterLog: ['…', '30:t11 STAGE v2', '31:t11 ACTIVATE v2'] } },
        { atMs: 232, type: 'quorum.reached', lane: 'commits', actor: 'node0', target: 'cluster', label: 'Activation reaches quorum', detail: '2 live · 2 required · 3 configured commit model/current=v2.', correlationId: 'rollout-v2', data: { live: 2, required: 2, configured: 3, index: 31 } },
        { atMs: 238, key: 'flip', type: 'model.version.flipped', lane: 'commits', actor: 'consensus', target: 'fleet', label: 'Atomic pointer flips to v2', detail: 'Every response binds embedding and index handles from the same immutable version slot.', correlationId: 'rollout-v2', entry: { op: 'flip', version: 'v2', requestId: 'q-after' } },
        { atMs: 310, key: 'regression', type: 'canary.regression.detected', lane: 'faults', actor: 'metrics', target: 'controller', label: 'Post-flip regression triggers rollback', detail: 'The retired v1 slot is still verified and warm, so rollback needs no artifact download.', correlationId: 'rollout-v2' },
        { atMs: 326, type: 'model.version.rollback', lane: 'commits', actor: 'consensus', target: 'fleet', label: 'Atomic rollback restores v1', detail: 'A second committed pointer entry moves every request to the intact v1 slot.', correlationId: 'rollout-v2', causedBy: 'regression', entry: { op: 'rollback', version: 'v1', requestId: 'q-rollback' } },
    ],
    invariants(state) {
        const mixed = state.responses.filter((response) => response.embeddingVersion !== response.indexVersion);
        const oneActive = [...state.pods.values()].every((pod) => pod.active === state.activeVersion);
        return [
            mixed.length === 0
                ? pass('no-mixed-version-response', 'every observed response used one model version end to end', { responses: state.responses })
                : fail('no-mixed-version-response', 'a response combined embedding and index versions', { mixed }),
            state.corruptRejected
                ? pass('artifact-integrity', 'the corrupt artifact never entered a ready shadow slot')
                : fail('artifact-integrity', 'corrupt bytes were eligible for activation'),
            state.barrierOpen
                ? pass('fleet-barrier', 'activation was enabled only after 3/3 shadow acknowledgements')
                : fail('fleet-barrier', 'the rollout flipped before all pods were ready'),
            oneActive
                ? pass('atomic-pointer', `all pods expose the committed ${state.activeVersion} pointer after rollback`, { active: state.activeVersion })
                : fail('atomic-pointer', 'pods expose different active pointers'),
        ];
    },
    metrics(state) {
        return [
            { label: 'corrupt artifacts', value: state.corruptRejected ? 1 : 0, unit: 'rejected' },
            { label: 'barrier wait', value: 208, unit: 'ms virtual' },
            { label: 'mixed responses', value: state.responses.filter((r) => r.embeddingVersion !== r.indexVersion).length, unit: 'observed' },
            { label: 'rollbacks', value: state.rollbacks, unit: 'atomic' },
        ];
    },
    explainEvent(event) {
        if (event.type === 'fleet.barrier.blocked') return 'The barrier reducer counts verified, shadow-ready pods. At this event only pod0 and pod1 qualify; pod2 is process-up but still downloading, so activation is structurally impossible.';
        if (event.type === 'artifact.checksum.failed') return 'The expected digest comes from consensus metadata. pod1 computed sha-corrupt, cleared its shadow slot, and therefore cannot contribute a readiness acknowledgement.';
        if (event.type === 'model.version.flipped') return 'The trace shows a single committed ACTIVATE v2 entry after the fleet barrier opened. Each request captures one immutable version slot, so embedding and index handles cannot straddle the flip.';
        if (event.type === 'model.version.rollback') return 'Rollback is another consensus pointer commit to the still-warm v1 slot. No pod downloads or mutates model files on the request path.';
        return event.data.detail;
    },
    visualization(state) {
        return {
            title: `model/current · ${state.activeVersion}`,
            subtitle: `${[...state.pods.values()].filter((pod) => pod.ready).length}/3 shadow-ready · barrier ${state.barrierOpen ? 'open' : 'closed'}`,
            nodes: [
                makeNode('controller', 'up', 'connected', 'rollout coordinator', state.canaryPassed ? 'canary passed' : 'canary pending', 'amber'),
                ...[...state.pods.entries()].map(([id, pod]) => makeNode(
                    id, pod.process, pod.network, `serving ${pod.active}`,
                    pod.ready ? 'v2 shadow ready' : pod.artifact ? 'verifying v2' : 'v2 unavailable',
                    pod.ready ? 'green' : pod.network === 'slow' ? 'red' : 'blue',
                )),
            ],
            policy: 'Artifact bytes move independently; only the consensus pointer changes serving state.',
        };
    },
};

// ---------------------------------------------------------------------------
// 5. Live streaming entitlement and playback session state
// ---------------------------------------------------------------------------

/**
 * The distributed-systems problem inside a streaming service is not video.
 *
 * It is that two pieces of per-viewer state must survive a leader failover with
 * different guarantees. Playback position must be **monotonic** — a viewer who
 * is 42 minutes into a match must never be sent backwards because a stale
 * heartbeat arrived late. Concurrent streams must obey a **capacity bound** —
 * a two-device plan must not become three devices because the cluster was
 * mid-election when the third asked.
 *
 * Neither is idempotency (payments), atomicity (rollout), or completeness
 * (search). Monotonicity and capacity are their own failure class, and the
 * classic way to get them wrong is to keep the counter in leader-local memory,
 * where a deposed leader still believes it has room to admit one more.
 */
function streamingState() {
    return {
        deviceLimit: 2,
        leaderEpoch: 1,
        commitIndex: 40,
        sessions: new Map(),
        positionHistory: new Map(),
        admitted: [],
        refused: [],
        staleHeartbeats: 0,
        rebuffers: 0,
        bitrateKbps: 8000,
        peakConcurrent: 0,
    };
}

function activeStreams(state) {
    return [...state.sessions.values()].filter((session) => session.active).length;
}

function applyStreaming(state, entry) {
    switch (entry.op) {
        case 'admit': {
            // Fencing first. An admission authored under an older leader epoch
            // is refused even if capacity exists, because the entry was created
            // by a leader that has already been replaced and whose view of the
            // stream count may be arbitrarily stale.
            if (entry.epoch < state.leaderEpoch) {
                const refusal = { sessionId: entry.sessionId, reason: 'stale-epoch', epoch: entry.epoch };
                state.refused.push(refusal);
                return { ok: false, ...refusal, currentEpoch: state.leaderEpoch };
            }
            const active = activeStreams(state);
            if (active >= state.deviceLimit) {
                const refusal = { sessionId: entry.sessionId, reason: 'device-limit', active, limit: state.deviceLimit };
                state.refused.push(refusal);
                return { ok: false, ...refusal };
            }
            state.commitIndex += 1;
            state.sessions.set(entry.sessionId, {
                device: entry.device, positionMs: 0, active: true, admittedAtIndex: state.commitIndex,
            });
            state.positionHistory.set(entry.sessionId, [0]);
            state.admitted.push({ sessionId: entry.sessionId, device: entry.device, index: state.commitIndex });
            state.peakConcurrent = Math.max(state.peakConcurrent, activeStreams(state));
            return { ok: true, sessionId: entry.sessionId, active: activeStreams(state), limit: state.deviceLimit };
        }
        case 'heartbeat': {
            const session = state.sessions.get(entry.sessionId);
            if (!session || !session.active) return { ok: false, reason: 'no-session' };
            // Monotonicity. A heartbeat that would move the viewer backwards is
            // discarded rather than applied — out-of-order delivery is normal,
            // and rewinding a live stream is a visible, unrecoverable defect.
            if (entry.positionMs <= session.positionMs) {
                state.staleHeartbeats += 1;
                return { ok: false, reason: 'nonmonotonic', held: session.positionMs, offered: entry.positionMs };
            }
            session.positionMs = entry.positionMs;
            state.positionHistory.get(entry.sessionId).push(entry.positionMs);
            state.commitIndex += 1;
            return { ok: true, positionMs: session.positionMs };
        }
        case 'leaderepoch':
            state.leaderEpoch = entry.epoch;
            return { ok: true, epoch: state.leaderEpoch };
        case 'release': {
            const session = state.sessions.get(entry.sessionId);
            if (session) { session.active = false; state.commitIndex += 1; }
            return { ok: Boolean(session), active: activeStreams(state) };
        }
        case 'bitrate':
            state.bitrateKbps = entry.kbps;
            return { ok: true, kbps: entry.kbps };
        case 'rebuffer':
            state.rebuffers += 1;
            return { ok: true, rebuffers: state.rebuffers };
        default:
            return { ok: true };
    }
}

const streaming = {
    id: 'streaming',
    name: 'Live streaming entitlement & playback',
    shortName: 'Streaming',
    question: 'Can a two-device limit and a monotonic playback position both survive a leader failover mid-match?',
    scenario: 'Stale leader admits a third device while a late heartbeat rewinds playback',
    createState: streamingState,
    applyCommittedEntry: applyStreaming,
    actions: [
        { atMs: 0, key: 'tv', type: 'session.stream.admitted', lane: 'clients', actor: 'living-room-tv', target: 'entitlement', label: 'TV starts the live match', detail: 'Session count becomes 1 of 2 in replicated state, not in leader memory.', correlationId: 'viewer-88', entry: { op: 'admit', sessionId: 'tv', device: 'living-room-tv', epoch: 1 }, data: (_s, { effect }) => ({ active: effect.active, limit: effect.limit }) },
        { atMs: 40, key: 'hb1', type: 'playback.position.advanced', lane: 'clients', actor: 'living-room-tv', target: 'entitlement', label: 'Playback reaches 00:30', detail: 'Heartbeats carry an absolute position so redelivery cannot double-count.', correlationId: 'viewer-88', entry: { op: 'heartbeat', sessionId: 'tv', positionMs: 30000 }, data: (_s, { effect }) => ({ positionMs: effect.positionMs }) },
        { atMs: 78, key: 'phone', type: 'session.stream.admitted', lane: 'clients', actor: 'phone', target: 'entitlement', label: 'Phone joins as the second device', detail: 'The plan allows 2 concurrent streams; both are now committed.', correlationId: 'viewer-88', entry: { op: 'admit', sessionId: 'phone', device: 'phone', epoch: 1 }, data: (_s, { effect }) => ({ active: effect.active, limit: effect.limit }) },
        { atMs: 96, key: 'laptop1', type: 'session.stream.refused', lane: 'commits', actor: 'laptop', target: 'entitlement', label: 'Third device is refused', detail: 'The capacity check is evaluated against committed state, so the answer is the same on every replica.', correlationId: 'viewer-88', entry: { op: 'admit', sessionId: 'laptop', device: 'laptop', epoch: 1 }, data: (_s, { effect }) => ({ reason: effect.reason, active: effect.active, limit: effect.limit }) },
        { atMs: 140, key: 'congestion', type: 'fault.bandwidth.degraded', lane: 'faults', actor: 'network', target: 'phone', label: 'Uplink congestion hits the phone', detail: 'The process is healthy; only available bandwidth changes.', correlationId: 'viewer-88', process: 'up', network: 'slow · 1.2 Mbps', entry: { op: 'bitrate', kbps: 1200 } },
        { atMs: 152, type: 'playback.rebuffer.started', lane: 'faults', actor: 'phone', target: 'player', label: 'Phone rebuffers once', detail: 'The ladder drops from 8000 to 1200 kbps. Quality degrades; correctness does not.', correlationId: 'viewer-88', causedBy: 'congestion', entry: { op: 'rebuffer' } },
        { atMs: 210, key: 'partition', type: 'fault.partition.injected', lane: 'faults', actor: 'network', target: 'node0', label: 'Entitlement leader is isolated', detail: 'node0 keeps believing it leads. It cannot reach a majority, so it cannot commit anything.', correlationId: 'viewer-88', process: 'up', network: 'partitioned', raftRole: 'stale leader' },
        { atMs: 268, key: 'failover', type: 'raft.leader.elected', lane: 'commits', actor: 'node1', nodeId: 'node1', target: 'cluster', label: 'node1 wins term 2', detail: 'The surviving majority elects a new leader and bumps the entitlement epoch.', correlationId: 'viewer-88', causedBy: 'partition', raftRole: 'leader', entry: { op: 'leaderepoch', epoch: 2 }, data: { term: 2, live: 2, required: 2, configured: 3 } },
        { atMs: 296, key: 'stalead', type: 'session.stream.refused', lane: 'invariants', actor: 'node0', target: 'entitlement', label: 'Stale leader cannot admit a third stream', detail: 'node0 authored this admission at epoch 1. The committed epoch is 2, so it is fenced out before capacity is even considered.', correlationId: 'viewer-88', causedBy: 'failover', entry: { op: 'admit', sessionId: 'laptop', device: 'laptop', epoch: 1 }, data: (_s, { effect }) => ({ reason: effect.reason, authoredEpoch: 1, currentEpoch: effect.currentEpoch }) },
        { atMs: 318, key: 'latehb', type: 'playback.position.rejected', lane: 'invariants', actor: 'living-room-tv', target: 'entitlement', label: 'Late heartbeat would rewind playback', detail: 'A heartbeat stamped 00:12 arrives after 00:30 was committed. Applying it would send the viewer backwards.', correlationId: 'viewer-88', entry: { op: 'heartbeat', sessionId: 'tv', positionMs: 12000 }, data: (_s, { effect }) => ({ held: effect.held, offered: effect.offered, reason: effect.reason }) },
        { atMs: 352, key: 'hb2', type: 'playback.position.advanced', lane: 'clients', actor: 'living-room-tv', target: 'entitlement', label: 'Playback resumes at 01:02', detail: 'Forward progress continues under the new leader with no gap in session state.', correlationId: 'viewer-88', entry: { op: 'heartbeat', sessionId: 'tv', positionMs: 62000 }, data: (_s, { effect }) => ({ positionMs: effect.positionMs }) },
        { atMs: 404, key: 'tvoff', type: 'session.stream.released', lane: 'clients', actor: 'living-room-tv', target: 'entitlement', label: 'TV stops watching', detail: 'Capacity is returned to the plan by a committed release, not by a timeout guess.', correlationId: 'viewer-88', entry: { op: 'release', sessionId: 'tv' }, data: (_s, { effect }) => ({ active: effect.active }) },
        { atMs: 438, key: 'laptop2', type: 'session.stream.admitted', lane: 'clients', actor: 'laptop', target: 'entitlement', label: 'Laptop is admitted now', detail: 'The same request that was refused twice succeeds once capacity genuinely exists.', correlationId: 'viewer-88', entry: { op: 'admit', sessionId: 'laptop', device: 'laptop', epoch: 2 }, data: (_s, { effect }) => ({ active: effect.active, limit: effect.limit }) },
        { atMs: 470, type: 'fault.partition.healed', lane: 'faults', actor: 'network', target: 'node0', label: 'Old leader rejoins as a follower', detail: 'node0 discovers term 2, steps down, and replays the entries it missed.', correlationId: 'viewer-88', network: 'connected', raftRole: 'follower' },
    ],
    invariants(state) {
        const rewinds = [...state.positionHistory.entries()].filter(([, history]) =>
            history.some((position, index) => index > 0 && position < history[index - 1]));
        const staleEpochRefusals = state.refused.filter((item) => item.reason === 'stale-epoch');
        const limitRefusals = state.refused.filter((item) => item.reason === 'device-limit');
        return [
            rewinds.length === 0
                ? pass('monotonic-playback', 'every session position moved forward only', { sessions: [...state.positionHistory.keys()] })
                : fail('monotonic-playback', 'a committed heartbeat moved playback backwards', { rewinds }),
            state.peakConcurrent <= state.deviceLimit
                ? pass('concurrent-stream-limit', `peak concurrency ${state.peakConcurrent} never exceeded the ${state.deviceLimit}-device plan`, { peak: state.peakConcurrent, limit: state.deviceLimit })
                : fail('concurrent-stream-limit', 'more streams were admitted than the plan allows', { peak: state.peakConcurrent }),
            staleEpochRefusals.length > 0
                ? pass('stale-leader-fenced', 'an admission authored by the deposed leader was rejected on epoch', staleEpochRefusals[0])
                : watch('stale-leader-fenced', 'this execution did not exercise a stale-epoch admission'),
            state.staleHeartbeats > 0
                ? pass('out-of-order-heartbeat-discarded', `${state.staleHeartbeats} late heartbeat(s) were discarded rather than applied`, { discarded: state.staleHeartbeats })
                : watch('out-of-order-heartbeat-discarded', 'no reordered heartbeat arrived in this execution'),
            limitRefusals.length > 0
                ? pass('capacity-refusal-is-committed', 'the limit was enforced from replicated state, so every replica agrees', limitRefusals[0])
                : watch('capacity-refusal-is-committed', 'capacity was never contended in this execution'),
        ];
    },
    metrics(state) {
        const tv = state.positionHistory.get('tv') || [0];
        return [
            { label: 'concurrent', value: `${activeStreams(state)}/${state.deviceLimit}`, unit: 'streams' },
            { label: 'peak position', value: `${Math.round(Math.max(...tv) / 1000)}s`, unit: 'monotonic' },
            { label: 'refused', value: state.refused.length, unit: 'admissions' },
            { label: 'rebuffers', value: state.rebuffers, unit: `${state.bitrateKbps} kbps` },
        ];
    },
    explainEvent(event) {
        const explanations = {
            'session.stream.refused': 'The device count lives in the replicated state machine, not in the leader process. Any replica evaluating this entry reaches the same verdict, which is why a failover cannot create a window where the limit is briefly wrong.',
            'raft.leader.elected': 'node1 collected votes from the majority side of the partition. Bumping the entitlement epoch on election is what makes every in-flight decision authored by node0 identifiable as stale.',
            'playback.position.rejected': 'Heartbeats are absolute positions, not deltas, so a late one is detectable by comparison alone. The state machine holds 30000 ms and the arriving entry offers 12000 ms, so it is discarded — a delta-based design would have silently rewound the viewer.',
            'fault.bandwidth.degraded': 'Bandwidth is a network dimension. The phone process is up and its session is still valid; only the bitrate ladder responds. Conflating this with a crash is how availability metrics become meaningless.',
        };
        return explanations[event.type] || event.data.detail;
    },
    visualization(state) {
        const active = activeStreams(state);
        const tv = state.sessions.get('tv');
        const phone = state.sessions.get('phone');
        const laptop = state.sessions.get('laptop');
        const seconds = (session) => (session ? `${Math.round(session.positionMs / 1000)}s` : 'idle');
        return {
            title: `viewer-88 · ${active}/${state.deviceLimit} streams`,
            subtitle: `entitlement epoch ${state.leaderEpoch} · ${state.refused.length} refused · ${state.rebuffers} rebuffer`,
            nodes: [
                makeNode('node0', 'up', state.leaderEpoch > 1 ? 'partitioned' : 'connected',
                    state.leaderEpoch > 1 ? 'stale leader · t1' : 'leader · t1',
                    `epoch ${Math.min(1, state.leaderEpoch)}`, state.leaderEpoch > 1 ? 'red' : 'green'),
                makeNode('node1', 'up', 'connected', state.leaderEpoch > 1 ? 'leader · t2' : 'follower · t1',
                    `commit ${state.commitIndex}`, state.leaderEpoch > 1 ? 'green' : 'blue'),
                makeNode('living-room-tv', tv?.active ? 'up' : 'stopped', 'connected', 'viewer device', seconds(tv), tv?.active ? 'green' : 'blue'),
                makeNode('phone', 'up', state.bitrateKbps < 8000 ? 'slow · 1.2 Mbps' : 'connected', 'viewer device', seconds(phone), state.bitrateKbps < 8000 ? 'amber' : 'green'),
                makeNode('laptop', laptop?.active ? 'up' : 'waiting', 'connected', 'viewer device',
                    laptop?.active ? seconds(laptop) : `refused ×${state.refused.filter((r) => r.sessionId === 'laptop').length}`,
                    laptop?.active ? 'green' : 'red'),
            ],
            policy: 'Position is monotonic and absolute; capacity is committed state fenced by leader epoch.',
        };
    },
};

// ---------------------------------------------------------------------------
// 6. Ride dispatch: exactly-one assignment with fencing tokens
// ---------------------------------------------------------------------------

/**
 * Matching one rider to one driver looks like a lease, and mostly is — until a
 * driver accepts an offer that already expired.
 *
 * That is the case that separates a correct dispatcher from a plausible one. An
 * offer times out, the ride is re-offered to somebody else, and *then* the
 * original driver's accept arrives, delayed by a slow uplink. Both drivers now
 * believe they have the ride. A timestamp comparison is not enough, because the
 * two decisions were made under different views of the world.
 *
 * The fix is a **fencing token**: every offer carries a monotonically
 * increasing epoch, and an accept naming a superseded epoch is rejected on
 * sight. This is the same shape as the entitlement epoch in the streaming
 * workload and the `expectRev` in a CAS, applied to a physical resource where a
 * double booking sends two cars to one address.
 */
function dispatchState() {
    return {
        commitIndex: 50,
        offerEpoch: 0,
        offers: new Map(),
        assignments: new Map(),
        driverBusy: new Map(),
        rejectedAccepts: [],
        expiredOffers: [],
        surgeMultiplier: 1,
        matchAttempts: 0,
    };
}

function applyDispatch(state, entry) {
    switch (entry.op) {
        case 'offer': {
            state.offerEpoch += 1;
            state.matchAttempts += 1;
            state.commitIndex += 1;
            state.offers.set(entry.rideId, { driver: entry.driver, epoch: state.offerEpoch, ttlMs: entry.ttlMs });
            return { ok: true, driver: entry.driver, epoch: state.offerEpoch, ttlMs: entry.ttlMs };
        }
        case 'expire': {
            const offer = state.offers.get(entry.rideId);
            if (!offer) return { ok: false, reason: 'no-offer' };
            state.offers.delete(entry.rideId);
            state.expiredOffers.push({ rideId: entry.rideId, driver: offer.driver, epoch: offer.epoch });
            return { ok: true, driver: offer.driver, epoch: offer.epoch };
        }
        case 'accept': {
            const offer = state.offers.get(entry.rideId);
            // Fencing. An accept is valid only for the offer epoch currently
            // outstanding. A late accept from a superseded offer names an older
            // epoch and is refused before anything else is considered.
            if (!offer || offer.epoch !== entry.epoch) {
                const rejection = {
                    rideId: entry.rideId, driver: entry.driver, offeredEpoch: entry.epoch,
                    currentEpoch: offer ? offer.epoch : null, reason: 'stale-offer-epoch',
                };
                state.rejectedAccepts.push(rejection);
                return { ok: false, ...rejection };
            }
            if (state.driverBusy.has(entry.driver)) {
                const rejection = {
                    rideId: entry.rideId, driver: entry.driver, reason: 'driver-already-assigned',
                    heldBy: state.driverBusy.get(entry.driver),
                };
                state.rejectedAccepts.push(rejection);
                return { ok: false, ...rejection };
            }
            if (state.assignments.has(entry.rideId)) {
                const rejection = { rideId: entry.rideId, driver: entry.driver, reason: 'ride-already-assigned' };
                state.rejectedAccepts.push(rejection);
                return { ok: false, ...rejection };
            }
            state.commitIndex += 1;
            state.offers.delete(entry.rideId);
            state.assignments.set(entry.rideId, { driver: entry.driver, index: state.commitIndex, epoch: entry.epoch });
            state.driverBusy.set(entry.driver, entry.rideId);
            return { ok: true, driver: entry.driver, rideId: entry.rideId, index: state.commitIndex };
        }
        case 'complete': {
            const assignment = state.assignments.get(entry.rideId);
            if (!assignment) return { ok: false, reason: 'not-assigned' };
            state.driverBusy.delete(assignment.driver);
            state.commitIndex += 1;
            return { ok: true, driver: assignment.driver };
        }
        case 'surge':
            state.surgeMultiplier = entry.multiplier;
            return { ok: true, multiplier: entry.multiplier };
        default:
            return { ok: true };
    }
}

const dispatch = {
    id: 'dispatch',
    name: 'Ride dispatch & driver assignment',
    shortName: 'Dispatch',
    question: 'When an offer times out and is reassigned, can the original driver still accept it?',
    scenario: 'Offer expires, ride is reassigned, the first driver accepts late',
    createState: dispatchState,
    applyCommittedEntry: applyDispatch,
    actions: [
        { atMs: 0, key: 'request', type: 'ride.request.received', lane: 'clients', actor: 'rider-31', target: 'matcher', label: 'Rider requests a car', detail: 'Three drivers are within the search radius; the matcher will offer them one at a time.', correlationId: 'ride-9', data: { rideId: 'ride-9', candidates: ['driver-a', 'driver-b', 'driver-c'], radiusM: 1200 } },
        { atMs: 22, key: 'surge', type: 'pricing.surge.applied', lane: 'clients', actor: 'matcher', target: 'rider-31', label: 'Surge multiplier 1.4× quoted', detail: 'Demand exceeds nearby supply. Pricing is quoted before assignment so the fare cannot change under the rider.', correlationId: 'ride-9', entry: { op: 'surge', multiplier: 1.4 } },
        { atMs: 40, key: 'offer1', type: 'dispatch.offer.issued', lane: 'commits', actor: 'matcher', target: 'driver-a', label: 'Offer 1 goes to driver-a', detail: (_s, { effect }) => `Offer epoch ${effect.epoch} with a ${effect.ttlMs} ms acceptance window.`, correlationId: 'ride-9', entry: { op: 'offer', rideId: 'ride-9', driver: 'driver-a', ttlMs: 12000 }, data: (_s, { effect }) => ({ epoch: effect.epoch, driver: effect.driver }) },
        { atMs: 96, key: 'uplink', type: 'fault.uplink.degraded', lane: 'faults', actor: 'network', target: 'driver-a', label: 'driver-a loses signal in a tunnel', detail: 'The phone is running and the driver taps accept. The packet simply does not arrive yet.', correlationId: 'ride-9', process: 'up', network: 'disconnected' },
        { atMs: 12040, key: 'expire', type: 'dispatch.offer.expired', lane: 'faults', actor: 'matcher', target: 'driver-a', label: 'Offer 1 expires unanswered', detail: 'The matcher must reassign or the rider waits forever. It cannot know whether driver-a accepted.', correlationId: 'ride-9', causedBy: 'uplink', entry: { op: 'expire', rideId: 'ride-9' }, data: (_s, { effect }) => ({ driver: effect.driver, epoch: effect.epoch }) },
        { atMs: 12080, key: 'offer2', type: 'dispatch.offer.issued', lane: 'commits', actor: 'matcher', target: 'driver-b', label: 'Offer 2 goes to driver-b', detail: (_s, { effect }) => `A new offer epoch ${effect.epoch} supersedes everything issued before it.`, correlationId: 'ride-9', entry: { op: 'offer', rideId: 'ride-9', driver: 'driver-b', ttlMs: 12000 }, data: (_s, { effect }) => ({ epoch: effect.epoch, driver: effect.driver }) },
        { atMs: 13400, key: 'accept2', type: 'dispatch.assignment.committed', lane: 'commits', actor: 'driver-b', target: 'matcher', label: 'driver-b accepts at epoch 2', detail: 'The accept names the outstanding epoch, so it is admitted and the assignment commits.', correlationId: 'ride-9', entry: { op: 'accept', rideId: 'ride-9', driver: 'driver-b', epoch: 2 }, data: (_s, { effect }) => ({ driver: effect.driver, index: effect.index }) },
        { atMs: 13650, key: 'lateaccept', type: 'dispatch.accept.fenced', lane: 'invariants', actor: 'driver-a', target: 'matcher', label: 'driver-a accepts too late', detail: 'The tunnel ends and the queued accept finally arrives — naming epoch 1, which was superseded 1.5 s ago.', correlationId: 'ride-9', causedBy: 'accept2', entry: { op: 'accept', rideId: 'ride-9', driver: 'driver-a', epoch: 1 }, data: (_s, { effect }) => ({ offeredEpoch: effect.offeredEpoch, currentEpoch: effect.currentEpoch, reason: effect.reason }) },
        { atMs: 13720, key: 'offer3', type: 'dispatch.offer.issued', lane: 'commits', actor: 'matcher', target: 'driver-b', label: 'A second rider is offered driver-b', detail: 'ride-12 is nearby and the matcher has stale supply data showing driver-b as free.', correlationId: 'ride-12', entry: { op: 'offer', rideId: 'ride-12', driver: 'driver-b', ttlMs: 12000 }, data: (_s, { effect }) => ({ epoch: effect.epoch }) },
        { atMs: 13860, key: 'doublebook', type: 'dispatch.accept.fenced', lane: 'invariants', actor: 'driver-b', target: 'matcher', label: 'Double booking is refused', detail: 'driver-b is already committed to ride-9. The second assignment is rejected on the driver, not on the epoch.', correlationId: 'ride-12', entry: { op: 'accept', rideId: 'ride-12', driver: 'driver-b', epoch: 3 }, data: (_s, { effect }) => ({ reason: effect.reason, heldBy: effect.heldBy }) },
        { atMs: 14200, key: 'offer4', type: 'dispatch.offer.issued', lane: 'commits', actor: 'matcher', target: 'driver-c', label: 'ride-12 is re-offered to driver-c', detail: 'Refusal is fast and specific, so the rider is rematched rather than left waiting.', correlationId: 'ride-12', entry: { op: 'offer', rideId: 'ride-12', driver: 'driver-c', ttlMs: 12000 }, data: (_s, { effect }) => ({ epoch: effect.epoch }) },
        { atMs: 15100, key: 'accept4', type: 'dispatch.assignment.committed', lane: 'commits', actor: 'driver-c', target: 'matcher', label: 'driver-c takes ride-12', detail: 'Two riders, two drivers, no overlap.', correlationId: 'ride-12', entry: { op: 'accept', rideId: 'ride-12', driver: 'driver-c', epoch: 4 }, data: (_s, { effect }) => ({ driver: effect.driver }) },
        { atMs: 21000, type: 'ride.completed', lane: 'clients', actor: 'driver-b', target: 'matcher', label: 'ride-9 completes', detail: 'driver-b is returned to the available pool by a committed entry.', correlationId: 'ride-9', entry: { op: 'complete', rideId: 'ride-9' }, data: (_s, { effect }) => ({ driver: effect.driver }) },
    ],
    invariants(state) {
        const driversUsed = [...state.assignments.values()].map((assignment) => assignment.driver);
        const uniqueDrivers = new Set(driversUsed).size === driversUsed.length;
        const staleRejections = state.rejectedAccepts.filter((item) => item.reason === 'stale-offer-epoch');
        const busyRejections = state.rejectedAccepts.filter((item) => item.reason === 'driver-already-assigned');
        return [
            [...state.assignments.keys()].every((rideId) => state.assignments.get(rideId).driver)
                && state.assignments.size === new Set(state.assignments.keys()).size
                ? pass('single-assignment', `${state.assignments.size} rides each hold exactly one committed driver`, { assignments: [...state.assignments].map(([ride, a]) => `${ride}→${a.driver}`) })
                : fail('single-assignment', 'a ride committed more than one driver'),
            uniqueDrivers
                ? pass('no-double-booking', 'no driver is committed to two rides at once', { drivers: driversUsed })
                : fail('no-double-booking', 'a driver was dispatched to two riders', { drivers: driversUsed }),
            staleRejections.length > 0
                ? pass('late-accept-fenced', 'an accept naming a superseded offer epoch was rejected', staleRejections[0])
                : watch('late-accept-fenced', 'no late accept arrived in this execution'),
            busyRejections.length > 0
                ? pass('supply-state-authoritative', 'stale supply data could not override committed driver state', busyRejections[0])
                : watch('supply-state-authoritative', 'no contended driver in this execution'),
            state.expiredOffers.length > 0 && state.assignments.size > 0
                ? pass('timeout-does-not-strand', 'an expired offer was reassigned and the rider still got a car', { expired: state.expiredOffers.length })
                : watch('timeout-does-not-strand', 'no offer expired in this execution'),
        ];
    },
    metrics(state) {
        return [
            { label: 'rides assigned', value: state.assignments.size, unit: 'committed' },
            { label: 'offers issued', value: state.matchAttempts, unit: `epoch ${state.offerEpoch}` },
            { label: 'accepts fenced', value: state.rejectedAccepts.length, unit: 'rejected' },
            { label: 'surge', value: `${state.surgeMultiplier}×`, unit: 'quoted' },
        ];
    },
    explainEvent(event) {
        const explanations = {
            'dispatch.offer.expired': 'The matcher cannot distinguish "driver-a declined" from "driver-a accepted and the reply is stuck in a tunnel". Both look identical. Expiring and reassigning is the only way to keep the rider moving, which is exactly why the late accept must be handled rather than assumed away.',
            'dispatch.accept.fenced': 'The accept carries the epoch it was offered under. The matcher compares it to the outstanding offer and finds a mismatch, so the request is refused without inspecting driver state at all. A wall-clock timestamp would not be sufficient here — the two decisions were made under different views, and only a monotonic token orders them.',
            'dispatch.assignment.committed': 'The assignment is a committed log entry, not a matcher-local map. That is what makes the subsequent double-booking check correct even if the matcher process restarts between the two accepts.',
            'pricing.surge.applied': 'Quoting before assignment means the fare is fixed by the same causal chain that produces the match, so a rider cannot be repriced by a reassignment they did not cause.',
        };
        return explanations[event.type] || event.data.detail;
    },
    visualization(state) {
        const driverNode = (id) => {
            const ride = state.driverBusy.get(id);
            const fenced = state.rejectedAccepts.some((item) => item.driver === id);
            return makeNode(id, 'up',
                id === 'driver-a' && !ride ? 'reconnected' : 'connected',
                ride ? `assigned ${ride}` : 'available',
                fenced && !ride ? 'accept fenced' : ride ? 'en route' : 'idle',
                ride ? 'green' : fenced ? 'red' : 'blue');
        };
        return {
            title: `${state.assignments.size} rides · offer epoch ${state.offerEpoch}`,
            subtitle: `${state.rejectedAccepts.length} accepts fenced · ${state.expiredOffers.length} offers expired`,
            nodes: [
                makeNode('matcher', 'up', 'connected', 'dispatch leader', `commit ${state.commitIndex}`, 'amber'),
                driverNode('driver-a'),
                driverNode('driver-b'),
                driverNode('driver-c'),
                makeNode('rider-31', 'up', 'connected', 'client', state.assignments.has('ride-9') ? 'matched' : 'waiting', state.assignments.has('ride-9') ? 'green' : 'amber'),
            ],
            policy: 'Every offer carries a fencing epoch; an accept for a superseded epoch can never commit.',
        };
    },
};

// ---------------------------------------------------------------------------
// 7. Flash-sale inventory: a bounded counter under contention and partition
// ---------------------------------------------------------------------------

/**
 * Overselling is the cheapest distributed-systems bug to explain and one of the
 * easiest to write.
 *
 * The naive version reads stock, checks it is positive, and decrements —
 * three steps that are not one step. Under contention two buyers both read 1
 * and both decrement. The fix is a conditional decrement evaluated inside the
 * replicated state machine, so the read and the write are the same committed
 * entry.
 *
 * The subtler case, and the one this scenario is built around, is a **leader
 * that accepts a reservation it cannot commit**. It is partitioned, so its
 * append never reaches a majority. If the client is told "reserved" optimistically,
 * or if the leader decrements its own local copy, stock is wrong the moment the
 * partition heals. The correct behaviour is that an uncommitted reservation has
 * *no effect whatsoever* — the buyer sees a failure and the counter never moved.
 */
function inventoryState() {
    return {
        initialStock: 3,
        stock: 3,
        commitIndex: 60,
        reservations: new Map(),
        rejected: [],
        uncommittedAttempts: [],
        released: [],
        confirmed: [],
        maxConcurrentHolds: 0,
    };
}

function applyInventory(state, entry) {
    switch (entry.op) {
        case 'reserve': {
            // A reservation that never reached a quorum is recorded as an
            // attempt for the trace, but must not touch stock. This is the
            // whole point of the scenario: the partitioned leader's optimism is
            // invisible to committed state.
            if (entry.committed === false) {
                state.uncommittedAttempts.push({ orderId: entry.orderId, units: entry.units, stockAtAttempt: state.stock });
                return { ok: false, reason: 'no-quorum', committed: false, stock: state.stock };
            }
            if (state.reservations.has(entry.orderId)) {
                const held = state.reservations.get(entry.orderId);
                return { ok: true, duplicate: true, orderId: entry.orderId, units: held.units, stock: state.stock };
            }
            if (state.stock < entry.units) {
                const rejection = { orderId: entry.orderId, units: entry.units, stock: state.stock, reason: 'sold-out' };
                state.rejected.push(rejection);
                return { ok: false, ...rejection };
            }
            state.stock -= entry.units;
            state.commitIndex += 1;
            state.reservations.set(entry.orderId, { units: entry.units, state: 'held', index: state.commitIndex });
            state.maxConcurrentHolds = Math.max(state.maxConcurrentHolds, state.reservations.size);
            return { ok: true, orderId: entry.orderId, units: entry.units, stock: state.stock };
        }
        case 'release': {
            const held = state.reservations.get(entry.orderId);
            if (!held || held.state !== 'held') return { ok: false, reason: 'not-held' };
            held.state = 'released';
            state.stock += held.units;
            state.commitIndex += 1;
            state.released.push({ orderId: entry.orderId, units: held.units, reason: entry.reason });
            return { ok: true, orderId: entry.orderId, units: held.units, stock: state.stock, reason: entry.reason };
        }
        case 'confirm': {
            const held = state.reservations.get(entry.orderId);
            if (!held || held.state !== 'held') return { ok: false, reason: 'not-held' };
            held.state = 'confirmed';
            state.commitIndex += 1;
            state.confirmed.push({ orderId: entry.orderId, units: held.units });
            return { ok: true, orderId: entry.orderId, units: held.units };
        }
        default:
            return { ok: true };
    }
}

const inventory = {
    id: 'inventory',
    name: 'Flash-sale inventory',
    shortName: 'Inventory',
    question: 'Can a partitioned leader oversell the last unit by accepting a reservation it cannot commit?',
    scenario: 'Three units, five buyers, one partition, one payment failure',
    createState: inventoryState,
    applyCommittedEntry: applyInventory,
    actions: [
        { atMs: 0, key: 'open', type: 'sale.window.opened', lane: 'clients', actor: 'catalog', target: 'buyers', label: 'Sale opens with 3 units', detail: 'Five buyers are already waiting. Stock is a replicated counter, not a cached number.', correlationId: 'sale-1', data: { stock: 3, waiting: 5 } },
        { atMs: 18, key: 'o1', type: 'inventory.reservation.committed', lane: 'commits', actor: 'order-1', target: 'leader', label: 'order-1 reserves 1 unit', detail: (_s, { effect }) => `Conditional decrement commits; ${effect.stock} units remain.`, correlationId: 'order-1', entry: { op: 'reserve', orderId: 'order-1', units: 1 }, data: (_s, { effect }) => ({ stock: effect.stock }) },
        { atMs: 34, key: 'o2', type: 'inventory.reservation.committed', lane: 'commits', actor: 'order-2', target: 'leader', label: 'order-2 reserves 1 unit', detail: (_s, { effect }) => `${effect.stock} units remain; the check and the decrement are one entry.`, correlationId: 'order-2', entry: { op: 'reserve', orderId: 'order-2', units: 1 }, data: (_s, { effect }) => ({ stock: effect.stock }) },
        { atMs: 62, key: 'partition', type: 'fault.partition.injected', lane: 'faults', actor: 'network', target: 'node0', label: 'Leader is cut off mid-sale', detail: 'node0 still accepts connections and still believes it leads. It just cannot reach a majority.', correlationId: 'sale-1', process: 'up', network: 'partitioned', raftRole: 'stale leader' },
        { atMs: 88, key: 'o3fail', type: 'inventory.reservation.uncommitted', lane: 'invariants', actor: 'order-3', target: 'node0', label: 'order-3 reaches the wrong leader', detail: 'node0 appends the reservation locally, then waits for acknowledgements that cannot arrive.', correlationId: 'order-3', causedBy: 'partition', entry: { op: 'reserve', orderId: 'order-3', units: 1, committed: false }, data: (_s, { effect }) => ({ reason: effect.reason, stock: effect.stock }) },
        { atMs: 1088, key: 'timeout', type: 'client.deadline.exceeded', lane: 'faults', actor: 'order-3', target: 'checkout', label: 'order-3 times out with no reservation', detail: 'The buyer sees a failure. Committed stock never moved, so nothing has to be undone.', correlationId: 'order-3', causedBy: 'o3fail', data: (state) => ({ stock: state.stock }) },
        { atMs: 1150, key: 'failover', type: 'raft.leader.elected', lane: 'commits', actor: 'node1', nodeId: 'node1', target: 'cluster', label: 'node1 takes over in term 6', detail: 'The majority side elects a new leader. node0 truncates its uncommitted append when it rejoins.', correlationId: 'sale-1', causedBy: 'partition', raftRole: 'leader', data: { term: 6, live: 2, required: 2, configured: 3 } },
        { atMs: 1210, key: 'o3retry', type: 'inventory.reservation.committed', lane: 'commits', actor: 'order-3', target: 'node1', label: 'order-3 retries and succeeds', detail: (_s, { effect }) => `The retry commits against the real leader; stock is now ${effect.stock}.`, correlationId: 'order-3', entry: { op: 'reserve', orderId: 'order-3', units: 1 }, data: (_s, { effect }) => ({ stock: effect.stock }) },
        { atMs: 1240, key: 'o4', type: 'inventory.reservation.rejected', lane: 'invariants', actor: 'order-4', target: 'node1', label: 'order-4 is refused — sold out', detail: 'Stock is 0. The conditional decrement fails inside the state machine, so no negative value is representable.', correlationId: 'order-4', entry: { op: 'reserve', orderId: 'order-4', units: 1 }, data: (_s, { effect }) => ({ reason: effect.reason, stock: effect.stock }) },
        { atMs: 1420, key: 'payfail', type: 'payment.authorization.failed', lane: 'faults', actor: 'psp', target: 'order-2', label: 'order-2 payment is declined', detail: 'The hold must be returned to inventory, not silently abandoned.', correlationId: 'order-2' },
        { atMs: 1448, key: 'release', type: 'inventory.hold.released', lane: 'commits', actor: 'checkout', target: 'node1', label: 'order-2 releases its unit', detail: (_s, { effect }) => `One unit returns to stock; ${effect.stock} available again.`, correlationId: 'order-2', causedBy: 'payfail', entry: { op: 'release', orderId: 'order-2', reason: 'payment-declined' }, data: (_s, { effect }) => ({ stock: effect.stock, reason: effect.reason }) },
        { atMs: 1512, key: 'o5', type: 'inventory.reservation.committed', lane: 'commits', actor: 'order-5', target: 'node1', label: 'order-5 takes the returned unit', detail: (_s, { effect }) => `The released unit is resold immediately; ${effect.stock} remain.`, correlationId: 'order-5', entry: { op: 'reserve', orderId: 'order-5', units: 1 }, data: (_s, { effect }) => ({ stock: effect.stock }) },
        { atMs: 1590, key: 'retry3', type: 'dedup.duplicate.suppressed', lane: 'commits', actor: 'order-3', target: 'node1', label: 'order-3 retries once more', detail: 'The client never saw its success either. The reservation is keyed by order ID, so the retry returns the existing hold instead of taking a second unit.', correlationId: 'order-3', entry: { op: 'reserve', orderId: 'order-3', units: 1 }, data: (_s, { effect }) => ({ duplicate: effect.duplicate, stock: effect.stock }) },
        { atMs: 1680, type: 'inventory.order.confirmed', lane: 'commits', actor: 'checkout', target: 'node1', label: 'order-1 is confirmed', detail: 'The hold becomes a sale. Confirmed units never return to stock.', correlationId: 'order-1', entry: { op: 'confirm', orderId: 'order-1' } },
        { atMs: 1740, type: 'fault.partition.healed', lane: 'faults', actor: 'network', target: 'node0', label: 'node0 rejoins and truncates', detail: 'Its uncommitted order-3 append conflicts with the committed log and is discarded on the first AppendEntries.', correlationId: 'sale-1', network: 'connected', raftRole: 'follower' },
    ],
    invariants(state) {
        const held = [...state.reservations.values()].filter((item) => item.state !== 'released');
        const unitsOut = held.reduce((sum, item) => sum + item.units, 0);
        const ghost = state.uncommittedAttempts.filter((attempt) => state.reservations.has(attempt.orderId)
            && state.reservations.get(attempt.orderId).index <= 61);
        return [
            unitsOut + state.stock === state.initialStock
                ? pass('conservation-of-stock', `${unitsOut} held + ${state.stock} available = ${state.initialStock} initial`, { held: unitsOut, available: state.stock, initial: state.initialStock })
                : fail('conservation-of-stock', 'units were created or destroyed', { held: unitsOut, available: state.stock }),
            state.stock >= 0
                ? pass('no-oversell', `stock never went below zero across ${state.reservations.size + state.rejected.length} attempts`, { stock: state.stock, rejected: state.rejected.length })
                : fail('no-oversell', 'the counter went negative', { stock: state.stock }),
            ghost.length === 0
                ? pass('uncommitted-has-no-effect', 'the partitioned leader\'s reservation left committed stock untouched', { attempts: state.uncommittedAttempts })
                : fail('uncommitted-has-no-effect', 'an uncommitted reservation changed stock', { ghost }),
            state.released.length > 0 && state.confirmed.every((item) => !state.released.some((r) => r.orderId === item.orderId))
                ? pass('release-restores-exactly-once', 'a declined payment returned exactly its held units and no confirmed order was released', { released: state.released })
                : watch('release-restores-exactly-once', 'no hold was released in this execution'),
            state.rejected.length > 0
                ? pass('refusal-is-committed', 'the sold-out refusal was decided inside the state machine, so every replica agrees', state.rejected[0])
                : watch('refusal-is-committed', 'stock was never exhausted in this execution'),
        ];
    },
    metrics(state) {
        const held = [...state.reservations.values()].filter((item) => item.state === 'held').length;
        return [
            { label: 'stock', value: `${state.stock}/${state.initialStock}`, unit: 'available' },
            { label: 'holds', value: held, unit: `${state.confirmed.length} confirmed` },
            { label: 'refused', value: state.rejected.length, unit: 'sold out' },
            { label: 'uncommitted', value: state.uncommittedAttempts.length, unit: 'no effect' },
        ];
    },
    explainEvent(event) {
        const explanations = {
            'inventory.reservation.uncommitted': 'node0 appended the entry to its own log and then waited. Because it is on the minority side of the partition it can never reach a quorum, so the entry never commits and the state machine never applies it. The buyer correctly observes a failure, and — critically — no compensating action is required, because nothing happened.',
            'inventory.reservation.rejected': 'The bounds check lives inside the committed state transition, so read-check-decrement is one atomic step. A read-then-write in application code is what lets two buyers both observe stock=1 and both succeed.',
            'inventory.hold.released': 'A declined payment returns the units by another committed entry. Modelling holds and sales as distinct states is what makes this reversible without a compensating transaction that could itself fail.',
            'dedup.duplicate.suppressed': 'The reservation is keyed by order ID. order-3 never learned its first attempt succeeded, so the retry is inevitable — and returns the existing hold rather than consuming a second unit.',
            'fault.partition.healed': 'node0 rejoins, discovers term 6, and its uncommitted append at the conflicting index is overwritten by the leader. The oversell it was one acknowledgement away from causing is erased by log matching.',
        };
        return explanations[event.type] || event.data.detail;
    },
    visualization(state) {
        const holdFor = (orderId) => {
            const record = state.reservations.get(orderId);
            if (!record) return state.rejected.some((r) => r.orderId === orderId) ? 'refused' : 'waiting';
            return record.state;
        };
        return {
            title: `sale-1 · ${state.stock}/${state.initialStock} available`,
            subtitle: `${state.reservations.size} reservations · ${state.rejected.length} refused · ${state.uncommittedAttempts.length} uncommitted`,
            nodes: [
                makeNode('node0', 'up', state.uncommittedAttempts.length ? 'partitioned' : 'connected',
                    state.uncommittedAttempts.length ? 'stale leader' : 'leader',
                    `${state.uncommittedAttempts.length} orphan append`, state.uncommittedAttempts.length ? 'red' : 'green'),
                makeNode('node1', 'up', 'connected', 'leader · t6', `commit ${state.commitIndex}`, 'green'),
                makeNode('order-2', 'up', 'connected', 'buyer', holdFor('order-2'), holdFor('order-2') === 'released' ? 'amber' : 'blue'),
                makeNode('order-3', 'up', 'connected', 'buyer', holdFor('order-3'), holdFor('order-3') === 'held' ? 'green' : 'amber'),
                makeNode('order-4', 'up', 'connected', 'buyer', holdFor('order-4'), 'red'),
            ],
            policy: 'Read, bounds check, and decrement are one committed entry; an uncommitted reservation has no effect at all.',
        };
    },
};

const EXTENDED_WORKLOADS = createExtendedWorkloads({ pass, fail, watch, makeNode });

const WORKLOADS = Object.freeze([
    configuration, payment, vectorSearch, rollout, streaming, dispatch, inventory, ...EXTENDED_WORKLOADS,
].map(validateWorkload));

function getWorkload(id) {
    return WORKLOADS.find((workload) => workload.id === id) || null;
}

module.exports = {
    REQUIRED_INTERFACE,
    WORKLOADS,
    validateWorkload,
    runWorkload,
    getWorkload,
};
