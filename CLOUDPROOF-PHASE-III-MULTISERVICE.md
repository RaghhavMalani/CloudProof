# CloudProof Phase III — Multi-Service Failure Propagation

> **Status: design and preregistration, written before any Phase III model exists.** Phase II-B.2
> is frozen on `main` (`de43a31`, PR #6). This document fixes the new world, the pair construction,
> the controls and the pass criteria *before* the simulator is finished and before any model is
> trained. Section 12 lists the only decisions left open, which are the ones a simulator-only
> pilot is allowed to settle. Everything else here is fixed.

## 1. Research question

> Can relational models identify failure propagation across multi-service cloud dependency
> graphs better than topology-blind and degree-aware baselines, while deterministic CloudProof
> remains the verifier?

The unit of evidence is again a **decisive counterfactual pair**: two worlds that are identical to
every non-relational model, receive the same fault, and have different simulator outcomes. What
is new is what "identical" means. It now also covers every node's degree, co-location counts, and
the fault target's own one-hop neighbourhood, so a correct ranking has to come from *where* a
failure sits in the dependency graph and *what depends on it*.

## 2. Why Phase II-B.2 is not enough

Phase II-B.2 passed its attribution test narrowly (`CLOUDPROOF-PHASE-II-B2.md`), with four
weaknesses:

- **Degree carried most of the signal.** A degree-preserving edge permutation kept 0.74–0.75 of
  the full GNN's 0.873. The largest family was decided by how many pods sat on the crashing node.
- **Transfer beyond degree was not established.** On the 45 pairs from never-seen topologies,
  the lead over the degree-preserving control was +0.02 to +0.08 with intervals including zero.
- **A fixed per-family preference scored well.** Each family had a designated "treated"
  arrangement that was usually riskier. The model learned that preference and ranked all nine
  reversals wrong.
- **The world was single-service.** There was one Deployment, one Service, one HPA and one PDB.
  On natural data a pooled model matched the GNN, because there was little relational structure
  to exploit.

Phase III is designed so that each of these would show up as a failure rather than hide inside a
pass.

## 3. The world: CloudProof Mesh

A new, separate package (`packages/cloudproof-mesh/`). The Phase I–II single-service twin
(`packages/cloudproof/`) is not modified, so the Phase I byte-identical replay and the frozen
corpus v2 are untouched.

### 3.1 Resources

| Resource | Meaning | Intrinsic state |
| --- | --- | --- |
| Zone | failure domain | degraded |
| Node | machine in one zone | ready, draining, pod slots |
| Pod | one instance of a service | phase (RUNNING, STARTING, PENDING, FAILED), ready |
| Service | logical component; kind ∈ {api, cache, queue, worker, database} | desired replicas, minimum healthy, per-pod capacity (rps), startup time, database role (primary/replica), promoted flag, cache warmth, queue backlog fraction and capacity, consumer stall |
| Route | a class of user traffic entering the system | traffic share, rps |
| Volume | zonal storage for one database | available |

Services are anonymous (`svc-01`, …). No name, role label or identifier is ever a model feature.

### 3.2 Relations

| Relation | From → to | Semantics |
| --- | --- | --- |
| LOCATED_IN | Node → Zone, Volume → Zone | failure domain membership |
| RUNS_ON | Pod → Node | placement |
| OWNS | Service → Pod | instances |
| MOUNTS | Pod → Volume | database pods need their zonal volume |
| ENTERS | Route → Service | the route's traffic enters this service |
| CALLS | Service → Service | synchronous **hard** dependency |
| CALLS_OPTIONAL | Service → Service | synchronous **soft** dependency (degraded, not failed) |
| READS_THROUGH | Service → cache Service | reads go through a cache |
| BACKED_BY | cache Service → database Service | cache misses fall through to this store |
| WRITES | Service → database Service | hard dependency on the write path |
| READS | Service → database Service | hard read dependency; a replica falls back to its primary |
| REPLICATES | primary database → replica database | failover pairing |
| PUBLISHES | Service → queue Service | asynchronous; fails only under backpressure |
| CONSUMES | worker Service → queue Service | drains the queue |

Every request edge has fan-out 1, so a service's load is the sum of the traffic its callers pass
on. That load is **not** a feature: it is a function of the wiring, and exposing it would let a
pooled model read relational information. The graph is a DAG; the generator rejects cycles.

### 3.3 Semantics (evaluated every 100 ms tick)

1. **Nodes and zones.** A crashed node and every node in a degraded zone are not ready. Pods on a
   crashed node fail at once. Pods on a not-ready node in a degraded zone are unavailable, and are
   evicted after `evictionDelayMs` = 2 000 ms.
2. **Rescheduling.** A failed or evicted pod becomes PENDING after `rescheduleDelayMs` = 800 ms.
   The scheduler places it on a ready, uncordoned node with a free slot: fewest pods first, then
   node ID. A database pod may only be placed in its volume's zone. A placed pod is STARTING for
   the service's `startupMs`, then RUNNING.
3. **Health.** `healthy` = RUNNING pods on ready nodes, excluding database pods whose volume is
   unavailable. `capacity = healthy × podCapacityRps`. A service is *intrinsically* up when
   `healthy ≥ minHealthy`.
4. **Load.** Route traffic (`share × rps`) enters its service and flows along CALLS,
   CALLS_OPTIONAL, WRITES and READS from every intrinsically-up caller. A cache passes
   `missRatio × load` to its backing store: 0.2 when warm, 1.0 when cold or down. A flushed cache
   is cold for `cacheWarmupMs` = 3 000 ms. A down cache sends all of its callers' reads to the
   backing store.
5. **Overload.** A service whose load exceeds its capacity is down for the tick. Overload is
   computed once per tick from the load of the intrinsically-up world, so the down set only
   grows within a tick and the result is deterministic.
6. **Queues.** Each tick, backlog += producers' load × Δt − consumers' capacity × Δt. Consumers
   drain only while up and not stalled. When the backlog reaches capacity, the queue is full and
   every publisher is down (backpressure).
7. **Hard propagation.** In reverse topological order, a service is down if any hard dependency
   is down:
   - CALLS or WRITES to a down service;
   - READS to a down replica whose primary is also down;
   - PUBLISHES to a full queue;
   - READS_THROUGH to a down cache whose backing store is down.

   CALLS_OPTIONAL never propagates.
8. **Failover.** When a primary database has been intrinsically down for `failoverDelayMs` = 1 500
   ms and its replica is up, the replica is promoted. From then on, WRITES and READS to the
   primary resolve to the replica.
9. **Routes and SLO.** A route fails when its entry service is down. The error share is the sum of
   the shares of the failing routes. **Invariant `mesh.slo.route-error-budget`:** error share ≤
   0.20 after every tick and every instantaneous action. The first violation ends the trajectory.
10. **Incident class.** Start from the failing route with the largest share. Follow the first down
    hard dependency, in ID order, to a root service. The root's reason sets the class:
    - `INSTANCE_LOSS`: healthy below its minimum;
    - `STORAGE_UNAVAILABLE`: the same, with the volume unavailable;
    - `OVERLOAD`;
    - `CACHE_STAMPEDE`: overload while a cold or down cache feeds the root;
    - `QUEUE_BACKPRESSURE`.

### 3.4 Actions

| Kind | Actions |
| --- | --- |
| Operations | `advance-time {ms}`, `scale {service, replicas}`, `traffic-shift {rps}`, `drain-node {node}`, `uncordon-node {node}`, `recover-node {node}`, `recover-zone {zone}` |
| Faults | `node-crash {node}`, `zone-degraded {zone}`, `pod-crash {pod}`, `cache-flush {service}`, `consumer-stall {service, durationMs}`, `traffic-spike {factor}` |

Controllers run inside `advance-time`, in a fixed order on every tick: evictions, restarts, the
scheduler, readiness, failover, cache warm-up, queue backlog, propagation, then the SLO check.

### 3.5 Determinism

A world is a pure function of its template and seed, and a schedule is a pure function of its
world and seed. There is no wall-clock time and no unseeded randomness. Every transition records
a SHA-256 of the canonical state, and a replay must reproduce every digest.

## 4. Counterfactual pairs

### 4.1 Construction principles

1. **Degree-preserving double-edge swap.** The two wirings W and W′ differ by one swap
   `(u₁→v₁, u₂→v₂) ↔ (u₁→v₂, u₂→v₁)` within a single relation type. Every node keeps its type,
   its features and its in- and out-degree for every relation. Placement, node sets, replica
   counts, capacities, zone counts and the degree histogram are identical by construction.
2. **No treated arm.** W and W′ are symmetric. Which one is called A is a seeded coin.
3. **The fault location is randomized over the motif.** Each family has two fault targets, f₁
   and f₂. Under f₁ one wiring exposes the critical path; under f₂ the other one does. The fault
   is drawn 50/50. Consequences:
   - A preference based only on the wiring is at chance by design.
   - So is a preference based only on the fault.
   - Only the *interaction* between fault location and wiring, which is the propagation path,
     predicts the outcome.
   This removes the Phase II failure mode where a fixed "treated is riskier" preference scored
   well.
4. **Same exogenous schedule.** Both members share the seed, warm-up, fault and continuation:
   20 × `advance-time 250 ms` (5 s).
5. **Truth comes from execution.** The riskier member is the one whose trajectory violates the
   SLO. A pair is *decisive* when exactly one member violates.

### 4.2 Guarantees, asserted for every pair (a failed assertion rejects the pair)

- **P1. Pooled identity.** Per node type, the multiset of node-feature vectors is identical,
  including the action-target flag. Any permutation-invariant pooled model ties.
- **P2. Degree-aware identity.** Every node carries its features together with a degree vector
  (in- and out-degree per relation). Per node type, the multiset of those combined vectors is
  identical. So are:
  - the co-location multisets: pods and distinct services per node and per zone, and distinct
    nodes and zones per service, each joined with the owner's features;
  - the fault target's own features, degree vector and co-location counts;
  - the multiset of the target's one-hop neighbours' combined feature-and-degree vectors.
- **P3. Same fault and continuation**, byte-identical as schedule actions.
- **P4. The relation tensors differ** in exactly the swapped relation type.
- **P5. The prefix states are identical** except for the swapped edges. No member violates
  before the fault.

A degree-aware flat baseline (§7) sees exactly the P1 and P2 information, so on every decisive
pair it ties by construction. That is a gate, not evidence.

### 4.3 Families

| # | Family | Swapped relation | Fault targets (drawn 50/50) | Mechanism | Hops from fault to route |
| --- | --- | --- | --- | --- | ---: |
| F1 | `route-entry` | ENTERS (high-share route ↔ low-share route) | crash the node holding entry P's pods / entry Q's pods | route weighting | 3 |
| F2 | `call-dependency` | CALLS (callers on high/low-share paths ↔ callees X, Y) | crash X's node / Y's node | synchronous cascade | 5 |
| F3 | `cache-backing` | BACKED_BY (caches K₁, K₂ ↔ stores S₁ critical, S₂ non-critical) | flush K₁ / flush K₂ | cache stampede → overload → cascade | 5 |
| F4 | `storage-zone` | WRITES (writers on high/low-share paths ↔ databases D₁ in zone a, D₂ in zone b) | degrade zone a / zone b | zonal storage loss → cascade | 6 |
| F5 | `queue-consumer` | CONSUMES (workers W₁, W₂ ↔ queues fed by high/low-rate producers) | crash W₁'s node / W₂'s node | backlog growth, then backpressure, racing consumer recovery | 5 |

The motif's swapped elements have identical features (callees X ≅ Y, caches K₁ ≅ K₂, stores
S₁ ≅ S₂, and so on), so P1 and P2 hold. Everything else in the world is sampled from the template
(§5) and is identical between the members. That includes the other services, routes, placements
and nuisance load, some of which may itself fail and push a pair concordant.

