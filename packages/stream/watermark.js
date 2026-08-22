'use strict';

const { EVENT_TYPES, createEvent, jsonSafe, validateEvent } = require('../protocol/events');

const LATE_POLICIES = Object.freeze({
    DROP: 'drop',
    SIDE_OUTPUT: 'side-output',
    UPDATE: 'update',
});

const WATERMARK_EVENTS = Object.freeze({
    ADVANCED: EVENT_TYPES.STREAM_WATERMARK_ADVANCED,
    PARTITION_IDLE: EVENT_TYPES.STREAM_PARTITION_IDLE,
    WINDOW_EMITTED: EVENT_TYPES.STREAM_WINDOW_EMITTED,
    LATE_RECORD: EVENT_TYPES.STREAM_LATE_RECORD,
});

function assertPositive(value, name) {
    if (!Number.isFinite(value) || value <= 0) throw new TypeError(`${name} must be positive`);
}

function normalizeWindow(window) {
    if (!window || typeof window !== 'object') throw new TypeError('window configuration is required');
    if (window.type !== 'tumbling' && window.type !== 'sliding') {
        throw new TypeError('window.type must be tumbling or sliding');
    }
    assertPositive(window.sizeMs, 'window.sizeMs');
    const slideMs = window.type === 'tumbling' ? window.sizeMs : window.slideMs;
    assertPositive(slideMs, 'window.slideMs');
    if (window.type === 'sliding' && slideMs > window.sizeMs) {
        throw new TypeError('window.slideMs cannot exceed window.sizeMs');
    }
    return Object.freeze({ type: window.type, sizeMs: window.sizeMs, slideMs });
}

function assignWindows(eventTimeMs, window) {
    if (!Number.isFinite(eventTimeMs)) throw new TypeError('eventTimeMs must be finite');
    const latestStart = Math.floor(eventTimeMs / window.slideMs) * window.slideMs;
    const assigned = [];
    for (let startMs = latestStart; startMs + window.sizeMs > eventTimeMs; startMs -= window.slideMs) {
        assigned.push(Object.freeze({ startMs, endMs: startMs + window.sizeMs }));
    }
    return assigned.sort((left, right) => left.startMs - right.startMs);
}

function normalizeAggregate(aggregate) {
    const candidate = aggregate || {
        initial: () => 0,
        add: (count) => count + 1,
        result: (count) => count,
    };
    for (const name of ['initial', 'add', 'result']) {
        if (typeof candidate[name] !== 'function') throw new TypeError(`aggregate.${name} must be a function`);
    }
    return candidate;
}

function windowId({ startMs, endMs }) {
    return `${startMs}:${endMs}`;
}

class EventTimeWindowProcessor {
    constructor({
        partitions,
        clock,
        rng = null,
        allowedLatenessMs = 0,
        idleTimeoutMs = 60_000,
        window,
        latePolicy = LATE_POLICIES.DROP,
        windowRetentionMs = 60_000,
        aggregate = null,
        recorder = null,
        runId = 'stream-watermark',
    } = {}) {
        if (!Number.isInteger(partitions) || partitions < 1) {
            throw new TypeError('partitions must be a positive integer');
        }
        if (!clock || typeof clock.now !== 'function' || typeof clock.setTimeout !== 'function' ||
            typeof clock.clearTimeout !== 'function') {
            throw new TypeError('EventTimeWindowProcessor requires an injected timer-capable clock');
        }
        if (rng !== null && typeof rng.next !== 'function') throw new TypeError('rng must expose next()');
        if (!Number.isFinite(allowedLatenessMs) || allowedLatenessMs < 0) {
            throw new TypeError('allowedLatenessMs must be non-negative');
        }
        assertPositive(idleTimeoutMs, 'idleTimeoutMs');
        if (windowRetentionMs !== Infinity && (!Number.isFinite(windowRetentionMs) || windowRetentionMs < 0)) {
            throw new TypeError('windowRetentionMs must be non-negative or Infinity');
        }
        if (!Object.values(LATE_POLICIES).includes(latePolicy)) {
            throw new TypeError(`latePolicy must be ${Object.values(LATE_POLICIES).join(', ')}`);
        }
        if (recorder !== null && typeof recorder.record !== 'function') {
            throw new TypeError('recorder must expose record()');
        }

        this.clock = clock;
        this.rng = rng;
        this.allowedLatenessMs = allowedLatenessMs;
        this.idleTimeoutMs = idleTimeoutMs;
        this.window = normalizeWindow(window);
        this.latePolicy = latePolicy;
        this.windowRetentionMs = windowRetentionMs;
        this.aggregate = normalizeAggregate(aggregate);
        this.recorder = recorder;
        this.runId = runId;
        this.startedAt = clock.now();
        this.sequence = 0;
        this.events = [];
        this.streamWatermark = -Infinity;
        this.windows = new Map();
        this.emissions = [];
        this.pendingEmissions = [];
        this.sideOutput = [];
        this.metrics = {
            lateRecords: 0,
            droppedLateRecords: 0,
            sideOutputRecords: 0,
            updatedLateRecords: 0,
            updateMisses: 0,
            emittedWindows: 0,
            correctedEmissions: 0,
            idleTransitions: 0,
        };
        this.partitionStates = Array.from({ length: partitions }, (_, partition) => ({
            partition,
            maxSeenEventTime: -Infinity,
            watermark: -Infinity,
            lastActivityMs: clock.now(),
            seen: false,
            idle: false,
            idleTimer: null,
        }));
        for (const state of this.partitionStates) this._scheduleIdle(state);
    }

