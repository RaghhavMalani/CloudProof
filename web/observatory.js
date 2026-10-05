/*
 * CloudProof GNN Observatory.
 *
 * Replays observatory/replay.json: a real HeterogeneousRiskGNN training run that
 * ml/cloudproof/viz_tap.py recorded on one frozen counterfactual pair. Every
 * brightness, size, pulse and number on the page is read from that file:
 *
 *   node size and glow   <- L2 norm of the node's hidden state (input, layer 1, layer 2)
 *   pulse brightness     <- L2 norm of that edge's message, per layer and direction
 *   relation edge glow   <- Frobenius norm of the relation's forward and reverse weights
 *   readout streams      <- final hidden-state norm x the typed-mean pooling weight
 *   risk orb             <- sigmoid risk of the shown pair member under the chosen ablation
 *   published table      <- `final`, copied from the Phase II-B.2 result JSON at export
 *
 * Only the layout is constructed, and it is derived from the graph itself: zones on
 * a ring, nodes inside their zone (LOCATED_IN), pods orbiting their node (RUNS_ON),
 * the control plane above.
 *
 * The pure helpers live on `ObservatoryCore`, so tools/observatory.test.js can check
 * them against the committed replay without a browser. The script uses dynamic
 * import() only, so it also parses as a classic script (CI runs `node --check`).
 */
