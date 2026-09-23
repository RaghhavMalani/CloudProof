'use strict';

function eventSummary(event) {
    const elapsed = event.time ? event.time.elapsedMs : 0;
    if (event.type === 'fault.applied' || event.type === 'fault.healed') {
        return { atMs: elapsed, eventId: event.id, statement: event.type + ': ' + (event.data.fault || 'network change') };
    }
    if (event.type === 'rpc.blocked') {
        return {
            atMs: elapsed,
            eventId: event.id,
            statement: 'RPC ' + (event.data.rpcId || '?') + ' from ' + (event.data.from || '?')
                + ' to ' + (event.data.to || '?') + ' was blocked by ' + (event.data.reason || 'the network'),
        };
    }
    if (event.type === 'node.role.changed') {
        return {
            atMs: elapsed,
            eventId: event.id,
            statement: (event.subject.id || 'node') + ' changed role from '
                + (event.data.from || 'offline') + ' to ' + event.data.to + ' in term ' + event.data.term,
        };
    }
    if (event.type === 'node.term.changed') {
        return {
            atMs: elapsed,
            eventId: event.id,
            statement: (event.subject.id || 'node') + ' moved from term '
                + event.data.from + ' to term ' + event.data.to,
        };
    }
    return { atMs: elapsed, eventId: event.id, statement: event.type };
}

function teachingPoint(failure) {
    if (!failure) return 'No safety failure was observed.';
    if (failure.id === 'linearizability') {
        return 'Replica logs can agree while client-visible real-time order is still impossible. The history checker is the authority for this failure.';
    }
    if (failure.id === 'log-matching') {
        return 'Matching log terms must imply identical prefixes. A disagreement here is protocol state corruption, not merely lag.';
    }
    if (failure.id === 'state-machine-safety') {
        return 'Once an entry is committed, every replica must expose the same command at that index.';
    }
    if (failure.id === 'configuration-overlap') {
        return 'Successive single-server configurations must retain majority overlap or disjoint leaders become possible.';
    }
    if (failure.id === 'version-skew') {
        return 'Replicas at the same committed frontier must agree on the active rollout version.';
    }
    return 'The exact failure class is preserved during shrinking so the reproducer cannot drift to a different bug.';
}

function explainFailure(result) {
    const failure = result.failure;
    const events = result.trace && Array.isArray(result.trace.events) ? result.trace.events : [];
    if (!failure) {
        return {
            summary: 'No invariant violation was found.',
            failure: null,
            causalChain: [],
            teachingPoint: teachingPoint(null),
            regression: null,
        };
    }

    const terminal = events.findLast((event) => event.type === 'invariant.checked'
        && event.data && event.data.status === 'fail'
        && (event.data.id === failure.id
            || (failure.id === 'state-machine-safety' && event.data.id === 'state-machine-safety')));
    const terminalIndex = terminal ? events.indexOf(terminal) : events.length;
    const before = events.slice(0, terminalIndex < 0 ? events.length : terminalIndex);
    const candidates = [
        before.findLast((event) => event.type === 'fault.applied'),
        before.findLast((event) => event.type === 'node.role.changed'),
        before.findLast((event) => event.type === 'rpc.blocked'),
        terminal,
    ].filter(Boolean);
    const unique = [...new Map(candidates.map((event) => [event.id, event])).values()]
        .sort((a, b) => a.sequence - b.sequence)
        .map(eventSummary);

    return {
        summary: failure.id + ': ' + (failure.reason || 'the exact failure predicate was satisfied'),
        failure: { ...failure },
        causalChain: unique,
        teachingPoint: teachingPoint(failure),
        regression: {
            assertion: 'replay result failure.signature equals ' + failure.signature,
            artifactKind: 'cloudproof.failure-artifact',
        },
    };
}

module.exports = { explainFailure, eventSummary };
