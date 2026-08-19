'use strict';

/**
 * Workloads whose correctness arguments are deliberately not repetitions of
 * the Raft examples in index.js: a client-session guarantee over an eventual
 * projection, leaderless CRDT convergence, and an atomic outcome across two
 * independently owned ledgers.
 */
function createExtendedWorkloads({ pass, fail, watch, makeNode }) {
    // -----------------------------------------------------------------------
    // 8. Feed fan-out: read-your-writes over an eventual home timeline
    // -----------------------------------------------------------------------

    function feedState() {
        return {
            commitIndex: 70,
            posts: new Map(),
            sessions: new Map(),
            timelines: new Map([
                ['home-us', { postIds: [], appliedIndexes: new Set(), network: 'connected' }],
            ]),
            pendingFanout: [],
            reads: [],
            fallbackReads: 0,
            duplicateFanout: 0,
        };
    }

    function applyFeed(state, entry) {
        switch (entry.op) {
            case 'publish': {
                const prior = state.posts.get(entry.postId);
                if (prior) return { ok: true, duplicate: true, postId: entry.postId, index: prior.index };
                state.commitIndex += 1;
                const post = {
                    id: entry.postId,
                    author: entry.author,
                    body: entry.body,
                    index: state.commitIndex,
                };
                state.posts.set(post.id, post);
                const session = state.sessions.get(entry.sessionId) || { userId: entry.author, writes: [] };
                session.writes.push({ postId: post.id, index: post.index });
                state.sessions.set(entry.sessionId, session);
                state.pendingFanout.push(post.id);
                return { ok: true, duplicate: false, postId: post.id, index: post.index };
            }
            case 'read-home': {
                const timeline = state.timelines.get(entry.cacheId);
                const session = state.sessions.get(entry.sessionId);
                const required = session?.writes.slice() || [];
                const missing = required.filter((write) => !timeline.appliedIndexes.has(write.index));
                const fallback = missing.length > 0;
                const postIds = fallback
                    ? [...state.posts.values()].sort((a, b) => b.index - a.index).map((post) => post.id)
                    : timeline.postIds.slice();
                const read = {
                    sessionId: entry.sessionId,
                    cacheId: entry.cacheId,
                    consistency: fallback ? 'session-fallback' : 'eventual-cache',
                    required: required.map((write) => write.postId),
                    missingAtCache: missing.map((write) => write.postId),
                    postIds,
                };
                state.reads.push(read);
                if (fallback) state.fallbackReads += 1;
                return { ok: true, ...read };
            }
            case 'fanout': {
                const timeline = state.timelines.get(entry.cacheId);
                const post = state.posts.get(entry.postId);
                if (!post) return { ok: false, reason: 'post-not-committed' };
                if (timeline.appliedIndexes.has(post.index)) {
                    state.duplicateFanout += 1;
                    return { ok: true, duplicate: true, postId: post.id };
                }
                timeline.appliedIndexes.add(post.index);
                timeline.postIds.push(post.id);
                timeline.postIds.sort((left, right) => state.posts.get(right).index - state.posts.get(left).index);
                state.pendingFanout = state.pendingFanout.filter((id) => id !== post.id);
                return { ok: true, duplicate: false, postId: post.id, index: post.index };
            }
            case 'network': {
                const timeline = state.timelines.get(entry.cacheId);
                timeline.network = entry.status;
                return { ok: true, network: timeline.network };
            }
            default:
                return { ok: true };
        }
    }

    const feed = {
        id: 'feed',
        name: 'Social feed fan-out',
        shortName: 'Feed',
        question: 'Can an author reload immediately and see a committed post before asynchronous fan-out reaches the home timeline?',
        scenario: 'Post, instant reload, delayed fan-out',
        createState: feedState,
        applyCommittedEntry: applyFeed,
        actions: [
            { atMs: 0, key: 'warm', type: 'feed.cache.readied', lane: 'nodes', actor: 'home-us', target: 'edge', label: 'Home timeline is warm but behind', detail: 'The regional cache serves revision 70. It is healthy; asynchronous fan-out simply has no new post yet.', correlationId: 'post-41', network: 'connected' },
            { atMs: 12, key: 'publish', type: 'feed.post.committed', lane: 'commits', actor: 'user-7', target: 'post-store', label: 'post-41 commits', detail: (_state, { effect }) => `The canonical store commits post-41 at index ${effect.index} and returns that frontier in the session token.`, correlationId: 'post-41', entry: { op: 'publish', sessionId: 'session-web', author: 'user-7', postId: 'post-41', body: 'hello from the partition' }, data: (_state, { effect }) => ({ index: effect.index, sessionId: 'session-web' }) },
            { atMs: 18, key: 'queued', type: 'feed.fanout.queued', lane: 'nodes', actor: 'post-store', target: 'fanout-worker', label: 'Fan-out is queued', detail: 'Durability does not wait for every follower timeline. The worker may deliver this item later or more than once.', correlationId: 'post-41', causedBy: 'publish', data: { postId: 'post-41', targetCache: 'home-us' } },
            { atMs: 25, key: 'delay', type: 'network.delivery.delayed', lane: 'faults', actor: 'network', target: 'fanout-worker', label: 'Fan-out delivery is delayed', detail: 'The post exists in the canonical store, but home-us still lacks its committed index.', correlationId: 'post-41', causedBy: 'queued', entry: { op: 'network', cacheId: 'home-us', status: 'slow' }, network: 'slow' },
            { atMs: 31, key: 'reload', type: 'feed.timeline.read', lane: 'clients', actor: 'user-7', target: 'home-us', label: 'Author reloads immediately', detail: (_state, { effect }) => `home-us is missing ${effect.missingAtCache.join(', ')} required by the session token, so the gateway reads the canonical store.`, correlationId: 'post-41', causedBy: 'publish', entry: { op: 'read-home', sessionId: 'session-web', cacheId: 'home-us' }, data: (_state, { effect }) => ({ consistency: effect.consistency, returned: effect.postIds, missingAtCache: effect.missingAtCache }) },
            { atMs: 36, key: 'follower-read', type: 'feed.timeline.read', lane: 'clients', actor: 'follower-9', target: 'home-us', label: 'Another reader may still see the old feed', detail: 'Without an author session frontier, the eventual cache may omit post-41 while fan-out is pending.', correlationId: 'follower-9', entry: { op: 'read-home', sessionId: 'anonymous-session', cacheId: 'home-us' }, data: (_state, { effect }) => ({ consistency: effect.consistency, returned: effect.postIds }) },
            { atMs: 74, key: 'deliver', type: 'feed.fanout.applied', lane: 'nodes', actor: 'fanout-worker', target: 'home-us', label: 'Fan-out reaches the timeline', detail: 'home-us records the concrete committed index and inserts post-41 into feed order.', correlationId: 'post-41', causedBy: 'queued', entry: { op: 'fanout', cacheId: 'home-us', postId: 'post-41' }, data: (_state, { effect }) => ({ postId: effect.postId, index: effect.index }) },
            { atMs: 82, key: 'retry-delivery', type: 'feed.fanout.duplicate', lane: 'nodes', actor: 'fanout-worker', target: 'home-us', label: 'Worker redelivers the item', detail: 'At-least-once fan-out is safe because the timeline deduplicates by committed post index.', correlationId: 'post-41', causedBy: 'deliver', entry: { op: 'fanout', cacheId: 'home-us', postId: 'post-41' }, data: (_state, { effect }) => ({ duplicate: effect.duplicate }) },
            { atMs: 94, type: 'feed.timeline.read', lane: 'clients', actor: 'user-7', target: 'home-us', label: 'Later reload is served at the edge', detail: 'The cache now covers every write in the session, so no canonical fallback is required.', correlationId: 'post-41', causedBy: 'deliver', entry: { op: 'read-home', sessionId: 'session-web', cacheId: 'home-us' }, data: (_state, { effect }) => ({ consistency: effect.consistency, returned: effect.postIds }) },
        ],
        invariants(state) {
            const sessionReads = state.reads.filter((read) => read.sessionId === 'session-web');
            const readYourWrites = sessionReads.every((read) => read.required.every((postId) => read.postIds.includes(postId)));
            const eventualRead = state.reads.find((read) => read.sessionId === 'anonymous-session');
            const timeline = state.timelines.get('home-us');
            return [
                readYourWrites
                    ? pass('read-your-writes', 'every author reload included all writes named by its session frontier', { reads: sessionReads })
                    : fail('read-your-writes', 'an author reload omitted its own committed post', { reads: sessionReads }),
                state.fallbackReads === 1
                    ? pass('stale-cache-bypassed', 'one stale cache read fell back before returning an incomplete author view', { fallbacks: state.fallbackReads })
                    : fail('stale-cache-bypassed', 'the session fallback did not isolate the stale cache', { fallbacks: state.fallbackReads }),
                eventualRead && !eventualRead.postIds.includes('post-41')
                    ? pass('eventual-staleness-disclosed', 'a reader without a session guarantee observed the allowed pre-fan-out view')
                    : watch('eventual-staleness-disclosed', 'the eventual reader happened to receive the new post'),
                timeline.postIds.filter((id) => id === 'post-41').length === 1 && state.duplicateFanout === 1
                    ? pass('fanout-idempotent', 'at-least-once delivery produced one timeline item', { duplicateDeliveries: state.duplicateFanout })
                    : fail('fanout-idempotent', 'duplicate fan-out produced duplicate feed items'),
            ];
        },
        metrics(state) {
            return [
                { label: 'posts', value: state.posts.size, unit: 'canonical' },
                { label: 'session fallbacks', value: state.fallbackReads, unit: 'protected' },
                { label: 'fan-out pending', value: state.pendingFanout.length, unit: 'items' },
                { label: 'duplicates', value: state.duplicateFanout, unit: 'suppressed' },
            ];
        },
        explainEvent(event) {
            const explanations = {
                'feed.post.committed': 'The write acknowledgement names the canonical commit index. That index becomes a session obligation: later reads for this session cannot use a projection that does not contain it.',
                'feed.timeline.read': 'The gateway compares the session write set with the concrete indexes applied at the edge. Missing coverage causes a canonical fallback; a wall-clock delay would not prove the post is present.',
                'feed.fanout.applied': 'Fan-out updates a derived read model, not the source of truth. It can be asynchronous and at-least-once because each item carries its canonical identity and index.',
                'feed.fanout.duplicate': 'The retry carries the same post identity and index. The timeline recognizes it as already applied, so reliability does not become duplication.',
            };
            return explanations[event.type] || event.data.detail;
        },
        visualization(state) {
            const timeline = state.timelines.get('home-us');
            const containsPost = timeline.postIds.includes('post-41');
            return {
                title: `post store · commit ${state.commitIndex}`,
                subtitle: `${state.pendingFanout.length} fan-out pending · ${state.fallbackReads} session fallback`,
                nodes: [
                    makeNode('post-store', 'up', 'connected', 'canonical', `${state.posts.size} committed posts`, 'green'),
                    makeNode('fanout-worker', 'up', timeline.network, 'async worker', `${state.pendingFanout.length} queued`, timeline.network === 'slow' ? 'amber' : 'blue'),
                    makeNode('home-us', 'up', timeline.network, 'read projection', containsPost ? 'contains post-41' : 'behind index 71', containsPost ? 'green' : 'amber'),
                    makeNode('user-7', 'up', 'connected', 'author session', state.sessions.has('session-web') ? 'frontier 71' : 'no writes', 'purple'),
                ],
                policy: 'An eventual timeline may lag; an author session must cover every committed write or bypass it.',
            };
        },
    };

    // -----------------------------------------------------------------------
    // 9. Collaborative editing: leaderless replicated growable array (RGA)
    // -----------------------------------------------------------------------

    const BASE_DOCUMENT = Object.freeze([
        { id: 'base:1', after: 'ROOT', char: 'R', actor: 'seed', counter: 1 },
        { id: 'base:2', after: 'base:1', char: 'A', actor: 'seed', counter: 2 },
        { id: 'base:3', after: 'base:2', char: 'F', actor: 'seed', counter: 3 },
        { id: 'base:4', after: 'base:3', char: 'T', actor: 'seed', counter: 4 },
    ]);

    function createReplica() {
        return { ops: new Map(BASE_DOCUMENT.map((op) => [op.id, { ...op }])) };
    }

    function renderDocument(replica) {
        const children = new Map();
        for (const op of replica.ops.values()) {
            if (!children.has(op.after)) children.set(op.after, []);
            children.get(op.after).push(op);
        }
        for (const siblings of children.values()) siblings.sort((left, right) => left.id.localeCompare(right.id));
        const visit = (parent) => (children.get(parent) || [])
            .map((op) => `${op.deleted ? '' : op.char}${visit(op.id)}`)
            .join('');
        return visit('ROOT');
    }

    function refreshDocuments(state) {
        for (const [id, replica] of Object.entries(state.replicas)) {
            state.documents[id] = renderDocument(replica);
        }
    }

    function collaborationState() {
        const state = {
            replicas: { alice: createReplica(), bob: createReplica(), relay: createReplica() },
            documents: {},
            network: { alice: 'connected', bob: 'connected', relay: 'connected' },
            offlineAccepted: 0,
            authored: [],
            orphanDeliveries: [],
            duplicateDeliveries: 0,
            deliveryOrders: { alice: [], bob: [], relay: [] },
        };
        refreshDocuments(state);
        return state;
    }

    function applyCollaboration(state, entry) {
        switch (entry.op) {
            case 'network':
                state.network[entry.replica] = entry.status;
                return { ok: true, replica: entry.replica, status: entry.status };
            case 'local-insert': {
                const replica = state.replicas[entry.replica];
                if (!replica.ops.has(entry.operation.after)) return { ok: false, reason: 'missing-local-parent' };
                const duplicate = replica.ops.has(entry.operation.id);
                if (!duplicate) {
                    replica.ops.set(entry.operation.id, { ...entry.operation });
                    state.authored.push({ replica: entry.replica, operation: { ...entry.operation } });
                    if (state.network[entry.replica] === 'partitioned') state.offlineAccepted += 1;
                }
                refreshDocuments(state);
                return { ok: true, duplicate, document: state.documents[entry.replica] };
            }
            case 'deliver': {
                const replica = state.replicas[entry.replica];
                if (replica.ops.has(entry.operation.id)) {
                    state.duplicateDeliveries += 1;
                    return { ok: true, duplicate: true, document: state.documents[entry.replica] };
                }
                if (!replica.ops.has(entry.operation.after)) {
                    state.orphanDeliveries.push({ replica: entry.replica, operationId: entry.operation.id, after: entry.operation.after });
                }
                replica.ops.set(entry.operation.id, { ...entry.operation });
                state.deliveryOrders[entry.replica].push(entry.operation.id);
                refreshDocuments(state);
                return { ok: true, duplicate: false, document: state.documents[entry.replica] };
            }
            default:
                return { ok: true };
        }
    }

    const aliceOne = Object.freeze({ id: 'alice:1', after: 'base:4', char: '!', actor: 'alice', counter: 1 });
    const aliceTwo = Object.freeze({ id: 'alice:2', after: 'alice:1', char: '!', actor: 'alice', counter: 2 });
    const bobOne = Object.freeze({ id: 'bob:1', after: 'base:4', char: '?', actor: 'bob', counter: 1 });

    const collaboration = {
        id: 'collaboration',
        name: 'Leaderless collaborative editing',
        shortName: 'CRDT editing',
        question: 'Can concurrent offline edits arrive in different orders and still converge without electing a leader?',
        scenario: 'Two offline editors, reordered merge',
        createState: collaborationState,
        applyCommittedEntry: applyCollaboration,
        actions: [
            { atMs: 0, key: 'base', type: 'crdt.document.opened', lane: 'clients', actor: 'alice', target: 'document', label: 'All replicas start at RAFT', detail: 'alice, bob, and the relay have the same four immutable RGA operations.', correlationId: 'doc-7', data: { document: 'RAFT', replicas: 3 } },
            { atMs: 14, key: 'partition-a', type: 'fault.partition.injected', lane: 'faults', actor: 'network', target: 'alice', label: 'alice goes offline', detail: 'Local editing continues because operation IDs do not require a leader or a central sequence number.', correlationId: 'doc-7', entry: { op: 'network', replica: 'alice', status: 'partitioned' }, network: 'partitioned' },
            { atMs: 18, key: 'partition-b', type: 'fault.partition.injected', lane: 'faults', actor: 'network', target: 'bob', label: 'bob goes offline', detail: 'bob has the same causal base but cannot observe alice.', correlationId: 'doc-7', entry: { op: 'network', replica: 'bob', status: 'partitioned' }, network: 'partitioned' },
            { atMs: 24, key: 'a1', type: 'crdt.operation.authored', lane: 'clients', actor: 'alice', target: 'alice-replica', label: 'alice appends !', detail: (_state, { effect }) => `alice accepts alice:1 locally and renders ${effect.document}.`, correlationId: 'doc-7', entry: { op: 'local-insert', replica: 'alice', operation: aliceOne }, data: (_state, { effect }) => ({ operationId: 'alice:1', document: effect.document }) },
            { atMs: 28, key: 'a2', type: 'crdt.operation.authored', lane: 'clients', actor: 'alice', target: 'alice-replica', label: 'alice appends a second !', detail: 'alice:2 names alice:1 as its causal parent, so the two exclamation marks retain their local order.', correlationId: 'doc-7', causedBy: 'a1', entry: { op: 'local-insert', replica: 'alice', operation: aliceTwo }, data: (_state, { effect }) => ({ operationId: 'alice:2', document: effect.document }) },
            { atMs: 31, key: 'b1', type: 'crdt.operation.authored', lane: 'clients', actor: 'bob', target: 'bob-replica', label: 'bob concurrently appends ?', detail: 'bob:1 and alice:1 share base:4 as their parent. Their unique IDs provide the deterministic tie-break.', correlationId: 'doc-7', entry: { op: 'local-insert', replica: 'bob', operation: bobOne }, data: (_state, { effect }) => ({ operationId: 'bob:1', document: effect.document }) },
            { atMs: 48, key: 'relay-b', type: 'crdt.operation.delivered', lane: 'nodes', actor: 'bob', target: 'relay', label: 'relay receives bob first', detail: (_state, { effect }) => `The relay temporarily renders ${effect.document}; convergence does not require matching intermediate views.`, correlationId: 'doc-7', causedBy: 'b1', entry: { op: 'deliver', replica: 'relay', operation: bobOne }, data: (_state, { effect }) => ({ document: effect.document }) },
            { atMs: 54, key: 'relay-a2', type: 'crdt.operation.buffered', lane: 'nodes', actor: 'alice', target: 'relay', label: 'alice:2 arrives before its parent', detail: 'The relay stores the operation, but it is unreachable from ROOT until alice:1 arrives. It is not attached at a guessed position.', correlationId: 'doc-7', causedBy: 'a2', entry: { op: 'deliver', replica: 'relay', operation: aliceTwo }, data: (_state, { effect }) => ({ document: effect.document, missingParent: 'alice:1' }) },
            { atMs: 62, key: 'relay-a1', type: 'crdt.operation.delivered', lane: 'nodes', actor: 'alice', target: 'relay', label: 'Parent arrives and unlocks the child', detail: (_state, { effect }) => `The stored child becomes reachable and the relay deterministically renders ${effect.document}.`, correlationId: 'doc-7', causedBy: 'relay-a2', entry: { op: 'deliver', replica: 'relay', operation: aliceOne }, data: (_state, { effect }) => ({ document: effect.document }) },
            { atMs: 70, key: 'to-alice', type: 'crdt.operation.delivered', lane: 'nodes', actor: 'bob', target: 'alice', label: 'alice receives bob:1', detail: 'Concurrent siblings are ordered by stable operation ID, not arrival time.', correlationId: 'doc-7', causedBy: 'b1', entry: { op: 'deliver', replica: 'alice', operation: bobOne }, data: (_state, { effect }) => ({ document: effect.document }) },
            { atMs: 76, key: 'to-bob-a2', type: 'crdt.operation.buffered', lane: 'nodes', actor: 'alice', target: 'bob', label: 'bob also receives the child first', detail: 'A second delivery order exercises the same missing-parent rule on another replica.', correlationId: 'doc-7', causedBy: 'a2', entry: { op: 'deliver', replica: 'bob', operation: aliceTwo }, data: (_state, { effect }) => ({ document: effect.document }) },
            { atMs: 84, key: 'to-bob-a1', type: 'crdt.operation.delivered', lane: 'nodes', actor: 'alice', target: 'bob', label: 'bob receives alice:1', detail: (_state, { effect }) => `bob now renders ${effect.document}, matching alice and the relay despite a different delivery order.`, correlationId: 'doc-7', causedBy: 'to-bob-a2', entry: { op: 'deliver', replica: 'bob', operation: aliceOne }, data: (_state, { effect }) => ({ document: effect.document }) },
            { atMs: 92, key: 'heal-a', type: 'fault.partition.healed', lane: 'faults', actor: 'network', target: 'alice', label: 'alice reconnects', detail: 'No election or conflict-resolution prompt is needed; the operation set already determines the result.', correlationId: 'doc-7', entry: { op: 'network', replica: 'alice', status: 'connected' }, network: 'connected' },
            { atMs: 94, key: 'heal-b', type: 'fault.partition.healed', lane: 'faults', actor: 'network', target: 'bob', label: 'bob reconnects', detail: 'All three replicas now contain the same operation set.', correlationId: 'doc-7', entry: { op: 'network', replica: 'bob', status: 'connected' }, network: 'connected' },
            { atMs: 101, type: 'crdt.operation.duplicate', lane: 'nodes', actor: 'relay-link', target: 'relay', label: 'alice:1 is delivered twice', detail: 'Operation identity makes gossip and reconnect retries idempotent.', correlationId: 'doc-7', causedBy: 'relay-a1', entry: { op: 'deliver', replica: 'relay', operation: aliceOne }, data: (_state, { effect }) => ({ duplicate: effect.duplicate, document: effect.document }) },
        ],
        invariants(state) {
            const documents = Object.values(state.documents);
            const opSets = Object.values(state.replicas).map((replica) => [...replica.ops.keys()].sort().join(','));
            const allAuthoredPresent = state.authored.every(({ operation }) => Object.values(state.replicas)
                .every((replica) => replica.ops.has(operation.id)));
            const orphansResolved = state.orphanDeliveries.every(({ replica, operationId, after }) => {
                const target = state.replicas[replica];
                return target.ops.has(operationId) && target.ops.has(after);
            });
            return [
                new Set(documents).size === 1 && documents[0] === 'RAFT!!?'
                    ? pass('crdt-convergence', 'all replicas rendered RAFT!!? after exchanging the same operations', { documents: state.documents })
                    : fail('crdt-convergence', 'replicas did not converge', { documents: state.documents }),
                new Set(opSets).size === 1 && allAuthoredPresent
                    ? pass('operation-set-convergence', 'every offline edit is present at every replica', { operations: opSets[0].split(',') })
                    : fail('operation-set-convergence', 'an authored operation was lost'),
                state.offlineAccepted === 3
                    ? pass('leaderless-availability', 'three edits were accepted locally while both authors were partitioned', { accepted: state.offlineAccepted })
                    : fail('leaderless-availability', 'offline editing depended on a leader', { accepted: state.offlineAccepted }),
                state.orphanDeliveries.length === 2 && orphansResolved
                    ? pass('causal-dependency-preserved', 'two child-before-parent deliveries were buffered and later attached correctly', { deliveries: state.orphanDeliveries })
                    : fail('causal-dependency-preserved', 'a reordered child was misplaced or lost'),
                state.duplicateDeliveries === 1 && documents.every((document) => document === 'RAFT!!?')
                    ? pass('operation-idempotency', 'a duplicate gossip delivery did not duplicate text')
                    : fail('operation-idempotency', 'a duplicate delivery changed the document'),
            ];
        },
        metrics(state) {
            return [
                { label: 'replicas', value: Object.keys(state.replicas).length, unit: 'converged' },
                { label: 'offline edits', value: state.offlineAccepted, unit: 'accepted' },
                { label: 'reordered', value: state.orphanDeliveries.length, unit: 'buffered' },
                { label: 'document', value: state.documents.relay, unit: 'final' },
            ];
        },
        explainEvent(event) {
            const explanations = {
                'crdt.operation.authored': 'The operation ID combines an actor identity and a monotonic local counter. That makes it globally unique without asking a leader for a slot.',
                'crdt.operation.buffered': 'An RGA insertion names its causal parent. Receiving a child first is safe: the replica stores it, but traversal cannot expose it until the parent exists.',
                'crdt.operation.delivered': 'Replicas sort concurrent children by stable operation ID and preserve causal children beneath their parents. Arrival order can change intermediate views, never the final view.',
                'crdt.operation.duplicate': 'CRDT state is a set of uniquely identified operations. Unioning the same operation twice is the same as unioning it once.',
            };
            return explanations[event.type] || event.data.detail;
        },
        visualization(state) {
            const node = (id, accent) => makeNode(
                id,
                'up',
                state.network[id],
                'leaderless replica',
                state.documents[id],
                accent,
            );
            return {
                title: `doc-7 · ${state.documents.relay}`,
                subtitle: `${state.authored.length} authored ops · ${state.orphanDeliveries.length} reordered deliveries`,
                nodes: [
                    node('alice', 'purple'),
                    node('bob', 'blue'),
                    node('relay', 'green'),
                    makeNode('operation-set', 'up', 'gossip', 'merge rule', `${state.replicas.relay.ops.size} unique ops`, 'amber'),
                ],
                policy: 'Causal links preserve local intent; stable IDs order concurrent siblings; set union makes delivery order irrelevant.',
            };
        },
    };

    // -----------------------------------------------------------------------
    // 10. Two-ledger settlement: 2PC with a durable decision and recovery
    // -----------------------------------------------------------------------

    function settlementState() {
        return {
            initialTotal: 12000,
            balances: { 'ledger-a': 10000, 'ledger-b': 2000 },
            locked: { 'ledger-a': 0, 'ledger-b': 0 },
            transactions: new Map(),
            decisionLog: new Map(),
            coordinator: { alive: true, epoch: 1, recoveries: 0 },
            commitIndex: 90,
            recoveredDecisions: [],
            prepareSnapshots: [],
            balanceMutations: [],
            duplicateDecisions: 0,
            inDoubtObservations: 0,
        };
    }

    function getTransaction(state, txId) {
        return state.transactions.get(txId) || null;
    }

    function applySettlement(state, entry) {
        switch (entry.op) {
            case 'begin': {
                if (state.transactions.has(entry.txId)) return { ok: true, duplicate: true, txId: entry.txId };
                const tx = {
                    id: entry.txId,
                    source: entry.source,
                    target: entry.target,
                    amountCents: entry.amountCents,
                    votes: {},
                    participants: {
                        [entry.source]: { phase: 'initial' },
                        [entry.target]: { phase: 'initial' },
                    },
                    decision: null,
                    finalized: false,
                };
                state.transactions.set(tx.id, tx);
                return { ok: true, duplicate: false, txId: tx.id };
            }
            case 'prepare': {
                const tx = getTransaction(state, entry.txId);
                const before = { ...state.balances };
                const isSource = entry.participant === tx.source;
                const available = state.balances[entry.participant] - state.locked[entry.participant];
                const yes = !isSource || available >= tx.amountCents;
                tx.votes[entry.participant] = yes;
                tx.participants[entry.participant].phase = yes ? 'prepared' : 'rejected';
                if (yes && isSource) state.locked[entry.participant] += tx.amountCents;
                const snapshot = { txId: tx.id, participant: entry.participant, before, after: { ...state.balances }, vote: yes };
                state.prepareSnapshots.push(snapshot);
                return { ok: yes, vote: yes ? 'yes' : 'no', available, balances: { ...state.balances } };
            }
            case 'decide': {
                const tx = getTransaction(state, entry.txId);
                const allYes = [tx.source, tx.target].every((participant) => tx.votes[participant] === true);
                const decision = allYes ? 'commit' : 'abort';
                if (tx.decision && tx.decision !== decision) return { ok: false, reason: 'decision-already-durable', decision: tx.decision };
                if (!tx.decision) {
                    tx.decision = decision;
                    state.commitIndex += 1;
                    state.decisionLog.set(tx.id, { decision, index: state.commitIndex });
                }
                return { ok: true, decision: tx.decision, index: state.decisionLog.get(tx.id).index };
            }
            case 'crash':
                state.coordinator.alive = false;
                return { ok: true, epoch: state.coordinator.epoch };
            case 'observe-in-doubt': {
                const tx = getTransaction(state, entry.txId);
                state.inDoubtObservations += 1;
                return {
                    ok: true,
                    decisionKnownLocally: false,
                    phases: Object.fromEntries(Object.entries(tx.participants).map(([id, participant]) => [id, participant.phase])),
                    balances: { ...state.balances },
                };
            }
            case 'recover': {
                state.coordinator.alive = true;
                state.coordinator.epoch += 1;
                state.coordinator.recoveries += 1;
                const record = state.decisionLog.get(entry.txId);
                if (record) state.recoveredDecisions.push({ txId: entry.txId, ...record });
                return { ok: Boolean(record), epoch: state.coordinator.epoch, decision: record?.decision || null };
            }
            case 'apply-decision': {
                const tx = getTransaction(state, entry.txId);
                const durable = state.decisionLog.get(entry.txId);
                if (!durable) return { ok: false, reason: 'no-durable-decision' };
                const participant = tx.participants[entry.participant];
                const expectedPhase = durable.decision === 'commit' ? 'committed' : 'aborted';
                if (participant.phase === expectedPhase) {
                    state.duplicateDecisions += 1;
                    return { ok: true, duplicate: true, decision: durable.decision, participant: entry.participant };
                }
                if (durable.decision === 'commit') {
                    if (participant.phase !== 'prepared') return { ok: false, reason: 'participant-not-prepared' };
                    if (entry.participant === tx.source) {
                        state.balances[tx.source] -= tx.amountCents;
                        state.locked[tx.source] -= tx.amountCents;
                    } else {
                        state.balances[tx.target] += tx.amountCents;
                    }
                } else if (entry.participant === tx.source && participant.phase === 'prepared') {
                    state.locked[tx.source] -= tx.amountCents;
                }
                participant.phase = expectedPhase;
                state.balanceMutations.push({ txId: tx.id, participant: entry.participant, decision: durable.decision, balances: { ...state.balances } });
                tx.finalized = [tx.source, tx.target].every((id) => tx.participants[id].phase === expectedPhase);
                return { ok: true, duplicate: false, decision: durable.decision, participant: entry.participant, finalized: tx.finalized, balances: { ...state.balances } };
            }
            default:
                return { ok: true };
        }
    }

    const settlement = {
        id: 'settlement',
        name: 'Two-ledger payment settlement',
        shortName: 'Settlement',
        question: 'Can two independently owned ledgers reach one transaction outcome when the coordinator dies after recording commit?',
        scenario: 'Coordinator crash after 2PC decision',
        createState: settlementState,
        applyCommittedEntry: applySettlement,
        actions: [
            { atMs: 0, key: 'begin', type: 'settlement.transaction.begun', lane: 'clients', actor: 'checkout', target: 'coordinator', label: 'Begin transfer-88 for ₹42', detail: 'ledger-a owns the debit account and ledger-b owns the credit account. Neither service can update the other directly.', correlationId: 'transfer-88', entry: { op: 'begin', txId: 'transfer-88', source: 'ledger-a', target: 'ledger-b', amountCents: 4200 } },
            { atMs: 18, key: 'prepare-a', type: 'twopc.participant.prepared', lane: 'nodes', actor: 'coordinator', target: 'ledger-a', label: 'Debit ledger votes YES', detail: (_state, { effect }) => `ledger-a locks ₹42 but its visible balance remains ₹${(effect.balances['ledger-a'] / 100).toFixed(0)}.`, correlationId: 'transfer-88', causedBy: 'begin', entry: { op: 'prepare', txId: 'transfer-88', participant: 'ledger-a' }, data: (_state, { effect }) => ({ vote: effect.vote, available: effect.available }) },
            { atMs: 28, key: 'prepare-b', type: 'twopc.participant.prepared', lane: 'nodes', actor: 'coordinator', target: 'ledger-b', label: 'Credit ledger votes YES', detail: 'ledger-b durably promises it can accept the credit and waits for the global decision.', correlationId: 'transfer-88', causedBy: 'prepare-a', entry: { op: 'prepare', txId: 'transfer-88', participant: 'ledger-b' }, data: (_state, { effect }) => ({ vote: effect.vote }) },
            { atMs: 36, key: 'decision', type: 'twopc.decision.committed', lane: 'commits', actor: 'coordinator', target: 'decision-log', label: 'COMMIT decision becomes durable', detail: (_state, { effect }) => `Both votes are YES. COMMIT is recorded at replicated decision index ${effect.index} before either participant is notified.`, correlationId: 'transfer-88', causedBy: 'prepare-b', entry: { op: 'decide', txId: 'transfer-88' }, data: (_state, { effect }) => ({ decision: effect.decision, index: effect.index }) },
            { atMs: 41, key: 'crash', type: 'process.crashed', lane: 'faults', actor: 'coordinator', target: 'runtime', label: 'Coordinator dies before sending COMMIT', detail: 'Both ledgers remain prepared. The decision is safe because it preceded the crash in a durable log; progress now requires recovery.', correlationId: 'transfer-88', causedBy: 'decision', entry: { op: 'crash' }, process: 'crashed' },
            { atMs: 1031, key: 'in-doubt', type: 'twopc.transaction.indoubt', lane: 'faults', actor: 'ledger-a', target: 'coordinator', label: 'Participants are blocked in PREPARED', detail: 'A participant cannot invent COMMIT or ABORT. Prepared locks remain and balances have not moved while the coordinator is unavailable.', correlationId: 'transfer-88', causedBy: 'crash', entry: { op: 'observe-in-doubt', txId: 'transfer-88' }, data: (_state, { effect }) => ({ phases: effect.phases, balances: effect.balances }) },
            { atMs: 1080, key: 'recover', type: 'twopc.coordinator.recovered', lane: 'commits', actor: 'coordinator-2', target: 'decision-log', label: 'Replacement reads the durable decision', detail: (_state, { effect }) => `Coordinator epoch ${effect.epoch} recovers COMMIT; it does not rerun business logic or choose a new outcome.`, correlationId: 'transfer-88', causedBy: 'crash', entry: { op: 'recover', txId: 'transfer-88' }, data: (_state, { effect }) => ({ epoch: effect.epoch, decision: effect.decision }) },
            { atMs: 1102, key: 'commit-a', type: 'twopc.decision.applied', lane: 'commits', actor: 'coordinator-2', target: 'ledger-a', label: 'Debit ledger applies COMMIT', detail: 'ledger-a converts its prepared lock into the ₹42 debit. The target remains obligated to the same durable outcome.', correlationId: 'transfer-88', causedBy: 'recover', entry: { op: 'apply-decision', txId: 'transfer-88', participant: 'ledger-a' }, data: (_state, { effect }) => ({ decision: effect.decision, balances: effect.balances }) },
            { atMs: 1118, key: 'commit-b', type: 'twopc.decision.applied', lane: 'commits', actor: 'coordinator-2', target: 'ledger-b', label: 'Credit ledger applies COMMIT', detail: (_state, { effect }) => `ledger-b posts the matching credit; transfer-88 is now ${effect.finalized ? 'finalized' : 'pending'}.`, correlationId: 'transfer-88', causedBy: 'recover', entry: { op: 'apply-decision', txId: 'transfer-88', participant: 'ledger-b' }, data: (_state, { effect }) => ({ finalized: effect.finalized, balances: effect.balances }) },
            { atMs: 1132, key: 'duplicate', type: 'twopc.decision.duplicate', lane: 'nodes', actor: 'coordinator-2', target: 'ledger-b', label: 'COMMIT delivery is retried', detail: 'Participant state is keyed by transaction ID, so retrying the recovery message cannot credit ledger-b twice.', correlationId: 'transfer-88', causedBy: 'commit-b', entry: { op: 'apply-decision', txId: 'transfer-88', participant: 'ledger-b' }, data: (_state, { effect }) => ({ duplicate: effect.duplicate }) },
            { atMs: 1160, key: 'begin-89', type: 'settlement.transaction.begun', lane: 'clients', actor: 'checkout', target: 'coordinator-2', label: 'Begin transfer-89 for ₹80', detail: 'This second transfer isolates the abort path: ledger-a has only ₹58 after transfer-88.', correlationId: 'transfer-89', entry: { op: 'begin', txId: 'transfer-89', source: 'ledger-a', target: 'ledger-b', amountCents: 8000 } },
            { atMs: 1172, key: 'reject-89', type: 'twopc.participant.rejected', lane: 'nodes', actor: 'coordinator-2', target: 'ledger-a', label: 'Debit ledger votes NO', detail: 'The source cannot reserve ₹80, so no debit occurs and the only legal global decision is ABORT.', correlationId: 'transfer-89', causedBy: 'begin-89', entry: { op: 'prepare', txId: 'transfer-89', participant: 'ledger-a' }, data: (_state, { effect }) => ({ vote: effect.vote, available: effect.available }) },
            { atMs: 1184, key: 'abort-89', type: 'twopc.decision.committed', lane: 'commits', actor: 'coordinator-2', target: 'decision-log', label: 'ABORT becomes durable', detail: 'A missing or NO vote can never produce COMMIT. The abort record gives every participant the same terminal outcome.', correlationId: 'transfer-89', causedBy: 'reject-89', entry: { op: 'decide', txId: 'transfer-89' }, data: (_state, { effect }) => ({ decision: effect.decision, index: effect.index }) },
            { atMs: 1192, key: 'abort-a', type: 'twopc.decision.applied', lane: 'commits', actor: 'coordinator-2', target: 'ledger-a', label: 'ledger-a applies ABORT', detail: 'No balance or lock is changed because the prepare was rejected.', correlationId: 'transfer-89', causedBy: 'abort-89', entry: { op: 'apply-decision', txId: 'transfer-89', participant: 'ledger-a' } },
            { atMs: 1200, type: 'twopc.decision.applied', lane: 'commits', actor: 'coordinator-2', target: 'ledger-b', label: 'ledger-b applies ABORT', detail: 'Both participant records now agree on ABORT and transfer-89 is finalized with no ledger effect.', correlationId: 'transfer-89', causedBy: 'abort-89', entry: { op: 'apply-decision', txId: 'transfer-89', participant: 'ledger-b' } },
        ],
        invariants(state) {
            const transfer = state.transactions.get('transfer-88');
            const rejected = state.transactions.get('transfer-89');
            const terminalAgreement = [...state.transactions.values()].every((tx) => {
                if (!tx.finalized) return false;
                const expected = tx.decision === 'commit' ? 'committed' : 'aborted';
                return Object.values(tx.participants).every((participant) => participant.phase === expected);
            });
            const preparesWereInvisible = state.prepareSnapshots.every((snapshot) => JSON.stringify(snapshot.before) === JSON.stringify(snapshot.after));
            const abortedMutations = state.balanceMutations.filter((mutation) => mutation.txId === 'transfer-89')
                .some((mutation) => mutation.balances['ledger-a'] !== 5800 || mutation.balances['ledger-b'] !== 6200);
            const total = Object.values(state.balances).reduce((sum, balance) => sum + balance, 0);
            return [
                terminalAgreement
                    ? pass('atomic-transaction-outcome', 'both ledgers reached COMMIT for transfer-88 and ABORT for transfer-89', { transfer88: transfer.participants, transfer89: rejected.participants })
                    : fail('atomic-transaction-outcome', 'participants ended with mixed outcomes'),
                state.recoveredDecisions.some((record) => record.txId === 'transfer-88' && record.decision === 'commit') && transfer.finalized
                    ? pass('coordinator-crash-recovery', 'the replacement completed the durable COMMIT without choosing a new outcome', { recovery: state.recoveredDecisions[0] })
                    : fail('coordinator-crash-recovery', 'coordinator failure lost or changed the global decision'),
                preparesWereInvisible && state.inDoubtObservations === 1
                    ? pass('prepare-is-not-payment', 'prepared locks changed no visible balance while the coordinator was unavailable')
                    : fail('prepare-is-not-payment', 'a prepare vote moved visible money'),
                total === state.initialTotal
                    ? pass('ledger-conservation', `₹${(state.balances['ledger-a'] / 100).toFixed(0)} + ₹${(state.balances['ledger-b'] / 100).toFixed(0)} = ₹${(state.initialTotal / 100).toFixed(0)}`, { balances: state.balances })
                    : fail('ledger-conservation', 'money was created or destroyed', { balances: state.balances }),
                !abortedMutations && rejected.decision === 'abort'
                    ? pass('failed-prepare-aborts', 'the insufficient-funds transfer finalized ABORT with no ledger effect')
                    : fail('failed-prepare-aborts', 'a rejected prepare changed a balance'),
                state.duplicateDecisions === 1 && state.locked['ledger-a'] === 0
                    ? pass('decision-retry-idempotent', 'a repeated COMMIT message neither credited twice nor leaked a prepared lock')
                    : fail('decision-retry-idempotent', 'decision retry duplicated an effect or stranded a lock'),
            ];
        },
        metrics(state) {
            return [
                { label: 'ledger-a', value: `₹${(state.balances['ledger-a'] / 100).toFixed(0)}`, unit: 'settled' },
                { label: 'ledger-b', value: `₹${(state.balances['ledger-b'] / 100).toFixed(0)}`, unit: 'settled' },
                { label: 'recoveries', value: state.coordinator.recoveries, unit: `epoch ${state.coordinator.epoch}` },
                { label: 'decisions', value: state.decisionLog.size, unit: 'durable' },
            ];
        },
        explainEvent(event) {
            const explanations = {
                'twopc.participant.prepared': 'YES is a durable promise, not a payment. The participant reserves what it needs and cannot unilaterally forget the transaction, but its visible balance remains unchanged.',
                'twopc.decision.committed': 'The coordinator records one irreversible global outcome before sending it. Once COMMIT is durable, a replacement must finish COMMIT; it is not allowed to time out and choose ABORT.',
                'twopc.transaction.indoubt': 'This is 2PC\'s liveness cost. Prepared participants are safe but blocked while the decision is unavailable. They must not use a local timeout to invent an outcome.',
                'twopc.coordinator.recovered': 'Recovery reads the decision log rather than re-running the transaction. The new coordinator epoch changes the messenger, not the outcome.',
                'twopc.decision.duplicate': 'Each participant records the terminal phase under transfer-88. Re-delivering COMMIT returns the existing result, so recovery can retry until acknowledged.',
            };
            return explanations[event.type] || event.data.detail;
        },
        visualization(state) {
            const transfer = state.transactions.get('transfer-88');
            const phase = (id) => transfer?.participants[id]?.phase || 'idle';
            return {
                title: `transfer-88 · ${transfer?.decision || 'collecting votes'}`,
                subtitle: `decision index ${state.decisionLog.get('transfer-88')?.index || '—'} · coordinator epoch ${state.coordinator.epoch}`,
                nodes: [
                    makeNode('coordinator', state.coordinator.alive ? 'up' : 'crashed', 'connected', `2PC · epoch ${state.coordinator.epoch}`, state.coordinator.alive ? 'recovering decisions' : 'decision delivery stopped', state.coordinator.alive ? 'amber' : 'red'),
                    makeNode('decision-log', 'up', 'connected', 'replicated', `${state.decisionLog.size} durable decisions`, 'green'),
                    makeNode('ledger-a', 'up', 'connected', phase('ledger-a'), `₹${(state.balances['ledger-a'] / 100).toFixed(0)} · ₹${(state.locked['ledger-a'] / 100).toFixed(0)} locked`, 'blue'),
                    makeNode('ledger-b', 'up', 'connected', phase('ledger-b'), `₹${(state.balances['ledger-b'] / 100).toFixed(0)}`, 'purple'),
                ],
                policy: 'Prepare reserves; one durable decision fixes the outcome; recovery retries that decision until every participant agrees.',
            };
        },
    };

    return [feed, collaboration, settlement];
}

module.exports = { createExtendedWorkloads };
