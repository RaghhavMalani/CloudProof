'use strict';

/**
 * raft-perf.js — observational instrumentation for the Raft write path.
 *
 * Everything here is *observational*. It reads a monotonic host timer
 * (`performance.now`), never the Raft clock, so it cannot change an election
 * timeout, a lease, or anything the deterministic simulator replays. The
 * simulator never constructs one of these; RaftNode treats a missing recorder
 * as "do nothing", and every hook is a single null check when disabled.
 *
 * Stage names used by the write path (all in microseconds):
 *
 *   http.arrivalToAdmit   request headers parsed -> leader admission (body read, JSON parse, routing)
 *   leader.admitToDurable admission -> the leader's own copy is on stable storage
 *   leader.admitToCommit  admission -> commitIndex covers the entry (quorum reached)
 *   leader.commitToApply  commit -> applied to the state machine
 *   http.admitToResponse  admission -> the handler has the committed result
 *   http.arrivalToFinish  request headers parsed -> response fully handed to the socket
 *   log.encode            one LogStore write: JSON + CRC encoding of the batch
 *   log.write             one LogStore write: the write(2) call
 *   log.fsync             one LogStore fsync
 *   meta.persist          one StableStateStore save (tmp write + fsync + rename)
 *   rpc.appendEntriesRtt  leader: AppendEntries send -> response
 *   follower.append       follower: AppendEntries receive -> response ready (durable)
 *   apply                 one state-machine apply call
 *
 * Distributions of counts (not times) use the same histogram type:
 *   rpc.entriesPerAppend, log.entriesPerFsync, commit.entriesPerAdvance,
 *   groupCommit.entriesPerFlush, groupCommit.waitUs
 */

const { performance } = require('perf_hooks');
const { LogLinearHistogram } = require('./perf-histogram');

class RaftPerf {
    constructor({ now = () => performance.now() } = {}) {
        this.now = now;
        this.histograms = new Map();
        this.counters = new Map();
        // index -> admission time (ms, host timer). Only leader-admitted entries.
        this._admitted = new Map();
        // index -> commit time, held only until the entry is applied.
        this._committedAt = new Map();
        // Highest index already recorded as sent, so a batch that goes to two
        // followers records admission -> first send once per entry.
        this._sentWatermark = -1;
        this.resetAt = this.now();
    }

    /** Clears every recorded value. Used to exclude warmup from a window. */
    reset() {
        for (const histogram of this.histograms.values()) histogram.reset();
        this.counters.clear();
        this.resetAt = this.now();
    }

    histogram(name) {
        let histogram = this.histograms.get(name);
        if (!histogram) {
            histogram = new LogLinearHistogram({ unit: name.includes('entries') ? 'count' : 'us' });
            this.histograms.set(name, histogram);
        }
        return histogram;
    }

    /** Records a duration given in milliseconds, stored as microseconds. */
    observeMs(name, milliseconds) {
        this.histogram(name).record(milliseconds * 1000);
    }

    /** Records a dimensionless value (a count) as-is. */
    observeValue(name, value) {
        this.histogram(name).record(value);
    }

    count(name, n = 1) {
        this.counters.set(name, (this.counters.get(name) || 0) + n);
    }

    // ── replication RPCs (leader side) ──────────────────────────────────────

    /**
     * An AppendEntries carrying `count` entries starting at `firstIndex` is
     * about to be sent. Returns the send timestamp for recordAppendResponse.
     * The first send of each traced entry also records admission -> send.
     */
    recordAppendSent(firstIndex, count) {
        const now = this.now();
        this.count(count > 0 ? 'rpc.appendEntriesSent' : 'rpc.heartbeatsSent');
        if (count > 0) {
            this.observeValue('rpc.entriesPerAppend', count);
            this.count('rpc.entriesSent', count);
            const last = firstIndex + count - 1;
            for (let index = Math.max(firstIndex, this._sentWatermark + 1); index <= last; index += 1) {
                const admittedAt = this._admitted.get(index);
                if (admittedAt !== undefined) this.observeMs('leader.admitToFirstSend', now - admittedAt);
            }
            if (last > this._sentWatermark) this._sentWatermark = last;
        }
        return now;
    }

    recordAppendResponse(sentAt, success) {
        this.observeMs('rpc.appendEntriesRtt', this.now() - sentAt);
        if (!success) this.count('rpc.appendEntriesRejected');
    }

    // ── per-entry trace on the leader ───────────────────────────────────────

    entryAdmitted(index) {
        this._admitted.set(index, this.now());
    }

    /** Entries in [fromIndex, toIndexExclusive) are now durable on the leader. */
    entriesDurable(fromIndex, toIndexExclusive) {
        const now = this.now();
        for (let index = fromIndex; index < toIndexExclusive; index += 1) {
            const admittedAt = this._admitted.get(index);
            if (admittedAt !== undefined) this.observeMs('leader.admitToDurable', now - admittedAt);
        }
    }

    /** commitIndex moved from `previous` to `current`. */
    entriesCommitted(previous, current) {
        const now = this.now();
        this.observeValue('commit.entriesPerAdvance', current - previous);
        for (let index = previous + 1; index <= current; index += 1) {
            const admittedAt = this._admitted.get(index);
            if (admittedAt !== undefined) {
                this.observeMs('leader.admitToCommit', now - admittedAt);
                this._admitted.delete(index);
                this._committedAt.set(index, now);
            }
        }
    }

    entryApplied(index, applyStartedAt) {
        const now = this.now();
        this.observeMs('apply', now - applyStartedAt);
        const committedAt = this._committedAt.get(index);
        if (committedAt !== undefined) {
            this.observeMs('leader.commitToApply', now - committedAt);
            this._committedAt.delete(index);
        }
    }

    /**
     * Drops trace state for entries that will never commit under this leader
     * (step-down or truncation), so the maps cannot grow without bound.
     */
    forgetFrom(index) {
        for (const key of this._admitted.keys()) if (key >= index) this._admitted.delete(key);
        for (const key of this._committedAt.keys()) if (key >= index) this._committedAt.delete(key);
        if (this._sentWatermark >= index) this._sentWatermark = index - 1;
    }

    forgetAll() {
        this._admitted.clear();
        this._committedAt.clear();
        this._sentWatermark = -1;
    }

    snapshot() {
        const histograms = {};
        for (const [name, histogram] of [...this.histograms.entries()].sort(([a], [b]) => a.localeCompare(b))) {
            if (histogram.count > 0) histograms[name] = histogram.toJSON();
        }
        const counters = Object.fromEntries([...this.counters.entries()].sort(([a], [b]) => a.localeCompare(b)));
        return {
            windowMs: this.now() - this.resetAt,
            counters,
            histograms,
            pendingTraces: this._admitted.size,
        };
    }
}

module.exports = { RaftPerf };
