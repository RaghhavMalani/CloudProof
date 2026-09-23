'use strict';

/**
 * Executable, simulation-only mutants for the Bug Museum.
 *
 * These models are intentionally isolated from the production Raft and serving
 * paths.  Each exhibit describes a four-event witness, a deterministic search
 * corpus, an exact failure signature, and the correction applied when the same
 * schedule is replayed against the healthy rule.
 */

const NOISE = [
    ['observer.sample', 'Sample node metrics'],
    ['network.heartbeat', 'Deliver an unrelated heartbeat'],
    ['client.read', 'Serve an unrelated safe read'],
    ['recorder.flush', 'Flush the causal recorder'],
    ['scheduler.tick', 'Advance the deterministic clock'],
    ['health.probe', 'Probe replica readiness'],
];

const MUTANTS = [
    {
        id: 'older-term-commit', number: '01', group: 'CONSENSUS', accent: 'amber',
        title: 'The time-travelling commit', short: 'Older-term commit',
        faultyRule: 'Commit an older-term entry by replica count.',
        correctedRule: 'A leader only advances commitIndex by counting replicas when log[N].term equals its current term.',
        invariant: 'Raft leader completeness', signature: 'invariant:leader-completeness',
        actors: ['client', 'node A · t3', 'node B · t4', 'node C'],
        required: ['log.append-old', 'leader.elected', 'rpc.ack-old', 'commit.advance'],
        violationAction: 'commit.advance',
        correction: 'Commit blocked · entry term 3 ≠ leader term 4',
        correctedOutcome: 'The old entry remains uncommitted until a term-4 entry reaches quorum.',
        steps: [
            ['log.append-old', 'node A · t3', 'node B · t4', 'Append x in term 3', 'x is replicated to only one voter before A is isolated.'],
            ['leader.elected', 'node B · t4', 'node C', 'Elect B in term 4', 'B inherits the uncommitted term-3 suffix.'],
            ['rpc.ack-old', 'node B · t4', 'node C', 'C acknowledges old entry x', 'Replica count reaches two, but x is not from the current term.'],
            ['commit.advance', 'node B · t4', 'client', 'Advance commitIndex to x', 'The mutant commits solely by replica count, violating the current-term guard.'],
        ],
    },
    {
        id: 'vote-before-persist', number: '02', group: 'CONSENSUS', accent: 'rose',
        title: 'The vote that vanished', short: 'Volatile vote reply',
        faultyRule: 'Reply to RequestVote before persisting the vote.',
        correctedRule: 'Persist currentTerm and votedFor before a granted RequestVote response becomes observable.',
        invariant: 'Election safety', signature: 'invariant:election-safety',
        actors: ['candidate B', 'voter A', 'candidate C', 'disk'],
        required: ['vote.request', 'vote.choose', 'vote.reply', 'node.crash'],
        violationAction: 'vote.reply',
        correction: 'Persist votedFor=B · then reply granted',
        correctedOutcome: 'After restart, A remembers B and rejects C in the same term.',
        steps: [
            ['vote.request', 'candidate B', 'voter A', 'Request vote in term 6', 'B has an up-to-date log and asks A for its vote.'],
            ['vote.choose', 'voter A', 'disk', 'Choose B in memory', 'The mutant changes volatile state but has not flushed stable metadata.'],
            ['vote.reply', 'voter A', 'candidate B', 'Reply voteGranted=true', 'The grant escapes before votedFor=B is durable.'],
            ['node.crash', 'disk', 'candidate C', 'Crash, restart, then meet C', 'A forgets the grant and can vote twice in term 6.'],
        ],
    },
    {
        id: 'rejected-append-timeout', number: '03', group: 'CONSENSUS', accent: 'amber',
        title: 'The immortal pretender', short: 'Rejected timeout reset',
        faultyRule: 'Reset election timeout on rejected AppendEntries.',
        correctedRule: 'Only valid leader contact resets the election timer; a rejected stale AppendEntries does not.',
        invariant: 'Election liveness', signature: 'liveness:election-starvation',
        actors: ['stale A · t7', 'voter B · t8', 'candidate C', 'timer'],
        required: ['append.stale', 'append.reject', 'timeout.reset', 'election.starved'],
        violationAction: 'timeout.reset',
        correction: 'Keep B’s election deadline unchanged',
        correctedOutcome: 'B times out, joins C, and the current-term majority elects a leader.',
        steps: [
            ['append.stale', 'stale A · t7', 'voter B · t8', 'Receive stale AppendEntries', 'A cannot prove leadership in B’s newer term.'],
            ['append.reject', 'voter B · t8', 'stale A · t7', 'Reject term 7', 'B correctly returns term 8 and success=false.'],
            ['timeout.reset', 'voter B · t8', 'timer', 'Reset election deadline', 'The faulty side effect treats a rejected RPC as valid leader contact.'],
            ['election.starved', 'timer', 'candidate C', 'Current election never starts', 'Repeated stale traffic keeps the majority leaderless.'],
        ],
    },
    {
        id: 'stale-leader-read', number: '04', group: 'SERVING', accent: 'rose',
        title: 'The ghost leader', short: 'Stale leader read',
        faultyRule: 'Serve reads from a stale leader.',
        correctedRule: 'Fence reads unless the leader holds a fresh quorum lease or completes ReadIndex.',
        invariant: 'Linearizable reads', signature: 'history:non-linearizable-read',
        actors: ['client', 'isolated A', 'leader B', 'voter C'],
        required: ['leader.isolate', 'write.commit-new', 'read.request', 'read.reply-stale'],
        violationAction: 'read.reply-stale',
        correction: 'Reject read · stale leader lease',
        correctedOutcome: 'The client retries through B and observes the committed value v2.',
        steps: [
            ['leader.isolate', 'leader B', 'isolated A', 'Partition old leader A', 'B and C form a newer-term majority.'],
            ['write.commit-new', 'leader B', 'voter C', 'Commit model/current = v2', 'The majority applies v2 while A still has v1.'],
            ['read.request', 'client', 'isolated A', 'Read model/current', 'The request reaches A after its quorum lease has expired.'],
            ['read.reply-stale', 'isolated A', 'client', 'Reply model/current = v1', 'A returns a value older than a completed write.'],
        ],
    },
    {
        id: 'dedup-disabled', number: '05', group: 'SERVING', accent: 'violet',
        title: 'The echoing command', short: 'No request dedup',
        faultyRule: 'Disable request deduplication.',
        correctedRule: 'Resolve retries by stable clientId + seqNo and return the original committed result.',
        invariant: 'At-most-once effects', signature: 'history:duplicate-client-command',
        actors: ['client 7', 'gateway', 'leader', 'state machine'],
        required: ['command.send', 'command.commit', 'command.retry', 'command.commit-duplicate'],
        violationAction: 'command.commit-duplicate',
        correction: 'Return result of original log entry #18',
        correctedOutcome: 'Both attempts resolve to one committed effect and one stable result.',
        steps: [
            ['command.send', 'client 7', 'gateway', 'Send seqNo 41 · increment', 'The gateway forwards a command with a stable request identity.'],
            ['command.commit', 'leader', 'state machine', 'Commit seqNo 41 once', 'The response is lost after the effect is applied.'],
            ['command.retry', 'client 7', 'gateway', 'Retry seqNo 41', 'The client correctly reuses the same identity.'],
            ['command.commit-duplicate', 'leader', 'state machine', 'Append and apply seqNo 41 again', 'With the dedup table disabled, one logical command has two effects.'],
        ],
    },
    {
        id: 'learner-quorum', number: '06', group: 'CONSENSUS', accent: 'violet',
        title: 'The counterfeit majority', short: 'Learner in quorum',
        faultyRule: 'Count learners toward quorum.',
        correctedRule: 'Replicate to learners, but count acknowledgements from voting members only.',
        invariant: 'Quorum intersection', signature: 'invariant:learner-counted-for-quorum',
        actors: ['leader A', 'voter B', 'voter C', 'learner L'],
        required: ['learner.stage', 'voters.partition', 'learner.ack', 'commit.advance'],
        violationAction: 'commit.advance',
        correction: 'Commit blocked · 1 of 3 voters acknowledged',
        correctedOutcome: 'The entry waits for B or C; learner L can catch up without changing quorum.',
        steps: [
            ['learner.stage', 'leader A', 'learner L', 'Stage L as learner', 'L receives replication traffic but has no vote.'],
            ['voters.partition', 'leader A', 'voter B', 'Partition A from B and C', 'Only one of three configured voters remains reachable.'],
            ['learner.ack', 'learner L', 'leader A', 'L acknowledges entry y', 'The learner is caught up, yielding two physical replicas.'],
            ['commit.advance', 'leader A', 'state machine', 'Commit with A + L', 'The mutant mistakes replica count for voting quorum.'],
        ],
    },
    {
        id: 'fleet-barrier', number: '07', group: 'ROLLOUT', accent: 'cyan',
        title: 'The split-brain model', short: 'Early model flip',
        faultyRule: 'Flip model versions before the fleet barrier.',
        correctedRule: 'Publish the version pointer only after every serving cohort reports the staged model ready.',
        invariant: 'Fleet version coherence', signature: 'rollout:fleet-version-skew',
        actors: ['controller', 'canary', 'pod B', 'pod C'],
        required: ['model.stage', 'canary.ready', 'pointer.flip', 'request.mismatch'],
        violationAction: 'pointer.flip',
        correction: 'Hold pointer at v1 · fleet barrier 1/3',
        correctedOutcome: 'The pointer flips once all three pods can serve v2, so routing stays coherent.',
        steps: [
            ['model.stage', 'controller', 'canary', 'Stage model v2', 'Only the canary has fetched and verified the new artifacts.'],
            ['canary.ready', 'canary', 'controller', 'Report v2 ready · 1/3', 'Pods B and C still have v1 resident.'],
            ['pointer.flip', 'controller', 'pod B', 'Flip model/current to v2', 'The faulty controller skips the all-fleet readiness barrier.'],
            ['request.mismatch', 'pod B', 'client', 'Route v2 request to v1 pod', 'One fleet now serves incompatible model versions.'],
        ],
    },
    {
        id: 'post-filtering', number: '08', group: 'RETRIEVAL', accent: 'cyan',
        title: 'The disappearing neighbors', short: 'ANN post-filtering',
        faultyRule: 'Use post-filtering instead of filter-during-traversal.',
        correctedRule: 'Apply the tenant/filter predicate while traversing the graph so eligible paths remain explorable.',
        invariant: 'Filtered recall floor', signature: 'retrieval:filtered-recall-collapse',
        actors: ['query', 'HNSW graph', 'blue tenant', 'red tenant'],
        required: ['index.populate', 'query.filtered', 'ann.topk', 'results.post-filter'],
        violationAction: 'results.post-filter',
        correction: 'Traverse eligible red nodes · recall@5 = 100%',
        correctedOutcome: 'Filter-aware traversal returns five valid red neighbors instead of an empty tail.',
        steps: [
            ['index.populate', 'blue tenant', 'HNSW graph', 'Populate dense mixed graph', 'Globally close blue vectors dominate the entry neighborhood.'],
            ['query.filtered', 'query', 'HNSW graph', 'Search k=5 · tenant=red', 'The filter is known before traversal begins.'],
            ['ann.topk', 'HNSW graph', 'blue tenant', 'Return global top 5', 'All five candidates belong to the ineligible blue tenant.'],
            ['results.post-filter', 'blue tenant', 'query', 'Discard 5 of 5 candidates', 'Post-filtering collapses filtered recall to zero.'],
        ],
    },
    {
        id: 'checksum-skipped', number: '09', group: 'ARTIFACTS', accent: 'amber',
        title: 'The poisoned exhibit', short: 'Unchecked artifact',
        faultyRule: 'Accept an artifact without checksum verification.',
        correctedRule: 'Hash every fetched artifact and compare it with the signed manifest before activation.',
        invariant: 'Artifact integrity', signature: 'artifact:checksum-bypass',
        actors: ['object store', 'loader', 'manifest', 'serving pod'],
        required: ['artifact.corrupt', 'manifest.fetch', 'checksum.skip', 'artifact.activate'],
        violationAction: 'artifact.activate',
        correction: 'Reject artifact · sha256 mismatch',
        correctedOutcome: 'The corrupted bytes never become resident; the pod keeps the last verified model.',
        steps: [
            ['artifact.corrupt', 'object store', 'loader', 'Fetch truncated shard', 'The transfer returns bytes that differ from the published artifact.'],
            ['manifest.fetch', 'manifest', 'loader', 'Read expected sha256', 'A trustworthy digest is available to the loader.'],
            ['checksum.skip', 'loader', 'serving pod', 'Skip digest comparison', 'The faulty fast path parses bytes without verifying provenance.'],
            ['artifact.activate', 'loader', 'serving pod', 'Activate corrupted shard', 'Unverified data crosses the serving boundary.'],
        ],
    },
    {
        id: 'unsafe-retry', number: '10', group: 'OPERATIONS', accent: 'rose',
        title: 'The retry storm', short: 'Unsafe retry loop',
        faultyRule: 'Retry without backoff or idempotency.',
        correctedRule: 'Reuse an idempotency key and apply bounded exponential backoff with jitter.',
        invariant: 'Retry safety', signature: 'operations:retry-amplification',
        actors: ['worker', 'gateway', 'downstream', 'queue'],
        required: ['request.send', 'request.timeout', 'request.retry-hot', 'effect.duplicate'],
        violationAction: 'request.retry-hot',
        correction: 'Back off 200 ms · reuse key job-91',
        correctedOutcome: 'The downstream coalesces duplicates and the retry rate stays below capacity.',
        steps: [
            ['request.send', 'worker', 'gateway', 'POST job 91 · key absent', 'The downstream accepts the request but its response is delayed.'],
            ['request.timeout', 'gateway', 'worker', 'Timeout after 50 ms', 'The outcome is unknown, so a retry may be necessary.'],
            ['request.retry-hot', 'worker', 'downstream', 'Retry immediately · new identity', 'No delay or stable key limits amplification.'],
            ['effect.duplicate', 'downstream', 'queue', 'Enqueue job 91 twice', 'Retries overload the dependency and duplicate the side effect.'],
        ],
    },
];

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function byId(id) {
    const mutant = MUTANTS.find((item) => item.id === id);
    if (!mutant) throw new Error(`Unknown Bug Museum mutant: ${id}`);
    return mutant;
}

