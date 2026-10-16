'use strict';

/**
 * descriptors.js — range descriptors and the static range directory
 * (CLOUDPROOF-PHASE-IV-B.md §2.1, IV-B.0).
 *
 * A range owns the half-open key interval [startKey, endKey). The key space
 * runs from '' (the smallest key) to +infinity, written `endKey: null`. Keys
 * compare as UTF-8 byte strings, so the benchmark's fixed-width keys
 * (k00000..k99999) order numerically.
 *
 * In IV-B.0 the descriptors are immutable: loaded once from deterministic
 * configuration, validated, frozen, all at epoch 1. Nothing here needs
 * consensus, because nothing here changes.
 */

const STATES = Object.freeze({
    ACTIVE: 'ACTIVE',
    SPLITTING: 'SPLITTING',
    FENCED: 'FENCED',
    RETIRED: 'RETIRED',
});

/** Byte-order comparison of two keys; `null` as a bound means +infinity. */
function compareKeys(a, b) {
    return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** True when `key` falls in the descriptor's [startKey, endKey). */
function ownsKey(descriptor, key) {
    if (typeof key !== 'string') return false;
    if (compareKeys(key, descriptor.startKey) < 0) return false;
    return descriptor.endKey === null || compareKeys(key, descriptor.endKey) < 0;
}

/**
 * Checks a descriptor set for the static invariants of §4:
 *   I1 unique ownership, I2 no gap, I3 no overlap, I4 (static form) positive
 *   integer epochs, plus unique range ids and a covered key space.
 * Returns { ok, violations[] }; never throws, so callers can report every
 * problem at once.
 */
function checkDescriptors(descriptors) {
    const violations = [];
    const active = descriptors.filter((d) => d.state === STATES.ACTIVE);
    const ids = new Set();
    for (const d of descriptors) {
        if (typeof d.rangeId !== 'string' || d.rangeId === '') violations.push('a descriptor has no rangeId');
        else if (ids.has(d.rangeId)) violations.push(`rangeId ${d.rangeId} is not unique`);
        ids.add(d.rangeId);
        if (!Number.isInteger(d.epoch) || d.epoch < 1) violations.push(`${d.rangeId}: epoch ${d.epoch} is not a positive integer`);
        if (!Object.values(STATES).includes(d.state)) violations.push(`${d.rangeId}: unknown state ${d.state}`);
        if (typeof d.startKey !== 'string') violations.push(`${d.rangeId}: startKey must be a string`);
        if (d.endKey !== null && typeof d.endKey !== 'string') violations.push(`${d.rangeId}: endKey must be a string or null`);
        if (typeof d.startKey === 'string' && typeof d.endKey === 'string' && compareKeys(d.startKey, d.endKey) >= 0) {
            violations.push(`${d.rangeId}: empty or inverted interval [${d.startKey}, ${d.endKey})`);
        }
    }
    const sorted = [...active].sort((a, b) => compareKeys(a.startKey, b.startKey));
    if (!sorted.length) violations.push('no ACTIVE range: the key space is not covered (I2)');
    else if (sorted[0].startKey !== '') violations.push(`gap before ${sorted[0].rangeId}: the key space starts at '' (I2)`);
    for (let i = 0; i < sorted.length; i += 1) {
        const current = sorted[i];
        const next = sorted[i + 1];
        if (!next) {
            if (current.endKey !== null) violations.push(`gap after ${current.rangeId}: the last range must end at +infinity (I2)`);
            continue;
        }
        if (current.endKey === null) {
            violations.push(`overlap: ${current.rangeId} runs to +infinity but ${next.rangeId} starts at ${next.startKey} (I3)`);
            continue;
        }
        const order = compareKeys(current.endKey, next.startKey);
        if (order < 0) violations.push(`gap between ${current.rangeId} and ${next.rangeId}: [${current.endKey}, ${next.startKey}) (I2)`);
        if (order > 0) violations.push(`overlap between ${current.rangeId} and ${next.rangeId} at ${next.startKey} (I3)`);
    }
    return { ok: violations.length === 0, violations };
}

function freezeDescriptor(d) {
    return Object.freeze({
        rangeId: d.rangeId,
        startKey: d.startKey,
        endKey: d.endKey,
        epoch: d.epoch,
        replicas: Object.freeze([...(d.replicas || [])]),
        leaderHint: d.leaderHint ?? null,
        state: d.state,
    });
}

/**
 * The deterministic IV-B.0 configuration: `boundaries` split the key space
 * into boundaries.length + 1 ranges, r1..rN, every one ACTIVE at epoch 1 and
 * replicated on every node in `replicas`.
 */
function staticDescriptors({ boundaries, replicas }) {
    const starts = ['', ...boundaries];
    return starts.map((startKey, i) => ({
        rangeId: `r${i + 1}`,
        startKey,
        endKey: i + 1 < starts.length ? starts[i + 1] : null,
        epoch: 1,
        replicas: [...replicas],
        leaderHint: null,
        state: STATES.ACTIVE,
    }));
}

/**
 * Read-only directory over a validated, frozen descriptor set. In IV-B.0 it is
 * the authority because it never changes; from IV-B.1 it becomes a cache of
 * the ranges' own committed descriptors (§2.2).
 */
class RangeDirectory {
    constructor(descriptors) {
        const check = checkDescriptors(descriptors);
        if (!check.ok) throw new Error(`invalid range descriptors: ${check.violations.join('; ')}`);
        this._descriptors = Object.freeze(descriptors.map(freezeDescriptor));
        this._active = this._descriptors
            .filter((d) => d.state === STATES.ACTIVE)
            .sort((a, b) => compareKeys(a.startKey, b.startKey));
        this._byId = new Map(this._descriptors.map((d) => [d.rangeId, d]));
    }

    all() { return this._descriptors; }

    get(rangeId) { return this._byId.get(rangeId) || null; }

    /** The ACTIVE range owning `key` (binary search over sorted start keys). */
    lookup(key) {
        if (typeof key !== 'string') throw new TypeError('key must be a string');
        let lo = 0;
        let hi = this._active.length - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (compareKeys(this._active[mid].startKey, key) <= 0) lo = mid;
            else hi = mid - 1;
        }
        const descriptor = this._active[lo];
        if (!descriptor || !ownsKey(descriptor, key)) throw new Error(`no ACTIVE range owns ${JSON.stringify(key)}`);
        return descriptor;
    }
}

module.exports = { STATES, compareKeys, ownsKey, checkDescriptors, staticDescriptors, RangeDirectory };
