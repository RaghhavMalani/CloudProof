'use strict';

/**
 * order.js — the deterministic trial order of an interleaved sweep.
 *
 * Within each ladder rung every active curve runs once per round, and the
 * order inside a round is a row of a Williams Latin square: over k rounds (2k
 * when k is odd) every curve takes every position equally often, and every
 * curve immediately follows every other curve equally often. Slow drift in the
 * machine (the disk's fsync regime, thermal state) therefore spreads over all
 * configurations instead of lining up with one of them, and so does any
 * carry-over from the trial just before.
 *
 * Rows are taken from a single global round counter that advances across
 * rungs, so the order depends only on the plan and on which curves are still
 * active, never on wall-clock time or chance.
 */

const ORDER_SCHEME = Object.freeze({
    name: 'williams-latin',
    version: 1,
    text: 'Within a rung, each round runs every active curve once, in the order of row (round mod k) of a '
        + 'Williams Latin square over the k active curves in plan order (rows k..2k-1 mirrored when k is odd). '
        + 'The round counter is global across rungs.',
});

/** First row of a Williams square: 0, 1, k-1, 2, k-2, 3, ... */
function williamsBase(k) {
    const row = [];
    let low = 0;
    let high = k - 1;
    for (let i = 0; i < k; i += 1) {
        if (i === 0) row.push(low++);
        else if (i % 2 === 1) row.push(low++);
        else row.push(high--);
    }
    return row;
}

/** Index permutation for `round` over k items. */
function williamsRow(k, round) {
    if (k <= 0) return [];
    const period = k % 2 === 0 ? k : 2 * k;
    const r = ((round % period) + period) % period;
    const shift = r % k;
    let row = williamsBase(k).map((value) => (value + shift) % k);
    if (k % 2 === 1 && r >= k) row = row.reverse();
    return row;
}

function orderedRound(items, round) {
    return williamsRow(items.length, round).map((index) => items[index]);
}

module.exports = { ORDER_SCHEME, williamsBase, williamsRow, orderedRound };