## 5. Topology templates and splits

Worlds are sampled from **structural templates**, and a template's worlds all belong to one
split. The test and OOD templates are structural regimes that training never sees:

| Split | Templates | Structural regime |
| --- | --- | --- |
| train | T1–T8 | 2–3 zones; call depth 1–2; every combination of 0–2 caches, 0–1 queues and 1–2 databases |
| validation | V1–V2 | the same ranges, with parameter combinations not in train |
| test | X1–X2 | **call depth 3**, 3 zones, caches *and* queues together |
| OOD | O1–O2 | **4 zones**, depth 3, 1.5–2× more services, pods and nodes |

The primary pair set is the decisive pairs from the **test and OOD templates**: worlds, depths and
sizes the model has never seen.

## 6. Natural training corpus

This reuses the Phase II-A.2 contract:

- an outcome-blind generator (no intended outcome, no expectation guard);
- labels only from execution;
- pre-incident rows only;
- outcome-blind row selection;
- matched safe/unsafe trajectories within strata;
- a `ShortcutProbe` gate on nuisance features;
- SHA-256 freeze before any training.

Primary label: SLO violation within the next K = 5 transitions. K = 1, 10 and 20 are secondary
and exploratory. Schedules are 30–80 actions long, with a per-trajectory fault hazard and faults
drawn uniformly from the §3.4 fault vocabulary over uniformly drawn targets. Pairs are evaluation
only: no pair record, pair label or pair world ever enters training.

