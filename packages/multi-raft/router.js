'use strict';

/**
 * router.js — the client-side RangeRouter (CLOUDPROOF-PHASE-IV-B.md §2.2, §13).
 *
 * IV-B.0 routing is deliberately nothing more than:
 *
 *   descriptor = directory.lookup(key)
 *   request = { rangeId: descriptor.rangeId, expectedRangeEpoch: descriptor.epoch,
 *               clientId, seqNo, key, op, value }
 *
 * The router never decides correctness: the range rejects a request whose
 * (rangeId, epoch) or key does not match its own descriptor (§3.3). Each
 * client owns its seqNo sequence, so (clientId, seqNo) — the LogicalRequestId
 * of §3.4 — is unique per logical request. A retry reuses it; a new request
 * never does.
 */

const crypto = require('crypto');

/** SHA-256 of the canonical operation (§3.4 operationDigest). */
function operationDigest({ op, key, value = null, expected = null }) {
    const canonical = JSON.stringify([op, key, value === undefined ? null : value, expected === undefined ? null : expected]);
    return crypto.createHash('sha256').update(canonical).digest('hex');
}

function logicalRequestId({ clientId, seqNo }) {
    return `${clientId}#${seqNo}`;
}

class RangeRouter {
    constructor({ directory }) {
        if (!directory) throw new Error('RangeRouter requires a directory');
        this.directory = directory;
    }

    /** The (rangeId, epoch) a request for `key` must carry. */
    route(key) {
        const descriptor = this.directory.lookup(key);
        return { rangeId: descriptor.rangeId, expectedRangeEpoch: descriptor.epoch, descriptor };
    }

    /** A complete routed request for one logical operation. */
    request({ clientId, seqNo, op, key, value = null, expected = undefined }) {
        if (typeof clientId !== 'string' || clientId === '') throw new Error('request requires a clientId');
        if (!Number.isInteger(seqNo) || seqNo < 1) throw new Error('request requires a positive integer seqNo');
        const { rangeId, expectedRangeEpoch } = this.route(key);
        const request = { rangeId, expectedRangeEpoch, clientId, seqNo, key, op, value };
        if (expected !== undefined) request.expected = expected;
        return request;
    }
}

/** One client's logical-request sequence: seqNo starts at 1 and only grows. */
class ClientSession {
    constructor(clientId) {
        this.clientId = clientId;
        this.lastSeqNo = 0;
    }

    next() {
        this.lastSeqNo += 1;
        return { clientId: this.clientId, seqNo: this.lastSeqNo };
    }
}

module.exports = { RangeRouter, ClientSession, operationDigest, logicalRequestId };
