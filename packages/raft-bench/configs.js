'use strict';

/**
 * Benchmark configurations. Each is the same replica binary with a different
 * set of environment flags, so a comparison never mixes builds.
 *
 * The ablation is cumulative: each step keeps everything before it.
 */

const CONFIGS = {
    baseline: {
        description: 'Current implementation: synchronous per-append fsync, metadata fsync on every commit '
            + 'advance, stop-and-wait replication per follower, unbounded AppendEntries batches, '
            + 'HTTP/1.1 + JSON via axios/express.',
        env: {},
    },
};

function configEnv(name) {
    const config = CONFIGS[name];
    if (!config) throw new Error(`unknown benchmark config "${name}" (known: ${Object.keys(CONFIGS).join(', ')})`);
    return { ...config.env };
}

module.exports = { CONFIGS, configEnv };
