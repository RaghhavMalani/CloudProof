# Running and deploying CloudProof

CloudProof has three deliberately different execution surfaces. Do not confuse a
green browser simulation with a passing container or Kubernetes run.

| Surface | What actually runs | What it proves |
|---|---|---|
| Browser lab | real state-machine modules behind a virtual clock and simulated wire | deterministic replay and workload invariants |
| Docker Compose | gateway, Redis, and three separate Raft processes with named volumes | real process, DNS, socket, restart, and persistence behavior |
| Kubernetes | StatefulSet, PVCs, Services, readiness/liveness, anti-affinity, and disruption budgets | stable identity, scheduling, storage, and quorum-safe voluntary disruption |

## Browser lab

The browser build is static files. It has no server or API and does not require
Docker:

```bash
node tools/build-web.js
npx serve web
```

Open the printed URL. The page loads the real `raft.js`, `hnsw.js`,
`state-machine.js`, `quantize.js`, and `sparse.js` modules over a simulated
network. Only the clock and wire are substituted. This is what makes replay and
fuzz reduction deterministic.

## Live Docker cluster

```bash
docker compose up --build -d
```

Open <http://localhost:4000>. The live UI is served by the gateway and talks to
the actual three-replica cluster. State survives ordinary container restarts in
the three named volumes.

To refresh the recorded Docker row shown in the browser lab:

```bash
docker compose --profile research run --rm reality-harness
```

That command connects to the Compose processes and writes
`web/reality-run.json`. The browser labels it as a recorded capture; it is not a
live event stream.

## Local Kubernetes with kind

The repository includes a complete local cluster path. It creates one control
plane plus three consensus workers, builds and side-loads the images, replaces
the production `gp3` StorageClass, deploys the system, and waits for readiness:

```bash
bash tools/kind-up.sh
```

This requires Docker, `kind`, `kubectl`, and a Bash environment. Remove the
cluster with `bash tools/kind-up.sh --down`.

## Production Kubernetes

`k8s/cloudproof-raft.yaml` intentionally targets dedicated consensus nodes and `gp3`
volumes. Before applying it, provide the published images, a `gp3` StorageClass,
and three nodes labelled and tainted for `cloudproof.io/tier=consensus`.

```bash
kubectl apply -f k8s/cloudproof-raft.yaml
kubectl -n cloudproof-raft get pods,pvc,pdb
kubectl -n cloudproof-raft get service gateway
```

## Static browser hosting

## Vercel

```bash
npm i -g vercel
vercel
vercel --prod
```

`vercel.json` sets `buildCommand: node tools/build-web.js` and
`outputDirectory: web`, so Vercel runs the bundler and serves the result.
Install step is a no-op because there are no dependencies.

## Other static hosts

The build produces the self-contained `web` directory, so any
static host works:

```bash
node tools/build-web.js
npx serve web            # or: python3 -m http.server -d web
```

Netlify: publish directory `web`, build command `node tools/build-web.js`.
GitHub Pages: run the build in CI and publish `web/`.
Cloudflare Pages: same two settings.

## Browser implementation

The page loads the real `raft.js`, `hnsw.js`, `state-machine.js`, `quantize.js`
and `sparse.js` — the same files the server runs — over a simulated network
under a virtual clock. Nothing is reimplemented for the browser. The only
substitutions are the clock and the wire, which is precisely what makes the
deterministic fuzzer possible too.
