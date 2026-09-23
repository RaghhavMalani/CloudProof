'use strict';

// Worker-thread entry for the causal corpus pool. Each message carries a chunk
// of indices; results go back in the same order so the parent can flush them
// strictly by index and keep every output file byte-identical across runs.

const { parentPort, workerData } = require('node:worker_threads');
const { executeCausalTrajectory, executeCounterfactualPair } = require('./cloud-causal-corpus');

parentPort.on('message', async (message) => {
    try {
        const results = [];
        for (const index of message.indices) {
            results.push(workerData.task === 'pair'
                ? await executeCounterfactualPair(index, workerData.config)
                : await executeCausalTrajectory(index, workerData.config, workerData.wantRows));
        }
        parentPort.postMessage({ chunkId: message.chunkId, results });
    } catch (error) {
        parentPort.postMessage({ chunkId: message.chunkId, error: error.stack || String(error) });
    }
});
