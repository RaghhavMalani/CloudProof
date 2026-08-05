/**
 * consensus-client.js — the serving tier's view of the Raft cluster.
 *
 * Writes go to the leader and follow 307 redirects to find it. Watches
 * deliberately do not: they are served from applied local state, so any replica
 * can answer one, and pointing every pod's watch at the leader would turn the
 * leader into a fan-out bottleneck for exactly the workload that does not need
 * it.
 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class ConsensusClient {
    constructor(replicaUrls, { label = 'client' } = {}) {
        this.replicas = [...replicaUrls];
        this.label = label;
        this.leaderUrl = this.replicas[0];
        // Watches are pinned to one replica per client, chosen by a hash of the
        // label so pods spread themselves across followers without needing to
        // coordinate.
        this.watchUrl = this.replicas[hash(label) % this.replicas.length];
        this.stats = { redirects: 0, watchErrors: 0, writeErrors: 0 };
    }

    async _fetch(url, options = {}, timeoutMs = 5000) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            return await fetch(url, { ...options, signal: controller.signal });
        } finally {
            clearTimeout(timer);
        }
    }

    async write(route, body, attempt = 0) {
        if (attempt > this.replicas.length * 3) throw new Error('no leader available');
        const target = this.leaderUrl;

        let response;
        try {
            response = await this._fetch(`${target}${route}`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body),
            });
        } catch (_) {
            this.stats.writeErrors += 1;
            this._advanceLeader(target);
            await sleep(50);
            return this.write(route, body, attempt + 1);
        }

        const payload = await response.json().catch(() => ({}));

        if (response.status === 307) {
            this.stats.redirects += 1;
            this.leaderUrl = payload.leaderUrl || this._nextReplica(target);
            await sleep(30);
            return this.write(route, body, attempt + 1);
        }

        // 503 means the write reached the leader but could not reach a quorum.
        // Unlike a 409 it is worth retrying, because the cluster may simply be
        // mid-election.
        if (response.status === 503 && payload.retryable) {
            await sleep(100);
            return this.write(route, body, attempt + 1);
        }

        return { status: response.status, body: payload };
    }

    _nextReplica(current) {
        const index = this.replicas.indexOf(current);
        return this.replicas[(index + 1) % this.replicas.length];
    }

    _advanceLeader(current) {
        this.leaderUrl = this._nextReplica(current);
    }

    /** Conditional write. `expectRev: 0` means the key must not exist. */
    cas(key, { expectRev, expect, value }) {
        return this.write(`/cas/${encodeURIComponent(key)}`, { expectRev, expect, value });
    }

    async put(key, value) {
        const response = await this._fetch(`${this.leaderUrl}/kv/${encodeURIComponent(key)}`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ value }),
        });
        if (response.status === 307) {
            const payload = await response.json().catch(() => ({}));
            this.leaderUrl = payload.leaderUrl || this._nextReplica(this.leaderUrl);
            return this.put(key, value);
        }
        return { status: response.status, body: await response.json().catch(() => ({})) };
    }

    async del(key) {
        const response = await this._fetch(`${this.leaderUrl}/kv/${encodeURIComponent(key)}`, {
            method: 'DELETE',
            headers: { 'content-type': 'application/json' },
            body: '{}',
        });
        if (response.status === 307) {
            const payload = await response.json().catch(() => ({}));
            this.leaderUrl = payload.leaderUrl || this._nextReplica(this.leaderUrl);
            return this.del(key);
        }
        return { status: response.status, body: await response.json().catch(() => ({})) };
    }

    /** Reads are stale by default here: the serving tier tolerates it and it keeps load off the leader. */
    async get(key, { linearizable = false } = {}) {
        const base = linearizable ? this.leaderUrl : this.watchUrl;
        const suffix = linearizable ? '' : '?stale=1';
        const response = await this._fetch(`${base}/kv/${encodeURIComponent(key)}${suffix}`);
        if (response.status === 404) return null;
        if (!response.ok) throw new Error(`get ${key} failed: ${response.status}`);
        return response.json();
    }

    async list(prefix) {
        const response = await this._fetch(
            `${this.watchUrl}/kv?prefix=${encodeURIComponent(prefix)}&stale=1`,
        );
        if (!response.ok) throw new Error(`list ${prefix} failed: ${response.status}`);
        return (await response.json()).keys;
    }

    /**
     * Long-polls for changes under a prefix and calls `onEvent` for each.
     *
     * The cursor is carried across reconnects, which is the entire reason
     * watches resume from a revision rather than from "now": a pod that misses
     * an event because its connection dropped would keep serving a model the
     * cluster has already moved on from, and nothing would ever correct it.
     */
    startWatch(prefix, onEvent, { fromRev = 0 } = {}) {
        let cursor = fromRev;
        let running = true;

        const loop = async () => {
            while (running) {
                try {
                    const response = await this._fetch(
                        `${this.watchUrl}/watch?prefix=${encodeURIComponent(prefix)}&fromRev=${cursor}`,
                        {},
                        30000,
                    );

                    if (response.status === 204) continue; // nothing yet; poll again
                    if (!response.ok) throw new Error(`watch status ${response.status}`);

                    const payload = await response.json();
                    for (const event of payload.events) {
                        cursor = Math.max(cursor, event.rev);
                        await onEvent(event);
                    }
                } catch (_) {
                    if (!running) return;
                    this.stats.watchErrors += 1;
                    // Move to another replica: the current one may be down, and
                    // the cursor makes the move safe.
                    this.watchUrl = this._nextReplica(this.watchUrl);
                    await sleep(200);
                }
            }
        };

        void loop();
        return () => { running = false; };
    }
}

function hash(text) {
    let h = 2166136261;
    for (let i = 0; i < text.length; i += 1) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return (h >>> 0);
}

module.exports = { ConsensusClient };
