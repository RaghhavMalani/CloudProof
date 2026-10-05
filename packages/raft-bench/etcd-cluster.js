'use strict';

/**
 * etcd-cluster.js — a local three-member etcd cluster behind the same
 * interface as LocalCluster, for the matched comparison (methodology
 * amendment 4).
 *
 * Stock etcd: the official release binary, downloaded into .bench-data/etcd
 * and checksum-verified (nothing is installed), with every flag at its default
 * except the ones a three-member loopback cluster cannot do without: member
 * names, data directories, URLs and the initial cluster. Each trial gets
 * fresh data directories on the same drive as the CloudProof replicas, and the
 * same per-process power policy. A binary whose SHA-256 is not the pinned one
 * is refused, so every trial provably ran the same etcd.
 *
 * Telemetry comes from each member's own /metrics (Prometheus text format),
 * scraped when the measurement window opens and when it closes; the window
 * figures are the differences. The counters used are listed in
 * WINDOW_COUNTERS.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');
const { applyPolicy } = require('./power-throttling');
const { requestJson, sleep } = require('./cluster');

const ROOT = path.join(__dirname, '..', '..');
const ETCD_VERSION = '3.7.2';
const RELEASE_DIR = `etcd-v${ETCD_VERSION}-windows-amd64`;
// SHA-256 of etcd.exe inside etcd-v3.7.2-windows-amd64.zip, whose own SHA-256
// was verified against the release's SHA256SUMS and GitHub's asset digest.
const ETCD_BINARY_SHA256 = 'fae2288f43e5d845e5f07c31a4817899804d4f66f09152b6c3fec0d726b9169a';
// Peer URLs sit 100 above the client ports: clear of CloudProof's client
// ports (basePort..+2) and of its framed-TCP ports (basePort+1000..).
const PEER_PORT_OFFSET = 100;

/** Window counters: record field -> Prometheus metric (summed over label sets). */
const WINDOW_COUNTERS = Object.freeze({
    cpuSeconds: 'process_cpu_seconds_total',
    walFsyncs: 'etcd_disk_wal_fsync_duration_seconds_count',
    walFsyncSeconds: 'etcd_disk_wal_fsync_duration_seconds_sum',
    walWriteBytes: 'etcd_disk_wal_write_bytes_total',
    backendCommits: 'etcd_disk_backend_commit_duration_seconds_count',
    backendCommitSeconds: 'etcd_disk_backend_commit_duration_seconds_sum',
    snapshotFsyncs: 'etcd_snap_fsync_duration_seconds_count',
    snapshotDbFsyncs: 'etcd_snap_db_fsync_duration_seconds_count',
    peerSentBytes: 'etcd_network_peer_sent_bytes_total',
    peerReceivedBytes: 'etcd_network_peer_received_bytes_total',
    clientGrpcSentBytes: 'etcd_network_client_grpc_sent_bytes_total',
    clientGrpcReceivedBytes: 'etcd_network_client_grpc_received_bytes_total',
    proposalsCommitted: 'etcd_server_proposals_committed_total',
    proposalsApplied: 'etcd_server_proposals_applied_total',
    proposalsFailed: 'etcd_server_proposals_failed_total',
    leaderChanges: 'etcd_server_leader_changes_seen_total',
});

/** Gauges read at the window close. */
const WINDOW_GAUGES = Object.freeze({
    isLeader: 'etcd_server_is_leader',
    hasLeader: 'etcd_server_has_leader',
    proposalsPending: 'etcd_server_proposals_pending',
    residentMemoryBytes: 'process_resident_memory_bytes',
    dbTotalSizeBytes: 'etcd_mvcc_db_total_size_in_bytes',
    goroutines: 'go_goroutines',
});

/**
 * Parses Prometheus text exposition into { metricName: sum over its label
 * sets }. Comments and malformed lines are skipped.
 */
function parseMetrics(text) {
    const totals = {};
    for (const line of text.split('\n')) {
        if (!line || line.startsWith('#')) continue;
        const match = /^([A-Za-z_:][A-Za-z0-9_:]*)(\{[^}]*\})?\s+(\S+)/.exec(line);
        if (!match) continue;
        const value = Number(match[3]);
        if (!Number.isFinite(value)) continue;
        totals[match[1]] = (totals[match[1]] || 0) + value;
    }
    return totals;
}

/** Differences of the window counters between two parsed scrapes; gauges at the close. */
function windowDelta(before, after) {
    const counters = {};
    for (const [field, metric] of Object.entries(WINDOW_COUNTERS)) {
        counters[field] = (metric in after && metric in before) ? after[metric] - before[metric] : null;
    }
    const gauges = {};
    for (const [field, metric] of Object.entries(WINDOW_GAUGES)) gauges[field] = metric in after ? after[metric] : null;
    return { counters, gauges };
}

