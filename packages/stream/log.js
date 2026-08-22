'use strict';

const { EVENT_TYPES, createEvent, jsonSafe, validateEvent } = require('../protocol/events');

const DELIVERY_MODES = Object.freeze({
    AT_LEAST_ONCE: 'at-least-once',
    EXACTLY_ONCE: 'exactly-once',
});

const STREAM_EVENTS = Object.freeze({
    RECORD_APPENDED: EVENT_TYPES.STREAM_RECORD_APPENDED,
    RECORD_DELIVERED: EVENT_TYPES.STREAM_RECORD_DELIVERED,
    OFFSET_COMMITTED: EVENT_TYPES.STREAM_OFFSET_COMMITTED,
    GROUP_REBALANCED: EVENT_TYPES.STREAM_GROUP_REBALANCED,
    RETENTION_TRUNCATED: EVENT_TYPES.STREAM_RETENTION_TRUNCATED,
    EFFECT_APPLIED: EVENT_TYPES.STREAM_EFFECT_APPLIED,
});

class OffsetOutOfRangeError extends RangeError {
    constructor({ topic, partition, offset, earliestOffset, latestOffset }) {
        super(`offset ${offset} for ${topic}[${partition}] is outside retained range ` +
            `[${earliestOffset}, ${latestOffset}]`);
        this.name = 'OffsetOutOfRangeError';
        this.code = 'OFFSET_OUT_OF_RANGE';
        this.topic = topic;
        this.partition = partition;
        this.offset = offset;
        this.earliestOffset = earliestOffset;
        this.latestOffset = latestOffset;
    }
}

function assertPositiveInteger(value, name) {
    if (!Number.isInteger(value) || value < 1) throw new TypeError(`${name} must be a positive integer`);
}

function normalizeRetention(retention = {}) {
    const out = {
        maxRecords: retention.maxRecords ?? Infinity,
        maxBytes: retention.maxBytes ?? Infinity,
    };
    for (const [name, value] of Object.entries(out)) {
        if (value !== Infinity && (!Number.isInteger(value) || value < 1)) {
            throw new TypeError(`retention.${name} must be a positive integer or Infinity`);
        }
    }
    return Object.freeze(out);
}

function deepFreeze(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    for (const child of Object.values(value)) deepFreeze(child);
    return Object.freeze(value);
}

function stableKey(key) {
    if (key === undefined || key === null) throw new TypeError('record key is required');
    return JSON.stringify(jsonSafe(key));
}

