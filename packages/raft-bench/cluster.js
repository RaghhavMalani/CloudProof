'use strict';

/**
 * cluster.js — a real, local, three-process Raft cluster for benchmarking.
 *
 * Each replica is `node replica/index.js`, the same entrypoint the container
 * runs, on loopback, with its own fresh data directory. Nothing is simulated:
 * real fsyncs, real sockets, real HTTP. Optimization profiles are selected with
 * environment variables, so every configuration runs the same binary.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { applyPolicy } = require('./power-throttling');

const ROOT = path.join(__dirname, '..', '..');
const REPLICA_ENTRY = path.join(ROOT, 'replica', 'index.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Minimal JSON-over-HTTP helper with its own short-lived agent. */
function requestJson(url, { method = 'GET', body = null, timeoutMs = 5000 } = {}) {
    return new Promise((resolve, reject) => {
        const target = new URL(url);
        const payload = body === null ? null : Buffer.from(JSON.stringify(body));
        const req = http.request({
            host: target.hostname,
            port: target.port,
            path: target.pathname + target.search,
            method,
            agent: false,
            headers: payload
                ? { 'content-type': 'application/json', 'content-length': payload.length }
                : {},
        }, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                let data = null;
                try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }
                resolve({ status: res.statusCode, data });
            });
        });
        req.setTimeout(timeoutMs, () => req.destroy(new Error('ETIMEDOUT')));
        req.on('error', reject);
        req.end(payload || undefined);
    });
}

class LocalCluster {
    constructor({
        size = 3,
        basePort = 17001,
        dataRoot,
        logRoot = null,
        env = {},
        label = 'cluster',
        nodeArgs = [],
        // 'os-default' leaves Windows' process power policy alone (the
        // historical baseline); 'disabled' opts every replica out of power
        // throttling before it serves a request (methodology amendment 2).
        powerThrottling = 'os-default',
    }) {
        if (!dataRoot) throw new Error('LocalCluster requires dataRoot');
        this.size = size;
        this.basePort = basePort;
        this.dataRoot = dataRoot;
        this.logRoot = logRoot || path.join(dataRoot, 'logs');
        this.env = env;
        this.label = label;
        this.nodeArgs = nodeArgs;
        this.powerThrottling = powerThrottling;
        this.powerPolicy = null;
        this.urls = Array.from({ length: size }, (_, i) => `http://127.0.0.1:${basePort + i}`);
        this.processes = [];
        this.exits = [];
    }

    replicaEnv(index) {
        const id = `replica${index + 1}`;
        return {
            ...process.env,
            REPLICA_ID: id,
            PORT: String(this.basePort + index),
            NODE_URL: this.urls[index],
            PEERS: this.urls.filter((_, i) => i !== index).join(','),
            DATA_DIR: path.join(this.dataRoot, id),
            // Nothing listens on the discard port, so the leader-change hook
            // fails immediately instead of waiting on DNS for "gateway".
            GATEWAY_URL: 'http://127.0.0.1:9',
            RAFT_PERF: '1',
            ...this.env,
        };
    }

    async start({ leaderTimeoutMs = 20000 } = {}) {
        fs.rmSync(this.dataRoot, { recursive: true, force: true });
        fs.mkdirSync(this.logRoot, { recursive: true });
        for (let index = 0; index < this.size; index += 1) {
            fs.mkdirSync(path.join(this.dataRoot, `replica${index + 1}`), { recursive: true });
            const logFile = fs.openSync(path.join(this.logRoot, `replica${index + 1}.log`), 'w');
            const child = spawn(process.execPath, [...this.nodeArgs, REPLICA_ENTRY], {
                env: this.replicaEnv(index),
                stdio: ['ignore', logFile, logFile],
                windowsHide: true,
            });
            fs.closeSync(logFile);
            const exit = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
            this.processes[index] = child;
            this.exits[index] = exit;
        }
        this.powerPolicy = applyPolicy(this.powerThrottling,
            this.processes.map((child, index) => ({ role: `replica${index + 1}`, pid: child.pid })));
        await this.waitForHealth();
        return this.waitForLeader(leaderTimeoutMs);
    }

