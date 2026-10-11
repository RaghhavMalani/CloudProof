'use strict';

/**
 * gate-checks.js — the two independent IV-B.0 gates and the evidence behind
 * them (CLOUDPROOF-PHASE-IV-B.md §5, §13), shared by the simulator campaign and
 * the live multi-process run.
 *
 *   LOGICAL API CORRECTNESS   per-logical-key linearizability of the combined
 *                             client history (linearizability is local, so a
 *                             history of single-key operations is linearizable
 *                             iff each key's sub-history is)
 *   EXACTLY-ONCE APPLICATION  applicationCount <= 1 for every LogicalRequestId,
 *                             and = 1 for every acknowledged write, counted
 *                             from the ranges' application ledgers — never
 *                             inferred from the register checker, which can
 *                             accept a write applied twice.
 */

const path = require('path');
const { execFileSync } = require('child_process');
const { LinearizabilityChecker } = require('../../sim/linearizability');

/** The commit a gate ran on, and whether tracked files were modified. */
function gitProvenance() {
    const root = path.join(__dirname, '..', '..');
    const git = (args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    try {
        return { sha: git(['rev-parse', 'HEAD']), dirty: git(['status', '--porcelain', '--untracked-files=no']).length > 0 };
    } catch (_) {
        return { sha: null, dirty: null };
    }
}

/**
 * Splits a HistoryRecorder event stream by logical key. Each process issues
 * one operation at a time, so a completion belongs to that process's
 * outstanding invoke, and every per-key sub-history stays well-formed.
 */
function historyByKey(events) {
    const outstanding = new Map();
    const byKey = new Map();
    for (const event of events) {
        let key;
        if (event.type === 'invoke') {
            if (outstanding.has(event.process)) throw new Error(`process ${event.process} invoked twice without completing`);
            key = event.op.key;
            outstanding.set(event.process, key);
        } else {
            if (!outstanding.has(event.process)) throw new Error(`process ${event.process} completed without an invoke`);
            key = outstanding.get(event.process);
            outstanding.delete(event.process);
        }
        if (!byKey.has(key)) byKey.set(key, []);
        byKey.get(key).push(event);
    }
    return byKey;
}

/** Gate 1. An exhausted search is inconclusive, and inconclusive fails the gate. */
function checkLogicalLinearizability(events, { maxSteps = 2_000_000 } = {}) {
    const perKey = [];
    for (const [key, history] of historyByKey(events)) {
        const result = new LinearizabilityChecker(undefined, { maxSteps }).check(history);
        perKey.push({
            key,
            operations: history.filter((e) => e.type === 'invoke').length,
            linearizable: result.linearizable,
            exhausted: Boolean(result.exhausted),
            steps: result.steps,
            reason: result.reason || null,
        });
    }
    const failures = perKey.filter((r) => !r.linearizable);
    return {
        ok: failures.length === 0,
        keys: perKey.length,
        operations: perKey.reduce((t, r) => t + r.operations, 0),
        violations: failures.filter((r) => !r.exhausted),
        inconclusive: failures.filter((r) => r.exhausted),
        perKey,
    };
}

/**
 * The authoritative committed ledger of each range: every live replica's
 * ledger must be a prefix of the longest one (State Machine Safety, as seen by
 * the ledger); a disagreement is reported, not resolved.
 */
function committedLedgers(replicaLedgers) {
    const byRange = new Map();
    for (const { rangeId, nodeId, ledger } of replicaLedgers) {
        if (!byRange.has(rangeId)) byRange.set(rangeId, []);
        byRange.get(rangeId).push({ nodeId, ledger });
    }
    const ledgers = new Map();
    const disagreements = [];
    for (const [rangeId, replicas] of byRange) {
        const longest = replicas.reduce((a, b) => (b.ledger.length > a.ledger.length ? b : a));
        for (const replica of replicas) {
            for (let i = 0; i < replica.ledger.length; i += 1) {
                const a = replica.ledger[i];
                const b = longest.ledger[i];
                if (a.index !== b.index || a.logicalRequestId !== b.logicalRequestId || a.outcome !== b.outcome) {
                    disagreements.push({ rangeId, nodes: [replica.nodeId, longest.nodeId], position: i });
                    break;
                }
            }
        }
        ledgers.set(rangeId, longest.ledger);
    }
    return { ledgers, disagreements };
}

/**
 * Gate 2, with the per-request rows of §5.2.
 *   requests: [{ logicalRequestId, attempts: [{ rangeId, epoch, status }], acknowledged, resultReturned }]
 *   replicaLedgers: [{ rangeId, nodeId, ledger }]   (RangeStateMachine ledgers)
 *   probes: [{ status }]                            (deliberately mis-addressed writes)
 */
function checkExactlyOnce({ requests, replicaLedgers, probes = [] }) {
    const { ledgers, disagreements } = committedLedgers(replicaLedgers);
    const applications = new Map();
    let staleApplied = 0;
    for (const [rangeId, ledger] of ledgers) {
        for (const row of ledger) {
            if (row.outcome !== 'applied') continue;
            if (row.addressedRangeId !== row.rangeId || row.addressedEpoch !== row.epoch) staleApplied += 1;
            if (!applications.has(row.logicalRequestId)) applications.set(row.logicalRequestId, []);
            applications.get(row.logicalRequestId).push({ rangeId, epoch: row.epoch, index: row.index });
        }
    }
    const rows = requests.map((request) => {
        const applied = applications.get(request.logicalRequestId) || [];
        return {
            logicalRequestId: request.logicalRequestId,
            attemptCount: request.attempts.length,
            rangeIdsAttempted: [...new Set(request.attempts.map((a) => a.rangeId))],
            epochsAttempted: [...new Set(request.attempts.map((a) => a.epoch))],
            committedRangeId: applied[0] ? applied[0].rangeId : null,
            committedEpoch: applied[0] ? applied[0].epoch : null,
            applicationCount: applied.length,
            acknowledged: request.acknowledged,
            resultReturned: request.resultReturned ?? null,
        };
    });
    const known = new Set(requests.map((r) => r.logicalRequestId));
    const unrequested = [...applications.keys()].filter((id) => !known.has(id));
    const appliedMoreThanOnce = rows.filter((r) => r.applicationCount > 1);
    const missingAcknowledged = rows.filter((r) => r.acknowledged && r.applicationCount === 0);
    const staleProbesAccepted = probes.filter((p) => p.status === 'OK').length;
    const counts = {
        requests: rows.length,
        acknowledged: rows.filter((r) => r.acknowledged).length,
        retried: rows.filter((r) => r.attemptCount > 1).length,
        appliedMoreThanOnce: appliedMoreThanOnce.length,
        duplicateLogicalWrites: appliedMoreThanOnce.reduce((t, r) => t + r.applicationCount - 1, 0),
        missingAcknowledged: missingAcknowledged.length,
        acknowledgedAppliedOnce: rows.filter((r) => r.acknowledged && r.applicationCount === 1).length,
        unacknowledgedApplied: rows.filter((r) => !r.acknowledged && r.applicationCount === 1).length,
        staleEpochWritesAccepted: staleApplied + staleProbesAccepted,
        probes: probes.length,
        unrequestedApplications: unrequested.length,
        ledgerDisagreements: disagreements.length,
    };
    const ok = counts.appliedMoreThanOnce === 0 && counts.missingAcknowledged === 0
        && counts.staleEpochWritesAccepted === 0 && counts.unrequestedApplications === 0 && counts.ledgerDisagreements === 0;
    return { ok, counts, rows, appliedMoreThanOnce, missingAcknowledged, unrequested, disagreements };
}

module.exports = { historyByKey, checkLogicalLinearizability, committedLedgers, checkExactlyOnce, gitProvenance };