    _record(type, details = {}) {
        const event = this.recorder
            ? this.recorder.record(type, details)
            : createEvent({
                runId: this.runId,
                sequence: ++this.sequence,
                epochMs: this.clock.now(),
                startedAt: this.startedAt,
                type,
                ...details,
            });
        const validation = validateEvent(event);
        if (!validation.ok) throw new Error(`invalid causal event: ${validation.errors.join(', ')}`);
        this.events.push(event);
        return event;
    }

    _scheduleIdle(state) {
        if (state.idleTimer !== null) this.clock.clearTimeout(state.idleTimer);
        const activity = state.lastActivityMs;
        state.idleTimer = this.clock.setTimeout(() => {
            if (state.lastActivityMs !== activity || state.idle) return;
            state.idle = true;
            state.idleTimer = null;
            this.metrics.idleTransitions += 1;
            this._record(WATERMARK_EVENTS.PARTITION_IDLE, {
                source: { component: 'watermark-generator' },
                subject: { kind: 'stream-partition', partition: state.partition },
                data: { idle: true, lastActivityMs: state.lastActivityMs, watermark: state.watermark },
            });
            this._recomputeStreamWatermark();
        }, this.idleTimeoutMs);
    }

    _touchPartition(partition, eventTimeMs) {
        const state = this.partitionStates[partition];
        if (!state) throw new RangeError(`invalid partition ${partition}`);
        if (state.idle) {
            state.idle = false;
            this._record(WATERMARK_EVENTS.PARTITION_IDLE, {
                source: { component: 'watermark-generator' },
                subject: { kind: 'stream-partition', partition },
                data: { idle: false, eventTimeMs },
            });
        }
        state.seen = true;
        state.lastActivityMs = this.clock.now();
        state.maxSeenEventTime = Math.max(state.maxSeenEventTime, eventTimeMs);
        const previous = state.watermark;
        state.watermark = Math.max(state.watermark, state.maxSeenEventTime - this.allowedLatenessMs);
        this._scheduleIdle(state);
        if (state.watermark > previous) {
            this._record(WATERMARK_EVENTS.ADVANCED, {
                source: { component: 'watermark-generator' },
                subject: { kind: 'stream-partition', partition },
                data: { scope: 'partition', from: previous, to: state.watermark, maxSeenEventTime: state.maxSeenEventTime },
            });
        }
        this._recomputeStreamWatermark();
    }

    _recomputeStreamWatermark() {
        const active = this.partitionStates.filter((state) => !state.idle);
        if (active.length === 0) return this.streamWatermark;
        const candidate = Math.min(...active.map((state) => state.watermark));
        if (candidate > this.streamWatermark) {
            const previous = this.streamWatermark;
            this.streamWatermark = candidate;
            this._record(WATERMARK_EVENTS.ADVANCED, {
                source: { component: 'watermark-generator' },
                subject: { kind: 'stream' },
                data: {
                    scope: 'stream',
                    from: previous,
                    to: candidate,
                    activePartitions: active.map((state) => state.partition),
                },
            });
            this._emitEligibleWindows();
            this._purgeExpiredWindows();
        }
        return this.streamWatermark;
    }

    _newWindow(descriptor) {
        const state = {
            ...descriptor,
            accumulator: this.aggregate.initial(descriptor),
            records: [],
            emitted: false,
            lastResult: null,
        };
        this.windows.set(windowId(descriptor), state);
        return state;
    }

    _add(window, record) {
        const next = this.aggregate.add(window.accumulator, record);
        if (next !== undefined) window.accumulator = next;
        window.records.push(record);
    }

    _emit(window, kind) {
        const result = jsonSafe(this.aggregate.result(window.accumulator, {
            startMs: window.startMs,
            endMs: window.endMs,
            records: window.records.slice(),
        }));
        const emission = Object.freeze({
            kind,
            window: Object.freeze({ startMs: window.startMs, endMs: window.endMs }),
            result,
            watermark: this.streamWatermark,
            processingTimeMs: this.clock.now(),
        });
        window.emitted = true;
        window.lastResult = result;
        this.emissions.push(emission);
        this.pendingEmissions.push(emission);
        if (kind === 'initial') this.metrics.emittedWindows += 1;
        else this.metrics.correctedEmissions += 1;
        this._record(WATERMARK_EVENTS.WINDOW_EMITTED, {
            source: { component: 'event-time-window' },
            subject: { kind: 'event-time-window', startMs: window.startMs, endMs: window.endMs },
            data: emission,
        });
        return emission;
    }