    async waitForHealth(timeoutMs = 15000) {
        const deadline = Date.now() + timeoutMs;
        for (const url of this.urls) {
            for (;;) {
                try {
                    const response = await requestJson(`${url}/health`, { timeoutMs: 1000 });
                    if (response.status === 200) break;
                } catch (_) { /* not up yet */ }
                if (Date.now() > deadline) throw new Error(`${url} did not become healthy`);
                await sleep(50);
            }
        }
    }

    async statuses() {
        return Promise.all(this.urls.map(async (url) => {
            try {
                const response = await requestJson(`${url}/status`, { timeoutMs: 1000 });
                return { url, ...response.data };
            } catch (error) {
                return { url, error: error.message };
            }
        }));
    }

    /**
     * Waits for exactly one leader whose no-op has committed on it, so the
     * first measured write does not race the election.
     */
    async waitForLeader(timeoutMs = 20000) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const statuses = await this.statuses();
            const leaders = statuses.filter((s) => s.state === 'LEADER');
            if (leaders.length === 1 && leaders[0].commitIndex >= 0) {
                this.leader = leaders[0];
                this.leaderUrl = leaders[0].url;
                return this.leader;
            }
            await sleep(100);
        }
        throw new Error('no stable leader elected');
    }

    async perfAll(pathname, method = 'GET') {
        return Promise.all(this.urls.map(async (url) => {
            const response = await requestJson(`${url}${pathname}`, { method, timeoutMs: 30000 });
            if (response.status !== 200) throw new Error(`${url}${pathname} -> ${response.status}`);
            return response.data;
        }));
    }

    resetPerf() { return this.perfAll('/perf/reset', 'POST'); }
    collectPerf() { return this.perfAll('/perf'); }

    async startProfile(url, intervalUs = 250) {
        const response = await requestJson(`${url}/perf/profile/start?intervalUs=${intervalUs}`, { method: 'POST' });
        if (response.status !== 200) throw new Error(`profile start failed: ${JSON.stringify(response.data)}`);
    }

    async stopProfile(url) {
        const response = await requestJson(`${url}/perf/profile/stop`, { method: 'POST', timeoutMs: 60000 });
        if (response.status !== 200) throw new Error(`profile stop failed: ${JSON.stringify(response.data)}`);
        return response.data.profile;
    }

    /** Hard stop (TerminateProcess on Windows, SIGKILL elsewhere). */
    async kill(index) {
        const child = this.processes[index];
        if (!child || child.exitCode !== null) return;
        child.kill('SIGKILL');
        await this.exits[index];
    }

    async restart(index) {
        await this.kill(index);
        const logFile = fs.openSync(path.join(this.logRoot, `replica${index + 1}.log`), 'a');
        const child = spawn(process.execPath, [...this.nodeArgs, REPLICA_ENTRY], {
            env: this.replicaEnv(index),
            stdio: ['ignore', logFile, logFile],
            windowsHide: true,
        });
        fs.closeSync(logFile);
        this.processes[index] = child;
        this.exits[index] = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
        const restarted = applyPolicy(this.powerThrottling, [{ role: `replica${index + 1}`, pid: child.pid }]);
        if (this.powerPolicy) this.powerPolicy.processes.push({ ...restarted.processes[0], restarted: true });
    }

    diskUsage() {
        let bytes = 0;
        const walk = (dir) => {
            let entries = [];
            try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
            for (const entry of entries) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) walk(full);
                else if (entry.name.endsWith('.log') && dir === this.logRoot) continue;
                else { try { bytes += fs.statSync(full).size; } catch (_) { /* raced */ } }
            }
        };
        for (let index = 0; index < this.size; index += 1) walk(path.join(this.dataRoot, `replica${index + 1}`));
        return bytes;
    }

    async stop({ keepData = false } = {}) {
        await Promise.all(this.processes.map((_, index) => this.kill(index)));
        if (!keepData) {
            // Windows can hold a handle for a moment after TerminateProcess.
            for (let attempt = 0; attempt < 20; attempt += 1) {
                try {
                    for (let index = 0; index < this.size; index += 1) {
                        fs.rmSync(path.join(this.dataRoot, `replica${index + 1}`), { recursive: true, force: true });
                    }
                    break;
                } catch (_) {
                    await sleep(100);
                }
            }
        }
    }
}

module.exports = { LocalCluster, requestJson, sleep };
