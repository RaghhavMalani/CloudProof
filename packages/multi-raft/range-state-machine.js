'use strict';

/**
 * range-state-machine.js — the replicated state machine of one range
 * (CLOUDPROOF-PHASE-IV-B.md §3.3, §5.2, §11).
 *
 * It is the existing StateMachine plus two things, both decided at apply, in
 * log order, identically on every replica:
 *
 *   1. The range fence. A routed operation applies only if its rangeId and
 *      expectedRangeEpoch match this range's descriptor, the range is ACTIVE,
 *      and its key is inside [startKey, endKey). Otherwise the entry is
 *      applied as a deterministic no-op and its result is STALE_RANGE_EPOCH,
 *      carrying the descriptor so a router can refresh. This, not the
 *      admission check at the edge, is the safety authority.
 *
 *   2. The application ledger. Every routed operation that reaches apply is
 *      recorded with its LogicalRequestId, range, epoch and log index, as an
 *      application or a rejection. Exactly-once is counted from these ledgers
 *      (§5.2), never inferred from the client history.
 *
 * It is handed to the unchanged Phase IV-A engine through its existing
 * `stateMachine` option; replica/raft.js does not change. With no log
 * compaction, the ledger is rebuilt by log replay on restart like the rest of
 * the state.
 *
 * Deduplication is deliberately NOT added here in IV-B.0: the engine's
 * existing log-scan dedup is what is being measured (§3.4). A second
 * application of a LogicalRequestId would show up in the ledger.
 */

const { StateMachine } = require('../../replica/state-machine');
const { STATES, ownsKey } = require('./descriptors');
const { operationDigest, logicalRequestId } = require('./router');

const ROUTED_OPS = new Set(['set', 'delete', 'cas']);
// Raft-internal entries that carry no client operation.
const INTERNAL_OPS = new Set(['noop', 'config', 'tick']);

const STALE_RANGE_EPOCH = 'STALE_RANGE_EPOCH';

/**
 * Whether an operation addressed as (rangeId, expectedRangeEpoch, key) may be
 * served by this range: the part of the fence that reads share.
 */
function addressVerdict(descriptor, { rangeId, expectedRangeEpoch, key }) {
    if (typeof rangeId !== 'string') return { ok: false, reason: 'unrouted operation' };
    if (rangeId !== descriptor.rangeId) return { ok: false, reason: `range ${rangeId} is not ${descriptor.rangeId}` };
    if (descriptor.state !== STATES.ACTIVE) return { ok: false, reason: `range ${descriptor.rangeId} is ${descriptor.state}` };
    if (expectedRangeEpoch !== descriptor.epoch) {
        return { ok: false, reason: `epoch ${expectedRangeEpoch} is not ${descriptor.epoch}` };
    }
    if (!ownsKey(descriptor, key)) return { ok: false, reason: `key ${JSON.stringify(key)} is outside the range` };
    return { ok: true };
}

/**
 * The fence decision for a routed write against a descriptor. Shared by apply
 * (authoritative) and admission (a fast reject only).
 */
function fenceVerdict(descriptor, command) {
    if (!command) return { ok: false, reason: 'unrouted operation' };
    const address = addressVerdict(descriptor, command);
    if (!address.ok) return address;
    if (typeof command.clientId !== 'string' || command.clientId === '' || !Number.isInteger(command.seqNo)) {
        return { ok: false, reason: 'missing LogicalRequestId (clientId, seqNo)' };
    }
    if (!ROUTED_OPS.has(command.op)) return { ok: false, reason: `operation ${command.op} is not supported in a range` };
    return { ok: true };
}

function staleRangeEpoch(descriptor, reason) {
    return { ok: false, error: STALE_RANGE_EPOCH, reason, descriptor };
}

/** The canonical operation a routed command applies (for operationDigest). */
function canonicalOperation(command) {
    return {
        op: command.op,
        key: command.key,
        value: command.value ?? null,
        expected: command.op === 'cas' ? { expectRev: command.expectRev ?? null, expect: command.expect ?? null } : null,
    };
}

class RangeStateMachine extends StateMachine {
    constructor({ descriptor }) {
        super();
        if (!descriptor) throw new Error('RangeStateMachine requires a descriptor');
        this.descriptor = descriptor;
        /** Every routed operation that reached apply, in log order. */
        this.ledger = [];
    }

    apply(entry) {
        const command = entry && entry.data;
        const op = command && command.op;
        if (!command || INTERNAL_OPS.has(op)) return super.apply(entry);

        const verdict = fenceVerdict(this.descriptor, command);
        const row = {
            index: entry.index,
            logicalRequestId: Number.isInteger(command.seqNo) ? logicalRequestId(command) : null,
            clientId: command.clientId ?? null,
            seqNo: command.seqNo ?? null,
            key: command.key ?? null,
            op: op ?? null,
            operationDigest: operationDigest(canonicalOperation(command)),
            rangeId: this.descriptor.rangeId,
            epoch: this.descriptor.epoch,
            addressedRangeId: command.rangeId ?? null,
            addressedEpoch: command.expectedRangeEpoch ?? null,
        };
        if (!verdict.ok) {
            // A no-op for every bookkeeping purpose (clock, lease expiry,
            // lastAppliedIndex), then the rejection replaces the no-op result.
            super.apply({ ...entry, data: { op: 'noop' } });
            this.ledger.push({ ...row, outcome: 'rejected', reason: verdict.reason });
            return this._rememberResult(entry.index, staleRangeEpoch(this.descriptor, verdict.reason));
        }
        // Past the fence, the operation is executed, and that is what
        // exactly-once counts: a CAS whose comparison fails was still
        // executed once. Whether it changed state is recorded separately.
        const result = super.apply(entry);
        this.ledger.push({ ...row, outcome: 'applied', ok: Boolean(result && result.ok), result });
        return result;
    }

    /** Ledger rows of executed operations (the exactly-once count, §5.2). */
    applications() {
        return this.ledger.filter((row) => row.outcome === 'applied');
    }
}

module.exports = {
    RangeStateMachine, addressVerdict, fenceVerdict, staleRangeEpoch, STALE_RANGE_EPOCH, ROUTED_OPS, INTERNAL_OPS,
};