    _emitEligibleWindows() {
        const ordered = [...this.windows.values()].sort((left, right) =>
            left.endMs - right.endMs || left.startMs - right.startMs);
        for (const window of ordered) {
            // Equality is not enough: a watermark T only rules out event times
            // strictly below T, so a window ending at T can still receive T.
            if (!window.emitted && this.streamWatermark > window.endMs) this._emit(window, 'initial');
        }
    }

    _purgeExpiredWindows() {
        if (this.windowRetentionMs === Infinity) return;
        for (const [id, window] of this.windows) {
            if (window.emitted && this.streamWatermark > window.endMs + this.windowRetentionMs) {
                this.windows.delete(id);
            }
        }
    }

    ingest(input) {
        if (!input || typeof input !== 'object') throw new TypeError('record must be an object');
        const { partition, eventTimeMs } = input;
        if (!Number.isInteger(partition) || !this.partitionStates[partition]) {
            throw new RangeError(`invalid partition ${partition}`);
        }
        if (!Number.isFinite(eventTimeMs)) throw new TypeError('eventTimeMs must be finite');
        const record = Object.freeze({
            ...jsonSafe(input),
            eventTimeMs,
            processingTimeMs: this.clock.now(),
        });

        this._touchPartition(partition, eventTimeMs);
        const descriptors = assignWindows(eventTimeMs, this.window);
        const closed = descriptors.filter((descriptor) => this.streamWatermark > descriptor.endMs);
        const open = descriptors.filter((descriptor) => this.streamWatermark <= descriptor.endMs);
        for (const descriptor of open) {
            const window = this.windows.get(windowId(descriptor)) || this._newWindow(descriptor);
            this._add(window, record);
        }

        let corrected = 0;
        let missed = 0;
        if (closed.length > 0) {
            this.metrics.lateRecords += 1;
            if (this.latePolicy === LATE_POLICIES.DROP) {
                this.metrics.droppedLateRecords += 1;
            } else if (this.latePolicy === LATE_POLICIES.SIDE_OUTPUT) {
                this.metrics.sideOutputRecords += 1;
                this.sideOutput.push(Object.freeze({ record, windows: closed }));
            } else {
                for (const descriptor of closed) {
                    const window = this.windows.get(windowId(descriptor));
                    if (!window || !window.emitted) {
                        missed += 1;
                        continue;
                    }
                    this._add(window, record);
                    this._emit(window, 'update');
                    corrected += 1;
                }
                if (corrected > 0) this.metrics.updatedLateRecords += 1;
                if (missed > 0) this.metrics.updateMisses += 1;
            }
            this._record(WATERMARK_EVENTS.LATE_RECORD, {
                source: { component: 'event-time-window' },
                subject: { kind: 'stream-record', partition, offset: input.offset ?? null },
                data: {
                    policy: this.latePolicy,
                    eventTimeMs,
                    processingTimeMs: record.processingTimeMs,
                    watermark: this.streamWatermark,
                    windows: closed,
                    corrected,
                    missed,
                },
            });
        }
        this._emitEligibleWindows();
        this._purgeExpiredWindows();
        return {
            late: closed.length > 0,
            watermark: this.streamWatermark,
            windows: descriptors,
            processingTimeMs: record.processingTimeMs,
            corrected,
        };
    }

    watermark() {
        return this.streamWatermark;
    }

    partitionWatermark(partition) {
        const state = this.partitionStates[partition];
        if (!state) throw new RangeError(`invalid partition ${partition}`);
        return state.watermark;
    }

    getWindow(startMs, endMs) {
        const window = this.windows.get(windowId({ startMs, endMs }));
        if (!window) return null;
        return {
            startMs: window.startMs,
            endMs: window.endMs,
            emitted: window.emitted,
            result: window.emitted ? window.lastResult : jsonSafe(this.aggregate.result(window.accumulator, {
                startMs: window.startMs,
                endMs: window.endMs,
                records: window.records.slice(),
            })),
            recordCount: window.records.length,
        };
    }

    drainEmissions() {
        const pending = this.pendingEmissions.slice();
        this.pendingEmissions.length = 0;
        return pending;
    }

    close() {
        for (const state of this.partitionStates) {
            if (state.idleTimer !== null) this.clock.clearTimeout(state.idleTimer);
            state.idleTimer = null;
        }
    }
}

module.exports = {
    EventTimeWindowProcessor,
    LATE_POLICIES,
    WATERMARK_EVENTS,
    assignWindows,
};
