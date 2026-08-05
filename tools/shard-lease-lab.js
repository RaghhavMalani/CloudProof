#!/usr/bin/env node
/**
 * shard-lease-lab.js — exercises the lease primitive the way the control plane
 * will actually use it.
 *
 * Simulated pods compete for a fixed set of shards. Each pod tries to acquire
 * every shard it does not already hold, renews what it holds at a third of the
 * TTL, and gives up its leases when it is killed. Partway through, one pod is
 * killed *without* releasing anything — the interesting case, because that is
 * what a crashed node looks like — and the lab measures how long the cluster
 * takes to hand its shards to someone else.
 *
 * The safety assertion is the point: at no observed instant may a shard be
 * held by two pods. That is what makes it safe to have exactly one pod serving
 * a given index shard, which is the whole reason consensus is in this system.
 *
 *   node tools/shard-lease-lab.js --replicas http://localhost:5001,... \
 *        --shards 6 --pods 4 --ttl 1500 --kill 8000
 */

const DEFAULTS = {
    replicas: 'http://127.0.0.1:5001,http://127.0.0.1:5002,http://127.0.0.1:5003',
    shards: 6,
    pods: 4,
    ttl: 1500,
    kill: 8000,
    duration: 20000,
};

function parseArgs() {
    const options = { ...DEFAULTS };
    const argv = process.argv.slice(2);
    for (let i = 0; i < argv.length; i += 2) {
        const key = argv[i].replace(/^--/, '');
        if (!(key in options)) continue;
        options[key] = key === 'replicas' ? argv[i + 1] : Number(argv[i + 1]);
    }
    options.replicas = String(options.replicas).split(',').filter(Boolean);
    return options;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class Cluster {
    constructor(urls) {
        this.urls = urls;
        this.leaderUrl = urls[0];
        this.redirects = 0;
    }

    /**
     * Writes go to the leader. Discovering a leader change from a 307 is
     * exactly what a real client does, so the lab does it too rather than
     * being told who leads.
     */
    async write(route, body, attempt = 0) {
        const target = this.leaderUrl;
        let response;
        try {
            response = await fetch(`${target}${route}`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body),
            });
        } catch (_) {
            if (attempt > this.urls.length) throw new Error('no reachable replica');
            this.leaderUrl = this.urls[(this.urls.indexOf(target) + 1) % this.urls.length];
            return this.write(route, body, attempt + 1);
        }

        const payload = await response.json().catch(() => ({}));

        if (response.status === 307) {
            this.redirects += 1;
            this.leaderUrl = payload.leaderUrl || this.urls[(this.urls.indexOf(target) + 1) % this.urls.length];
            if (attempt > this.urls.length * 2) throw new Error('leader never settled');
            await sleep(50);
            return this.write(route, body, attempt + 1);
        }

        return { status: response.status, body: payload };
    }

    async state(url = this.leaderUrl) {
        const response = await fetch(`${url}/state`);
        return response.json();
    }
}

/**
 * One simulated embedding pod. Holds leases, renews them, and stops cleanly or
 * abruptly depending on how it is shut down.
 */
class Pod {
    constructor(name, cluster, options) {
        this.name = name;
        this.cluster = cluster;
        this.options = options;
        this.held = new Set();
        this.alive = true;
        this.acquired = 0;
        this.lost = 0;
    }

    async run() {
        while (this.alive) {
            for (let shard = 0; shard < this.options.shards && this.alive; shard += 1) {
                const key = `shard/${shard}`;
                if (this.held.has(key)) continue;
                const { status, body } = await this.cluster.write(`/lease/${encodeURIComponent(key)}/acquire`, {
                    holder: this.name,
                    ttlMs: this.options.ttl,
                });
                if (status === 200 && body.ok) {
                    this.held.add(key);
                    this.acquired += 1;
                }
            }
            await sleep(60);
        }
    }

    /** Renews at a third of the TTL, so two consecutive failures are survivable. */
    async renewLoop() {
        while (this.alive) {
            await sleep(Math.max(50, Math.floor(this.options.ttl / 3)));
            if (!this.alive) return;
            for (const key of [...this.held]) {
                const { status, body } = await this.cluster.write(`/lease/${encodeURIComponent(key)}/renew`, {
                    holder: this.name,
                    ttlMs: this.options.ttl,
                });
                if (status !== 200 || !body.ok) {
                    // Losing a renewal means the lease lapsed and someone else
                    // may already own the shard. A real pod would stop serving
                    // it immediately — that is the fencing behaviour.
                    this.held.delete(key);
                    this.lost += 1;
                }
            }
        }
    }

    /** SIGKILL equivalent: stop renewing, release nothing. */
    kill() {
        this.alive = false;
        this.held.clear();
    }

    async drain() {
        this.alive = false;
        for (const key of [...this.held]) {
            await this.cluster.write(`/lease/${encodeURIComponent(key)}/release`, { holder: this.name });
        }
        this.held.clear();
    }
}

