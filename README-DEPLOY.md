# Deploying the browser demo

The demo is static files. There is no server, no API and no cost.

## Vercel

```bash
npm i -g vercel
vercel            # first run: link the project
vercel --prod
```

`vercel.json` sets `buildCommand: node tools/build-web.js` and
`outputDirectory: web`, so Vercel runs the bundler and serves the result.
Install step is a no-op because there are no dependencies.

## Anything else

The build produces two files — `web/index.html` and `web/bundle.js` — so any
static host works:

```bash
node tools/build-web.js
npx serve web            # or: python3 -m http.server -d web
```

Netlify: publish directory `web`, build command `node tools/build-web.js`.
GitHub Pages: run the build in CI and publish `web/`.
Cloudflare Pages: same two settings.

## What is actually running

The page loads the real `raft.js`, `hnsw.js`, `state-machine.js`, `quantize.js`
and `sparse.js` — the same files the server runs — over a simulated network
under a virtual clock. Nothing is reimplemented for the browser. The only
substitutions are the clock and the wire, which is precisely what makes the
deterministic fuzzer possible too.