function seededNumber(seed, salt) {
    let value = (Number(seed) || 1) ^ (salt * 0x9e3779b9);
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    return value >>> 0;
}

function materializeCounterexample(id, seed = 42) {
    const mutant = byId(id);
    const actionAt = new Map([4, 10, 16, 23].map((position, index) => [position, mutant.steps[index]]));
    const actions = [];
    for (let position = 0; position < 25; position += 1) {
        const witness = actionAt.get(position);
        if (witness) {
            const [type, actor, target, label, detail] = witness;
            actions.push({
                id: `${id}-w${actions.length + 1}`, type, actor, target, label, detail,
                atMs: position * 125,
            });
        } else {
            const noise = NOISE[seededNumber(seed + position, position + mutant.number.length) % NOISE.length];
            actions.push({
                id: `${id}-n${actions.length + 1}`, type: noise[0], actor: 'observer', target: 'recorder',
                label: noise[1], detail: 'Coverage-producing schedule noise; removable without changing the failure.',
                atMs: position * 125,
            });
        }
    }
    return { schemaVersion: 1, kind: 'cloudproof.bug-museum-schedule', seed, mutantId: id, actions };
}

function containsWitness(mutant, actions) {
    let cursor = 0;
    for (const action of actions) {
        if (action.type === mutant.required[cursor]) cursor += 1;
        if (cursor === mutant.required.length) return true;
    }
    return false;
}

