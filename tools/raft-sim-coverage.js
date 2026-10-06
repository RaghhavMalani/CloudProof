#!/usr/bin/env node
'use strict';

/**
 * raft-sim-coverage.js — did a fault campaign actually reach the windows an
 * optimization opens?
 *
 *   node tools/raft-sim-coverage.js --runs 300 --raft-profile group-commit-delay
 *
 * A campaign with zero violations is only evidence if the dangerous
 * interleavings happened. This runs the same materialized schedules as
 * sim/search.js and counts, by observing the real engine and the simulated
 * stores (never changing them):
 *
 *   crashesWithUnflushedEntries / unflushedEntriesLost   crash-before-flush
 *   deferredAcks / revokedAcks                           follower acks held for durability
 *   stalePipelinedResponses                              responses fenced by leadership epoch
 *   pipelinedRejections / probeTransitions               conflict backtracking under pipelining
 *   maxInflightObserved                                  window actually used
 */

const { materializeSchedule, runSchedule } = require('../sim/schedule');
const { MemoryLogStore } = require('../sim/cluster');
const { RaftNode } = require('../replica/raft');

function parse(argv) {
    const options = { runs: 300, first: 1, 'raft-profile': null };
    for (let i = 0; i < argv.length; i += 1) {
        const key = argv[i].replace(/^--/, '');
        const value = argv[++i];
        options[key] = key === 'raft-profile' ? value : Number(value);
    }
    return options;
}

async function main() {
    const options = parse(process.argv.slice(2));
    const counters = {
        schedules: 0,
        violations: 0,
        flushes: 0,
        crashesWithUnflushedEntries: 0,
        unflushedEntriesLost: 0,
        deferredAcks: 0,
        revokedAcks: 0,
        stalePipelinedResponses: 0,
        pipelinedRejections: 0,
        probeTransitions: 0,
        maxInflightObserved: 0,
    };

    const originalDrop = MemoryLogStore.prototype.dropPending;
    MemoryLogStore.prototype.dropPending = function dropPending() {
        if (this.pending.length > 0) {
            counters.crashesWithUnflushedEntries += 1;
            counters.unflushedEntriesLost += this.pending.length;
        }
        return originalDrop.call(this);
    };
    const originalFlush = MemoryLogStore.prototype.flush;
    MemoryLogStore.prototype.flush = function flush() {
        const count = originalFlush.call(this);
        if (count > 0) counters.flushes += 1;
        return count;
    };
    const originalAck = RaftNode.prototype._acknowledgeWhenDurable;
    RaftNode.prototype._acknowledgeWhenDurable = function acknowledge(response) {
        counters.deferredAcks += 1;
        return originalAck.call(this, response).then((sent) => {
            if (!sent.success) counters.revokedAcks += 1;
            return sent;
        });
    };
    // Pipelining hooks exist only once pipelining does; observed if present.
    const hook = (name, fn) => {
        const original = RaftNode.prototype[name];
        if (typeof original !== 'function') return;
        RaftNode.prototype[name] = function wrapped(...args) { fn(this, args); return original.apply(this, args); };
    };
    hook('_onPipelineStale', () => { counters.stalePipelinedResponses += 1; });
    hook('_onPipelineReject', () => { counters.pipelinedRejections += 1; });
    hook('_enterProbe', () => { counters.probeTransitions += 1; });
    hook('_onPipelineSend', (node, [peer]) => {
        const progress = node._progress && node._progress[peer];
        if (progress) counters.maxInflightObserved = Math.max(counters.maxInflightObserved, progress.inflight.size);
    });

    const log = console.log;
    console.log = () => {};
    try {
        for (let seed = options.first; seed < options.first + options.runs; seed += 1) {
            const schedule = materializeSchedule(seed, options['raft-profile'] ? { raftProfile: options['raft-profile'] } : {});
            const result = await runSchedule(schedule, { recording: false });
            counters.schedules += 1;
            if (!result.ok) counters.violations += 1;
        }
    } finally {
        console.log = log;
    }
    process.stdout.write(`${JSON.stringify({ profile: options['raft-profile'] || 'default', ...counters })}\n`);
}

main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
});
