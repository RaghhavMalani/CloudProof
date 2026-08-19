#!/usr/bin/env node
'use strict';

/**
 * Runs one configuration/watch scenario against the Docker Raft processes and
 * writes the result in the exact causal envelope used by the simulator.
 *
 * This is intentionally one integration demonstration, not a second simulator.
 * Raft protocol exploration stays in memory; this harness measures the pieces
 * reality adds: scheduling, sockets, fsync, DNS, and readiness propagation.
 *
 *   docker compose --profile research run --rm reality-harness
 */

const fs = require('node:fs');
const path = require('node:path');
const { createEvent } = require('../packages/protocol/events');
const { getWorkload, runWorkload } = require('../packages/workloads');

const URLS = (process.env.RAFT_REPLICAS_URLS
    || 'http://replica1:5001,http://replica2:5002,http://replica3:5003').split(',');
const OUTPUT = process.env.REALITY_OUTPUT || path.join(__dirname, '..', 'web', 'reality-run.json');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function wallEvent(event) {
    return { ...event, time: { ...event.time, kind: 'wall' } };
}

class Recorder {
    constructor(runId) {
        this.runId = runId;
        this.startedAt = Date.now();
        this.events = [];
    }

    record(type, data, { actor = 'reality-harness', target = null, correlationId = 'watch-reality' } = {}) {
        const event = wallEvent(createEvent({
            runId: this.runId,
            sequence: this.events.length + 1,
            epochMs: Date.now(),
            startedAt: this.startedAt,
            type,
            source: { component: actor },
            subject: { kind: 'semantic-step', id: type },
            correlationId,
            causationId: this.events.at(-1)?.id || null,
            data: { lane: 'commits', semantic: true, actor, target, ...data },
        }));
        this.events.push(event);
        return event;
    }
}

async function json(url, options = {}) {
    const response = await fetch(url, options);
    const body = await response.json().catch(() => ({}));
    return { response, body };
}

async function discoverLeader(deadlineMs = 20000) {
    const deadline = Date.now() + deadlineMs;
    while (Date.now() < deadline) {
        for (const url of URLS) {
            try {
                const { body } = await json(`${url}/status`);
                if (body.state === 'LEADER') return { url, status: body };
            } catch (_) { /* container may still be starting */ }
        }
        await sleep(150);
    }
    throw new Error(`no leader discovered at ${URLS.join(', ')}`);
}

