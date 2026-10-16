#!/usr/bin/env node
'use strict';

/**
 * node-main.js — one Multi-Raft process (IV-B.0).
 *
 *   MR_NODE_ID=n1 MR_PORT=17101 MR_ORIGINS=http://127.0.0.1:17101,http://127.0.0.1:17102,http://127.0.0.1:17103 \
 *   MR_DATA_DIR=.bench-data/mr/n1 MR_BOUNDARIES=h,p MR_PROFILE=optimized-http node packages/multi-raft/node-main.js
 *
 * Hosts a replica of every static range (r1..rN from MR_BOUNDARIES) on one
 * HTTP listener. Each range replica keeps its own Raft state and log under
 * <MR_DATA_DIR>/<rangeId>/, fsynced by the unchanged engine.
 */

const fs = require('fs');
const path = require('path');
const { RangeDirectory, staticDescriptors } = require('./descriptors');
const { MultiRaftNode } = require('./multi-raft-node');
const { createMultiRaftServer } = require('./http-server');
const { PROFILES } = require('../../replica/raft-profiles');

function main() {
    const nodeId = process.env.MR_NODE_ID;
    const port = Number(process.env.MR_PORT);
    const origins = (process.env.MR_ORIGINS || '').split(',').filter(Boolean);
    const dataDir = path.resolve(process.env.MR_DATA_DIR || `.bench-data/multi-raft/${nodeId}`);
    const boundaries = (process.env.MR_BOUNDARIES || 'h,p').split(',').filter(Boolean);
    const profileName = process.env.MR_PROFILE || 'optimized-http';
    if (!nodeId || !port || origins.length < 1) throw new Error('MR_NODE_ID, MR_PORT and MR_ORIGINS are required');
    const profile = PROFILES[profileName];
    if (!profile) throw new Error(`unknown MR_PROFILE ${profileName}`);
    if (profile.wire) throw new Error(`IV-B.0 runs the HTTP transport only; ${profileName} selects ${profile.wire}`);
    const nodeIds = origins.map((_, i) => `n${i + 1}`);
    const origin = origins[nodeIds.indexOf(nodeId)];
    if (!origin) throw new Error(`MR_NODE_ID ${nodeId} is not one of ${nodeIds.join(', ')}`);

    const directory = new RangeDirectory(staticDescriptors({ boundaries, replicas: nodeIds }));
    const node = new MultiRaftNode({
        nodeId,
        origin,
        memberOrigins: origins,
        directory,
        storageFor: (rangeId) => {
            const dir = path.join(dataDir, rangeId);
            fs.mkdirSync(dir, { recursive: true });
            return { storagePath: path.join(dir, 'raft-state.json') };
        },
        raftOptions: { ...profile },
    });
    const server = createMultiRaftServer(node);
    server.keepAliveTimeout = 60000;
    server.listen(port, '127.0.0.1', () => {
        process.stdout.write(`[multi-raft ${nodeId}] listening on ${origin}; ranges ${[...node.groups.keys()].join(',')}; profile ${profileName}\n`);
    });
    const shutdown = () => { node.stop(); server.close(() => process.exit(0)); };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
}

main();
