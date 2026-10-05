'use strict';

/**
 * Benchmark configurations. Each is the same replica binary with a different
 * RAFT_PROFILE (replica/raft-profiles.js), so a comparison never mixes builds.
 *
 * These are the nine configurations frozen in methodology.json (amendment 1).
 * Every optimization is an independent option, so the set both isolates
 * single optimizations (pipeline-only, batch-only, transport-only) and stacks
 * them; the profile names are the config names.
 */

const PROFILE_CONFIGS = [
    ['baseline', 'Original engine: synchronous fsync per append, one AppendEntries in flight per follower, '
        + 'HTTP/1.1 + JSON via axios/express.'],
    ['group-commit', 'Durable group commit: one fsync per event-loop turn, acks after flush, leader counts '
        + 'itself only when durable, commit index persisted lazily.'],
    ['pipeline-only', 'Pipelined replication (up to 8 AppendEntries in flight per follower) on the '
        + 'synchronous-fsync engine.'],
    ['batch-only', 'Bounded batches (512 entries / 1 MiB) and one coalesced replication round per turn, on '
        + 'the synchronous-fsync engine.'],
    ['group-batch', 'Group commit + bounded, coalesced batches.'],
    ['group-batch-pipeline', 'Group commit + bounded, coalesced batches + pipelined replication.'],
    ['optimized-http', 'group-batch-pipeline without the two per-write log lines, HTTP transport.'],
    ['optimized-binary', 'optimized-http over the framed binary TCP transport.'],
    ['transport-only', 'Original engine with only the framed binary TCP transport.'],
];

const CONFIGS = Object.fromEntries(PROFILE_CONFIGS.map(([name, description]) => [name, {
    description,
    env: name === 'baseline' ? {} : { RAFT_PROFILE: name },
}]));

/**
 * Systems other than CloudProof that the same harness drives, with the same
 * generator, ladder, windows and stability rule (methodology amendment 4).
 * They are not replica profiles, so they stay out of CONFIGS.
 */
const EXTERNAL_SYSTEMS = Object.freeze({
    etcd: {
        system: 'etcd',
        description: 'Stock etcd v3.7.2 (official release), three members on loopback, every flag at its default '
            + 'except names, data directories, URLs and the initial cluster; clients use the v3 HTTP/JSON gateway.',
    },
});

/** 'cloudproof' for a replica profile, the system's name for an external system. */
function systemOf(name) {
    if (CONFIGS[name]) return 'cloudproof';
    if (EXTERNAL_SYSTEMS[name]) return EXTERNAL_SYSTEMS[name].system;
    throw new Error(`unknown benchmark config "${name}" (known: ${[...Object.keys(CONFIGS), ...Object.keys(EXTERNAL_SYSTEMS)].join(', ')})`);
}

function configEnv(name) {
    const config = CONFIGS[name];
    if (!config) throw new Error(`unknown benchmark config "${name}" (known: ${Object.keys(CONFIGS).join(', ')})`);
    return { ...config.env };
}

module.exports = { CONFIGS, EXTERNAL_SYSTEMS, configEnv, systemOf };