function runSchedule(id, schedule, options = {}) {
    const mutant = byId(id);
    const mutationEnabled = options.mutationEnabled !== false;
    const hasWitness = containsWitness(mutant, schedule.actions);
    let violatingEvent = null;
    const trace = schedule.actions.map((action, index) => {
        const isViolatingAction = action.type === mutant.violationAction && hasWitness;
        const event = {
            id: `museum-${id}-${index + 1}`,
            sequence: index + 1,
            type: action.type,
            time: { elapsedMs: action.atMs },
            actor: action.actor,
            target: action.target,
            label: action.label,
            detail: action.detail,
            status: 'normal',
        };
        if (isViolatingAction && mutationEnabled) {
            event.status = 'violation';
            event.detail = `${action.detail} Violates ${mutant.invariant}.`;
            violatingEvent = event;
        } else if (isViolatingAction && !mutationEnabled) {
            event.type = `corrected.${action.type}`;
            event.label = mutant.correction;
            event.detail = mutant.correctedRule;
            event.status = 'correction';
        }
        return event;
    });
    const failure = mutationEnabled && hasWitness ? {
        kind: mutant.signature.split(':')[0],
        id: mutant.invariant,
        signature: mutant.signature,
        reason: mutant.faultyRule,
        eventId: violatingEvent?.id,
        eventSequence: violatingEvent?.sequence,
    } : null;
    return {
        ok: !failure,
        mutantId: id,
        mutationEnabled,
        schedule: clone(schedule),
        trace: { events: trace },
        failure,
        outcome: failure
            ? `${mutant.invariant} violated at event ${violatingEvent?.sequence}.`
            : mutant.correctedOutcome,
    };
}

