#!/usr/bin/env node
/**
 * dashboard.js — a live view of the whole system on one page.
 *
 * Deliberately dependency-free: node's own http module and one inline HTML
 * document. A dashboard that needs its own build step is a dashboard that stops
 * working six months later, and this one exists to be opened during a demo.
 *
 * It aggregates rather than stores. Every number on the page is read from a
 * replica or a serving pod at request time, so what you see is the system's
 * actual state and not a cache that might disagree with it.
 *
 *   node tools/dashboard.js          # then open http://localhost:8080
 */

const http = require('http');
const path = require('path');

const PORT = Number(process.env.DASHBOARD_PORT || 8080);
const REPLICAS = (process.env.RAFT_REPLICAS_URLS
    || 'http://127.0.0.1:5001,http://127.0.0.1:5002,http://127.0.0.1:5003').split(',').filter(Boolean);
const PODS = (process.env.SERVING_URLS
    || 'http://127.0.0.1:7000,http://127.0.0.1:7001,http://127.0.0.1:7002').split(',').filter(Boolean);
const ARTIFACT_DIR = process.env.ARTIFACT_DIR || path.join(__dirname, '..', 'artifacts');

const { ConsensusClient } = require('../serving/consensus-client');
const { RolloutController } = require('../serving/rollout-controller');

const consensus = new ConsensusClient(REPLICAS, { label: 'dashboard' });
const events = [];

function note(message, kind = 'info') {
    events.unshift({ at: new Date().toISOString().slice(11, 23), message, kind });
    events.length = Math.min(events.length, 60);
}

const timeout = (ms) => AbortSignal.timeout(ms);

async function fetchJson(url, ms = 1200) {
    try {
        const response = await fetch(url, { signal: timeout(ms) });
        if (!response.ok) return null;
        return await response.json();
    } catch (_) {
        return null;
    }
}

async function collect() {
    const [replicas, pods] = await Promise.all([
        Promise.all(REPLICAS.map(async (url) => ({ url, status: await fetchJson(`${url}/status`) }))),
        Promise.all(PODS.map(async (url) => ({ url, status: await fetchJson(`${url}/status`) }))),
    ]);

    // Read the keyspace from whichever replica currently leads. Reading from a
    // follower would be fine for a dashboard, but showing the leader's view
    // makes the pause demo legible: when the leader is paused you can watch the
    // remaining two elect a new one and the keyspace follow it.
    const leader = replicas.find((r) => r.status?.state === 'LEADER');
    const stateUrl = leader?.url ?? replicas.find((r) => r.status)?.url;
    const keyspace = stateUrl ? await fetchJson(`${stateUrl}/state`) : null;

    return { replicas, pods, keyspace, events, leaderUrl: leader?.url ?? null };
}

// ── actions ──────────────────────────────────────────────────────────────────

// Manifests come from wherever the artifacts live — a directory when running as
// local processes, MinIO in kind, S3 on EKS. Reading them through the same
// backend the serving pods use means the dashboard cannot roll out a version
// the pods would then fail to fetch.
const { backendFromEnv } = require('../serving/artifacts');
const artifacts = backendFromEnv({ ...process.env, ARTIFACT_DIR });

async function loadManifest(version) {
    const raw = await artifacts.read(`index/${version}/manifest.json`);
    return JSON.parse(raw.toString('utf8'));
}

async function runRollout(version, { rollback = false } = {}) {
    const controller = new RolloutController(consensus, {
        holder: 'dashboard',
        log: (m) => note(m, 'rollout'),
    });
    const manifest = await loadManifest(version);
    const livePods = (await Promise.all(PODS.map((u) => fetchJson(`${u}/healthz`)))).filter(Boolean).length;

    await controller.acquireLock();
    try {
        const result = rollback
            ? await controller.rollback(manifest)
            : await controller.rollout(manifest, { expectedPods: livePods, timeoutMs: 60000 });
        note(result.ok
            ? `${rollback ? 'rollback' : 'rollout'} to ${version} complete` +
              `${result.preloadMs ? ` (preload ${result.preloadMs}ms, flip ${result.flipMs}ms)` : ''}`
            : `${version} failed at ${result.phase}: ${result.error}`,
        result.ok ? 'ok' : 'error');
        return result;
    } finally {
        await controller.releaseLock();
    }
}

