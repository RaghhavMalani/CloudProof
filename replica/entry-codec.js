'use strict';

/**
 * entry-codec.js — each log entry is JSON-encoded at most once per process.
 *
 * The same entry object is encoded for the durable log record and, on a
 * leader, for every follower it is replicated to; at 16 KiB payloads the
 * repeated JSON.stringify is a measurable share of the leader's CPU. The
 * encoding is cached per entry *object* in a WeakMap, so it disappears with
 * the entry and never outlives a truncation.
 *
 * This relies on an invariant the engine already keeps: a log entry is never
 * mutated after it is appended (the state machine reads `entry.data`, it does
 * not write it). A receiver that decodes an entry from a wire format that
 * carried its JSON can prime the cache with that exact text, so a follower does
 * not re-encode what it was just sent.
 */

const cache = new WeakMap();

function entryJson(entry) {
    let json = cache.get(entry);
    if (json === undefined) {
        json = JSON.stringify(entry);
        cache.set(entry, json);
    }
    return json;
}

/** Records `json` as the encoding of `entry`. Must equal JSON.stringify(entry). */
function primeEntryJson(entry, json) {
    cache.set(entry, json);
}

/** Encoded size in UTF-16 code units (equal to bytes for ASCII payloads). */
function entryLength(entry) {
    return entryJson(entry).length;
}

module.exports = { entryJson, primeEntryJson, entryLength };
