#!/usr/bin/env node
/**
 * make-artifact.js — builds a versioned model + index artifact set.
 *
 * The weights are synthetic: a seeded random projection matrix rather than a
 * trained encoder. That is honest about what is being measured. The numbers
 * this project reports are about *moving and materialising* a checkpoint —
 * fetch, checksum, parse, resident memory — and those costs depend on size and
 * format, not on whether the floats mean anything. Swapping in a real CLIP
 * checkpoint changes the magnitude of every phase and none of the shapes.
 *
 * Sizes are configurable precisely so the cold-start breakdown can be plotted
 * against artifact size instead of asserted at one point.
 *
 *   node tools/make-artifact.js --version v1 --dim 128 --rows 8192 --shards 3 --vectors 2000
 */

const fs = require('fs');
const path = require('path');

const { encodeMatrix, encodeShard, sha256 } = require('../serving/artifacts');

const DEFAULTS = {
    version: 'v1',
    dim: 128,
    rows: 8192,
    shards: 3,
    vectors: 2000,
    out: path.join(process.cwd(), 'artifacts'),
    seed: 1,
};

function parseArgs() {
    const options = { ...DEFAULTS };
    const argv = process.argv.slice(2);
    for (let i = 0; i < argv.length; i += 2) {
        const key = argv[i].replace(/^--/, '');
        if (!(key in options)) continue;
        const raw = argv[i + 1];
        options[key] = ['version', 'out'].includes(key) ? raw : Number(raw);
    }
    return options;
}

/** Deterministic PRNG so a given version always produces identical bytes. */
function makeRandom(seed) {
    let s = seed >>> 0;
    return () => {
        s ^= s << 13; s >>>= 0;
        s ^= s >> 17;
        s ^= s << 5; s >>>= 0;
        return (s / 0xffffffff) * 2 - 1;
    };
}

(function main() {
    const options = parseArgs();
    // Seeding from the version string is what makes v1 and v2 genuinely
    // different spaces — which is the point. If they were the same, mixing
    // versions across shards would be harmless and the rollout demo would prove
    // nothing.
    const seed = options.seed + [...options.version].reduce((a, c) => a + c.charCodeAt(0), 0);
    const random = makeRandom(seed);

    const directory = path.join(options.out, 'index', options.version);
    fs.mkdirSync(directory, { recursive: true });

    const weights = new Float32Array(options.rows * options.dim);
    for (let i = 0; i < weights.length; i += 1) weights[i] = random() * 0.05;
    const modelBuffer = encodeMatrix(options.rows, options.dim, weights);
    fs.writeFileSync(path.join(directory, 'model.bin'), modelBuffer);

    const checksums = { model: sha256(modelBuffer) };

    for (let shard = 0; shard < options.shards; shard += 1) {
        const ids = Array.from({ length: options.vectors }, (_, i) => `doc-${shard}-${i}`);
        const vectors = new Float32Array(options.vectors * options.dim);
        for (let i = 0; i < options.vectors; i += 1) {
            let norm = 0;
            for (let d = 0; d < options.dim; d += 1) {
                const value = random();
                vectors[i * options.dim + d] = value;
                norm += value * value;
            }
            norm = Math.sqrt(norm) || 1;
            for (let d = 0; d < options.dim; d += 1) vectors[i * options.dim + d] /= norm;
        }
        const shardBuffer = encodeShard(ids, options.dim, vectors);
        fs.writeFileSync(path.join(directory, `shard-${shard}.bin`), shardBuffer);
        checksums[`shard-${shard}`] = sha256(shardBuffer);
    }

    const manifest = {
        version: options.version,
        dim: options.dim,
        shards: options.shards,
        sha256: checksums,
        builtAt: new Date().toISOString(),
    };

    fs.writeFileSync(
        path.join(directory, 'manifest.json'),
        `${JSON.stringify(manifest, null, 2)}\n`,
    );

    const totalBytes = fs.readdirSync(directory)
        .reduce((sum, file) => sum + fs.statSync(path.join(directory, file)).size, 0);

    console.log(`built ${options.version} in ${directory}`);
    console.log(`  model  ${options.rows}x${options.dim}  ${(modelBuffer.length / 1e6).toFixed(1)}MB`);
    console.log(`  shards ${options.shards} x ${options.vectors} vectors`);
    console.log(`  total  ${(totalBytes / 1e6).toFixed(1)}MB`);
    console.log(`\nmanifest:\n${JSON.stringify(manifest, null, 2)}`);
})();
