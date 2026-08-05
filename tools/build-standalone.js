#!/usr/bin/env node
/**
 * build-standalone.js — one HTML file with everything inlined.
 *
 * `web/index.html` + `web/bundle.js` is the right shape for a host, because the
 * bundle caches separately. But a single file that runs by double-clicking it
 * has a use the two-file version does not: it can be emailed, attached to an
 * application, dropped in a Slack message, or opened with no server at all.
 * `file://` blocks a lot of things — module imports, fetch, workers — but a
 * plain inline script is not one of them.
 *
 *   node tools/build-standalone.js   →   web/standalone.html
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// Comments are ~40% of the source here, and they are written for people reading
// the repository, not for a browser. Stripping them for the inlined copy takes
// 150KB to 92KB. Deliberately conservative: this only removes whole-line `//`
// comments and block comments, and does not touch anything else. It is not a
// minifier and must not become one — a bug introduced by a clever transform
// would be invisible and would only manifest in the demo.
function stripComments(source) {
    return source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
        .replace(/\n{3,}/g, '\n\n');
}

const bundlePath = path.join(ROOT, 'web', 'bundle.js');
if (!fs.existsSync(bundlePath)) {
    console.error('run `node tools/build-web.js` first');
    process.exit(1);
}

const bundle = stripComments(fs.readFileSync(bundlePath, 'utf8'));
const html = fs.readFileSync(path.join(ROOT, 'web', 'index.html'), 'utf8');

// The external script tag becomes an inline one. Nothing else about the page
// changes, so what ships is what was tested.
const standalone = html.replace(
    '<script src="bundle.js"></script>',
    `<script>\n${bundle}\n</script>`,
);

if (standalone === html) {
    console.error('could not find the bundle script tag — did index.html change?');
    process.exit(1);
}

const out = path.join(ROOT, 'web', 'standalone.html');
fs.writeFileSync(out, standalone);

console.log(`wrote ${out}`);
console.log(`  ${(standalone.length / 1024).toFixed(0)}KB, single file, no server needed`);
console.log('  open it by double-clicking, or drag it into a browser tab');