/** FNV-1a over UTF-16 code units is deterministic on every supported Node version. */
function hashKey(key) {
    const input = stableKey(key);
    let hash = 2166136261;
    for (let index = 0; index < input.length; index += 1) {
        hash ^= input.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}

function serializedBytes(value) {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function normalizeConsumers(consumers, { allowEmpty = false } = {}) {
    let ids;
    if (Number.isInteger(consumers)) {
        if (consumers < (allowEmpty ? 0 : 1)) {
            throw new TypeError(`consumers must be ${allowEmpty ? 'non-negative' : 'positive'}`);
        }
        ids = Array.from({ length: consumers }, (_, index) => `consumer-${index}`);
    } else if (Array.isArray(consumers)) {
        ids = consumers.map((id) => String(id));
        if (!allowEmpty && ids.length === 0) throw new TypeError('at least one consumer is required');
    } else {
        throw new TypeError('consumers must be a count or an array of ids');
    }
    if (ids.some((id) => id.length === 0) || new Set(ids).size !== ids.length) {
        throw new TypeError('consumer ids must be non-empty and unique');
    }
    return ids;
}

function validateDelivery(delivery) {
    if (!Object.values(DELIVERY_MODES).includes(delivery)) {
        throw new TypeError(`delivery must be ${Object.values(DELIVERY_MODES).join(' or ')}`);
    }
}

class EventLog {
    constructor({
        partitions = 1,
        retention = {},
        clock,
        rng = null,
        recorder = null,
        runId = 'stream-log',
    } = {}) {
        assertPositiveInteger(partitions, 'partitions');
        if (!clock || typeof clock.now !== 'function') throw new TypeError('EventLog requires an injected clock');
        if (rng !== null && typeof rng.next !== 'function') throw new TypeError('rng must expose next()');
        if (recorder !== null && typeof recorder.record !== 'function') {
            throw new TypeError('recorder must expose record()');
        }
        this.defaultPartitions = partitions;
        this.defaultRetention = normalizeRetention(retention);
        this.clock = clock;
        this.rng = rng;
        this.recorder = recorder;
        this.runId = runId;
        this.startedAt = clock.now();
        this.sequence = 0;
        this.events = [];
        this.topics = new Map();
        this.groups = new Map();
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

    createTopic(name, { partitions = this.defaultPartitions, retention = this.defaultRetention } = {}) {
        if (typeof name !== 'string' || name.length === 0) throw new TypeError('topic name is required');
        assertPositiveInteger(partitions, 'partitions');
        if (this.topics.has(name)) {
            const existing = this.topics.get(name);
            if (existing.partitions.length !== partitions) {
                throw new Error(`topic ${name} already exists with ${existing.partitions.length} partitions`);
            }
            return existing;
        }
        const topic = {
            name,
            retention: normalizeRetention(retention),
            partitions: Array.from({ length: partitions }, () => ({
                records: [],
                baseOffset: 0,
                nextOffset: 0,
                bytes: 0,
            })),
        };
        this.topics.set(name, topic);
        return topic;
    }

    _topic(name) {
        const topic = this.topics.get(name);
        if (!topic) throw new Error(`unknown topic: ${name}`);
        return topic;
    }

    partitionFor(topicName, key) {
        const count = this.topics.get(topicName)?.partitions.length ?? this.defaultPartitions;
        return hashKey(key) % count;
    }

    append(topicName, { key, value, eventTimeMs }) {
        if (!Number.isFinite(eventTimeMs)) throw new TypeError('eventTimeMs must be finite');
        const topic = this.topics.get(topicName) || this.createTopic(topicName);
        const partition = this.partitionFor(topicName, key);
        const state = topic.partitions[partition];
        const safeKey = deepFreeze(jsonSafe(key));
        const safeValue = deepFreeze(jsonSafe(value));
        const offset = state.nextOffset;
        const recordBody = {
            topic: topicName,
            partition,
            offset,
            key: safeKey,
            value: safeValue,
            eventTimeMs,
            processingTimeMs: this.clock.now(),
        };
        const record = deepFreeze({
            ...recordBody,
            sizeBytes: serializedBytes(recordBody),
        });
        state.records.push(record);
        state.nextOffset += 1;
        state.bytes += record.sizeBytes;

        this._record(STREAM_EVENTS.RECORD_APPENDED, {
            source: { component: 'event-log' },
            subject: { kind: 'stream-record', topic: topicName, partition, offset },
            data: record,
        });
        this._applyRetention(topic, partition);
        return { partition, offset };
    }

    _applyRetention(topic, partition) {
        const state = topic.partitions[partition];
        let removedRecords = 0;
        let removedBytes = 0;
        const fromOffset = state.baseOffset;
        while (state.records.length > topic.retention.maxRecords || state.bytes > topic.retention.maxBytes) {
            const removed = state.records.shift();
            removedRecords += 1;
            removedBytes += removed.sizeBytes;
            state.bytes -= removed.sizeBytes;
            state.baseOffset = removed.offset + 1;
        }
        if (removedRecords > 0) {
            this._record(STREAM_EVENTS.RETENTION_TRUNCATED, {
                source: { component: 'event-log' },
                subject: { kind: 'stream-partition', topic: topic.name, partition },
                data: {
                    fromOffset,
                    toOffset: state.baseOffset,
                    removedRecords,
                    removedBytes,
                },
            });
        }
    }

    read(topicName, partition, offset, { maxRecords = Infinity } = {}) {
        const topic = this._topic(topicName);
        if (!Number.isInteger(partition) || partition < 0 || partition >= topic.partitions.length) {
            throw new RangeError(`invalid partition ${partition} for topic ${topicName}`);
        }
        if (!Number.isInteger(offset) || offset < 0) throw new TypeError('offset must be a non-negative integer');
        if (maxRecords !== Infinity && (!Number.isInteger(maxRecords) || maxRecords < 1)) {
            throw new TypeError('maxRecords must be a positive integer or Infinity');
        }
        const state = topic.partitions[partition];
        if (offset < state.baseOffset || offset > state.nextOffset) {
            throw new OffsetOutOfRangeError({
                topic: topicName,
                partition,
                offset,
                earliestOffset: state.baseOffset,
                latestOffset: state.nextOffset,
            });
        }
        if (offset === state.nextOffset) return [];
        const start = offset - state.baseOffset;
        return state.records.slice(start, maxRecords === Infinity ? undefined : start + maxRecords);
    }

    offsets(topicName, partition) {
        const topic = this._topic(topicName);
        const state = topic.partitions[partition];
        if (!state) throw new RangeError(`invalid partition ${partition} for topic ${topicName}`);
        return { earliest: state.baseOffset, latest: state.nextOffset };
    }

    subscribe(topicName, {
        groupId,
        consumers = 1,
        delivery = DELIVERY_MODES.AT_LEAST_ONCE,
    } = {}) {
        const topic = this._topic(topicName);
        if (typeof groupId !== 'string' || groupId.length === 0) throw new TypeError('groupId is required');
        validateDelivery(delivery);
        const key = `${topicName}\u0000${groupId}`;
        if (this.groups.has(key)) {
            const group = this.groups.get(key);
            if (group.delivery !== delivery) throw new Error(`group ${groupId} already uses ${group.delivery}`);
            group.rebalance({ consumers });
            return group;
        }
        const group = new ConsumerGroup({ log: this, topic, groupId, consumers, delivery });
        this.groups.set(key, group);
        return group;
    }
}

class ConsumerGroup {
    constructor({ log, topic, groupId, consumers, delivery }) {
        this.log = log;
        this.topic = topic;
        this.groupId = groupId;
        this.delivery = delivery;
        this.consumerIds = [];
        this.generation = 0;
        this.assignments = new Map();
        this.positions = new Map();
        this.committedOffsets = new Map(topic.partitions.map((partition, index) => [index, partition.baseOffset]));
        this.effects = new Map();
        this.rebalance({ consumers });
    }

    _resetPositions() {
        this.positions = new Map(this.committedOffsets);
    }

    rebalance({ consumers = this.consumerIds } = {}) {
        const ids = normalizeConsumers(consumers, { allowEmpty: true });
        const previousAssignments = Object.fromEntries(this.assignments);
        this.consumerIds = ids;
        this.assignments = new Map();
        for (let partition = 0; partition < this.topic.partitions.length; partition += 1) {
            if (ids.length > 0) this.assignments.set(partition, ids[partition % ids.length]);
        }
        // A rebalance discards volatile fetch positions. Only committed offsets
        // survive ownership changes, which is exactly where at-least-once
        // redelivery comes from after a process-before-commit crash.
        this._resetPositions();
        this.generation += 1;
        this.log._record(STREAM_EVENTS.GROUP_REBALANCED, {
            source: { component: 'consumer-group', groupId: this.groupId },
            subject: { kind: 'consumer-group', topic: this.topic.name, groupId: this.groupId },
            data: {
                generation: this.generation,
                consumers: ids,
                previousAssignments,
                assignments: Object.fromEntries(this.assignments),
                committedOffsets: Object.fromEntries(this.committedOffsets),
            },
        });
        return Object.fromEntries(this.assignments);
    }

    join(consumerId) {
        return this.rebalance({ consumers: [...this.consumerIds, String(consumerId)] });
    }

    leave(consumerId) {
        const id = String(consumerId);
        return this.rebalance({ consumers: this.consumerIds.filter((candidate) => candidate !== id) });
    }

    poll({ maxRecords = 100 } = {}) {
        assertPositiveInteger(maxRecords, 'maxRecords');
        const batch = [];
        Object.defineProperties(batch, {
            groupId: { value: this.groupId, enumerable: false },
            topic: { value: this.topic.name, enumerable: false },
            generation: { value: this.generation, enumerable: false },
        });
        for (let partition = 0; partition < this.topic.partitions.length && batch.length < maxRecords; partition += 1) {
            const consumerId = this.assignments.get(partition);
            if (consumerId === undefined) continue;
            const position = this.positions.get(partition);
            const records = this.log.read(this.topic.name, partition, position, {
                maxRecords: maxRecords - batch.length,
            });
            for (const record of records) {
                const delivered = deepFreeze({ ...record, consumerId, generation: this.generation });
                batch.push(delivered);
                this.log._record(STREAM_EVENTS.RECORD_DELIVERED, {
                    source: { component: 'consumer-group', groupId: this.groupId, consumerId },
                    subject: {
                        kind: 'stream-record', topic: this.topic.name,
                        partition: record.partition, offset: record.offset,
                    },
                    data: { delivery: this.delivery, generation: this.generation },
                });
            }
            this.positions.set(partition, position + records.length);
        }
        return batch;
    }

    _commitPlan(batch) {
        if (!Array.isArray(batch)) throw new TypeError('batch must be returned by poll()');
        if (batch.groupId !== undefined && batch.groupId !== this.groupId) {
            throw new Error(`batch belongs to group ${batch.groupId}, not ${this.groupId}`);
        }
        const plan = new Map();
        for (const record of batch) {
            if (record.topic !== this.topic.name) throw new Error(`batch contains topic ${record.topic}`);
            const state = this.topic.partitions[record.partition];
            if (!state || !Number.isInteger(record.offset) || record.offset < 0 || record.offset >= state.nextOffset) {
                throw new RangeError('batch contains an invalid partition or offset');
            }
            plan.set(record.partition, Math.max(plan.get(record.partition) ?? 0, record.offset + 1));
        }
        return plan;
    }

    _applyCommit(plan) {
        for (const [partition, nextOffset] of plan) {
            const previous = this.committedOffsets.get(partition);
            const committed = Math.max(previous, nextOffset);
            if (committed === previous) continue;
            this.committedOffsets.set(partition, committed);
            // A batch fetched before a rebalance may legitimately commit after
            // the new assignment is installed. Keep the volatile fetch cursor
            // at least as far forward as that durable commit or the new owner
            // would immediately redeliver an already committed record.
            this.positions.set(partition, Math.max(this.positions.get(partition) ?? 0, committed));
            this.log._record(STREAM_EVENTS.OFFSET_COMMITTED, {
                source: { component: 'consumer-group', groupId: this.groupId },
                subject: { kind: 'stream-partition', topic: this.topic.name, partition },
                data: { fromOffset: previous, toOffset: committed, generation: this.generation },
            });
        }
    }

    commit(batch) {
        this._applyCommit(this._commitPlan(batch));
        return Object.fromEntries(this.committedOffsets);
    }

    process(batch, handler, { mode = this.delivery, crashBeforeCommit = false } = {}) {
        if (typeof handler !== 'function') throw new TypeError('handler must be a function');
        validateDelivery(mode);
        const plan = this._commitPlan(batch);
        const effects = mode === DELIVERY_MODES.EXACTLY_ONCE ? new Map(this.effects) : this.effects;
        for (const record of batch) {
            const outcome = handler(record, effects);
            if (outcome && typeof outcome.then === 'function') {
                this._resetPositions();
                throw new TypeError('consumer effects must be synchronous to preserve atomicity');
            }
        }
        if (crashBeforeCommit) {
            // Exactly-once effects live in the private copy until the offset can
            // commit. At-least-once effects are already visible, making the
            // process/commit failure window deliberately observable.
            this._resetPositions();
            return { committed: false, processed: batch.length };
        }
        if (mode === DELIVERY_MODES.EXACTLY_ONCE) this.effects = effects;
        this._applyCommit(plan);
        this.log._record(STREAM_EVENTS.EFFECT_APPLIED, {
            source: { component: 'consumer-group', groupId: this.groupId },
            subject: { kind: 'consumer-effect', topic: this.topic.name, groupId: this.groupId },
            data: { delivery: mode, records: batch.length, offsets: Object.fromEntries(plan) },
        });
        return { committed: true, processed: batch.length };
    }

    committedOffset(partition) {
        if (!this.committedOffsets.has(partition)) throw new RangeError(`invalid partition ${partition}`);
        return this.committedOffsets.get(partition);
    }

    effect(key) {
        return this.effects.get(key);
    }

    effectEntries() {
        return [...this.effects.entries()];
    }
}

module.exports = {
    DELIVERY_MODES,
    STREAM_EVENTS,
    EventLog,
    ConsumerGroup,
    OffsetOutOfRangeError,
    hashKey,
};
