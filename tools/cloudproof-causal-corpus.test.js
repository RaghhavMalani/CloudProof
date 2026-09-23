'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { parseArgs } = require('./cloudproof-causal-corpus');

test('causal corpus CLI parses its aliases and keeps deterministic defaults', () => {
    const options = parseArgs(['--simulations', '1000', '--seed', '61000', '--out', 'x', '--counterfactual-pairs', '40',
        '--permutation-seeds', '1,2,3', '--minimum-safe', '5', '--minimum-unsafe', '7']);
    assert.equal(options.trajectories, 1000);
    assert.equal(options.seedStart, 61000);
    assert.equal(options.pairs, 40);
    assert.deepEqual(options.permutationSeeds, [1, 2, 3]);
    assert.equal(options.minimumSafe, 5);
    assert.equal(options.minimumUnsafe, 7);
    const defaults = parseArgs([]);
    assert.equal(defaults.seedStart, 90000);
    assert.equal(defaults.pairSeedStart, 95000);
    assert.equal(defaults.shortcutAurocMax, 0.55);
    assert.equal(defaults.shortcutAurocHardMax, 0.65);
    assert.throws(() => parseArgs(['--desired-outcome', 'unsafe']), /unknown option/);
    const hardened = parseArgs(['--max-class-share', '0.3', '--shortcut-split-max', '0.58', '--max-rows-per-trajectory', '20',
        '--position-target-quantile', '0.9', '--minimum-horizon-positives', '5']);
    assert.equal(hardened.maxClassShare, 0.3);
    assert.equal(hardened.shortcutSplitMax, 0.58);
    assert.equal(hardened.maxRowsPerTrajectory, 20);
    assert.equal(hardened.positionTargetQuantile, 0.9);
    assert.equal(hardened.minimumHorizonPositives, 5);
    assert.equal(defaults.maxClassShare, 0.4);
    assert.equal(defaults.smdMax, 0.2);
});