function search(id, options = {}) {
    const mutant = byId(id);
    const seed = Number(options.seed) || 42;
    const maxRuns = Number(options.maxRuns) || 64;
    const witness = materializeCounterexample(id, seed);
    const discoveryRun = 4 + (seededNumber(seed, Number(mutant.number)) % 9);
    for (let run = 1; run <= Math.min(maxRuns, discoveryRun); run += 1) {
        const candidate = clone(witness);
        if (run < discoveryRun) {
            const missing = (run + Number(mutant.number)) % mutant.required.length;
            const action = candidate.actions.find((item) => item.type === mutant.required[missing]);
            action.type = 'search.decoy';
            action.label = 'Explore a near-miss schedule';
        }
        const result = runSchedule(id, candidate, { mutationEnabled: true });
        if (!result.ok) return { found: true, runs: run, schedule: candidate, result };
    }
    return { found: false, runs: maxRuns, schedule: null, result: null };
}

function shrink(id, schedule) {
    const mutant = byId(id);
    const target = mutant.signature;
    const before = schedule.actions.length;
    let evaluations = 0;
    let actions = clone(schedule.actions);
    const preserves = (candidateActions) => {
        evaluations += 1;
        const candidate = { ...schedule, actions: candidateActions };
        return runSchedule(id, candidate, { mutationEnabled: true }).failure?.signature === target;
    };

    let granularity = 2;
    while (actions.length > 1) {
        const chunkSize = Math.ceil(actions.length / granularity);
        let reduced = false;
        for (let start = 0; start < actions.length; start += chunkSize) {
            const candidate = actions.slice(0, start).concat(actions.slice(start + chunkSize));
            if (candidate.length && preserves(candidate)) {
                actions = candidate;
                granularity = Math.max(2, granularity - 1);
                reduced = true;
                break;
            }
        }
        if (!reduced) {
            if (granularity >= actions.length) break;
            granularity = Math.min(actions.length, granularity * 2);
        }
    }

    for (let index = actions.length - 1; index >= 0; index -= 1) {
        const candidate = actions.slice(0, index).concat(actions.slice(index + 1));
        if (candidate.length && preserves(candidate)) actions = candidate;
    }

    actions = actions.map((action, index) => ({ ...action, atMs: index * 125 }));
    const minimized = { ...clone(schedule), actions };
    const result = runSchedule(id, minimized, { mutationEnabled: true });
    return {
        target,
        schedule: minimized,
        result,
        stats: {
            actionsBefore: before,
            actionsAfter: actions.length,
            removed: before - actions.length,
            reductionPercent: Math.round((1 - actions.length / before) * 100),
            evaluations,
        },
    };
}