async function handleAction(name, params) {
    switch (name) {
        case 'pause': {
            await fetch(`${params.url}/pause`, { method: 'POST', signal: timeout(2000) });
            note(`paused ${params.url} — watch the survivors elect a new leader`, 'warn');
            return { ok: true };
        }
        case 'resume': {
            await Promise.all(REPLICAS.map((url) =>
                fetch(`${url}/resume`, { method: 'POST', signal: timeout(2000) }).catch(() => {})));
            note('resumed all replicas', 'ok');
            return { ok: true };
        }
        case 'rollout': return runRollout(params.version);
        case 'rollback': return runRollout(params.version, { rollback: true });
        case 'query': {
            const results = await Promise.all(PODS.map(async (url) => {
                try {
                    const response = await fetch(`${url}/search`, {
                        method: 'POST',
                        headers: { 'content-type': 'application/json' },
                        body: JSON.stringify({ query: params.query || 'a photo of a cat', topK: 3 }),
                        signal: timeout(2000),
                    });
                    return response.ok ? await response.json() : { error: response.status, podId: url };
                } catch (error) { return { error: error.message, podId: url }; }
            }));
            return { ok: true, results };
        }
        default: return { ok: false, error: `unknown action ${name}` };
    }
}

// ── server ───────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === '/api/state') {
        const body = await collect();
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        return res.end(JSON.stringify(body));
    }

    if (url.pathname === '/api/action' && req.method === 'POST') {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const payload = JSON.parse(Buffer.concat(chunks).toString() || '{}');
        try {
            const result = await handleAction(payload.action, payload);
            res.writeHead(200, { 'content-type': 'application/json' });
            return res.end(JSON.stringify(result));
        } catch (error) {
            note(`${payload.action} failed: ${error.message}`, 'error');
            res.writeHead(500, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ ok: false, error: error.message }));
        }
    }

    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(PAGE);
});

