'use strict';

/**
 * raft-profiles.js — the Phase IV-A optimization settings, in one place.
 *
 * The same named profiles drive the live replica (through environment
 * variables, see optionsFromEnv) and the deterministic simulator (through
 * `raftProfile` in a schedule's config), so the configuration that is
 * benchmarked is the configuration that is fault-tested.
 *
 * `baseline` is the empty object: the engine's defaults are the original,
 * unoptimized behaviour. Every optimization is an independent option, so a
 * profile can isolate one as well as stack several. The `-delay` profiles are
 * simulator stress variants, never benchmarked.
 */

const GROUP_COMMIT = Object.freeze({ maxEntries: 1024, maxDelayMs: 0, metaIntervalMs: 100 });
// Simulator stress settings. With maxDelayMs 0 the appended-but-not-durable
// window lasts zero virtual milliseconds, so a scheduled crash essentially
// never lands inside it (measured: 0 of 300 schedules). An 8 ms window and a
// small batch cap make crash-before-flush, revoked acknowledgements and
// lagging commit indexes routine. Strictly more adversarial than the
// benchmarked setting.
const GROUP_COMMIT_DELAY = Object.freeze({ maxEntries: 4, maxDelayMs: 8, metaIntervalMs: 60 });
const PIPELINE = Object.freeze({ maxInflight: 8 });
const PIPELINE_DELAY = Object.freeze({ maxInflight: 4 });
const BATCH = Object.freeze({ maxEntries: 512, maxBytes: 1024 * 1024, coalesce: true });
// Tiny batches, so every burst spans several requests and a lagging follower
// is caught up piecewise.
const BATCH_DELAY = Object.freeze({ maxEntries: 3, maxBytes: 600, coalesce: true });

const PROFILES = Object.freeze({
    baseline: Object.freeze({}),
    'group-commit': Object.freeze({ groupCommit: GROUP_COMMIT }),
    'group-commit-delay': Object.freeze({ groupCommit: GROUP_COMMIT_DELAY }),

    // Pipelining alone, on the original synchronous-fsync engine.
    'pipeline-only': Object.freeze({ pipeline: PIPELINE }),
    // Group commit + pipelining, without bounded batches.
    'group-pipeline': Object.freeze({ groupCommit: GROUP_COMMIT, pipeline: PIPELINE }),
    'pipeline-delay': Object.freeze({ groupCommit: GROUP_COMMIT_DELAY, pipeline: PIPELINE_DELAY }),

    // Bounded batches with the coalesced trigger, alone and with group commit.
    'batch-only': Object.freeze({ replicationBatch: BATCH }),
    'group-batch': Object.freeze({ groupCommit: GROUP_COMMIT, replicationBatch: BATCH }),
    'group-batch-pipeline': Object.freeze({ groupCommit: GROUP_COMMIT, pipeline: PIPELINE, replicationBatch: BATCH }),
    'batched-delay': Object.freeze({
        groupCommit: GROUP_COMMIT_DELAY, pipeline: PIPELINE_DELAY, replicationBatch: BATCH_DELAY,
    }),

    // `wire` selects the replica-to-replica transport (raft-transport.js); it
    // is not a RaftNode option. In the simulator it routes every RPC through
    // the binary codec (sim/wire-codec.js).
    //
    // The transport alone on the original engine: isolates what the wire
    // format is worth when the disk path is unchanged.
    'transport-only': Object.freeze({ wire: 'framed-tcp' }),
    'optimized-delay': Object.freeze({
        groupCommit: GROUP_COMMIT_DELAY, pipeline: PIPELINE_DELAY, replicationBatch: BATCH_DELAY, wire: 'framed-tcp',
    }),

    // Every engine optimization without the two per-write log lines, over the
    // original HTTP transport and over the framed transport.
    'optimized-http': Object.freeze({
        groupCommit: GROUP_COMMIT, pipeline: PIPELINE, replicationBatch: BATCH, logHotPath: false,
    }),
    'optimized-binary': Object.freeze({
        groupCommit: GROUP_COMMIT, pipeline: PIPELINE, replicationBatch: BATCH, logHotPath: false, wire: 'framed-tcp',
    }),
});

function profileOptions(name) {
    if (name === undefined || name === null || name === '') return {};
    const profile = PROFILES[name];
    if (!profile) throw new Error(`unknown raft profile "${name}" (known: ${Object.keys(PROFILES).join(', ')})`);
    return JSON.parse(JSON.stringify(profile));
}

const flag = (value) => value === '1' || value === 'true';
const int = (value, fallback) => (value === undefined || value === '' ? fallback : Number.parseInt(value, 10));

/**
 * RaftNode options from the environment. RAFT_PROFILE selects a named
 * profile; individual variables override or extend it:
 *
 *   RAFT_GROUP_COMMIT=1  RAFT_GC_MAX_ENTRIES  RAFT_GC_MAX_DELAY_MS  RAFT_GC_META_INTERVAL_MS
 *   RAFT_PIPELINE=1      RAFT_PIPELINE_MAX_INFLIGHT
 *   RAFT_BATCH=1         RAFT_BATCH_MAX_ENTRIES  RAFT_BATCH_MAX_BYTES  RAFT_BATCH_COALESCE
 *   RAFT_TRANSPORT=tcp|http  (overrides the profile's `wire`)
 *   RAFT_LOG_HOT_PATH=0|1    (per-write log lines; default on)
 */
function optionsFromEnv(env = process.env) {
    const options = profileOptions(env.RAFT_PROFILE);
    if (flag(env.RAFT_GROUP_COMMIT) || options.groupCommit) {
        const base = options.groupCommit || GROUP_COMMIT;
        options.groupCommit = {
            maxEntries: int(env.RAFT_GC_MAX_ENTRIES, base.maxEntries),
            maxDelayMs: int(env.RAFT_GC_MAX_DELAY_MS, base.maxDelayMs),
            metaIntervalMs: int(env.RAFT_GC_META_INTERVAL_MS, base.metaIntervalMs),
        };
    }
    if (flag(env.RAFT_PIPELINE) || options.pipeline) {
        const base = options.pipeline || PIPELINE;
        options.pipeline = { maxInflight: int(env.RAFT_PIPELINE_MAX_INFLIGHT, base.maxInflight) };
    }
    if (flag(env.RAFT_BATCH) || options.replicationBatch) {
        const base = options.replicationBatch || BATCH;
        options.replicationBatch = {
            maxEntries: int(env.RAFT_BATCH_MAX_ENTRIES, base.maxEntries),
            maxBytes: int(env.RAFT_BATCH_MAX_BYTES, base.maxBytes),
            coalesce: env.RAFT_BATCH_COALESCE === undefined ? base.coalesce : flag(env.RAFT_BATCH_COALESCE),
        };
    }
    if (env.RAFT_TRANSPORT) options.wire = env.RAFT_TRANSPORT === 'tcp' ? 'framed-tcp' : 'http';
    if (env.RAFT_LOG_HOT_PATH !== undefined && env.RAFT_LOG_HOT_PATH !== '') options.logHotPath = flag(env.RAFT_LOG_HOT_PATH);
    return options;
}

module.exports = { PROFILES, profileOptions, optionsFromEnv };
