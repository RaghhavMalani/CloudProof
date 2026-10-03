'use strict';

/**
 * failpoints.js — test-only process-death failpoints (Phase IV-A durability
 * gate).
 *
 * Mounted only when RAFT_TEST_FAILPOINTS=1. A test arms one named site on one
 * replica (POST /test/failpoint {name, skip}); the engine calls hit(name, ctx)
 * at that site; after `skip` further hits the next one fires: a marker with
 * the engine state at that instant is written synchronously to a file and to
 * stderr, and the process terminates on the spot (TerminateProcess on
 * Windows, SIGKILL elsewhere). No exit handler runs and nothing is flushed,
 * which is what an operating-system kill of the leader looks like.
 *
 * Sites (replica/raft.js, replica/raft-transport.js):
 *   leader.beforeFlush          group-commit buffer non-empty, before write+fsync
 *   leader.durableBeforeQuorum  flushed on the leader, not yet committed
 *   leader.committedBeforeReply committed and applied, no client answered yet
 *   leader.pipelinedInflight    an AppendEntries answer arrives while others to
 *                               the same follower are still outstanding
 *   leader.batchedReplication   the answer to a multi-entry batch arrives
 *   transport.framedInflight    a batch frame is written on the framed
 *                               transport while others are unanswered
 */

const fs = require('fs');

const SITES = Object.freeze([
    'leader.beforeFlush',
    'leader.durableBeforeQuorum',
    'leader.committedBeforeReply',
    'leader.pipelinedInflight',
    'leader.batchedReplication',
    'transport.framedInflight',
]);

function killNow() {
    process.kill(process.pid, 'SIGKILL');
    process.exit(137); // not reached where SIGKILL is synchronous
}

class Failpoints {
    constructor({ markerFile = null, fire = killNow, now = () => new Date().toISOString() } = {}) {
        this.markerFile = markerFile;
        this.fire = fire;
        this.now = now;
        this.armed = null;
        this.fired = null;
    }

    arm(name, { skip = 0 } = {}) {
        if (!SITES.includes(name)) throw new Error(`unknown failpoint ${name} (known: ${SITES.join(', ')})`);
        this.armed = { name, skip: Math.max(0, Math.floor(skip)), hits: 0, armedAt: this.now() };
        return this.status();
    }

    disarm() {
        this.armed = null;
        return this.status();
    }

    status() {
        return { armed: this.armed, fired: this.fired, sites: SITES };
    }

    hit(name, context = {}) {
        const armed = this.armed;
        if (!armed || armed.name !== name) return;
        armed.hits += 1;
        if (armed.hits <= armed.skip) return;
        this.armed = null;
        this.fired = { name, hits: armed.hits, skip: armed.skip, armedAt: armed.armedAt, firedAt: this.now(), context };
        const line = `FAILPOINT ${JSON.stringify(this.fired)}\n`;
        if (this.markerFile) fs.writeFileSync(this.markerFile, line);
        try { fs.writeSync(2, line); } catch (_) { /* stderr may be closed */ }
        this.fire(this.fired);
    }
}

module.exports = { Failpoints, SITES };