/** Command-line flags of one member. Everything not listed is etcd's default. */
function memberArgs({ index, size, basePort, dataRoot, token }) {
    const client = (i) => `http://127.0.0.1:${basePort + i}`;
    const peer = (i) => `http://127.0.0.1:${basePort + PEER_PORT_OFFSET + i}`;
    const name = (i) => `m${i + 1}`;
    return [
        '--name', name(index),
        '--data-dir', path.join(dataRoot, name(index)),
        '--listen-client-urls', client(index),
        '--advertise-client-urls', client(index),
        '--listen-peer-urls', peer(index),
        '--initial-advertise-peer-urls', peer(index),
        '--initial-cluster', Array.from({ length: size }, (_, i) => `${name(i)}=${peer(i)}`).join(','),
        '--initial-cluster-state', 'new',
        '--initial-cluster-token', token,
    ];
}

/**
 * The binary: ETCD_BIN if set, else .bench-data/etcd/<release>/etcd.exe in
 * this checkout or, from a linked worktree (the pinned sweep worktree), in
 * the main checkout that owns the repository.
 */
function resolveBinary() {
    if (process.env.ETCD_BIN) return process.env.ETCD_BIN;
    const relative = path.join('.bench-data', 'etcd', RELEASE_DIR, 'etcd.exe');
    const candidates = [path.join(ROOT, relative)];
    try {
        const common = execFileSync('git', ['-C', ROOT, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
            { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        candidates.push(path.join(path.dirname(common), relative));
    } catch (_) { /* not a git checkout */ }
    return candidates.find((file) => fs.existsSync(file)) || candidates[0];
}

const identities = new Map();

/** What ran: version, the binary's SHA-256 and the flags that differ from etcd's defaults. */
function etcdIdentity(binary) {
    if (!identities.has(binary)) {
        const sha256 = fs.existsSync(binary)
            ? crypto.createHash('sha256').update(fs.readFileSync(binary)).digest('hex')
            : null;
        identities.set(binary, {
            name: 'etcd',
            version: ETCD_VERSION,
            binarySha256: sha256,
            binarySha256Pinned: ETCD_BINARY_SHA256,
            flagsBeyondDefaults: ['--name', '--data-dir', '--listen-client-urls', '--advertise-client-urls',
                '--listen-peer-urls', '--initial-advertise-peer-urls', '--initial-cluster',
                '--initial-cluster-state', '--initial-cluster-token'],
            clientApi: 'v3 HTTP/JSON gateway, POST /v3/kv/put',
        });
    }
    return identities.get(binary);
}

class EtcdCluster {
    constructor({
        size = 3,
        basePort = 17001,
        dataRoot,
        logRoot = null,
        label = 'etcd',
        powerThrottling = 'os-default',
        binary = resolveBinary(),
    }) {
        if (!dataRoot) throw new Error('EtcdCluster requires dataRoot');
        this.size = size;
        this.basePort = basePort;
        this.dataRoot = dataRoot;
        this.logRoot = logRoot || path.join(dataRoot, 'logs');
        this.label = label;
        this.powerThrottling = powerThrottling;
        this.binary = binary;
        this.powerPolicy = null;
        this.controlRetries = 0;
        this.agent = new http.Agent({ keepAlive: true, maxSockets: 4 });
        this.urls = Array.from({ length: size }, (_, i) => `http://127.0.0.1:${basePort + i}`);
        this.names = Array.from({ length: size }, (_, i) => `m${i + 1}`);
        this.processes = [];
        this.exits = [];
        this.windowStart = null;
    }

    identity() { return etcdIdentity(this.binary); }

    /** Throws unless the binary is the pinned, checksum-verified etcd. */
    verifyBinary() {
        const identity = this.identity();
        if (identity.binarySha256 !== ETCD_BINARY_SHA256) {
            throw new Error(`etcd binary at ${this.binary} has SHA-256 ${identity.binarySha256}, `
                + `not the pinned ${ETCD_BINARY_SHA256} (methodology amendment 4)`);
        }
        return identity;
    }

    async start({ leaderTimeoutMs = 20000 } = {}) {
        this.verifyBinary();
        fs.rmSync(this.dataRoot, { recursive: true, force: true });
        fs.mkdirSync(this.logRoot, { recursive: true });
        const token = `cloudproof-bench-${crypto.randomBytes(4).toString('hex')}`;
        for (let index = 0; index < this.size; index += 1) {
            const logFile = fs.openSync(path.join(this.logRoot, `${this.names[index]}.log`), 'w');
            const child = spawn(this.binary, memberArgs({
                index, size: this.size, basePort: this.basePort, dataRoot: this.dataRoot, token,
            }), { stdio: ['ignore', logFile, logFile], windowsHide: true });
            fs.closeSync(logFile);
            this.processes[index] = child;
            this.exits[index] = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
        }
        this.powerPolicy = applyPolicy(this.powerThrottling,
            this.processes.map((child, index) => ({ role: `etcd-${this.names[index]}`, pid: child.pid })));
        await this.waitForHealth();
        return this.waitForLeader(leaderTimeoutMs);
    }

    async waitForHealth(timeoutMs = 15000) {
        const deadline = Date.now() + timeoutMs;
        for (const url of this.urls) {
            for (;;) {
                try {
                    const response = await requestJson(`${url}/health`, { timeoutMs: 1000, agent: this.agent });
                    if (response.status === 200 && response.data && response.data.health === 'true') break;
                } catch (_) { /* not up yet */ }
                if (Date.now() > deadline) throw new Error(`${url} did not become healthy`);
                await sleep(50);
            }
        }
    }

    /**
     * Each member's own view from /v3/maintenance/status: a member is LEADER
     * when the leader it reports is itself. Same shape as a CloudProof
     * replica's status for the fields the trial uses.
     */
    async statuses() {
        return Promise.all(this.urls.map(async (url, index) => {
            try {
                const response = await requestJson(`${url}/v3/maintenance/status`, {
                    method: 'POST', body: {}, timeoutMs: 1000, agent: this.agent,
                });
                const s = response.data;
                const memberId = s.header.member_id;
                return {
                    url,
                    replicaId: this.names[index],
                    memberId,
                    leaderId: s.leader,
                    state: s.leader === memberId ? 'LEADER' : 'FOLLOWER',
                    term: Number(s.raftTerm),
                    raftIndex: Number(s.raftIndex),
                    raftAppliedIndex: Number(s.raftAppliedIndex),
                };
            } catch (error) {
                return { url, replicaId: this.names[index], error: error.message };
            }
        }));
    }

    /** Waits until every member reports the same leader and term. */
    async waitForLeader(timeoutMs = 20000) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const statuses = await this.statuses();
            const leaders = statuses.filter((s) => s.state === 'LEADER');
            if (statuses.every((s) => !s.error) && leaders.length === 1
                && statuses.every((s) => s.leaderId === leaders[0].memberId && s.term === leaders[0].term)) {
                this.leader = leaders[0];
                this.leaderUrl = leaders[0].url;
                return this.leader;
            }
            await sleep(100);
        }
        throw new Error('no stable etcd leader elected');
    }

    /** Same retry policy as LocalCluster.controlRequest. */
    async controlRequest(url, options) {
        for (let attempt = 0; ; attempt += 1) {
            try {
                return await requestJson(url, { agent: this.agent, ...options });
            } catch (error) {
                const transient = ['ECONNREFUSED', 'EADDRINUSE', 'ECONNRESET'].includes(error.code);
                if (!transient || attempt >= 19) throw error;
                this.controlRetries += 1;
                await sleep(500);
            }
        }
    }

    async scrapeAll() {
        return Promise.all(this.urls.map(async (url) => {
            const response = await this.controlRequest(`${url}/metrics`, { timeoutMs: 30000 });
            if (response.status !== 200 || typeof response.data !== 'string') throw new Error(`${url}/metrics -> ${response.status}`);
            return parseMetrics(response.data);
        }));
    }

    /** Window open: one scrape per member, and when it was taken. */
    async resetPerf() {
        this.windowStart = { at: process.hrtime.bigint(), metrics: await this.scrapeAll() };
    }

    /** Window close: per-member differences since resetPerf(). */
    async collectPerf() {
        if (!this.windowStart) throw new Error('collectPerf() before resetPerf()');
        const metrics = await this.scrapeAll();
        const seconds = Number(process.hrtime.bigint() - this.windowStart.at) / 1e9;
        const statuses = await this.statuses();
        return metrics.map((after, index) => ({
            system: 'etcd',
            replicaId: this.names[index],
            memberId: statuses[index].memberId || null,
            state: statuses[index].state || null,
            status: { term: statuses[index].term, leaderId: statuses[index].leaderId || null },
            scrapeWindowSeconds: seconds,
            ...windowDelta(this.windowStart.metrics[index], after),
        }));
    }

    async startProfile() { throw new Error('CPU profiles are recorded for CloudProof replicas only'); }

    async stopProfile() { throw new Error('CPU profiles are recorded for CloudProof replicas only'); }

    async kill(index) {
        const child = this.processes[index];
        if (!child || child.exitCode !== null) return;
        child.kill('SIGKILL');
        await this.exits[index];
    }

    diskUsage() {
        let bytes = 0;
        const walk = (dir) => {
            let entries = [];
            try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
            for (const entry of entries) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) walk(full);
                else { try { bytes += fs.statSync(full).size; } catch (_) { /* raced */ } }
            }
        };
        for (const name of this.names) walk(path.join(this.dataRoot, name));
        return bytes;
    }

    async stop({ keepData = false } = {}) {
        await Promise.all(this.processes.map((_, index) => this.kill(index)));
        this.agent.destroy();
        if (!keepData) {
            // Windows can hold a handle for a moment after TerminateProcess.
            for (let attempt = 0; attempt < 20; attempt += 1) {
                try {
                    for (const name of this.names) fs.rmSync(path.join(this.dataRoot, name), { recursive: true, force: true });
                    break;
                } catch (_) {
                    await sleep(100);
                }
            }
        }
    }
}

module.exports = {
    EtcdCluster, ETCD_VERSION, ETCD_BINARY_SHA256, PEER_PORT_OFFSET, WINDOW_COUNTERS, WINDOW_GAUGES,
    parseMetrics, windowDelta, memberArgs, etcdIdentity, resolveBinary,
};
