'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');
const test = require('node:test');

const { parseMetrics, windowDelta, memberArgs, resolveBinary, etcdIdentity, ETCD_BINARY_SHA256, PEER_PORT_OFFSET } = require('./etcd-cluster');
const { requestBuilder, makeValue } = require('./loadgen-worker');
const { summarizeTrial, runTrial } = require('./run');
const { CONFIGS, EXTERNAL_SYSTEMS, systemOf } = require('./configs');
const { LogLinearHistogram } = require('../../replica/perf-histogram');

const WORKER = path.join(__dirname, 'loadgen-worker.js');

test('Prometheus text is summed per metric over its label sets, comments and junk skipped', () => {
    const text = [
        '# HELP etcd_network_peer_sent_bytes_total The total number of bytes sent to peers.',
        '# TYPE etcd_network_peer_sent_bytes_total counter',
        'etcd_network_peer_sent_bytes_total{To="a"} 1556',
        'etcd_network_peer_sent_bytes_total{To="b"} 44',
        'process_resident_memory_bytes 3.1801344e+07',
        'etcd_disk_wal_fsync_duration_seconds_bucket{le="0.001"} 7',
        'etcd_disk_wal_fsync_duration_seconds_count 10',
        'not a metric line',
        'go_gc_duration_seconds{quantile="0.5"} NaN',
    ].join('\n');
    const m = parseMetrics(text);
    assert.equal(m.etcd_network_peer_sent_bytes_total, 1600);
    assert.equal(m.process_resident_memory_bytes, 31801344);
    assert.equal(m.etcd_disk_wal_fsync_duration_seconds_count, 10);
    assert.equal(m.etcd_disk_wal_fsync_duration_seconds_bucket, 7);
    assert.ok(!('go_gc_duration_seconds' in m));
});

test('window counters are differences, gauges are the closing value, missing metrics are null', () => {
    const before = { process_cpu_seconds_total: 1.5, etcd_disk_wal_fsync_duration_seconds_count: 100, etcd_server_is_leader: 0 };
    const after = { process_cpu_seconds_total: 3.25, etcd_disk_wal_fsync_duration_seconds_count: 400, etcd_server_is_leader: 1 };
    const { counters, gauges } = windowDelta(before, after);
    assert.equal(counters.cpuSeconds, 1.75);
    assert.equal(counters.walFsyncs, 300);
    assert.equal(counters.backendCommits, null);
    assert.equal(gauges.isLeader, 1);
    assert.equal(gauges.residentMemoryBytes, null);
});

test('member flags set only the cluster topology; everything else is etcd default', () => {
    const args = memberArgs({ index: 1, size: 3, basePort: 17001, dataRoot: 'D:\\data', token: 't' });
    const flags = args.filter((a) => a.startsWith('--'));
    assert.deepEqual(flags, etcdIdentity(resolveBinary()).flagsBeyondDefaults);
    const value = (flag) => args[args.indexOf(flag) + 1];
    assert.equal(value('--name'), 'm2');
    assert.equal(value('--listen-client-urls'), 'http://127.0.0.1:17002');
    assert.equal(value('--listen-peer-urls'), `http://127.0.0.1:${17002 + PEER_PORT_OFFSET}`);
    assert.equal(value('--initial-cluster'), 'm1=http://127.0.0.1:17101,m2=http://127.0.0.1:17102,m3=http://127.0.0.1:17103');
    // Peer ports stay clear of CloudProof's client and framed-TCP ports.
    assert.ok(PEER_PORT_OFFSET >= 3 && PEER_PORT_OFFSET < 1000);
});

test('the CloudProof request is unchanged and etcd stores the same key and value bytes', () => {
    const value = makeValue(1024, 0x9e3779b9);
    const cloudproof = requestBuilder({ protocol: 'cloudproof-kv', value, keySpace: 1000 });
    const a = cloudproof(42);
    assert.equal(a.method, 'PUT');
    assert.equal(a.path, '/kv/k42');
    assert.equal(a.body.toString(), JSON.stringify({ value }));
    assert.equal(cloudproof(7).body, a.body, 'one shared body');

    const etcd = requestBuilder({ protocol: 'etcd-v3-json', value, keySpace: 1000 });
    const b = etcd(42);
    assert.equal(b.method, 'POST');
    assert.equal(b.path, '/v3/kv/put');
    const parsed = JSON.parse(b.body.toString());
    assert.equal(Buffer.from(parsed.key, 'base64').toString(), 'k42');
    assert.equal(Buffer.from(parsed.value, 'base64').toString(), value);
    assert.equal(etcd(42), b, 'bodies are prebuilt per key');
    assert.throws(() => requestBuilder({ protocol: 'nope', value, keySpace: 1 }), /unknown load-generator protocol/);
});