server.listen(PORT, () => {
    note('dashboard started', 'ok');
    console.log(`\n  CloudProof dashboard → http://localhost:${PORT}\n`);
});

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>CloudProof</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{--bg:#0d1117;--panel:#161b22;--line:#30363d;--dim:#8b949e;--fg:#e6edf3;
--leader:#3fb950;--follower:#58a6ff;--paused:#f85149;--warn:#d29922;--accent:#a371f7}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}
header{padding:16px 20px;border-bottom:1px solid var(--line);display:flex;align-items:baseline;gap:16px;flex-wrap:wrap}
h1{font-size:16px;margin:0;letter-spacing:.5px}
.sub{color:var(--dim);font-size:12px}
main{display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:14px;padding:14px}
section{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:14px}
h2{font-size:11px;text-transform:uppercase;letter-spacing:1.2px;color:var(--dim);margin:0 0 12px}
.node{display:flex;justify-content:space-between;align-items:center;padding:9px 10px;border-radius:6px;
background:#0d1117;border:1px solid var(--line);margin-bottom:7px}
.node .id{font-weight:600}
.badge{font-size:10px;padding:2px 7px;border-radius:10px;letter-spacing:.5px}
.LEADER{background:rgba(63,185,80,.15);color:var(--leader);border:1px solid var(--leader)}
.FOLLOWER{background:rgba(88,166,255,.12);color:var(--follower);border:1px solid var(--follower)}
.CANDIDATE{background:rgba(210,153,34,.15);color:var(--warn);border:1px solid var(--warn)}
.PAUSED,.DOWN{background:rgba(248,81,73,.15);color:var(--paused);border:1px solid var(--paused)}
.meta{color:var(--dim);font-size:11px;text-align:right;line-height:1.7}
table{width:100%;border-collapse:collapse;font-size:12px}
td,th{padding:5px 6px;border-bottom:1px solid var(--line);text-align:left}
th{color:var(--dim);font-weight:500;font-size:10px;text-transform:uppercase;letter-spacing:.8px}
.lease{color:var(--accent)}
.bar{height:4px;background:var(--line);border-radius:2px;overflow:hidden;margin-top:3px}
.bar>i{display:block;height:100%;background:var(--accent);transition:width .2s linear}
button{font:inherit;font-size:12px;background:#21262d;color:var(--fg);border:1px solid var(--line);
border-radius:6px;padding:7px 12px;cursor:pointer;margin:0 6px 6px 0}
button:hover{border-color:var(--follower);color:var(--follower)}
button.danger:hover{border-color:var(--paused);color:var(--paused)}
button:disabled{opacity:.4;cursor:not-allowed}
#events{font-size:11px;max-height:230px;overflow:auto}
#events div{padding:3px 0;border-bottom:1px solid #21262d;display:flex;gap:9px}
#events .t{color:#484f58;flex-shrink:0}
.ok{color:var(--leader)} .warn{color:var(--warn)} .error{color:var(--paused)} .rollout{color:var(--accent)}
.v{display:inline-block;padding:1px 6px;border-radius:4px;background:rgba(163,113,247,.15);
color:var(--accent);border:1px solid var(--accent);font-size:11px}
.hint{color:var(--dim);font-size:11px;margin-top:10px;line-height:1.6}
pre{margin:8px 0 0;font-size:11px;color:var(--dim);max-height:150px;overflow:auto;white-space:pre-wrap}
</style></head><body>
<header>
  <h1>CloudProof</h1>
  <span class="sub" id="summary">connecting…</span>
</header>
<main>
  <section>
    <h2>Consensus tier</h2>
    <div id="replicas"></div>
    <div class="hint">Pause the leader and watch the remaining two elect a replacement.
    Quorum is 2 of 3, so one failure is survivable and two is not.</div>
  </section>

  <section>
    <h2>Serving tier</h2>
    <div id="pods"></div>
    <div class="hint">Each pod owns one index shard and reports the model version it is
    actually serving. During a rollout these change within milliseconds of each other.</div>
  </section>

  <section>
    <h2>Replicated keyspace</h2>
    <table id="keys"><thead><tr><th>key</th><th>value</th><th>rev</th><th>lease</th></tr></thead><tbody></tbody></table>
  </section>

  <section>
    <h2>Controls</h2>
    <div>
      <button onclick="act('rollout',{version:'v2'})">Roll out v2</button>
      <button onclick="act('rollback',{version:'v1'})">Roll back to v1</button>
    </div>
    <div>
      <button class="danger" onclick="pauseLeader()">Pause the leader</button>
      <button onclick="act('resume',{})">Resume all</button>
    </div>
    <div>
      <button onclick="runQuery()">Query every shard</button>
    </div>
    <pre id="queryout"></pre>
  </section>

  <section style="grid-column:1/-1">
    <h2>Events</h2>
    <div id="events"></div>
  </section>
</main>
<script>
let last = null;

async function act(action, params) {
  document.querySelectorAll('button').forEach(b => b.disabled = true);
  try { await fetch('/api/action', {method:'POST',headers:{'content-type':'application/json'},
    body: JSON.stringify({action, ...params})}); }
  finally { setTimeout(()=>document.querySelectorAll('button').forEach(b=>b.disabled=false), 400); refresh(); }
}

function pauseLeader() {
  const leader = last?.leaderUrl;
  if (!leader) return;
  act('pause', {url: leader});
}

async function runQuery() {
  const out = document.getElementById('queryout');
  out.textContent = 'querying…';
  const r = await fetch('/api/action', {method:'POST',headers:{'content-type':'application/json'},
    body: JSON.stringify({action:'query', query:'a photo of a cat'})});
  const {results} = await r.json();
  out.textContent = results.map(x => x.error
    ? x.podId + ': ' + x.error
    : x.podId + '  [' + x.modelVersion + ']  shard ' + x.shardId + '  ' +
      x.results.map(h => h.id + ' ' + h.score.toFixed(3)).join('  ')).join('\\n');
}

function el(html) { const d = document.createElement('div'); d.innerHTML = html.trim(); return d.firstChild; }

function renderReplicas(replicas) {
  const host = document.getElementById('replicas');
  host.innerHTML = '';
  for (const r of replicas) {
    const s = r.status;
    const state = s ? s.state : 'DOWN';
    host.appendChild(el(\`<div class="node">
      <div><span class="id">\${s ? s.replicaId : r.url.split(':').pop()}</span>
      <span class="badge \${state}">\${state}</span></div>
      <div class="meta">term \${s?s.term:'–'} · log \${s?s.logLength:'–'} · commit \${s?s.commitIndex:'–'}<br>
      \${s?s.keys:0} keys · \${s?s.leases:0} leases · rev \${s?s.revision:'–'}</div></div>\`));
  }
}

function renderPods(pods) {
  const host = document.getElementById('pods');
  host.innerHTML = '';
  for (const p of pods) {
    const s = p.status;
    if (!s) {
      host.appendChild(el(\`<div class="node"><div><span class="id">\${p.url.split(':').pop()}</span>
        <span class="badge DOWN">DOWN</span></div><div class="meta">–</div></div>\`));
      continue;
    }
    const cs = s.coldStart || {};
    host.appendChild(el(\`<div class="node">
      <div><span class="id">\${s.podId}</span>
      \${s.active ? '<span class="v">'+s.active+'</span>' : '<span class="badge DOWN">no model</span>'}
      \${s.shadow ? '<span class="badge CANDIDATE">staged '+s.shadow+'</span>' : ''}</div>
      <div class="meta">shard \${s.shardId} · \${s.metrics.queries} queries<br>
      ready in \${cs.activeAfterManifestMs ?? '–'}ms · \${s.metrics.activations} activations</div></div>\`));
  }
}

function renderKeys(keyspace) {
  const body = document.querySelector('#keys tbody');
  body.innerHTML = '';
  if (!keyspace) return;
  const leases = new Map((keyspace.leases||[]).map(l => [l.key, l]));
  for (const k of keyspace.keys) {
    const lease = leases.get(k.key);
    const value = typeof k.value === 'object' && k.value !== null
      ? (k.value.version ?? JSON.stringify(k.value)) : String(k.value);
    const pct = lease ? Math.max(0, Math.min(100, (lease.remainingMs / lease.ttlMs) * 100)) : 0;
    body.appendChild(el(\`<tr><td>\${k.key}</td><td>\${value}</td><td>\${k.rev}</td>
      <td class="lease">\${lease ? lease.holder + ' ' + lease.remainingMs + 'ms<div class="bar"><i style="width:'+pct+'%"></i></div>' : '—'}</td></tr>\`));
  }
}

function renderEvents(events) {
  const host = document.getElementById('events');
  host.innerHTML = '';
  for (const e of events) {
    host.appendChild(el(\`<div><span class="t">\${e.at}</span><span class="\${e.kind}">\${e.message}</span></div>\`));
  }
}

async function refresh() {
  try {
    const data = await (await fetch('/api/state')).json();
    last = data;
    renderReplicas(data.replicas);
    renderPods(data.pods);
    renderKeys(data.keyspace);
    renderEvents(data.events);
    const up = data.replicas.filter(r=>r.status).length;
    const leader = data.replicas.find(r=>r.status?.state==='LEADER');
    document.getElementById('summary').textContent =
      up + '/' + data.replicas.length + ' replicas up · ' +
      (leader ? 'leader ' + leader.status.replicaId + ' term ' + leader.status.term : 'NO LEADER — election in progress') +
      ' · ' + data.pods.filter(p=>p.status?.active).length + '/' + data.pods.length + ' pods serving';
  } catch (_) {
    document.getElementById('summary').textContent = 'dashboard unreachable';
  }
}

refresh();
setInterval(refresh, 500);
</script></body></html>`;

module.exports = { server };
