#!/usr/bin/env node
'use strict';

/**
 * observatory-capture.js: render GNN Observatory stills with a headless
 * Chromium-family browser (Chrome, Edge or Chromium), with no npm dependencies.
 *
 * It serves web/ from an in-process static server on a free port, starts the
 * browser headless with a throwaway profile (never your own browser session) and
 * drives it over the DevTools protocol with Node's built-in WebSocket: device
 * emulation per shot, wait until the page reports its first rendered frame, then
 * screenshot. WebGL runs on the browser's software rasterizer if there is no GPU.
 * The page's ?t= parameter freezes the message-passing cycle and the camera, so
 * a capture is repeatable.
 *
 *   node tools/observatory-capture.js            # web/observatory/fallback.png
 *   node tools/observatory-capture.js --all      # plus the README / PR stills in docs/observatory/
 *   node tools/observatory-capture.js --browser "C:\...\msedge.exe" --shot out.png --query "mode=no-edges&t=2" --size 1280x800
 */

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, 'web');
const SHOTS_DIR = path.join(ROOT, 'docs', 'observatory');

// The fallback is what a browser without WebGL shows in place of the 3D view, so
// it is the stage alone (?capture=stage).
const FALLBACK = { file: path.join(WEB, 'observatory', 'fallback.png'), query: 'capture=stage&frame=best&mode=full&graph=B&t=1.25&az=18', size: [1400, 900] };
const STILLS = [
    { file: path.join(SHOTS_DIR, 'observatory-full.png'), query: 'frame=best&mode=full&graph=B&t=1.25&az=18', size: [1600, 1000] },
    { file: path.join(SHOTS_DIR, 'observatory-readout.png'), query: 'frame=best&mode=full&graph=B&t=6.95&az=18', size: [1600, 1000] },
    { file: path.join(SHOTS_DIR, 'observatory-no-edges.png'), query: 'frame=best&mode=no-edges&graph=B&t=6.95&az=18', size: [1600, 1000] },
    { file: path.join(SHOTS_DIR, 'observatory-rewired.png'), query: 'frame=best&mode=rewired-edges&graph=B&t=1.25&az=18', size: [1600, 1000] },
    { file: path.join(SHOTS_DIR, 'observatory-mobile.png'), query: 'frame=best&mode=full&graph=B&t=1.25', size: [390, 844], scale: 2, mobile: true },
];

const TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseArgs(argv) {
    const options = { browser: process.env.CHROME_PATH || null, all: false, shot: null, query: null, size: null, timeout: 60000 };
    for (let index = 0; index < argv.length; index += 1) {
        const name = argv[index];
        const value = argv[index + 1];
        if (name === '--all') { options.all = true; continue; }
        if (value === undefined) throw new TypeError(`missing value for ${name}`);
        if (name === '--browser') options.browser = value;
        else if (name === '--shot') options.shot = path.resolve(value);
        else if (name === '--query') options.query = value;
        else if (name === '--size') options.size = value.split(/[x,]/).map(Number);
        else if (name === '--timeout') options.timeout = Number(value);
        else throw new TypeError(`unknown option: ${name}`);
        index += 1;
    }
    return options;
}

function findBrowser(explicit) {
    const candidates = explicit ? [explicit] : [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge',
    ];
    const found = candidates.find((candidate) => fs.existsSync(candidate));
    if (!found) throw new Error('no Chrome, Edge or Chromium found; pass --browser PATH or set CHROME_PATH');
    return found;
}

function serve(directory) {
    const server = http.createServer((request, response) => {
        const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
        const file = path.join(directory, pathname === '/' ? 'index.html' : pathname);
        if (!file.startsWith(directory) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
            response.writeHead(404);
            response.end('not found');
            return;
        }
        response.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
        fs.createReadStream(file).pipe(response);
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function launch(browser) {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'observatory-capture-'));
    const child = spawn(browser, [
        '--headless=new',
        `--user-data-dir=${profile}`,
        '--remote-debugging-port=0',
        '--no-first-run',
        '--no-default-browser-check',
        '--hide-scrollbars',
        '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader',
        'about:blank',
    ], { stdio: 'ignore' });
    const portFile = path.join(profile, 'DevToolsActivePort');
    for (let attempt = 0; attempt < 150 && !fs.existsSync(portFile); attempt += 1) await sleep(100);
    if (!fs.existsSync(portFile)) throw new Error('the browser did not open a DevTools port');
    const port = fs.readFileSync(portFile, 'utf8').split('\n')[0].trim();
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const socket = new WebSocket(targets.find((target) => target.type === 'page').webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
        socket.addEventListener('open', resolve);
        socket.addEventListener('error', reject);
    });
    let next = 0;
    const pending = new Map();
    socket.addEventListener('message', (event) => {
        const message = JSON.parse(event.data);
        if (message.id && pending.has(message.id)) {
            pending.get(message.id)(message);
            pending.delete(message.id);
        }
    });
    const send = (method, params = {}) => new Promise((resolve, reject) => {
        next += 1;
        pending.set(next, (message) => (message.error ? reject(new Error(`${method}: ${message.error.message}`)) : resolve(message.result)));
        socket.send(JSON.stringify({ id: next, method, params }));
    });
    const close = () => {
        socket.close();
        child.kill();
        setTimeout(() => fs.rmSync(profile, { recursive: true, force: true }), 500);
    };
    return { send, close };
}

async function capture(session, url, shot, timeout) {
    const [width, height] = shot.size;
    await session.send('Emulation.setDeviceMetricsOverride', {
        width, height, deviceScaleFactor: shot.scale || 1, mobile: Boolean(shot.mobile),
    });
    await session.send('Page.navigate', { url });
    const deadline = Date.now() + timeout;
    for (;;) {
        const { result } = await session.send('Runtime.evaluate', {
            expression: "document.readyState === 'complete' && document.body.dataset.ready === '1'",
            returnByValue: true,
        });
        if (result.value) break;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${url} to render`);
        await sleep(150);
    }
    await sleep(600);
    const { data } = await session.send('Page.captureScreenshot', { format: 'png' });
    fs.mkdirSync(path.dirname(shot.file), { recursive: true });
    fs.writeFileSync(shot.file, Buffer.from(data, 'base64'));
}

async function main(argv = process.argv.slice(2)) {
    const options = parseArgs(argv);
    const browser = findBrowser(options.browser);
    const shots = options.shot
        ? [{ file: options.shot, query: options.query || FALLBACK.query, size: options.size || FALLBACK.size }]
        : [FALLBACK, ...(options.all ? STILLS : [])];
    const server = await serve(WEB);
    const session = await launch(browser);
    try {
        await session.send('Page.enable');
        await session.send('Runtime.enable');
        for (const shot of shots) {
            const url = `http://127.0.0.1:${server.address().port}/observatory.html?${shot.query}`;
            await capture(session, url, shot, options.timeout);
            process.stdout.write(`${path.relative(ROOT, shot.file)}  ${shot.size.join('x')}${shot.scale ? `@${shot.scale}x` : ''}  ${fs.statSync(shot.file).size} bytes\n`);
        }
    } finally {
        session.close();
        server.close();
    }
}

if (require.main === module) {
    main().catch((error) => {
        process.stderr.write(`${error.stack || error.message}\n`);
        process.exitCode = 1;
    });
}

module.exports = { FALLBACK, STILLS, findBrowser, parseArgs };