test('etcd is an external system, not a tenth replica profile', () => {
    assert.equal(systemOf('etcd'), 'etcd');
    assert.equal(systemOf('baseline'), 'cloudproof');
    assert.ok(!CONFIGS.etcd);
    assert.ok(EXTERNAL_SYSTEMS.etcd);
    assert.throws(() => systemOf('zookeeper'), /unknown benchmark config/);
});

test('the open-loop generator speaks the etcd gateway format', async () => {
    const seen = [];
    const server = await new Promise((resolve) => {
        const s = http.createServer((req, res) => {
            const chunks = [];
            req.on('data', (c) => chunks.push(c));
            req.on('end', () => {
                seen.push({ method: req.method, url: req.url, body: JSON.parse(Buffer.concat(chunks).toString()) });
                res.end('{"header":{}}');
            });
        });
        s.listen(0, '127.0.0.1', () => resolve(s));
    });
    const result = await new Promise((resolve, reject) => {
        const child = fork(WORKER, [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
        let message = null;
        child.on('message', (m) => { if (m.type === 'result') message = m; });
        child.on('exit', () => (message ? resolve(message) : reject(new Error('no result'))));
        child.send({ type: 'start', config: {
            target: `http://127.0.0.1:${server.address().port}`, ratePerSecond: 100, phaseMs: 0, connections: 2,
            payloadBytes: 16, keySpace: 3, warmupMs: 100, durationMs: 300, timeoutMs: 1000, drainMs: 500,
            startEpochMs: Date.now() + 100, workerIndex: 0, workers: 1, protocol: 'etcd-v3-json',
        } });
    });
    server.close();
    assert.ok(result.counts.ok > 0);
    assert.ok(seen.every((r) => r.method === 'POST' && r.url === '/v3/kv/put'));
    assert.deepEqual([...new Set(seen.map((r) => Buffer.from(r.body.key, 'base64').toString()))].sort(), ['k0', 'k1', 'k2']);
});

function fakeWorkerResult(ok) {
    const h = new LogLinearHistogram();
    for (let i = 0; i < ok; i += 1) h.record(2000);
    const json = h.toJSON();
    const empty = new LogLinearHistogram().toJSON();
    return {
        workerIndex: 0,
        cpu: { userMicros: 1000, systemMicros: 0, wallMs: 1000 },
        counts: { scheduled: ok, ok, okCompletedInWindow: ok, httpErrors: {}, networkErrors: {}, timeoutsSent: 0, timeoutsUnsent: 0, connectRetries: 0 },
        perSecond: [],
        histograms: { latencyAll: json, latencyOk: json, serviceOk: json, generatorLag: empty, clientQueueWait: empty,
            firstFifthOk: json, lastFifthOk: json, clientQueueDepth: new LogLinearHistogram({ unit: 'count' }).toJSON(),
            clientInflight: new LogLinearHistogram({ unit: 'count' }).toJSON() },
    };
}

test('an etcd trial summary maps WAL fsyncs, bbolt commits and CPU onto the shared record', () => {
    const member = (replicaId, state, c) => ({
        system: 'etcd', replicaId, memberId: replicaId, state, status: { term: 2, leaderId: 'm1' }, scrapeWindowSeconds: 10.01,
        counters: { cpuSeconds: c.cpu, walFsyncs: c.wal, walFsyncSeconds: c.wal * 0.0005, walWriteBytes: 0, backendCommits: c.bbolt,
            backendCommitSeconds: c.bbolt * 0.001, snapshotFsyncs: c.snap || 0, snapshotDbFsyncs: 0, peerSentBytes: c.sent,
            peerReceivedBytes: c.recv, clientGrpcSentBytes: c.gs || 0, clientGrpcReceivedBytes: c.gr || 0,
            proposalsCommitted: 10000, proposalsApplied: 10000, proposalsFailed: 0, leaderChanges: 0 },
        gauges: { isLeader: state === 'LEADER' ? 1 : 0, hasLeader: 1, proposalsPending: 0, residentMemoryBytes: 1, dbTotalSizeBytes: 1, goroutines: 1 },
    });
    const trial = summarizeTrial({
        runId: 'x', config: 'etcd', env: {}, rate: 1000, payloadBytes: 1024, connections: 4, generators: 1, keySpace: 1000,
        warmupMs: 1000, durationMs: 10000, timeoutMs: 1000, repetition: 0, startedAt: 'now',
        leader: { replicaId: 'm1', term: 2 },
        statusesAtEnd: [{ replicaId: 'm1', term: 2, state: 'LEADER' }, { replicaId: 'm2', term: 2, state: 'FOLLOWER' }, { replicaId: 'm3', term: 2, state: 'FOLLOWER' }],
        results: [fakeWorkerResult(10000)],
        serverSnapshots: [
            member('m1', 'LEADER', { cpu: 5, wal: 500, bbolt: 100, sent: 9e6, recv: 1e5, gs: 1e5, gr: 1.4e7, snap: 2 }),
            member('m2', 'FOLLOWER', { cpu: 2, wal: 400, bbolt: 100, sent: 1e5, recv: 4.5e6 }),
            member('m3', 'FOLLOWER', { cpu: 2, wal: 400, bbolt: 100, sent: 1e5, recv: 4.5e6 }),
        ],
        diskBytes: 0, system: 'etcd',
    });
    const l = trial.server.leader;
    assert.equal(l.replicaId, 'm1');
    assert.equal(l.cpuPercentOfOneCore, 50);
    assert.equal(l.cpuMicrosPerOp, 500);
    assert.equal(l.rates.logFsyncsPerSec, 50);
    assert.equal(l.rates.metaSavesPerSec, 10);
    assert.equal(l.rates.otherSyncsPerSec, 0.2);
    assert.equal(l.rates.appendEntriesPerSec, null);
    assert.equal(l.stages['log.entriesPerFsync'].mean, 20);
    assert.equal(l.etcd.meanWalFsyncMs, 0.5);
    assert.equal(trial.server.clusterCpuMicrosPerOp, 900);
    assert.equal(trial.server.clusterDurableSyncsPerOp, (500 + 400 + 400 + 300 + 2) / 10000);
    assert.equal(trial.server.replicationBytesPerOp, (1e5 + 4.5e6) * 2 / 10000);
    assert.equal(trial.server.clientBytesPerOp, (1e5 + 1.4e7) / 10000);
    assert.ok(trial.leadershipStable);
    assert.match(trial.workload.operation, /\/v3\/kv\/put/);
});

// A real three-member etcd cluster, briefly, when the pinned binary is on
// this machine (it is not on CI, which runs Linux without etcd).
const binary = resolveBinary();
const haveEtcd = process.platform === 'win32' && fs.existsSync(binary)
    && etcdIdentity(binary).binarySha256 === ETCD_BINARY_SHA256;
test('a live etcd trial elects a leader, takes writes and reports its window', { skip: !haveEtcd && 'pinned etcd binary not present' }, async () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'etcd-trial-'));
    try {
        const { record } = await runTrial({
            config: 'etcd', rate: 200, payloadBytes: 64, connections: 8, generators: 1, warmupMs: 1000, durationMs: 2000,
            drainMs: 2000, basePort: 27301, dataRoot,
        });
        assert.equal(record.failed, undefined, record.failure && record.failure.message);
        assert.equal(record.system.binarySha256, ETCD_BINARY_SHA256);
        assert.ok(record.achievedPerSec > 150, `achieved ${record.achievedPerSec}/s`);
        assert.equal(record.errorRate, 0);
        assert.ok(record.leadershipStable);
        assert.equal(record.server.followers.length, 2);
        assert.ok(record.server.leader.rates.logFsyncsPerSec > 0);
        assert.ok(record.server.clusterCpuMicrosPerOp > 0);
    } finally {
        fs.rmSync(dataRoot, { recursive: true, force: true });
    }
});
