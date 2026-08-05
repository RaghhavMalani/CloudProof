#!/usr/bin/env node
/**
 * rollout-cli.js — the entrypoint the rollout Job runs.
 *
 * Reads the manifest from the artifact store rather than taking it as
 * arguments, so the thing that gets rolled out is exactly the thing that was
 * built. Passing dimensions and checksums on the command line invites a
 * mismatch between what the Job says and what is actually in the bucket.
 *
 *   MODEL_VERSION=v2 EXPECTED_PODS=4 node rollout-cli.js
 *   MODEL_VERSION=v1 ROLLBACK=1 node rollout-cli.js
 */

const { backendFromEnv } = require('./artifacts');
const { ConsensusClient } = require('./consensus-client');
const { RolloutController } = require('./rollout-controller');

const VERSION = process.env.MODEL_VERSION;
const EXPECTED_PODS = Number.parseInt(process.env.EXPECTED_PODS || '0', 10);
const ROLLBACK = process.env.ROLLBACK === '1';
const TIMEOUT_MS = Number.parseInt(process.env.ROLLOUT_TIMEOUT_MS || '300000', 10);
const REPLICAS = (process.env.RAFT_REPLICAS_URLS || '').split(',').filter(Boolean);

(async () => {
    if (!VERSION) throw new Error('MODEL_VERSION is required');
    if (REPLICAS.length === 0) throw new Error('RAFT_REPLICAS_URLS is required');
    if (!ROLLBACK && EXPECTED_PODS < 1) {
        // Defaulting this to something would be worse than failing: a rollout
        // that waits for zero acknowledgements flips instantly and provides
        // none of the safety the two-phase protocol exists for.
        throw new Error('EXPECTED_PODS must be at least 1 for a forward rollout');
    }

    const backend = backendFromEnv();
    const manifest = JSON.parse(
        (await backend.read(`index/${VERSION}/manifest.json`)).toString('utf8'),
    );

    const consensus = new ConsensusClient(REPLICAS, { label: `rollout-${VERSION}` });
    const controller = new RolloutController(consensus, {
        holder: `rollout-${VERSION}-${process.pid}`,
    });

    await controller.acquireLock();
    try {
        const result = ROLLBACK
            ? await controller.rollback(manifest)
            : await controller.rollout(manifest, { expectedPods: EXPECTED_PODS, timeoutMs: TIMEOUT_MS });

        console.log(JSON.stringify(result, null, 2));
        if (!result.ok) {
            // Non-zero so the Job is marked failed. A rollout that stalled at
            // the staging phase has changed nothing observable — model/current
            // still points at the old version — so failing loudly and leaving
            // it alone is the correct outcome.
            process.exitCode = 1;
        }
    } finally {
        await controller.releaseLock();
    }
})().catch((error) => {
    console.error(`rollout failed: ${error.message}`);
    process.exit(1);
});