## 7. Models (Phase III-B; none trained yet)

| Model | Role | Sees |
| --- | --- | --- |
| **Relational GNN** | hypothesis | Phase II-B family unchanged except for the new vocabulary: per-relation forward and reverse messages, mean aggregation, LayerNorm; **L = 6 layers** (§4.3's longest path is 6 hops); an `isActionTarget` input flag on the target node; typed mean pooling plus the target embedding |
| Depth control | diagnostic | the same GNN with L = 2 |
| Pooled MLP | topology-blind | typed mean/min/max/sum pools of node features plus the action and the target node's own features |
| **Degree-aware MLP** | stronger non-relational control | the pooled MLP's inputs plus the §4.2 P2 summary: degree histograms, joint feature-and-degree pools, co-location pools, the target's degree and co-location counts and its one-hop neighbourhood |
| Exposure heuristic | symbolic relational reference, not learned | sum of the shares of routes that reach a directly affected service through hard edges |

**Frozen recipe:** Phase II-B's optimizer, learning rate, weight decay, batch size, patience,
early stopping on validation NLL and five seeds. Hidden width 48. Parameter-matched MLPs,
within 1.25× of the GNN. No tuning after any test, OOD or pair result.

## 8. Controls

- **Primary: uniform rewiring.** Both endpoints of every relation are resampled among
  type-compatible nodes, keeping only relation-type edge counts. Seeds 1729, 2729 and 3729.
- **Secondary: degree-preserving randomization.** The target column of every relation is
  permuted. Seeds as above. Because pair members differ by a degree-preserving swap, this control
  isolates information *beyond* degree.
- **No edges.** Construction check.
- **Collapsed or random relation types.** Diagnostics only.
- **Clock-blind retrain.** Every absolute timestamp column is zeroed. The masked field list is
  written into each model config before training.

## 9. Primary test and pass criteria (fixed now)

The primary set is the decisive pairs from test and OOD templates, **N ≥ 350**. The accuracy
measure is tie-aware pairwise accuracy (ties within |margin| ≤ 10⁻⁶). Intervals are 10 000-resample
percentile bootstraps over pair IDs with seed 20260922, paired for differences. p-values are
exact binomial tests with ties excluded.

**Gate G (construction):** the pooled MLP, the degree-aware MLP and the no-edge GNN tie every
primary pair. If G fails, the experiment is invalid, not failed.

| # | Criterion | Threshold |
| --- | --- | --- |
| C1 | Relational signal | GNN accuracy ≥ 0.65, bootstrap lower bound > 0.5, p < 0.01 |
| C2 | Beats uniform rewiring (primary control) | for **each** of the three seeds: GNN − rewired ≥ 0.10, paired interval excludes 0 |
| C3 | Beyond degree | for **each** of the three degree-preserving seeds: GNN − randomized ≥ 0.10, paired interval excludes 0 |
| C4 | No fixed preference | accuracy ≥ 0.60 with bootstrap lower bound > 0.5 on **both** halves: pairs where the canonical wiring (lexicographically smaller wiring digest) is riskier, and pairs where it is safer |
| C5 | Not timing | clock-blind GNN meets C1 |

**GRAPH ATTRIBUTION PASSED** if and only if G holds and C1–C5 all pass. Otherwise **FAILED**,
reported with the same tables. The allowed claim, if it passes:

> On controlled CloudProof multi-service interventions whose members are identical to pooled and
> degree-aware models, relational message passing identifies simulator-derived failure
> propagation through the service dependency graph.

**Secondary, reported, not criteria:**

- H2 (natural data): GNN minus degree-aware MLP, transition AUROC on OOD, with a
  trajectory-bootstrap interval.
- The depth control (L = 6 vs L = 2), per family.
- Per-family accuracy.
- The exposure heuristic.
- The K = 1/10/20 horizons.
- The fixed-budget verification benchmark, which measures operational usefulness only.

Deterministic CloudProof remains the verifier in every case.

## 10. Sample size

With N = 350 and accuracy near 0.75, the 95 % interval half-width is about ±0.045. Paired
differences against a control near 0.5 have half-widths of about ±0.05–0.06, so the 0.10
thresholds in C2 and C3 are resolvable. The C4 halves have about 175 pairs each (±0.065).
Phase II-B.2 had 45 unseen pairs (±0.14).

## 11. Known limitations, stated in advance

- The world is synthetic, and pair truth is simulator truth.
- Five families encode five mechanisms. A model can pass by learning those mechanisms from natural
  data, which is the point, but that says nothing about mechanisms the simulator lacks: retries,
  timeouts, partial degradation and latency SLOs.
- Load is deliberately not a feature, so the models must infer it from wiring and route shares.
- Motif elements are feature-identical by construction. Natural worlds are not, so the pair
  distribution differs from the training distribution by design.
- CPU-only training on one laptop. Ensembles run at 4–6 concurrent members after a one-epoch
  benchmark (Phase II-B.2 §5.2).

## 12. What is frozen, and what the pilot may still set

**Frozen by this document:** the question; the world semantics (§3); pair principles P1–P5 and
families F1–F5; the split policy by template (§5); the model roster and recipe (§7); the controls
(§8); criteria G and C1–C5 with their thresholds (§9); N ≥ 350.

**Open until the simulator-only pilot (§13), then frozen before any model trains:**

- the numeric ranges inside each template;
- the per-family motif parameter ranges (route shares, replica counts, headroom, queue capacity);
- the number of pairs generated per template, chosen to reach N ≥ 350 decisive unseen pairs.

The pilot reads simulator outcomes only: validity, decisiveness and balance. No model, learned
score or feature importance is computed before the freeze.

## 13. Build plan and status

| Step | Content | Status |
| --- | --- | --- |
| III-A.1 | `packages/cloudproof-mesh`: world, engine, graph export, runner, pair builder, degree-aware summary, tests | in progress |
| III-A.2 | Simulator-only pilot: pair validity, decisive rate and balance per family and template; natural base rates | pending |
| III-A.3 | Freeze template and motif ranges; outcome-blind natural corpus with matching and shortcut gates; SHA-256 freeze | pending |
| III-B | Tensorizer for the mesh vocabulary; train the §7 roster; evaluate §9 | pending |
