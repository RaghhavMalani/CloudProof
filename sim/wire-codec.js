'use strict';

/**
 * wire-codec.js — puts the framed binary codec on the simulated wire.
 *
 * The simulator cannot open real sockets, but it can make every RPC travel
 * the way the framed TCP transport would carry it: request encoded to a
 * frame, decoded on arrival; response the same on the way back. Any field the
 * protocol relies on that the codec dropped, reordered or changed would then
 * surface as a violation in the ordinary fault campaigns, with a replayable
 * seed. Node-only (Buffer), so it lives outside the browser-bundled cluster.
 */

const { ROUTE_TYPES, encodeRequest, encodeResponse, decodeBody, FrameDecoder } = require('../replica/raft-codec');

function throughFrames(frame) {
    const frames = new FrameDecoder().push(frame);
    if (frames.length !== 1) throw new Error(`expected one frame, decoded ${frames.length}`);
    return decodeBody(frames[0].type, frames[0].body);
}

function codecTransport(inner) {
    let stream = 0;
    return {
        post(url, body, options) {
            const type = ROUTE_TYPES[new URL(url).pathname];
            if (!type) return inner.post(url, body, options);
            stream = (stream % 0xfffffffe) + 1;
            const decoded = throughFrames(encodeRequest(type, body, stream));
            return inner.post(url, decoded, options).then((response) => ({
                data: throughFrames(encodeResponse(type, response.data, stream)),
            }));
        },
    };
}

/** SimCluster `wrapTransport` for a resolved profile, or null. */
function wireFor(raftOptions) {
    return raftOptions && raftOptions.wire === 'framed-tcp' ? codecTransport : null;
}

module.exports = { codecTransport, wireFor };