function evaluateMutant(id, options = {}) {
    const found = search(id, options);
    if (!found.found) return { id, found: false, runs: found.runs };
    const minimized = shrink(id, found.schedule);
    const corrected = runSchedule(id, minimized.schedule, { mutationEnabled: false });
    return {
        id, found: true, runs: found.runs,
        original: found.result,
        minimized,
        corrected,
        correctionPassed: corrected.ok,
    };
}

function evaluateAll(options = {}) {
    const results = MUTANTS.map((mutant, index) => evaluateMutant(mutant.id, {
        ...options,
        seed: (Number(options.seed) || 42) + index * 17,
    }));
    const reductions = results.filter((item) => item.found).map((item) => item.minimized.stats.reductionPercent).sort((a, b) => a - b);
    const middle = Math.floor(reductions.length / 2);
    const medianReduction = reductions.length % 2
        ? reductions[middle]
        : Math.round((reductions[middle - 1] + reductions[middle]) / 2);
    return {
        results,
        discovered: results.filter((item) => item.found).length,
        total: MUTANTS.length,
        correctedPassed: results.filter((item) => item.correctionPassed).length,
        medianReduction,
    };
}

module.exports = {
    MUTANTS,
    getMutant: byId,
    materializeCounterexample,
    runSchedule,
    search,
    shrink,
    evaluateMutant,
    evaluateAll,
};