(function (global) {
  'use strict';

  const REPLAY_URL = 'observatory/replay.json';
  const FALLBACK_URL = 'observatory/fallback.png';

  const RELATION_COLORS = {
    RUNS_ON: '#4fd8ff',
    OWNS: '#a98bff',
    ROUTES_TO: '#6ee67a',
    LOCATED_IN: '#ffb347',
    SELECTS: '#ff6b6b',
    PROTECTS: '#ff7ad9',
    SCALES: '#e8f06a',
  };
  const COLLAPSED_COLOR = '#e6e1ff';
  const TYPE_COLORS = {
    Pod: '#d2ecff',
    Node: '#ffffff',
    Deployment: '#ddd2ff',
    Service: '#cdffd8',
    HPA: '#fffbc8',
    PDB: '#ffd6f1',
    Zone: '#ffd8a0',
  };
  const CONTROL_PLANE = ['Deployment', 'Service', 'HPA', 'PDB'];
  const MODE_ORDER = ['full', 'no-edges', 'randomized-edges', 'rewired-edges', 'collapsed-edge-types', 'random-relation-labels'];
  const MODE_INFO = {
    full: { label: 'FULL', note: () => 'The intact probe graph, exactly as the frozen corpus recorded it.' },
    'no-edges': {
      label: 'NO EDGES',
      note: () => 'Every relation is removed. A and B have identical pooled inputs, so without edges they are the same input and must score the same.',
    },
    'randomized-edges': {
      label: 'RANDOMIZED',
      note: (seed) => `The target end of every relation is permuted, so every node keeps its degree (the Phase II-B.1 control, edge seed ${seed}).`,
    },
    'rewired-edges': {
      label: 'REWIRED',
      note: (seed) => `Both endpoints are resampled among type-compatible nodes; only per-relation edge counts survive (edge seed ${seed}).`,
    },
    'collapsed-edge-types': {
      label: 'COLLAPSED',
      note: () => 'The wiring is kept; every relation is sent through the average of all seven relation transforms. A diagnostic, not connectivity destruction.',
    },
    'random-relation-labels': {
      label: 'RANDOM LABELS',
      note: () => 'The wiring is kept; each relation is sent through another relation’s transform (colours show which). A diagnostic, not connectivity destruction.',
    },
  };
  const FRAME_SECONDS = 0.14;
  const POD_SPIN = 0.22;

  // ------------------------------------------------------------------ pure core

  const core = {};

  core.RELATION_COLORS = RELATION_COLORS;
  core.MODE_INFO = MODE_INFO;

  core.modeOrder = function modeOrder(modes) {
    return MODE_ORDER.filter((mode) => modes.includes(mode)).concat(modes.filter((mode) => !MODE_ORDER.includes(mode)));
  };

  core.modeStates = function modeStates(frame, mode) {
    return mode === 'full' ? { layers: frame.layers, msg: frame.msg } : frame.ablation[mode];
  };

  core.relationWeight = function relationWeight(weights) {
    const values = weights.forward.concat(weights.reverse);
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  };

  core.computeScales = function computeScales(replay, modes) {
    const layers = replay.meta.model.config.layers;
    const node = { embed: 1e-9, layers: new Array(layers).fill(1e-9) };
    const msg = new Array(layers).fill(1e-9);
    let low = Infinity;
    let high = -Infinity;
    const max = (current, values) => values.reduce((best, value) => (value > best ? value : best), current);
    for (const frame of replay.frames) {
      for (const values of Object.values(frame.embed)) node.embed = max(node.embed, values);
      for (const mode of modes) {
        const states = core.modeStates(frame, mode);
        states.layers.forEach((layer, index) => {
          for (const values of Object.values(layer)) node.layers[index] = max(node.layers[index], values);
        });
        states.msg.forEach((layer, index) => {
          for (const relation of Object.values(layer)) msg[index] = max(max(msg[index], relation.forward), relation.reverse);
        });
      }
      for (const weights of Object.values(frame.relW)) {
        const value = core.relationWeight(weights);
        low = Math.min(low, value);
        high = Math.max(high, value);
      }
    }
    return { node, msg, weight: [low, high] };
  };

  core.indexReplay = function indexReplay(replay) {
    const meta = replay.meta;
    const modes = core.modeOrder(meta.tap.modes);
    const graphs = replay.graphs.map((graph) => {
      const byId = new Map(graph.nodes.map((node) => [node.id, node]));
      const slotIndex = new Map(graph.edges.map((edge, index) => [`${edge.rel}#${edge.slot}`, index]));
      const aligned = { full: graph.edges.slice() };
      for (const [mode, edges] of Object.entries(graph.edgesByMode)) {
        const list = new Array(graph.edges.length).fill(null);
        for (const edge of edges) {
          const index = slotIndex.get(`${edge.rel}#${edge.slot}`);
          if (index === undefined) throw new Error(`${mode} edge ${edge.rel}#${edge.slot} has no slot in ${graph.variant}`);
          list[index] = edge;
        }
        aligned[mode] = list;
      }
      const byRelation = {};
      for (const relation of meta.vocabulary.relationTypes) byRelation[relation] = [];
      graph.edges.forEach((edge, index) => byRelation[edge.rel].push(index));
      const typeCounts = {};
      for (const node of graph.nodes) typeCounts[node.type] = (typeCounts[node.type] || 0) + 1;
      return Object.assign({}, graph, { byId, aligned, byRelation, typeCounts });
    });
    const frames = replay.frames;
    return {
      replay,
      meta,
      final: replay.final,
      vocabulary: meta.vocabulary,
      relations: meta.vocabulary.relationTypes,
      modes,
      graphs,
      frames,
      layers: meta.model.config.layers,
      steps: frames.reduce((best, frame) => Math.max(best, frame.step), 0),
      scales: core.computeScales(replay, modes),
    };
  };

  core.computeLayout = function computeLayout(index) {
    const zoneIds = [...new Set(index.graphs.flatMap((graph) => graph.nodes.filter((node) => node.type === 'Zone').map((node) => node.id)))].sort();
    const radius = zoneIds.length > 1 ? 10.5 : 0;
    const zones = zoneIds.map((id, position) => {
      const angle = Math.PI / 2 + (2 * Math.PI * position) / zoneIds.length;
      return { id, angle, center: [radius * Math.cos(angle), 0, radius * Math.sin(angle)] };
    });
    const zoneById = new Map(zones.map((zone) => [zone.id, zone]));
    const byId = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
    const graphs = index.graphs.map((graph) => {
      const place = new Map();
      const zoneOf = {};
      const hostOf = {};
      for (const edge of graph.edges) {
        if (edge.rel === 'LOCATED_IN') zoneOf[edge.from] = edge.to;
        if (edge.rel === 'RUNS_ON') hostOf[edge.from] = edge.to;
      }
      for (const zone of zones) place.set(zone.id, { fixed: [zone.center[0], -0.7, zone.center[2]] });
      const groups = new Map();
      for (const node of graph.nodes.filter((item) => item.type === 'Node')) {
        const key = zoneOf[node.id] || '';
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(node.id);
      }
      for (const [zoneId, ids] of groups) {
        const zone = zoneById.get(zoneId);
        const center = zone ? zone.center : [0, 0, 0];
        const angle = zone ? zone.angle : 0;
        const spread = ids.length > 1 ? 2.4 : 0;
        ids.sort(byId).forEach((id, position) => {
          const theta = angle + Math.PI / 2 + (2 * Math.PI * position) / ids.length;
          place.set(id, { fixed: [center[0] + spread * Math.cos(theta), 0, center[2] + spread * Math.sin(theta)] });
        });
      }
      const pods = new Map();
      for (const node of graph.nodes.filter((item) => item.type === 'Pod')) {
        const key = hostOf[node.id] && place.has(hostOf[node.id]) ? hostOf[node.id] : '';
        if (!pods.has(key)) pods.set(key, []);
        pods.get(key).push(node.id);
      }
      for (const [host, ids] of pods) {
        ids.sort(byId).forEach((id, position) => {
          const phase = (2 * Math.PI * position) / ids.length;
          place.set(id, host
            ? { host, radius: 1.3, height: 0.9, phase }
            : { fixed: [2.2 * Math.cos(phase), 2.4, 2.2 * Math.sin(phase)] });
        });
      }
      const anchors = {
        // Deployment in the middle; the others around it, none directly in front of it.
        Deployment: { angle: null, y: 6.6 },
        Service: { angle: Math.PI / 2 + Math.PI / 3, y: 8.4 },
        HPA: { angle: -Math.PI / 2, y: 8.4 },
        PDB: { angle: Math.PI / 2 - Math.PI / 3, y: 8.4 },
      };
      for (const type of CONTROL_PLANE) {
        const ids = graph.nodes.filter((node) => node.type === type).map((node) => node.id).sort(byId);
        const anchor = anchors[type];
        const base = anchor.angle === null ? [0, anchor.y, 0] : [4.2 * Math.cos(anchor.angle), anchor.y, 4.2 * Math.sin(anchor.angle)];
        const tangent = anchor.angle === null ? [1, 0, 0] : [-Math.sin(anchor.angle), 0, Math.cos(anchor.angle)];
        ids.forEach((id, position) => {
          const offset = 1.7 * (position - (ids.length - 1) / 2);
          place.set(id, { fixed: [base[0] + tangent[0] * offset, base[1], base[2] + tangent[2] * offset] });
        });
      }
      graph.nodes.forEach((node, position) => {
        if (!place.has(node.id)) place.set(node.id, { fixed: [0, 3.5 + position * 0.4, 0] });
      });
      return { place, zoneOf, hostOf };
    });
    const ringRadius = 4.7;
    const orb = [0, 13.4, 0];
    // Bounding sphere of everything drawn, so the camera can frame the scene at any aspect.
    const extents = [orb, [orb[0], orb[1] + 2.4, orb[2]]];
    for (const zone of zones) {
      for (let step = 0; step < 16; step += 1) {
        const angle = (2 * Math.PI * step) / 16;
        extents.push([zone.center[0] + ringRadius * Math.cos(angle), -0.7, zone.center[2] + ringRadius * Math.sin(angle)]);
      }
    }
    for (const graph of graphs) {
      for (const entry of graph.place.values()) if (entry.fixed) extents.push(entry.fixed);
    }
    const low = [0, 1, 2].map((axis) => Math.min(...extents.map((item) => item[axis])));
    const high = [0, 1, 2].map((axis) => Math.max(...extents.map((item) => item[axis])));
    const center = low.map((value, axis) => (value + high[axis]) / 2);
    const reach = Math.max(...extents.map((item) => Math.hypot(item[0] - center[0], item[1] - center[1], item[2] - center[2])));
    return { zones, graphs, orb, ringRadius, bounds: { center, radius: reach } };
  };

  core.positionAt = function positionAt(layoutGraph, id, time) {
    const entry = layoutGraph.place.get(id);
    if (!entry) return [0, 0, 0];
    if (entry.fixed) return entry.fixed.slice();
    const host = core.positionAt(layoutGraph, entry.host, time);
    const angle = entry.phase + POD_SPIN * time;
    return [host[0] + entry.radius * Math.cos(angle), host[1] + entry.height, host[2] + entry.radius * Math.sin(angle)];
  };

  core.relationColor = function relationColor(mode, relation, vocabulary) {
    if (mode === 'collapsed-edge-types') return COLLAPSED_COLOR;
    if (mode === 'random-relation-labels') return RELATION_COLORS[vocabulary.randomRelationLabels[relation]] || RELATION_COLORS[relation];
    return RELATION_COLORS[relation];
  };

  // Normalized ||W||F for the transform a relation is actually sent through in `mode`.
  core.relationGlow = function relationGlow(index, frame, mode, relation) {
    const [low, high] = index.scales.weight;
    const normalized = (name) => (core.relationWeight(frame.relW[name]) - low) / Math.max(1e-9, high - low);
    if (mode === 'collapsed-edge-types') return index.relations.reduce((sum, name) => sum + normalized(name), 0) / index.relations.length;
    if (mode === 'random-relation-labels') return normalized(index.vocabulary.randomRelationLabels[relation]);
    return normalized(relation);
  };

  core.margin = function margin(frame, mode) {
    const risks = frame.risk[mode];
    return risks[1] - risks[0];
  };

  core.formatP = function formatP(value) {
    if (value === null || value === undefined) return '—';
    if (value >= 0.001) return value.toFixed(value >= 0.1 ? 2 : 3);
    const [mantissa, exponent] = value.toExponential(1).split('e');
    const superscript = { '-': '⁻', 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹' };
    return `${mantissa} × 10${String(Number(exponent)).split('').map((character) => superscript[character]).join('')}`;
  };

  const percent = (value) => `${(100 * value).toFixed(1)}%`;
  const span = (values, format) => {
    const low = Math.min(...values);
    const high = Math.max(...values);
    return low === high ? format(low) : `${format(low)}–${format(high)}`;
  };

  // One display row per published model/mode; seeded modes collapse to ranges, as in the README.
  core.publishedRows = function publishedRows(final) {
    const groups = [];
    for (const row of final.rows) {
      const key = `${row.artifact}|${row.baseMode}`;
      let group = groups.find((item) => item.key === key);
      if (!group) {
        group = { key, artifact: row.artifact, baseMode: row.baseMode, label: row.label, rows: [] };
        groups.push(group);
      }
      group.rows.push(row);
    }
    return groups.map((group) => {
      const rows = group.rows;
      const seeds = rows.map((row) => row.edgeSeed).filter((seed) => seed !== null);
      const pValues = rows.map((row) => row.pValue).filter((value) => value !== null);
      return {
        artifact: group.artifact,
        baseMode: group.baseMode,
        label: group.label,
        seeds,
        pairs: rows[0].pairs,
        correct: span(rows.map((row) => row.correct), String),
        ties: span(rows.map((row) => row.ties), String),
        accuracy: span(rows.map((row) => row.tieAwareAccuracy), percent),
        interval: rows.length === 1
          ? `[${percent(rows[0].bootstrap95[0])}, ${percent(rows[0].bootstrap95[1])}]`
          : `[${percent(Math.min(...rows.map((row) => row.bootstrap95[0])))}, ${percent(Math.max(...rows.map((row) => row.bootstrap95[1])))}]`,
        pValue: pValues.length === 0 ? '—' : pValues.length === 1 ? core.formatP(pValues[0]) : `${core.formatP(Math.min(...pValues))} … ${core.formatP(Math.max(...pValues))}`,
      };
    });
  };

  // The training loss a frame reports: the batch loss at a step, the epoch mean at an
  // epoch end, and for the restored best checkpoint the mean of the epoch it came from.
  core.frameLoss = function frameLoss(index, frameIndex) {
    const frame = index.frames[frameIndex];
    if (typeof frame.trainLoss === 'number') return frame.trainLoss;
    if (frame.phase === 'best') {
      const source = index.frames.find((item) => item.phase === 'epoch' && item.epoch === frame.epoch);
      if (source) return source.trainLoss;
    }
    return null;
  };

  core.statusLine = function statusLine(index, frameIndex) {
    const frame = index.frames[frameIndex];
    const value = core.frameLoss(index, frameIndex);
    const loss = value === null ? 'n/a' : value.toFixed(3);
    const sha = (index.meta.corpus && index.meta.corpus.manifestSha256) || '';
    return [
      '● REPLAY',
      index.meta.model.architecture,
      `seed ${index.meta.seed}`,
      `step ${frame.step}/${index.steps}`,
      `loss ${loss}`,
      `corpus sha ${sha.slice(0, 4)}…`,
    ].join(' — ');
  };

  core.frameLabel = function frameLabel(index, frameIndex) {
    const frame = index.frames[frameIndex];
    const head = `FRAME ${frameIndex + 1}/${index.frames.length} · STEP ${frame.step}/${index.steps}`;
    if (frame.phase === 'init') return `${head} · BEFORE THE FIRST STEP`;
    if (frame.phase === 'best') return `${head} · RESTORED BEST CHECKPOINT (EPOCH ${frame.epoch})`;
    if (frame.phase === 'epoch') {
      const auroc = frame.validation && frame.validation.auroc !== null ? frame.validation.auroc.toFixed(3) : '—';
      return `${head} · END OF EPOCH ${frame.epoch} · VAL AUROC ${auroc}`;
    }
    return `${head} · EPOCH ${frame.epoch}`;
  };

  core.cycle = function cycle(layers) {
    const phases = [{ id: 'encode', label: 'INPUT ENCODERS · PER-TYPE LINEAR + RELU', seconds: 0.8, stage: 'embed' }];
    for (let layer = 0; layer < layers; layer += 1) {
      const name = `LAYER ${layer + 1}`;
      const before = layer === 0 ? 'embed' : layer - 1;
      phases.push({ id: `l${layer}f`, label: `${name} · MESSAGES SOURCE → TARGET`, seconds: 1.05, layer, direction: 1, stage: before });
      phases.push({ id: `l${layer}r`, label: `${name} · MESSAGES TARGET → SOURCE`, seconds: 1.05, layer, direction: -1, stage: before });
      phases.push({ id: `l${layer}u`, label: `${name} · MEAN AGGREGATE + SELF · LAYERNORM · RELU`, seconds: 0.6, update: [before, layer], stage: layer });
    }
    phases.push({ id: 'readout', label: 'READOUT · TYPED MEAN POOL + ACTION + TARGET NODE → RISK HEAD', seconds: 1.2, stage: layers - 1, readout: true });
    phases.push({ id: 'hold', label: 'SIGMOID RISK', seconds: 1.0, stage: layers - 1, hold: true });
    let start = 0;
    for (const phase of phases) {
      phase.start = start;
      start += phase.seconds;
    }
    return { phases, period: start };
  };

  core.cycleAt = function cycleAt(plan, time) {
    const t = ((time % plan.period) + plan.period) % plan.period;
    const phase = plan.phases.find((item) => t >= item.start && t < item.start + item.seconds) || plan.phases[plan.phases.length - 1];
    return { phase, progress: Math.min(1, (t - phase.start) / phase.seconds), position: plan.phases.indexOf(phase) };
  };

  global.ObservatoryCore = core;
  if (!global.document || typeof global.document.getElementById !== 'function') return;

  // ------------------------------------------------------------------ page

  const $ = (id) => document.getElementById(id);
  const escape = (value) => String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  const params = new URLSearchParams(location.search);
  const motionQuery = global.matchMedia ? global.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
  const still = params.has('t') ? Math.max(0, Number(params.get('t')) || 0) : null;
  if (params.get('capture') === 'stage') document.body.dataset.capture = 'stage';

  const state = {
    frame: 0,
    mode: 'full',
    graph: 1,
    playing: false,
    reduced: Boolean(motionQuery.matches),
    hovered: null,
  };
  let index = null;
  let scene = null;
  const listeners = [];

  function fatal(message) {
    const element = $('obs-fatal');
    element.textContent = message;
    element.hidden = false;
  }

  function hasWebGL() {
    try {
      const canvas = document.createElement('canvas');
      return Boolean(canvas.getContext('webgl2') || canvas.getContext('webgl'));
    } catch (error) {
      return false;
    }
  }

  function showFallback(reason) {
    const image = $('obs-fallback-img');
    image.src = FALLBACK_URL;
    image.hidden = false;
    // The still already shows the scene's own labels; the legend and panel stay live.
    $('obs-labels').hidden = true;
    document.querySelector('.obs-hud-phase').hidden = true;
    fatal(`${reason} Showing a still frame; the timeline, risks and published numbers below are live.`);
    $('obs-fatal').classList.add('obs-fatal-banner');
  }

  function setState(patch) {
    const previous = Object.assign({}, state);
    Object.assign(state, patch);
    for (const listener of listeners) listener(state, previous);
  }

  // --------------------------------------------------------------- static panel

  function pairSvg(graph, other) {
    const zones = graph.nodes.filter((node) => node.type === 'Zone').map((node) => node.id).sort();
    const zoneOf = {};
    const hostOf = {};
    const otherHost = {};
    for (const edge of graph.edges) {
      if (edge.rel === 'LOCATED_IN') zoneOf[edge.from] = edge.to;
      if (edge.rel === 'RUNS_ON') hostOf[edge.from] = edge.to;
    }
    for (const edge of other.edges) if (edge.rel === 'RUNS_ON') otherHost[edge.from] = edge.to;
    const columns = zones.map((zone) => graph.nodes.filter((node) => node.type === 'Node' && zoneOf[node.id] === zone).map((node) => node.id).sort());
    const width = 168;
    const columnWidth = width / Math.max(1, zones.length);
    const rows = Math.max(1, ...columns.map((column) => column.length));
    const height = 18 + rows * 28;
    const parts = [`<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escape(`Placement in member ${graph.variant}`)}">`];
    zones.forEach((zone, column) => {
      const x = column * columnWidth;
      parts.push(`<text x="${x + columnWidth / 2}" y="9" text-anchor="middle" fill="#ffb347" fill-opacity=".7" font-family="Consolas,monospace" font-size="7" letter-spacing="1">${escape(zone.split('/')[1].toUpperCase())}</text>`);
      columns[column].forEach((nodeId, row) => {
        const y = 15 + row * 28;
        const target = nodeId === graph.target;
        parts.push(`<rect x="${x + 4}" y="${y}" width="${columnWidth - 8}" height="22" rx="2" fill="#000" stroke="${target ? '#ff6b6b' : 'rgba(236,232,223,.28)'}" stroke-width="${target ? 1.2 : 0.8}"/>`);
        parts.push(`<text x="${x + 7}" y="${y + 8}" fill="${target ? '#ff6b6b' : '#8f8a80'}" font-family="Consolas,monospace" font-size="6">${escape(nodeId.split('/')[1])}${target ? ' ✕' : ''}</text>`);
        const pods = Object.keys(hostOf).filter((pod) => hostOf[pod] === nodeId).sort();
        pods.forEach((pod, position) => {
          const moved = otherHost[pod] !== nodeId;
          const cx = x + 10 + position * 9;
          parts.push(`<circle cx="${cx}" cy="${y + 15}" r="3" fill="#4fd8ff" fill-opacity=".85"/>`);
          if (moved) parts.push(`<circle cx="${cx}" cy="${y + 15}" r="4.8" fill="none" stroke="#fff" stroke-width=".8"/>`);
        });
      });
    });
    parts.push('</svg>');
    return parts.join('');
  }

  function renderStatic() {
    const meta = index.meta;
    const probe = meta.probe;
    const training = meta.training || {};
    $('obs-model-meta').textContent = `${meta.model.architecture} · ${meta.model.parameterCount.toLocaleString('en-US')} PARAMETERS · ${index.layers} × ${meta.model.config.hidden_dim}-D RELATION LAYERS · ${index.relations.length} RELATIONS`;
    $('obs-probe-title').textContent = `PROBE ${probe.pairId.toUpperCase()} · ${String(probe.family).toUpperCase()} · ${String(probe.split).toUpperCase()} SPLIT`;
    $('obs-probe-rule').textContent = `Chosen by rule, not by score: the ${probe.rule}.`;
    const moved = index.graphs[0].edges.filter((edge) => edge.rel === 'RUNS_ON')
      .filter((edge) => !index.graphs[1].edges.some((other) => other.rel === 'RUNS_ON' && other.from === edge.from && other.to === edge.to))
      .map((edge) => edge.from.split('/')[1]);
    const action = index.graphs[0].action;
    $('obs-blind').innerHTML = `A and B have <b>identical pooled inputs</b>: the same node-feature rows per resource type and the same action vector (checked at export with the Phase II-B.2 construction check). They differ only in <b>${escape(probe.relationsDiffer.join(', '))}</b>${moved.length ? ` (${escape(moved.join(', '))} is wired to a different node)` : ''}. A model that sees only pooled features must give both the same score; it can rank them only by reading the wiring. The action is <b>${escape(action.type)}</b> on <b>${escape(index.graphs[0].target || '—')}</b>.`;

    const final = index.final;
    $('obs-published-sub').textContent = `${final.pairs} relational-only, outcome-discordant pairs · five-seed ensembles · graph attribution ${final.graphAttribution} (${Object.values(final.criteria).filter(Boolean).length}/${Object.keys(final.criteria).length} pre-registered criteria)`;
    const margins = (final.probePair && final.probePair.margins) || {};
    const onPair = [
      ['Full GNN on this pair', margins['gnn-full-k5|full']],
      ['Pooled MLP on this pair', margins['pooled-mlp-k5|full']],
      ['Full GNN, no edges', margins['gnn-full-k5|no-edges']],
    ].filter(([, value]) => value !== undefined);
    $('obs-onpair').innerHTML = onPair.length
      ? onPair.map(([label, value]) => `<span>${escape(label)} · margin</span><span>${value > 0 ? '+' : ''}${value.toFixed(4)} ${Math.abs(value) <= final.tieTolerance ? 'tie' : value > 0 ? '✓' : '✗'}</span>`).join('')
      : '';
    const rows = core.publishedRows(final);
    $('obs-table').innerHTML = `<thead><tr><th>MODEL</th><th>CORRECT</th><th>TIES</th><th>ACC.</th><th>95% CI</th><th>P</th></tr></thead><tbody>${rows.map((row) => `
      <tr data-artifact="${escape(row.artifact)}" data-mode="${escape(row.baseMode)}" class="${row.artifact === 'gnn-full-k5' && row.baseMode === 'full' ? 'lead' : ''}">
        <td>${escape(row.label)}${row.seeds.length ? `<small>${row.seeds.length} edge seeds</small>` : ''}</td>
        <td>${escape(row.correct)}/${row.pairs}</td><td>${escape(row.ties)}</td><td>${escape(row.accuracy)}</td><td>${escape(row.interval)}</td><td>${escape(row.pValue)}</td>
      </tr>`).join('')}</tbody>`;
    $('obs-table-note').textContent = 'Tie-aware pairwise accuracy; ties within 1e-6 count as half. Collapsed and random-label modes keep the wiring, so they are diagnostics, not connectivity destruction; the report shows relation types are not used stably across models.';
    $('obs-claim').innerHTML = `<p>The supported claim is exactly this: “${escape(final.supportedClaim)}” Deterministic CloudProof remains the verifier.</p><cite>Quoted from README.md · numbers from ${escape(final.sources.counterfactualRanking.path)}</cite>`;
    $('obs-notice').innerHTML = `<b>${escape(meta.notice)}</b> This run: seed ${meta.seed}, ${training.epochs} epochs on the first ${Number(training.maxTrainRecords).toLocaleString('en-US')} training rows, ${index.steps} optimizer steps, a frame every ${meta.tap.everySteps} steps. Risk is the sigmoid output of a model trained with weighted BCE (positive weight ${Number(training.positiveWeight).toFixed(2)}), so compare A with B rather than reading it as a probability. Probe ${escape(probe.recordIds.join(' / '))}, corpus manifest ${escape(meta.corpus.manifestSha256.slice(0, 12))}…, exported at ${escape((meta.git.commitSha || '').slice(0, 7))}.`;

    // Mode and member controls.
    const seed = meta.tap.edgeSeed;
    $('obs-modes').innerHTML = `<span class="obs-control-label">ABLATION</span>${index.modes.map((mode, position) => `<button type="button" role="radio" data-mode="${escape(mode)}" aria-checked="false" title="${escape(MODE_INFO[mode] ? MODE_INFO[mode].note(seed) : mode)}"><kbd>${position + 1}</kbd>${escape(MODE_INFO[mode] ? MODE_INFO[mode].label : mode.toUpperCase())}</button>`).join('')}`;
    $('obs-members').innerHTML = `<span class="obs-control-label">MEMBER</span>${index.graphs.map((graph, position) => `<button type="button" role="radio" data-graph="${position}" aria-checked="false"><kbd>${escape(graph.variant)}</kbd>${graph.outcome.trajectoryUnsafe ? 'UNSAFE' : 'SAFE'}</button>`).join('')}`;
    $('obs-modes').querySelectorAll('button').forEach((button) => button.addEventListener('click', () => setState({ mode: button.dataset.mode })));
    $('obs-members').querySelectorAll('button').forEach((button) => button.addEventListener('click', () => setState({ graph: Number(button.dataset.graph) })));

    $('obs-pair').innerHTML = index.graphs.map((graph, position) => {
      const other = index.graphs[1 - position];
      const outcome = graph.outcome;
      return `<button type="button" class="obs-member" data-graph="${position}" aria-pressed="false">
        <header><span>${escape(graph.variant)} · ${escape(String(graph.arm || '').toUpperCase())}</span><em class="${outcome.trajectoryUnsafe ? 'unsafe' : 'safe'}">${outcome.trajectoryUnsafe ? 'UNSAFE' : 'SAFE'}</em></header>
        ${pairSvg(graph, other)}
        <div class="risk" data-risk="${position}"><small>RISK · FULL</small>—</div>
        <div class="bar"><b data-bar="${position}" style="width:0%"></b></div>
        <div class="why">${escape(String(graph.role || '').replace(/-/g, ' '))} · simulator: ${escape(outcome.trajectoryUnsafe ? (outcome.incidentClass || 'violation').toLowerCase().replace(/_/g, ' ') : 'no violation')}</div>
      </button>`;
    }).join('');
    $('obs-pair').querySelectorAll('.obs-member').forEach((button) => button.addEventListener('click', () => setState({ graph: Number(button.dataset.graph) })));

    renderSparkline();
    const scrubber = $('obs-scrubber');
    scrubber.max = String(index.frames.length - 1);
    scrubber.addEventListener('input', () => setState({ frame: Number(scrubber.value), playing: false }));
    $('obs-play').addEventListener('click', togglePlay);
  }

  function renderSparkline() {
    const frames = index.frames;
    const losses = frames.filter((frame) => frame.phase === 'step' && frame.trainLoss !== null);
    const epochs = frames.filter((frame) => frame.phase === 'epoch');
    const values = losses.concat(epochs).map((frame) => frame.trainLoss);
    const low = Math.min(...values);
    const high = Math.max(...values);
    const x = (step) => (600 * step) / Math.max(1, index.steps);
    const y = (value) => 30 - (26 * (value - low)) / Math.max(1e-9, high - low);
    const line = losses.map((frame) => `${x(frame.step).toFixed(1)},${y(frame.trainLoss).toFixed(1)}`).join(' ');
    const ticks = epochs.map((frame) => `<line x1="${x(frame.step)}" x2="${x(frame.step)}" y1="0" y2="34" stroke="rgba(236,232,223,.14)" stroke-dasharray="2 3"/><circle cx="${x(frame.step)}" cy="${y(frame.trainLoss)}" r="2.4" fill="#ffb347"/><text x="${x(frame.step) - 3}" y="8" text-anchor="end" fill="#5f5b55" font-family="Consolas,monospace" font-size="7">E${frame.epoch}</text>`).join('');
    $('obs-spark').innerHTML = `<polyline points="${line}" fill="none" stroke="rgba(79,216,255,.55)" stroke-width="1" vector-effect="non-scaling-stroke"/>${ticks}<line id="obs-spark-cursor" x1="0" x2="0" y1="0" y2="34" stroke="#4fd8ff" stroke-width="1" vector-effect="non-scaling-stroke"/>`;
  }

  // -------------------------------------------------------------- dynamic panel

  function renderDynamic() {
    const frame = index.frames[state.frame];
    const mode = state.mode;
    const risks = frame.risk[mode];
    index.graphs.forEach((graph, position) => {
      const risk = document.querySelector(`[data-risk="${position}"]`);
      risk.innerHTML = `<small>RISK · ${escape(MODE_INFO[mode] ? MODE_INFO[mode].label : mode)}</small>${risks[position].toFixed(4)}`;
      document.querySelector(`[data-bar="${position}"]`).style.width = `${(100 * risks[position]).toFixed(1)}%`;
    });
    document.querySelectorAll('.obs-member').forEach((button) => button.setAttribute('aria-pressed', String(Number(button.dataset.graph) === state.graph)));
    document.querySelectorAll('#obs-modes button').forEach((button) => button.setAttribute('aria-checked', String(button.dataset.mode === mode)));
    document.querySelectorAll('#obs-members button').forEach((button) => button.setAttribute('aria-checked', String(Number(button.dataset.graph) === state.graph)));

    const riskier = index.graphs.findIndex((graph) => graph.outcome.trajectoryUnsafe);
    const margin = riskier === 1 ? core.margin(frame, mode) : -core.margin(frame, mode);
    const tolerance = index.final.tieTolerance;
    const verdict = Math.abs(margin) <= tolerance
      ? '<span class="no">tie: this model cannot tell A from B here</span>'
      : margin > 0 ? '<span class="ok">ranks the unsafe member higher</span>' : '<span class="no">ranks the safe member higher</span>';
    const unsafe = index.graphs[riskier] ? index.graphs[riskier].variant : 'B';
    const safe = index.graphs[1 - riskier] ? index.graphs[1 - riskier].variant : 'A';
    const signed = Math.abs(margin) <= tolerance ? margin.toFixed(4).replace('-', '') : `${margin > 0 ? '+' : ''}${margin.toFixed(4)}`;
    $('obs-margin').innerHTML = `<strong>${signed}</strong>demo model · risk(${unsafe}) − risk(${safe}) · ${escape(MODE_INFO[mode] ? MODE_INFO[mode].label : mode)} · ${verdict}`;

    document.querySelectorAll('#obs-table tbody tr').forEach((row) => {
      row.classList.toggle('current', row.dataset.artifact === 'gnn-full-k5' && row.dataset.mode === mode);
    });
    // A live region: rewrite it only when the mode changes, not on every replay frame.
    const note = $('obs-mode-note');
    if (note.dataset.mode !== mode) {
      const info = MODE_INFO[mode];
      note.dataset.mode = mode;
      note.innerHTML = `<b>${escape(info ? info.label : mode)}</b>${escape(info ? info.note(index.meta.tap.edgeSeed) : '')}`;
    }

    $('obs-frame').textContent = core.frameLabel(index, state.frame);
    $('obs-status').innerHTML = `<span class="dot">●</span>${escape(core.statusLine(index, state.frame).slice(1))}`;
    const scrubber = $('obs-scrubber');
    if (Number(scrubber.value) !== state.frame) scrubber.value = String(state.frame);
    scrubber.setAttribute('aria-valuetext', `${core.frameLabel(index, state.frame)}; risk A ${risks[0].toFixed(3)}, B ${risks[1].toFixed(3)}`);
    const cursor = $('obs-spark-cursor');
    if (cursor) {
      const x = (600 * frame.step) / Math.max(1, index.steps);
      cursor.setAttribute('x1', x);
      cursor.setAttribute('x2', x);
    }
    $('obs-play').textContent = state.playing ? '❚❚' : '▶';
    $('obs-play').setAttribute('aria-label', state.playing ? 'Pause the training replay' : 'Play the training replay');
    renderLegend(frame, mode);
  }

  function renderLegend(frame, mode) {
    const endpoints = index.vocabulary.relationEndpoints;
    const rows = index.relations.map((relation) => {
      const color = core.relationColor(mode, relation, index.vocabulary);
      const glow = core.relationGlow(index, frame, mode, relation);
      const weight = core.relationWeight(frame.relW[relation]);
      return `<i style="color:${color};background:${color}"></i><span>${relation}<em>${endpoints[relation][0]}→${endpoints[relation][1]}</em></span><span class="lg-bar" style="color:${color}"><b style="width:${(100 * Math.max(0.03, glow)).toFixed(0)}%"></b></span><span class="lg-val">${weight.toFixed(2)}</span>`;
    }).join('');
    $('obs-legend').innerHTML = `<div class="lg-title"><span>RELATION · ‖W‖<sub>F</sub></span><span>STEP ${frame.step}</span></div>${rows}<div class="lg-foot">Edge glow: norm of the transform each relation is sent through. Pulses: each edge's message norm. Node size: hidden-state norm.</div>`;
  }

  // ------------------------------------------------------------------ playback

  function togglePlay() {
    if (!state.playing && state.frame >= index.frames.length - 1) setState({ frame: 0, playing: true });
    else setState({ playing: !state.playing });
  }

  function onKey(event) {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    const tag = event.target && event.target.tagName;
    const onButton = tag === 'BUTTON';
    const onRange = tag === 'INPUT';
    if (event.key === ' ' && !onButton) {
      event.preventDefault();
      togglePlay();
    } else if ((event.key === 'ArrowRight' || event.key === 'ArrowLeft') && !onRange) {
      event.preventDefault();
      const delta = (event.key === 'ArrowRight' ? 1 : -1) * (event.shiftKey ? 10 : 1);
      setState({ frame: Math.max(0, Math.min(index.frames.length - 1, state.frame + delta)), playing: false });
    } else if (/^[1-9]$/.test(event.key) && Number(event.key) <= index.modes.length) {
      setState({ mode: index.modes[Number(event.key) - 1] });
    } else if (event.key === 'a' || event.key === 'A' || event.key === 'b' || event.key === 'B') {
      const position = index.graphs.findIndex((graph) => graph.variant === event.key.toUpperCase());
      if (position >= 0) setState({ graph: position });
    }
  }

  // ------------------------------------------------------------------- 3D scene

  const EDGE_VERTEX = `
    attribute float aT;
    attribute float aMsgF;
    attribute float aMsgR;
    attribute float aAlpha;
    varying float vT;
    varying float vF;
    varying float vR;
    varying float vA;
    void main() {
      vT = aT; vF = aMsgF; vR = aMsgR; vA = aAlpha;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`;
  const EDGE_FRAGMENT = `
    uniform vec3 uColor;
    uniform float uBase;
    uniform float uFade;
    uniform float uHead;
    uniform float uDir;
    uniform float uPulse;
    varying float vT;
    varying float vF;
    varying float vR;
    varying float vA;
    void main() {
      float pulse = 0.0;
      if (uDir > 0.5) {
        float d = uHead - vT;
        pulse = (d >= 0.0 ? exp(-d * 7.0) * step(d, 0.7) : exp(d * 70.0)) * vF;
      } else if (uDir < -0.5) {
        float d = vT - uHead;
        pulse = (d >= 0.0 ? exp(-d * 7.0) * step(d, 0.7) : exp(d * 70.0)) * vR;
      }
      float intensity = (uBase + uPulse * pulse * 1.9) * uFade * vA;
      gl_FragColor = vec4(uColor * intensity, 1.0);
    }`;
  const NODE_VERTEX = `
    attribute vec3 aColor;
    attribute float aSize;
    attribute float aGlow;
    attribute float aAlpha;
    uniform float uScale;
    varying vec3 vColor;
    varying float vGlow;
    void main() {
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      gl_Position = projectionMatrix * mv;
      gl_PointSize = aSize * uScale / max(0.1, -mv.z);
      vColor = aColor;
      vGlow = aGlow * aAlpha;
    }`;
  const NODE_FRAGMENT = `
    varying vec3 vColor;
    varying float vGlow;
    void main() {
      vec2 p = gl_PointCoord * 2.0 - 1.0;
      float r = dot(p, p);
      if (r > 1.0) discard;
      float core = 1.0 - smoothstep(0.0, 0.16, r);
      float halo = exp(-r * 5.0) * 0.5;
      gl_FragColor = vec4(vColor * (core * 1.25 + halo) * vGlow, 1.0);
    }`;
  const ORB_VERTEX = `
    varying vec3 vNormal;
    varying vec3 vView;
    void main() {
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      vNormal = normalize(normalMatrix * normal);
      vView = normalize(-mv.xyz);
      gl_Position = projectionMatrix * mv;
    }`;
  const ORB_FRAGMENT = `
    uniform vec3 uColor;
    uniform float uEnergy;
    varying vec3 vNormal;
    varying vec3 vView;
    void main() {
      // Clamp before pow(): a dot product a hair above 1 gives NaN, and one NaN pixel
      // spreads through the bloom blur and blacks out the whole frame.
      float rim = pow(clamp(1.0 - dot(vNormal, vView), 0.0, 1.0), 2.4);
      gl_FragColor = vec4(uColor * (0.16 + rim * 1.5) * uEnergy, 1.0);
    }`;

  const SEGMENTS = 24;
  // Sprite diameter in world units from a normalized hidden-state norm.
  const sizeFor = (level) => 0.5 + 0.75 * Math.max(0, level);
  const ease = (value) => value * value * (3 - 2 * value);

  function createScene(three, addons) {
    const THREE = three;
    const { OrbitControls, EffectComposer, RenderPass, UnrealBloomPass, OutputPass } = addons;
    const host = $('obs-canvas-host');
    const stage = $('obs-stage');
    const labelsHost = $('obs-labels');
    const layout = core.computeLayout(index);
    const plan = core.cycle(index.layers);
    const relations = index.relations;

    const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
    renderer.setClearColor(0x000000, 1);
    let pixelRatio = Math.min(global.devicePixelRatio || 1, 1.5);
    renderer.setPixelRatio(pixelRatio);
    host.appendChild(renderer.domElement);
    renderer.domElement.setAttribute('role', 'img');
    renderer.domElement.setAttribute('aria-label', 'Probe Kubernetes graph: zones as rings, nodes in zones, pods orbiting nodes, control plane above, relation-coloured edges and a risk orb.');

    const scene3 = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 400);
    const azimuth = params.has('az') ? (Number(params.get('az')) * Math.PI) / 180 : 0.32;
    const elevation = 0.36;
    const fitCenter = new THREE.Vector3(...layout.bounds.center);
    camera.position.set(
      fitCenter.x + Math.sin(azimuth) * Math.cos(elevation),
      fitCenter.y + Math.sin(elevation),
      fitCenter.z + Math.cos(azimuth) * Math.cos(elevation),
    );
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.copy(fitCenter);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.autoRotateSpeed = 0.35;

    // Frame the whole graph and the orb at the current aspect ratio, keeping the view direction.
    function fitCamera() {
      const vertical = (camera.fov * Math.PI) / 360;
      const horizontal = Math.atan(Math.tan(vertical) * camera.aspect);
      // Tighter when height limits the view (labels and HUD sit in the margins), looser on portrait screens.
      const distance = (layout.bounds.radius / Math.sin(Math.min(vertical, horizontal))) * (horizontal < vertical ? 0.98 : 0.8);
      const direction = camera.position.clone().sub(controls.target).normalize();
      controls.target.copy(fitCenter);
      camera.position.copy(fitCenter).addScaledVector(direction, distance);
      controls.minDistance = distance * 0.3;
      controls.maxDistance = distance * 1.8;
      controls.update();
    }

    const samples = global.WebGL2RenderingContext && renderer.capabilities.isWebGL2 ? 4 : 0;
    const target = new THREE.WebGLRenderTarget(2, 2, { type: THREE.HalfFloatType, samples });
    const composer = new EffectComposer(renderer, target);
    composer.addPass(new RenderPass(scene3, camera));
    const bloom = new UnrealBloomPass(new THREE.Vector2(2, 2), 0.85, 0.35, 0.04);
    composer.addPass(bloom);
    composer.addPass(new OutputPass());

    // Zone rings.
    for (const zone of layout.zones) {
      for (const [radius, opacity] of [[layout.ringRadius, 0.2], [layout.ringRadius + 0.16, 0.07]]) {
        const points = [];
        for (let step = 0; step <= 128; step += 1) {
          const angle = (2 * Math.PI * step) / 128;
          points.push(new THREE.Vector3(zone.center[0] + radius * Math.cos(angle), -0.7, zone.center[2] + radius * Math.sin(angle)));
        }
        const ring = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), new THREE.LineBasicMaterial({
          color: new THREE.Color('#9fb2c6'), transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false,
        }));
        scene3.add(ring);
      }
    }

    // Edges: one LineSegments per relation type, quadratic Bezier curves sampled into segments.
    const maxSlots = {};
    for (const relation of relations) maxSlots[relation] = Math.max(...index.graphs.map((graph) => graph.byRelation[relation].length), 0);
    const edgeSets = {};
    for (const relation of relations) {
      const count = maxSlots[relation];
      const vertices = count * SEGMENTS * 2;
      const geometry = new THREE.BufferGeometry();
      const positions = new Float32Array(vertices * 3);
      const along = new Float32Array(vertices);
      for (let slot = 0; slot < count; slot += 1) {
        for (let segment = 0; segment < SEGMENTS; segment += 1) {
          const base = (slot * SEGMENTS + segment) * 2;
          along[base] = segment / SEGMENTS;
          along[base + 1] = (segment + 1) / SEGMENTS;
        }
      }
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
      geometry.setAttribute('aT', new THREE.BufferAttribute(along, 1));
      for (const name of ['aMsgF', 'aMsgR', 'aAlpha']) geometry.setAttribute(name, new THREE.BufferAttribute(new Float32Array(vertices), 1).setUsage(THREE.DynamicDrawUsage));
      const material = new THREE.ShaderMaterial({
        uniforms: {
          uColor: { value: new THREE.Color(RELATION_COLORS[relation]) },
          uBase: { value: 0.12 },
          uFade: { value: 1 },
          uHead: { value: -1 },
          uDir: { value: 0 },
          uPulse: { value: 1 },
        },
        vertexShader: EDGE_VERTEX,
        fragmentShader: EDGE_FRAGMENT,
        transparent: true,
        depthWrite: false,
        depthTest: false,
        blending: THREE.AdditiveBlending,
      });
      const lines = new THREE.LineSegments(geometry, material);
      lines.frustumCulled = false;
      scene3.add(lines);
      const slots = [];
      for (let slot = 0; slot < count; slot += 1) slots.push({ previous: null, next: null, k: 1, msgF: 0, msgR: 0, alpha: 1, hover: 1 });
      edgeSets[relation] = {
        geometry, material, slots, count,
        base: 0.12, baseTarget: 0.12,
        color: new THREE.Color(RELATION_COLORS[relation]), colorTarget: new THREE.Color(RELATION_COLORS[relation]),
      };
    }

    // Readout streams from every node of the shown member to the risk orb.
    const nodeSlots = Math.max(...index.graphs.map((graph) => graph.nodes.length));
    const streamGeometry = new THREE.BufferGeometry();
    const streamVertices = nodeSlots * SEGMENTS * 2;
    const streamAlong = new Float32Array(streamVertices);
    for (let slot = 0; slot < nodeSlots; slot += 1) {
      for (let segment = 0; segment < SEGMENTS; segment += 1) {
        const base = (slot * SEGMENTS + segment) * 2;
        streamAlong[base] = segment / SEGMENTS;
        streamAlong[base + 1] = (segment + 1) / SEGMENTS;
      }
    }
    streamGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(streamVertices * 3), 3).setUsage(THREE.DynamicDrawUsage));
    streamGeometry.setAttribute('aT', new THREE.BufferAttribute(streamAlong, 1));
    for (const name of ['aMsgF', 'aMsgR', 'aAlpha']) streamGeometry.setAttribute(name, new THREE.BufferAttribute(new Float32Array(streamVertices), 1).setUsage(THREE.DynamicDrawUsage));
    const streamMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color('#f4f1ff') },
        uBase: { value: 0.025 },
        uFade: { value: 1 },
        uHead: { value: -1 },
        uDir: { value: 0 },
        uPulse: { value: 1 },
      },
      vertexShader: EDGE_VERTEX,
      fragmentShader: EDGE_FRAGMENT,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    });
    const streams = new THREE.LineSegments(streamGeometry, streamMaterial);
    streams.frustumCulled = false;
    scene3.add(streams);

    // Nodes.
    const nodeGeometry = new THREE.BufferGeometry();
    nodeGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(nodeSlots * 3), 3).setUsage(THREE.DynamicDrawUsage));
    nodeGeometry.setAttribute('aColor', new THREE.BufferAttribute(new Float32Array(nodeSlots * 3), 3).setUsage(THREE.DynamicDrawUsage));
    for (const name of ['aSize', 'aGlow', 'aAlpha']) nodeGeometry.setAttribute(name, new THREE.BufferAttribute(new Float32Array(nodeSlots), 1).setUsage(THREE.DynamicDrawUsage));
    const nodeMaterial = new THREE.ShaderMaterial({
      uniforms: { uScale: { value: 400 } },
      vertexShader: NODE_VERTEX,
      fragmentShader: NODE_FRAGMENT,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    });
    const points = new THREE.Points(nodeGeometry, nodeMaterial);
    points.frustumCulled = false;
    scene3.add(points);

    // Risk orb and the action-target marker.
    const orbMaterial = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color('#ff6b6b') }, uEnergy: { value: 0.6 } },
      vertexShader: ORB_VERTEX,
      fragmentShader: ORB_FRAGMENT,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const orb = new THREE.Mesh(new THREE.SphereGeometry(0.72, 48, 32), orbMaterial);
    orb.position.set(...layout.orb);
    scene3.add(orb);
    const markerPoints = [];
    for (let step = 0; step <= 64; step += 1) {
      const angle = (2 * Math.PI * step) / 64;
      markerPoints.push(new THREE.Vector3(Math.cos(angle) * 0.95, 0, Math.sin(angle) * 0.95));
    }
    const marker = new THREE.Line(new THREE.BufferGeometry().setFromPoints(markerPoints), new THREE.LineBasicMaterial({
      color: new THREE.Color('#ff6b6b'), transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false,
    }));
    scene3.add(marker);

    // DOM labels.
    const nodeIds = [...new Set(index.graphs.flatMap((graph) => graph.nodes.map((node) => node.id)))];
    const labels = new Map();
    for (const id of nodeIds) {
      const node = index.graphs[0].byId.get(id) || index.graphs[1].byId.get(id);
      const element = document.createElement('div');
      element.className = 'obs-label';
      element.dataset.kind = node.type === 'Zone' ? 'zone' : CONTROL_PLANE.includes(node.type) ? 'control' : 'node';
      element.textContent = node.type === 'Zone' || node.type === 'Pod' || node.type === 'Node' ? node.label : `${node.type} · ${node.label}`;
      labelsHost.appendChild(element);
      labels.set(id, element);
    }
    const riskLabel = document.createElement('div');
    riskLabel.className = 'obs-label obs-label-risk';
    labelsHost.appendChild(riskLabel);
    const targetLabel = document.createElement('div');
    targetLabel.className = 'obs-label obs-label-target';
    labelsHost.appendChild(targetLabel);

    // Smoothed per-node positions, so A <-> B and layout changes glide.
    const rendered = new Map();
    let clock = still === null ? 0 : still;
    const raycaster = new THREE.Raycaster();
    const pointer = { x: 0, y: 0, inside: false, dirty: false, clientX: 0, clientY: 0 };
    const temp = new THREE.Vector3();
    const tempB = new THREE.Vector3();
    let width = 2;
    let height = 2;
    let frameTimes = [];
    let lastNow = null;
    let orbEnergy = 0.6;
    const scratchColor = new THREE.Color();
    const coolColor = new THREE.Color('#4fd8ff');
    const hotColor = new THREE.Color('#ff6b6b');

    function targetPosition(graphIndex, id, time) {
      return core.positionAt(layout.graphs[graphIndex], id, time);
    }

    function nodePosition(id) {
      return rendered.get(id) || targetPosition(state.graph, id, clock);
    }

    function displayed(graph, mode) {
      // For each relation, the edge each slot shows in (graph, mode); null when absent.
      const result = {};
      for (const relation of relations) {
        result[relation] = graph.byRelation[relation].map((edgeIndex) => graph.aligned[mode] ? graph.aligned[mode][edgeIndex] : graph.edges[edgeIndex]);
      }
      return result;
    }

    function retargetEdges(instant) {
      const graph = index.graphs[state.graph];
      const shown = displayed(graph, state.mode);
      for (const relation of relations) {
        const set = edgeSets[relation];
        set.slots.forEach((slot, position) => {
          const next = shown[relation][position] || null;
          const same = (left, right) => (left && right ? left.from === right.from && left.to === right.to : left === right);
          if (same(slot.next, next)) return;
          // Re-wire from whatever the slot shows now (mid-tween: the nearer end state).
          slot.previous = slot.k > 0.5 ? slot.next : slot.previous;
          slot.next = next;
          slot.k = instant ? 1 : 0;
        });
        set.colorTarget.set(core.relationColor(state.mode, relation, index.vocabulary));
        if (instant) set.color.copy(set.colorTarget);
      }
    }

    function applyFrameData() {
      const frame = index.frames[state.frame];
      for (const relation of relations) {
        edgeSets[relation].baseTarget = 0.05 + 0.3 * core.relationGlow(index, frame, state.mode, relation);
      }
    }

    // Per-edge message norms for one layer. `edge.slot` is the edge's column in the
    // tap's batch, which is exactly how frame.msg is indexed.
    let messageKey = null;
    function updateMessages(layer) {
      const key = `${layer}|${state.frame}|${state.mode}|${state.graph}`;
      if (key === messageKey) return;
      messageKey = key;
      const frame = index.frames[state.frame];
      const states = core.modeStates(frame, state.mode);
      const scale = index.scales.msg[layer] || 1;
      const shown = displayed(index.graphs[state.graph], state.mode);
      for (const relation of relations) {
        const set = edgeSets[relation];
        const messages = states.msg[layer][relation];
        const forward = set.geometry.getAttribute('aMsgF');
        const reverse = set.geometry.getAttribute('aMsgR');
        set.slots.forEach((slot, position) => {
          const edge = shown[relation][position];
          const f = edge ? (messages.forward[edge.slot] || 0) / scale : 0;
          const r = edge ? (messages.reverse[edge.slot] || 0) / scale : 0;
          forward.array.fill(f, position * SEGMENTS * 2, (position + 1) * SEGMENTS * 2);
          reverse.array.fill(r, position * SEGMENTS * 2, (position + 1) * SEGMENTS * 2);
        });
        forward.needsUpdate = true;
        reverse.needsUpdate = true;
      }
    }

    function stageNorms(stage) {
      const frame = index.frames[state.frame];
      if (stage === 'embed') return { values: frame.embed, scale: index.scales.node.embed };
      return { values: core.modeStates(frame, state.mode).layers[stage], scale: index.scales.node.layers[stage] };
    }

    function nodeNorm(node, stage) {
      const { values, scale } = stageNorms(stage);
      return values[node.type][node.batchIndex] / scale;
    }

    function curve(start, end, lift, out, t) {
      const mx = (start[0] + end[0]) / 2;
      const my = (start[1] + end[1]) / 2 + lift;
      const mz = (start[2] + end[2]) / 2;
      const u = 1 - t;
      out[0] = u * u * start[0] + 2 * u * t * mx + t * t * end[0];
      out[1] = u * u * start[1] + 2 * u * t * my + t * t * end[1];
      out[2] = u * u * start[2] + 2 * u * t * mz + t * t * end[2];
      return out;
    }

    const point = [0, 0, 0];
    function writeCurve(array, slotBase, start, end) {
      const dx = end[0] - start[0];
      const dy = end[1] - start[1];
      const dz = end[2] - start[2];
      const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const lift = 0.2 * length + 0.25;
      for (let segment = 0; segment < SEGMENTS; segment += 1) {
        const base = (slotBase + segment * 2) * 3;
        curve(start, end, lift, point, segment / SEGMENTS);
        array[base] = point[0]; array[base + 1] = point[1]; array[base + 2] = point[2];
        curve(start, end, lift, point, (segment + 1) / SEGMENTS);
        array[base + 3] = point[0]; array[base + 4] = point[1]; array[base + 5] = point[2];
      }
    }

    function lerp3(a, b, k) {
      return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
    }

    function resize() {
      const rect = stage.getBoundingClientRect();
      width = Math.max(2, Math.floor(rect.width));
      height = Math.max(2, Math.floor(rect.height));
      renderer.setPixelRatio(pixelRatio);
      renderer.setSize(width, height, false);
      composer.setPixelRatio(pixelRatio);
      composer.setSize(width, height);
      const aspect = width / height;
      const reframe = Math.abs(aspect - camera.aspect) > 1e-3;
      camera.aspect = aspect;
      camera.updateProjectionMatrix();
      if (reframe) fitCamera();
      nodeMaterial.uniforms.uScale.value = (height * pixelRatio) / (2 * Math.tan((camera.fov * Math.PI) / 360));
    }

    const observer = new ResizeObserver(resize);
    observer.observe(stage);
    resize();

    renderer.domElement.addEventListener('pointermove', (event) => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      pointer.clientX = event.clientX - rect.left;
      pointer.clientY = event.clientY - rect.top;
      pointer.inside = true;
      pointer.dirty = true;
    });
    renderer.domElement.addEventListener('pointerleave', () => {
      pointer.inside = false;
      pointer.dirty = true;
    });

    function pick() {
      if (!pointer.inside) return null;
      raycaster.setFromCamera({ x: pointer.x, y: pointer.y }, camera);
      const graph = index.graphs[state.graph];
      let best = null;
      let bestDistance = Infinity;
      for (const node of graph.nodes) {
        const position = nodePosition(node.id);
        temp.set(position[0], position[1], position[2]);
        const size = nodeSize(node);
        const radius = Math.max(0.42, size * 0.42);
        if (raycaster.ray.distanceSqToPoint(temp) <= radius * radius) {
          const distance = temp.distanceTo(camera.position);
          if (distance < bestDistance) {
            best = node.id;
            bestDistance = distance;
          }
        }
      }
      return best;
    }

    function currentStage() {
      if (state.reduced) return { stage: index.layers - 1, blend: null };
      const { phase, progress } = core.cycleAt(plan, clock);
      if (phase.update) return { stage: phase.update[1], blend: { from: phase.update[0], k: ease(progress) } };
      return { stage: phase.stage, blend: null };
    }

    function nodeLevel(node) {
      const { stage, blend } = currentStage();
      if (blend) return nodeNorm(node, blend.from) * (1 - blend.k) + nodeNorm(node, stage) * blend.k;
      return nodeNorm(node, stage);
    }

    function nodeSize(node) {
      return sizeFor(nodeLevel(node));
    }

    function tooltip(nodeId) {
      const element = $('obs-tooltip');
      if (!nodeId) {
        element.hidden = true;
        return;
      }
      const graph = index.graphs[state.graph];
      const node = graph.byId.get(nodeId);
      const features = Object.entries(node.features).map(([key, value]) => {
        let text;
        if (Array.isArray(value)) text = value.length === 0 ? '[]' : value.map((item) => (typeof item === 'object' ? Object.values(item).join('=') : String(item).split('/').pop())).join(', ');
        else if (value && typeof value === 'object') text = Object.entries(value).map(([inner, innerValue]) => `${inner} ${innerValue}`).join(' · ');
        else text = String(value);
        return `<dt>${escape(key)}</dt><dd>${escape(text)}</dd>`;
      }).join('');
      const frame = index.frames[state.frame];
      const states = core.modeStates(frame, state.mode);
      const norms = [`<dt>‖h‖ input</dt><dd>${frame.embed[node.type][node.batchIndex].toFixed(4)}</dd>`]
        .concat(states.layers.map((layer, position) => `<dt>‖h‖ layer ${position + 1}</dt><dd>${layer[node.type][node.batchIndex].toFixed(4)}</dd>`))
        .join('');
      const degree = {};
      const shown = displayed(graph, state.mode);
      for (const relation of relations) {
        for (const edge of shown[relation]) {
          if (edge && (edge.from === nodeId || edge.to === nodeId)) degree[relation] = (degree[relation] || 0) + 1;
        }
      }
      const wiring = Object.entries(degree).map(([relation, count]) => `${relation} ${count}`).join(' · ') || 'none';
      const encoded = Object.entries(node.encoded).map(([key, value]) => `${key} ${value}`).join(' · ');
      element.innerHTML = `<h3>${escape(node.type)} · ${escape(node.label)}${nodeId === graph.target ? ' · ACTION TARGET' : ''}</h3><dl>${features}<span class="tt-sep"></span>${norms}<dt>edges</dt><dd>${escape(wiring)}</dd><span class="tt-sep"></span><dt>encoded</dt><dd>${escape(encoded)}</dd></dl>`;
      element.hidden = false;
      const left = Math.min(width - element.offsetWidth - 8, pointer.clientX + 16);
      const top = Math.min(height - element.offsetHeight - 8, pointer.clientY + 14);
      element.style.left = `${Math.max(8, left)}px`;
      element.style.top = `${Math.max(8, top)}px`;
    }

    function project(position) {
      tempB.set(position[0], position[1], position[2]).project(camera);
      return { x: ((tempB.x + 1) / 2) * width, y: ((1 - tempB.y) / 2) * height, visible: tempB.z < 1 && tempB.z > -1 };
    }

    function updateScene(dt) {
      const graph = index.graphs[state.graph];
      const animate = !state.reduced && still === null;
      if (animate) clock += dt;
      const blend = state.reduced || still !== null ? 1 : 1 - Math.exp(-dt * 4.5);

      // Positions.
      for (const node of graph.nodes) {
        const goal = targetPosition(state.graph, node.id, clock);
        const current = rendered.get(node.id);
        rendered.set(node.id, current ? lerp3(current, goal, blend) : goal);
      }

      // Cycle phase.
      const { phase, progress, position } = core.cycleAt(plan, clock);
      const pulses = !state.reduced;
      $('obs-phase-name').textContent = state.reduced ? 'MESSAGE PASSING · FINAL LAYER (REDUCED MOTION)' : phase.label;
      const steps = $('obs-phase-steps');
      if (steps.childElementCount !== plan.phases.length) steps.innerHTML = plan.phases.map(() => '<li></li>').join('');
      [...steps.children].forEach((item, itemIndex) => item.classList.toggle('on', state.reduced ? true : itemIndex <= position));

      if (pulses && phase.layer !== undefined && phase.direction) updateMessages(phase.layer);

      // Edges.
      const hovered = state.hovered;
      for (const relation of relations) {
        const set = edgeSets[relation];
        set.base += (set.baseTarget - set.base) * blend;
        set.color.lerp(set.colorTarget, blend);
        set.material.uniforms.uColor.value.copy(set.color);
        set.material.uniforms.uBase.value = set.base;
        if (pulses && phase.layer !== undefined && phase.direction) {
          set.material.uniforms.uDir.value = phase.direction;
          set.material.uniforms.uHead.value = phase.direction > 0 ? -0.05 + progress * 1.75 : 1.05 - progress * 1.75;
          set.material.uniforms.uPulse.value = 1;
        } else {
          set.material.uniforms.uDir.value = 0;
        }
        const positionAttribute = set.geometry.getAttribute('position');
        const alphaAttribute = set.geometry.getAttribute('aAlpha');
        set.slots.forEach((slot, slotPosition) => {
          slot.k = Math.min(1, slot.k + (state.reduced || still !== null ? 1 : dt / 1.1));
          const k = ease(slot.k);
          let start;
          let end;
          let alpha;
          if (slot.previous && slot.next) {
            start = lerp3(nodePosition(slot.previous.from), nodePosition(slot.next.from), k);
            end = lerp3(nodePosition(slot.previous.to), nodePosition(slot.next.to), k);
            alpha = 1;
          } else if (slot.next) {
            start = nodePosition(slot.next.from);
            end = nodePosition(slot.next.to);
            alpha = k;
          } else if (slot.previous) {
            start = nodePosition(slot.previous.from);
            end = nodePosition(slot.previous.to);
            alpha = 1 - k;
          } else {
            alpha = 0;
          }
          const ends = slot.next || slot.previous;
          const touches = !hovered || (ends && (ends.from === hovered || ends.to === hovered));
          const value = alpha * (touches ? 1 : 0.15);
          const base = slotPosition * SEGMENTS * 2;
          if (start) writeCurve(positionAttribute.array, base, start, end);
          for (let vertex = 0; vertex < SEGMENTS * 2; vertex += 1) alphaAttribute.array[base + vertex] = value;
        });
        positionAttribute.needsUpdate = true;
        alphaAttribute.needsUpdate = true;
      }

      // Nodes.
      const positions = nodeGeometry.getAttribute('position');
      const colors = nodeGeometry.getAttribute('aColor');
      const sizes = nodeGeometry.getAttribute('aSize');
      const glows = nodeGeometry.getAttribute('aGlow');
      const alphas = nodeGeometry.getAttribute('aAlpha');
      const neighbours = new Set();
      if (hovered) {
        neighbours.add(hovered);
        for (const relation of relations) {
          for (const slot of edgeSets[relation].slots) {
            const ends = slot.next;
            if (ends && (ends.from === hovered || ends.to === hovered)) {
              neighbours.add(ends.from);
              neighbours.add(ends.to);
            }
          }
        }
      }
      const color = scratchColor;
      for (let slot = 0; slot < nodeSlots; slot += 1) {
        const node = graph.nodes[slot];
        if (!node) {
          sizes.array[slot] = 0;
          alphas.array[slot] = 0;
          continue;
        }
        const position = nodePosition(node.id);
        positions.array.set(position, slot * 3);
        color.set(TYPE_COLORS[node.type] || '#ffffff');
        colors.array.set([color.r, color.g, color.b], slot * 3);
        const level = Math.max(0, nodeLevel(node));
        const encodeRamp = !state.reduced && phase.id === 'encode' ? 0.35 + 0.65 * ease(progress) : 1;
        sizes.array[slot] = sizeFor(level);
        glows.array[slot] = (0.22 + 1.05 * level) * encodeRamp;
        alphas.array[slot] = hovered && !neighbours.has(node.id) ? 0.3 : 1;
      }
      for (const attribute of [positions, colors, sizes, glows, alphas]) attribute.needsUpdate = true;

      // Readout streams: typed mean pooling weights each node by 1 / nodes of its type;
      // the action target also enters the head directly.
      const streamPositions = streamGeometry.getAttribute('position');
      const streamStrength = streamGeometry.getAttribute('aMsgF');
      const streamAlpha = streamGeometry.getAttribute('aAlpha');
      const finalStage = index.layers - 1;
      for (let slot = 0; slot < nodeSlots; slot += 1) {
        const node = graph.nodes[slot];
        const base = slot * SEGMENTS * 2;
        const strength = node ? Math.min(1, nodeNorm(node, finalStage) * (node.id === graph.target ? 1 : 1 / graph.typeCounts[node.type])) : 0;
        if (node) writeCurve(streamPositions.array, base, nodePosition(node.id), layout.orb);
        const alpha = node ? (hovered && hovered !== node.id ? 0.15 : 1) : 0;
        for (let vertex = 0; vertex < SEGMENTS * 2; vertex += 1) {
          streamStrength.array[base + vertex] = strength;
          streamAlpha.array[base + vertex] = alpha;
        }
      }
      streamPositions.needsUpdate = true;
      streamStrength.needsUpdate = true;
      streamAlpha.needsUpdate = true;
      if (pulses && phase.readout) {
        streamMaterial.uniforms.uDir.value = 1;
        streamMaterial.uniforms.uHead.value = -0.05 + progress * 1.75;
      } else {
        streamMaterial.uniforms.uDir.value = 0;
      }
      streamMaterial.uniforms.uBase.value = state.reduced ? 0.1 : 0.025;

      // Orb.
      const frame = index.frames[state.frame];
      const risk = frame.risk[state.mode][state.graph];
      const energyGoal = state.reduced ? 0.9 : phase.hold ? 1.2 : phase.readout ? 0.55 + 0.65 * progress : 0.5;
      orbEnergy += (energyGoal - orbEnergy) * (state.reduced ? 1 : 1 - Math.exp(-dt * 6));
      orbMaterial.uniforms.uEnergy.value = orbEnergy;
      orbMaterial.uniforms.uColor.value.copy(coolColor).lerp(hotColor, risk);
      orb.scale.setScalar(0.9 + 0.3 * risk);

      // Target marker.
      const targetId = graph.target;
      marker.visible = Boolean(targetId);
      if (targetId) {
        const position = nodePosition(targetId);
        marker.position.set(position[0], position[1], position[2]);
        marker.scale.setScalar(1 + 0.08 * Math.sin(clock * 2.2));
      }

      // Labels.
      for (const [id, element] of labels) {
        const inGraph = graph.byId.has(id);
        if (!inGraph) {
          element.style.display = 'none';
          continue;
        }
        const node = graph.byId.get(id);
        const position = nodePosition(id);
        const anchor = node.type === 'Zone'
          ? [position[0], position[1], position[2] + layout.ringRadius + 0.5]
          : [position[0], position[1] + 0.55, position[2]];
        const screen = project(anchor);
        element.style.display = screen.visible ? '' : 'none';
        element.style.transform = `translate(${(screen.x + (node.type === 'Zone' ? -18 : 9)).toFixed(1)}px, ${(screen.y - 4).toFixed(1)}px)`;
        element.classList.toggle('dim', Boolean(hovered) && !neighbours.has(id));
        element.classList.toggle('hot', hovered === id);
      }
      const orbScreen = project([layout.orb[0], layout.orb[1] + 1.25, layout.orb[2]]);
      riskLabel.style.transform = `translate(calc(${orbScreen.x.toFixed(1)}px - 50%), calc(${orbScreen.y.toFixed(1)}px - 100%))`;
      riskLabel.innerHTML = `RISK ${risk.toFixed(4)}<small>${escape(graph.variant)} · ${escape(MODE_INFO[state.mode] ? MODE_INFO[state.mode].label : state.mode)} · STEP ${frame.step}</small>`;
      if (targetId) {
        const at = nodePosition(targetId);
        const targetScreen = project([at[0], at[1] - 0.9, at[2]]);
        const actionType = String(graph.action.type || '').split('.').pop().toUpperCase();
        targetLabel.textContent = `✕ ${actionType} TARGET`;
        targetLabel.style.display = targetScreen.visible ? '' : 'none';
        targetLabel.style.transform = `translate(${(targetScreen.x + 9).toFixed(1)}px, ${(targetScreen.y + 6).toFixed(1)}px)`;
      }
    }

    let failed = false;
    function frameLoop(now) {
      global.requestAnimationFrame(frameLoop);
      try {
        renderFrame(now);
      } catch (error) {
        if (!failed) {
          failed = true;
          console.error('GNN Observatory frame failed', error);
          fatal(`The 3D view hit an error: ${error.message}`);
        }
      }
    }

    function renderFrame(now) {
      if (lastNow === null) lastNow = now;
      const dt = Math.min(0.1, (now - lastNow) / 1000);
      lastNow = now;
      advancePlayback(dt);
      if (pointer.dirty) {
        pointer.dirty = false;
        const hit = pick();
        if (hit !== state.hovered) setState({ hovered: hit });
        tooltip(state.hovered);
      }
      controls.autoRotate = !state.reduced && still === null && !state.hovered;
      controls.update(dt);
      updateScene(dt);
      composer.render(dt);
      document.body.dataset.ready = '1';
      // Dynamic resolution: keep integrated GPUs above ~50 fps (not for frozen captures).
      if (still === null) frameTimes.push(dt);
      if (frameTimes.length >= 90) {
        const average = frameTimes.reduce((sum, value) => sum + value, 0) / frameTimes.length;
        frameTimes = [];
        if (average > 1 / 48 && pixelRatio > 0.6) {
          pixelRatio = Math.max(0.6, pixelRatio - 0.2);
          resize();
        } else if (average < 1 / 75 && pixelRatio < Math.min(global.devicePixelRatio || 1, 1.5)) {
          pixelRatio = Math.min(Math.min(global.devicePixelRatio || 1, 1.5), pixelRatio + 0.1);
          resize();
        }
      }
    }

    listeners.push((next, previous) => {
      if (next.graph !== previous.graph || next.mode !== previous.mode) retargetEdges(false);
      if (next.frame !== previous.frame || next.mode !== previous.mode) applyFrameData();
      if (next.hovered !== previous.hovered) tooltip(next.hovered);
    });

    if (params.has('debug')) global.__observatory = { THREE, camera, controls, renderer, composer, layout, edgeSets, points };
    retargetEdges(true);
    applyFrameData();
    for (const relation of relations) {
      edgeSets[relation].base = edgeSets[relation].baseTarget;
    }
    if (still !== null) controls.autoRotate = false;
    global.requestAnimationFrame(frameLoop);
    return { resize };
  }

  // -------------------------------------------------------------- frame driver

  let playClock = 0;
  function advancePlayback(dt) {
    if (!state.playing) return;
    playClock += dt;
    if (playClock < FRAME_SECONDS) return;
    playClock = 0;
    if (state.frame >= index.frames.length - 1) setState({ playing: false });
    else setState({ frame: state.frame + 1 });
  }

  function domOnlyLoop() {
    let last = null;
    function loop(now) {
      if (last === null) last = now;
      advancePlayback(Math.min(0.1, (now - last) / 1000));
      last = now;
      global.requestAnimationFrame(loop);
    }
    global.requestAnimationFrame(loop);
  }

  function initialFrame() {
    const requested = params.get('frame');
    const frames = index.frames;
    if (requested === 'last') return frames.length - 1;
    if (requested === 'best') {
      const best = frames.findIndex((frame) => frame.phase === 'best');
      return best >= 0 ? best : frames.length - 1;
    }
    if (requested !== null && Number.isFinite(Number(requested))) return Math.max(0, Math.min(frames.length - 1, Number(requested)));
    // Open on the restored best checkpoint: the model the training run returns.
    const best = frames.findIndex((frame) => frame.phase === 'best');
    return best >= 0 ? best : frames.length - 1;
  }

  async function boot() {
    let replay;
    try {
      const response = await fetch(REPLAY_URL);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      replay = await response.json();
    } catch (error) {
      fatal(`Could not load ${REPLAY_URL} (${error.message}). Serve the web/ directory over HTTP, for example: npx serve web`);
      $('obs-status').textContent = '● NO REPLAY';
      return;
    }
    index = core.indexReplay(replay);
    const requestedMode = params.get('mode');
    const requestedGraph = params.get('graph');
    state.frame = initialFrame();
    state.mode = index.modes.includes(requestedMode) ? requestedMode : 'full';
    const graphPosition = index.graphs.findIndex((graph) => graph.variant === String(requestedGraph || '').toUpperCase());
    state.graph = graphPosition >= 0 ? graphPosition : index.graphs.findIndex((graph) => graph.outcome.trajectoryUnsafe);
    if (state.graph < 0) state.graph = 0;
    renderStatic();
    listeners.push((next, previous) => {
      const keys = ['frame', 'mode', 'graph', 'playing', 'reduced'];
      if (keys.some((key) => next[key] !== previous[key])) renderDynamic();
    });
    renderDynamic();
    document.addEventListener('keydown', onKey);
    if (motionQuery.addEventListener) motionQuery.addEventListener('change', (event) => setState({ reduced: event.matches }));

    if (!hasWebGL()) {
      showFallback('WebGL is not available in this browser.');
      domOnlyLoop();
      return;
    }
    let modules;
    try {
      modules = await Promise.all([
        import('three'),
        import('three/addons/controls/OrbitControls.js'),
        import('three/addons/postprocessing/EffectComposer.js'),
        import('three/addons/postprocessing/RenderPass.js'),
        import('three/addons/postprocessing/UnrealBloomPass.js'),
        import('three/addons/postprocessing/OutputPass.js'),
      ]);
    } catch (error) {
      showFallback('three.js could not be loaded from the CDN.');
      domOnlyLoop();
      return;
    }
    const [three, orbit, composer, render, bloom, output] = modules;
    try {
      scene = createScene(three, {
        OrbitControls: orbit.OrbitControls,
        EffectComposer: composer.EffectComposer,
        RenderPass: render.RenderPass,
        UnrealBloomPass: bloom.UnrealBloomPass,
        OutputPass: output.OutputPass,
      });
    } catch (error) {
      showFallback(`The 3D view failed to start (${error.message}).`);
      domOnlyLoop();
    }
  }

  boot();
})(typeof window !== 'undefined' ? window : globalThis);
