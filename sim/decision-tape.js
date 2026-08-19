'use strict';

const { Rng } = require('./simulator');

function deriveSeed(seed, name) {
    let hash = (seed >>> 0) || 1;
    const text = String(name);
    for (let i = 0; i < text.length; i += 1) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 16777619) >>> 0;
    }
    return hash || 1;
}

function safeContext(value) {
    if (value === undefined || value === null) return null;
    try { return JSON.parse(JSON.stringify(value)); } catch (_) { return String(value); }
}

/**
 * A portable record of raw PRNG decisions for one semantic domain.
 *
 * Exact replay consumes the recorded raw integers instead of sampling again.
 * A shrunken schedule can change how many decisions a domain needs; in that
 * case replay projects the old tape onto the new execution and falls back to
 * the domain seed only after the tape is exhausted. Diagnostics make that
 * projection visible rather than silently pretending it was an exact replay.
 */
class DecisionTape {
    constructor({ seed = 1, stream = 'default', decisions = null, clock = null, startedAt = null } = {}) {
        this.seed = deriveSeed(seed, stream);
        this.stream = stream;
        this.clock = clock;
        this.startedAt = startedAt === null && clock ? clock.now() : startedAt;
        this.mode = decisions === null ? 'record' : 'replay';
        this.recorded = decisions === null ? [] : decisions.map((item) => ({ ...item }));
        this.observed = [];
        this.cursor = 0;
        this.rng = new Rng(this.seed);
        this.mismatches = [];
    }

    next(label = 'next', context = null) {
        const generated = this.rng.next();
        let raw = generated;
        const expected = this.recorded[this.cursor];
        if (this.mode === 'replay' && expected) {
            raw = expected.raw >>> 0;
            if (expected.label !== label) {
                this.mismatches.push({
                    sequence: this.cursor + 1,
                    expected: expected.label,
                    observed: label,
                });
            }
        } else if (this.mode === 'replay') {
            this.mismatches.push({ sequence: this.cursor + 1, expected: null, observed: label });
        }

        const item = {
            sequence: this.cursor + 1,
            stream: this.stream,
            label,
            raw: raw >>> 0,
            atMs: this.clock && this.startedAt !== null ? this.clock.now() - this.startedAt : null,
            context: safeContext(context),
        };
        this.observed.push(item);
        if (this.mode === 'record') this.recorded.push(item);
        this.cursor += 1;
        return raw >>> 0;
    }

    _annotate(value) {
        const item = this.observed[this.observed.length - 1];
        item.value = safeContext(value);
        if (this.mode === 'record') {
            this.recorded[this.recorded.length - 1].value = item.value;
        } else {
            const expected = this.recorded[this.cursor - 1];
            if (expected && Object.hasOwn(expected, 'value')
                && JSON.stringify(expected.value) !== JSON.stringify(item.value)) {
                this.mismatches.push({
                    sequence: this.cursor,
                    expectedValue: expected.value,
                    observedValue: item.value,
                });
            }
        }
        return value;
    }

    float(label, context) {
        return this._annotate(this.next(label, context) / 4294967296);
    }

    int(maxExclusive, label, context) {
        if (!Number.isInteger(maxExclusive) || maxExclusive < 1) return 0;
        return this._annotate(this.next(label, context) % maxExclusive);
    }

    range(min, max, label, context) {
        const width = Math.max(1, max - min + 1);
        return this._annotate(min + (this.next(label, context) % width));
    }

    pick(array, label, context) {
        return this._annotate(array[this.next(label, context) % array.length]);
    }

    chance(probability, label, context) {
        return this._annotate(this.next(label, context) / 4294967296 < probability);
    }

    export() { return this.recorded.map((item) => ({ ...item })); }
}

class DecisionStreams {
    constructor({ seed = 1, decisions = null, clock = null } = {}) {
        this.seed = seed;
        this.source = decisions;
        this.clock = clock;
        this.startedAt = clock ? clock.now() : null;
        this.streams = new Map();
    }

    stream(name) {
        if (!this.streams.has(name)) {
            const replay = this.source === null ? null : (this.source[name] || []);
            this.streams.set(name, new DecisionTape({
                seed: this.seed,
                stream: name,
                decisions: replay,
                clock: this.clock,
                startedAt: this.startedAt,
            }));
        }
        return this.streams.get(name);
    }

    export() {
        return Object.fromEntries([...this.streams].map(([name, tape]) => [name, tape.export()]));
    }

    diagnostics() {
        return Object.fromEntries([...this.streams].map(([name, tape]) => [name, {
            mode: tape.mode,
            consumed: tape.cursor,
            available: tape.recorded.length,
            exact: tape.mismatches.length === 0 && (tape.mode === 'record' || tape.cursor === tape.recorded.length),
            mismatches: tape.mismatches.slice(),
        }]));
    }
}

module.exports = { DecisionTape, DecisionStreams, deriveSeed };
