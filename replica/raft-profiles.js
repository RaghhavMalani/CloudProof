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

const PROFILES = Object.freeze({
    baseline: Object.freeze({}),
    'group-commit': Object.freeze({ groupCommit: GROUP_COMMIT }),
    'group-commit-delay': Object.freeze({ groupCommit: GROUP_COMMIT_DELAY }),
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
    return options;
}

module.exports = { PROFILES, profileOptions, optionsFromEnv };
