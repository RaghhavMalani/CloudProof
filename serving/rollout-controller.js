/**
 * rollout-controller.js — drives a model version across the fleet.
 *
 * Runs as a Job, not a Deployment: a rollout has a beginning and an end, and
 * modelling it as a long-lived process invites two controllers racing each
 * other. The `rollout/lock` lease makes that safe even if someone starts two
 * anyway — the second one is refused rather than interleaved.
 *
 * The protocol is deliberately conservative about what it will flip. It waits
 * for acknowledgements from pods rather than for a timer, and it treats
 * "not all pods acked" as a reason to stop rather than a reason to proceed
 * slowly. A stalled rollout is visible and reversible; a half-applied one that
 * splits the fleet across two vector spaces is neither.
 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class RolloutController {
    constructor(consensus, { holder = 'rollout-controller', log = console.log } = {}) {
        this.consensus = consensus;
        this.holder = holder;
        this.log = log;
    }

    /**
     * Two rollouts flipping `model/current` at once could leave the fleet on
     * whichever finished last while both report success. The lease makes the
     * second one fail loudly instead.
     */
    async acquireLock(ttlMs = 30000, { waitMs = 90000 } = {}) {
        const deadline = Date.now() + waitMs;
        let held = null;

        // Retry until the incumbent's lease lapses rather than failing on the
        // first refusal.
        //
        // The failure this prevents is specific and confusing: a rollout Job
        // that crashes leaves its lease live for up to a full TTL, and the
        // Kubernetes restart comes back with a *different* holder string, so
        // the retry is refused by the dead run's own lock. It reads as
        // contention when nothing is actually contending. Waiting out the TTL
        // resolves it without weakening the guarantee, because a genuinely
        // concurrent controller keeps renewing and this still gives up.
        for (;;) {
            const { status, body } = await this.consensus.write('/lease/rollout%2Flock/acquire', {
                holder: this.holder,
                ttlMs,
            });

            if (status === 200 && body.ok) break;

            held = body.holder ?? 'unknown';
            if (Date.now() >= deadline) {
                throw new Error(
                    `could not acquire the rollout lock within ${waitMs}ms; held by ${held}`,
                );
            }
            await sleep(1000);
        }

        this._renew = setInterval(() => {
            this.consensus.write('/lease/rollout%2Flock/renew', { holder: this.holder, ttlMs })
                .catch(() => {});
        }, Math.floor(ttlMs / 3));
        if (this._renew.unref) this._renew.unref();
    }

    async releaseLock() {
        if (this._renew) clearInterval(this._renew);
        this._renew = null;
        await this.consensus.write('/lease/rollout%2Flock/release', { holder: this.holder })
            .catch(() => {});
    }

    /** Pods that have acknowledged the given version. */
    async acks(version) {
        const entries = await this.consensus.list('model/ready/');
        return entries
            .filter((entry) => entry.value === version)
            .map((entry) => entry.key.slice('model/ready/'.length));
    }

    async liveePods() { return this.acks(undefined); }

    /**
     * Phase 1 — publish the manifest and wait for the fleet to preload it.
     *
     * `expectedPods` is passed in rather than discovered, because discovering
     * it from the readiness keys is circular: a pod that has never acked
     * anything is indistinguishable from one that does not exist. In-cluster
     * this comes from the Deployment's ready replica count.
     */
    async stage(manifest, { expectedPods, timeoutMs = 120000, pollMs = 200 } = {}) {
        // Linearizable: this read is the `expectRev` for a CAS, so a stale
        // value from a lagging follower would produce a spurious conflict and
        // fail a rollout that should have succeeded.
        const staged = await this.consensus.get('model/staged', { linearizable: true }).catch(() => null);
        const result = await this.consensus.cas('model/staged', {
            expectRev: staged ? staged.rev : 0,
            value: manifest,
        });
        if (result.status !== 200 || !result.body.ok) {
            throw new Error(`could not stage ${manifest.version}: ${JSON.stringify(result.body)}`);
        }
        this.log(`staged ${manifest.version} — waiting for ${expectedPods} pods to preload`);

        const startedAt = Date.now();
        let acked = [];
        while (Date.now() - startedAt < timeoutMs) {
            acked = await this.acks(manifest.version);
            if (acked.length >= expectedPods) {
                const elapsed = Date.now() - startedAt;
                this.log(`all ${acked.length} pods preloaded ${manifest.version} in ${elapsed}ms`);
                return { ok: true, acked, preloadMs: elapsed };
            }
            await sleep(pollMs);
        }

        return {
            ok: false,
            acked,
            error: `only ${acked.length}/${expectedPods} pods acked ${manifest.version} within ${timeoutMs}ms`,
        };
    }

    /**
     * Phase 2 — flip.
     *
     * By this point every pod already holds the version in memory, so the
     * observable cost of this call is one Raft commit plus one watch delivery
     * per pod. That is what makes the claim "atomic rollout" defensible: the
     * expensive, variable-duration work happened in phase 1, where being
     * half-done is harmless.
     */
    async activate(manifest) {
        const current = await this.consensus.get('model/current', { linearizable: true }).catch(() => null);
        if (current && current.value.version === manifest.version) {
            return { ok: true, alreadyActive: true, flipMs: 0 };
        }

        const startedAt = Date.now();
        const result = await this.consensus.cas('model/current', {
            expectRev: current ? current.rev : 0,
            value: manifest,
        });

        if (result.status !== 200 || !result.body.ok) {
            // A revision mismatch means someone else changed `model/current`
            // between the read and the write. Overwriting blindly would clobber
            // a rollback somebody may have just performed in an incident.
            return { ok: false, error: `flip rejected: ${JSON.stringify(result.body)}` };
        }

        return { ok: true, flipMs: Date.now() - startedAt, rev: result.body.rev };
    }

    /** Stage then activate, refusing to flip if the fleet did not fully preload. */
    async rollout(manifest, options = {}) {
        const staged = await this.stage(manifest, options);
        if (!staged.ok) {
            return { ok: false, phase: 'stage', ...staged };
        }
        const activated = await this.activate(manifest);
        return { ok: activated.ok, phase: activated.ok ? 'done' : 'activate', ...staged, ...activated };
    }

    /**
     * Rollback is just an activation of a version the pods already have in
     * their retired slot, so it costs a commit and a pointer swap. Notably it
     * does *not* re-stage: waiting for preload acks during an incident would be
     * exactly backwards.
     */
    async rollback(manifest) {
        this.log(`rolling back to ${manifest.version}`);
        return this.activate(manifest);
    }
}

module.exports = { RolloutController };