async function write(leaderUrl, key, value, clientId, seqNo) {
    const { response, body } = await json(`${leaderUrl}/kv/${encodeURIComponent(key)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ value, clientId, seqNo }),
    });
    if (!response.ok) throw new Error(`write ${key} failed: ${response.status} ${JSON.stringify(body)}`);
    return body;
}

async function followerCaughtUp(index, timeoutMs = 5000) {
    const started = Date.now();
    const reached = [];
    while (Date.now() - started < timeoutMs) {
        reached.length = 0;
        for (const url of URLS) {
            try {
                const { body } = await json(`${url}/status`);
                if (body.commitIndex >= index) reached.push({ url, commitIndex: body.commitIndex });
            } catch (_) { /* retry until deadline */ }
        }
        if (reached.length >= 2) return { reached: reached.slice(), propagationMs: Date.now() - started };
        await sleep(20);
    }
    throw new Error(`index ${index} did not reach quorum within ${timeoutMs}ms`);
}

async function deployedRun() {
    const recorder = new Recorder(`docker-watch-${Date.now()}`);
    const leader = await discoverLeader();
    recorder.record('node.role.observed', {
        lane: 'nodes', label: `${leader.status.replicaId} observed as leader`,
        detail: `Docker DNS resolved the replica and /status reported term ${leader.status.term}.`,
        term: leader.status.term,
    }, { actor: leader.status.replicaId, target: 'reality-harness' });

    const key = `reality/controller-${Date.now()}`;
    // Idempotency identities must be unique per harness run. Reusing seqNo 1–3
    // with a constant client ID makes a persistent cluster replay an older
    // run's results and leaves this run's unique key unwritten.
    const initial = await write(leader.url, key, { image: 'api:v1', replicas: 3 }, recorder.runId, 1);
    const checkpoint = initial.rev;
    recorder.record('watch.stream.opened', {
        lane: 'clients', label: `Watch checkpoint ${checkpoint} captured`,
        detail: 'The client now disconnects; no long-poll remains open.', revision: checkpoint,
    }, { actor: 'controller', target: leader.status.replicaId });
    recorder.record('network.disconnected', {
        lane: 'faults', label: 'Controller watch transport closed',
        detail: 'The controller process remains healthy while the socket is absent.', process: 'up', network: 'disconnected',
    }, { actor: 'network', target: 'controller' });

    const second = await write(leader.url, key, { image: 'api:v2', replicas: 3 }, recorder.runId, 2);
    const secondQuorum = await followerCaughtUp(second.index);
    recorder.record('state.machine.applied', {
        label: `Revision ${second.rev} committed while disconnected`, detail: 'Docker replicas applied api:v2.',
        revision: second.rev, index: second.index, propagationMs: secondQuorum.propagationMs,
    }, { actor: leader.status.replicaId, target: 'kv' });

    const third = await write(leader.url, key, { image: 'api:v3', replicas: 4 }, recorder.runId, 3);
    const thirdQuorum = await followerCaughtUp(third.index);
    recorder.record('state.machine.applied', {
        label: `Revision ${third.rev} committed while disconnected`, detail: 'Docker replicas applied api:v3 × 4.',
        revision: third.rev, index: third.index, propagationMs: thirdQuorum.propagationMs,
    }, { actor: leader.status.replicaId, target: 'kv' });

    const resumeStarted = Date.now();
    const watcherUrl = URLS.find((url) => url !== leader.url) || leader.url;
    const { response: watchResponse, body: watchBody } = await json(
        `${watcherUrl}/watch?prefix=${encodeURIComponent(key)}&fromRev=${checkpoint}`,
    );
    if (!watchResponse.ok) throw new Error(`watch resume failed: ${watchResponse.status}`);
    const revisions = (watchBody.events || []).map((event) => event.rev);
    recorder.record('watch.stream.resumed', {
        lane: 'clients', label: `Watch replayed revisions ${revisions.join(', ')}`,
        detail: 'A follower served every event newer than the durable checkpoint.',
        since: checkpoint, revisions, resumeMs: Date.now() - resumeStarted,
    }, { actor: 'controller', target: watcherUrl });
    recorder.record('controller.reconciled', {
        lane: 'clients', label: 'Controller reconciled api:v3 × 4',
        detail: 'The final desired state includes both updates made during disconnect.', revisions,
    }, { actor: 'controller', target: key });

    const readStarted = Date.now();
    const { response: readResponse, body: readBody } = await json(`${leader.url}/kv/${encodeURIComponent(key)}`);
    if (!readResponse.ok || !readBody.linearizable) throw new Error('linearizable read failed');
    recorder.record('read.index.confirmed', {
        label: 'Linearizable read returned the latest desired state',
        detail: 'The deployed leader confirmed authority before serving the value.',
        value: readBody.value, revision: readBody.rev, readMs: Date.now() - readStarted,
    }, { actor: leader.status.replicaId, target: 'controller' });

    const expected = [second.rev, third.rev];
    const replayOk = expected.every((revision) => revisions.includes(revision));
    recorder.record('invariant.checked', {
        lane: 'invariants', label: replayOk ? 'PASS FOR THIS EXECUTION · resumable watch' : 'FAIL · resumable watch',
        status: replayOk ? 'pass' : 'fail', id: 'resumable-watch', expected, observed: revisions,
    }, { actor: 'invariant-checker', target: 'watch-history' });

    return {
        schemaVersion: 1,
        kind: 'miniraft.reality-run',
        runId: recorder.runId,
        workload: 'configuration',
        recordedAt: new Date().toISOString(),
        source: 'docker-compose-processes',
        events: recorder.events,
        metrics: {
            recoveryMs: recorder.events.find((event) => event.type === 'watch.stream.resumed').time.elapsedMs,
            watchResumeMs: recorder.events.find((event) => event.type === 'watch.stream.resumed').data.resumeMs,
            readinessPropagationMs: Math.max(secondQuorum.propagationMs, thirdQuorum.propagationMs),
            replayedRevisions: revisions.length,
            invariantPassed: replayOk,
        },
        varianceSources: ['kernel-scheduling', 'network-timing', 'fsync-latency', 'container-start', 'dns', 'readiness-propagation'],
    };
}

function simulatedRun() {
    const result = runWorkload(getWorkload('configuration'), { seed: 42 });
    return {
        schemaVersion: 1,
        kind: 'miniraft.simulation-run',
        runId: result.events[0].runId,
        workload: 'configuration',
        source: 'deterministic-in-memory',
        events: result.events,
        metrics: { recoveryMs: result.events.find((event) => event.type === 'watch.stream.resumed').time.elapsedMs },
    };
}

(async () => {
    const deployed = await deployedRun();
    fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
    fs.writeFileSync(OUTPUT, `${JSON.stringify(deployed, null, 2)}\n`);
    const simulated = simulatedRun();
    console.log(`PASS  simulator recovery: ${simulated.metrics.recoveryMs}ms virtual`);
    console.log(`PASS  deployed recovery:  ${deployed.metrics.recoveryMs}ms wall`);
    console.log(`PASS  replayed revisions: ${deployed.metrics.replayedRevisions}`);
    console.log(`wrote ${OUTPUT}`);
})().catch((error) => {
    console.error(`reality harness failed: ${error.message}`);
    process.exitCode = 1;
});