(async () => {
    const options = parseArgs();
    const cluster = new Cluster(options.replicas);

    console.log(`shard-lease lab · ${options.pods} pods · ${options.shards} shards · ` +
        `ttl=${options.ttl}ms · killing pod-0 at ${options.kill}ms\n`);

    const pods = Array.from({ length: options.pods }, (_, i) => new Pod(`pod-${i}`, cluster, options));

    // ── observer ─────────────────────────────────────────────────────────────
    // Samples the authoritative keyspace continuously. Every sample is checked
    // for the one invariant that matters, and ownership changes are timestamped
    // so reassignment latency can be measured rather than asserted.
    const violations = [];
    const ownership = new Map();
    const transitions = [];
    let samples = 0;
    let observing = true;

    const observer = (async () => {
        while (observing) {
            try {
                const state = await cluster.state();
                samples += 1;
                const seen = new Map();
                for (const record of state.keys) {
                    if (!record.key.startsWith('shard/')) continue;
                    if (seen.has(record.key)) {
                        violations.push({ key: record.key, holders: [seen.get(record.key), record.value] });
                    }
                    seen.set(record.key, record.value);

                    const previous = ownership.get(record.key);
                    if (previous !== record.value) {
                        transitions.push({ key: record.key, from: previous ?? null, to: record.value, at: Date.now() });
                        ownership.set(record.key, record.value);
                    }
                }
                for (const key of [...ownership.keys()]) {
                    if (!seen.has(key)) {
                        transitions.push({ key, from: ownership.get(key), to: null, at: Date.now() });
                        ownership.delete(key);
                    }
                }
            } catch (_) { /* leader churn is expected */ }
            await sleep(25);
        }
    })();

    const startedAt = Date.now();
    const running = pods.flatMap((pod) => [pod.run(), pod.renewLoop()]);

    await sleep(options.kill);

    const victim = pods[0];
    const heldAtDeath = [...victim.held];
    const killedAt = Date.now();
    victim.kill();
    console.log(`t=${killedAt - startedAt}ms  killed ${victim.name}, holding ${heldAtDeath.join(', ') || '(nothing)'}\n`);

    await sleep(Math.max(options.duration - options.kill, options.ttl * 4));

    observing = false;
    for (const pod of pods) pod.alive = false;
    await Promise.allSettled([...running, observer]);

    // ── results ──────────────────────────────────────────────────────────────
    const reassignments = heldAtDeath.map((key) => {
        const handoff = transitions.find(
            (t) => t.key === key && t.at > killedAt && t.to !== null && t.to !== victim.name,
        );
        return { key, latencyMs: handoff ? handoff.at - killedAt : null, to: handoff ? handoff.to : null };
    });

    const finalState = await cluster.state();
    const finalOwners = finalState.keys
        .filter((k) => k.key.startsWith('shard/'))
        .map((k) => `${k.key}=${k.value}`);

    console.log('final ownership:', finalOwners.join('  ') || '(none)');
    console.log(`\nsamples taken:            ${samples}`);
    console.log(`ownership transitions:    ${transitions.length}`);
    console.log(`leader redirects handled: ${cluster.redirects}`);
    console.log(`double-ownership events:  ${violations.length}`);

    console.log('\nreassignment after the kill:');
    for (const item of reassignments) {
        console.log(`  ${item.key.padEnd(10)} -> ${(item.to ?? 'UNCLAIMED').padEnd(8)} ` +
            `${item.latencyMs === null ? '(never reassigned)' : `${item.latencyMs}ms`}`);
    }

    const measured = reassignments.filter((r) => r.latencyMs !== null).map((r) => r.latencyMs);
    if (measured.length > 0) {
        const mean = Math.round(measured.reduce((a, b) => a + b, 0) / measured.length);
        console.log(`\n  ttl=${options.ttl}ms · reassignment mean ${mean}ms · ` +
            `min ${Math.min(...measured)}ms · max ${Math.max(...measured)}ms`);
        console.log('  Expect roughly one TTL: the cluster cannot know a holder is gone ' +
            'until its lease lapses, so TTL is the floor on detection.');
    }

    console.log(`\nper-pod: ${pods.map((p) => `${p.name} acquired=${p.acquired} lostRenewals=${p.lost}`).join(' · ')}`);

    const ok = violations.length === 0
        && heldAtDeath.length > 0
        && reassignments.every((r) => r.latencyMs !== null);
    console.log(`\n${ok ? 'PASS' : 'FAIL'} — no shard was ever held by two pods` +
        `${heldAtDeath.length === 0 ? ' (but the victim held nothing; increase --kill)' : ''}` +
        `${reassignments.some((r) => r.latencyMs === null) ? ' (but some shards were never reassigned)' : ''}`);
    process.exit(ok ? 0 : 1);
})().catch((error) => {
    console.error('lab failed:', error.message);
    process.exit(1);
});
