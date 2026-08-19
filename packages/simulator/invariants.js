'use strict';

function proof(id, status, summary, evidence = {}) {
    return { id, status, ok: status !== 'fail', summary, evidence };
}

/** Machine-check the properties that can be proven from an in-memory cluster. */
function evaluateInvariants(cluster) {
    const states = cluster.states();
    const leadersByTerm = new Map();
    for (const leader of cluster.leaders) {
        const ids = leadersByTerm.get(leader.term) || [];
        ids.push(leader.node.replicaId);
        leadersByTerm.set(leader.term, ids);
    }
    const conflicting = [...leadersByTerm.entries()].find(([, ids]) => ids.length > 1);

    const electionSafety = conflicting
        ? proof('election-safety', 'fail', `term ${conflicting[0]} has ${conflicting[1].length} leaders`, {
            term: conflicting[0], leaders: conflicting[1],
        })
        : proof('election-safety', 'pass', 'at most one leader exists in every observed term', {
            leadersByTerm: Object.fromEntries(leadersByTerm),
        });

    const matching = cluster.checkLogConsistency();
    const logMatching = matching.ok
        ? proof('log-matching', 'pass', 'matching-term prefixes are byte-identical')
        : proof('log-matching', 'fail', matching.reason);

    const committed = states.length > 0
        ? cluster.checkCommittedPrefix()
        : { ok: true, verified: 0 };
    const stateMachineSafety = committed.ok
        ? proof('state-machine-safety', 'pass', `${committed.verified} committed entries share one prefix`, {
            verifiedEntries: committed.verified,
        })
        : proof('state-machine-safety', 'fail', committed.reason);

    const live = states.length;
    const voterCount = cluster.leader?.node?.members?.length || cluster.voters || cluster.size;
    const quorum = Math.floor(voterCount / 2) + 1;
    const quorumStatus = live >= quorum ? 'pass' : 'watch';
    const quorumHealth = proof('quorum-availability', quorumStatus,
        `${live} live node${live === 1 ? '' : 's'}; quorum requires ${quorum}`, { live, quorum, voterCount });

    const comparable = states.length > 0 && states.every((state) => state.commitIndex === states[0].commitIndex);
    const fingerprints = new Set(states.map((state) => state.index).filter(Boolean));
    const indexAgreement = !comparable
        ? proof('index-agreement', 'watch', 'replicas are at different commit indexes; comparison is deferred', {
            commitIndexes: Object.fromEntries(states.map((state) => [state.replicaId, state.commitIndex])),
        })
        : fingerprints.size <= 1
            ? proof('index-agreement', 'pass', 'caught-up replicas expose the same index fingerprint', {
                fingerprint: [...fingerprints][0] || null,
            })
            : proof('index-agreement', 'fail', 'caught-up replicas expose different index fingerprints', {
                fingerprints: Object.fromEntries(states.map((state) => [state.replicaId, state.index])),
            });

    return [electionSafety, logMatching, stateMachineSafety, quorumHealth, indexAgreement];
}

module.exports = { evaluateInvariants };
