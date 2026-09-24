/* CloudProof Operations Console — page controller.
 *
 * Everything this file shows comes from window.cloudProof.ops (the
 * packages/cloudproof-ops product layer over the CloudProof Mesh simulator).
 * It builds configurations, calls the API, and renders what comes back; it
 * never computes an outcome itself. Long searches run in slices so the page
 * stays responsive, and every slice is deterministic: chunking changes how
 * fast results arrive, never what they are.
 */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const ops = window.cloudProof?.ops;
  const Graph = window.CloudGraph;
  const root = $('ops-root');
  if (!root) return;
  if (!ops || !Graph) {
    root.innerHTML = '<section class="ops-view-head"><div><h1>The CloudProof engine did not load.</h1><p>Rebuild with <code>node tools/build-web.js</code> and refresh.</p></div></section>';
    return;
  }

  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
  const fmtT = (ms) => `T+${(ms / 1000).toFixed(1)} s`;
  const plural = (count, word) => `${count.toLocaleString('en-US')} ${word}${count === 1 ? '' : 's'}`;
  const params = new URLSearchParams(location.search);
  const reduceMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const MODES = ['verify', 'incident', 'architecture', 'agent', 'research'];
  const TITLES = {
    verify: 'CloudProof · Verify the cloud change before production does',
    incident: 'CloudProof · Incident Lab',
    architecture: 'CloudProof · Architecture what-if',
    agent: 'CloudProof · Agent Reliability Lab',
    research: 'CloudProof · Research',
  };
  const later = (fn) => setTimeout(fn, 0);

  function toast(message) {
    const el = $('ops-toast');
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => el.classList.remove('show'), 2200);
  }

  function download(filename, text, type = 'application/json') {
    const blob = new Blob([text], { type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // Run `step()` repeatedly in wall-clock slices until it reports done.
  function pump(step, onDone, token) {
    const tick = () => {
      if (token && token.cancelled) return;
      const done = step();
      if (done) onDone();
      else setTimeout(tick, 0);
    };
    later(tick);
  }

  // ---------------------------------------------------------------- modes
  const meta = document.querySelector('meta[name="theme-color"]');
  let agentThemeColor = null;
  const initialized = new Set();

  function setMode(mode, { updateUrl = true, focus = false } = {}) {
    const next = MODES.includes(mode) ? mode : 'verify';
    const previous = document.body.dataset.mode;
    if (previous === 'agent' && meta) agentThemeColor = meta.getAttribute('content');
    document.body.dataset.mode = next;
    document.querySelectorAll('[data-mode-target]').forEach((button) => {
      if (button.dataset.modeTarget === next) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
    document.querySelectorAll('.ops-view').forEach((view) => { view.hidden = view.dataset.view !== next; });
    if (meta) meta.setAttribute('content', next === 'agent' ? (agentThemeColor || '#65101b') : '#08090a');
    document.title = TITLES[next];
    const skip = $('skip-link');
    if (skip) skip.setAttribute('href', next === 'agent' ? '#agent-lab' : `#view-${next}`);
    if (updateUrl) {
      const url = new URL(location.href);
      url.searchParams.set('mode', next);
      history.replaceState(null, '', url);
    }
    if (!initialized.has(next)) {
      initialized.add(next);
      if (next === 'incident') initIncident();
      if (next === 'architecture') initArchitecture();
      if (next === 'research') initResearch();
    }
    if (focus) {
      const target = next === 'agent' ? document.querySelector('#quick-start') : $(`view-${next}`);
      target?.scrollIntoView({ block: 'start', behavior: reduceMotion ? 'auto' : 'smooth' });
    }
  }

  document.querySelectorAll('[data-mode-target]').forEach((button) => {
    button.addEventListener('click', () => setMode(button.dataset.modeTarget, { focus: true }));
  });

  // ---------------------------------------------------------------- graph panel
  function inspectHtml(model, selection) {
    if (!selection) return '<span class="ops-help">Select a service, dependency, route, zone or node for details. Keyboard: Tab to an element, Enter to select.</span>';
    if (selection.kind === 'service') {
      const service = model.services.find((item) => item.id === selection.id);
      if (!service) return '';
      const inbound = model.edges.filter((edge) => edge.to === service.id).map((edge) => `${edge.from} ${edge.verb} it`);
      const outbound = model.edges.filter((edge) => edge.from === service.id).map((edge) => `${edge.verb} ${edge.to}`);
      const pods = service.pods.map((pod) => `${pod.id.replace('pod/', '')} ${pod.serving ? 'serving' : pod.phase.toLowerCase()}${pod.node ? ` @${pod.node}` : ''}`).join(', ');
      return `<b>${esc(service.label)}</b> <span class="ops-tag">${esc(service.kind)}${service.role ? ` · ${esc(service.role)}` : ''}</span> ${service.version ? `<span class="ops-tag live">${esc(service.version)}</span>` : ''}
        <dl>
          <div><dt>Status</dt><dd>${esc(Graph.statusText(service))}</dd></div>
          <div><dt>Healthy / desired</dt><dd>${service.healthy}/${service.desired} (min ${service.minHealthy})</dd></div>
          <div><dt>${service.kind === 'queue' ? 'Backlog' : 'Load / capacity'}</dt><dd>${service.kind === 'queue' ? `${service.backlog}/${service.queueCapacity} msgs` : `${Math.round(service.loadRps)}/${service.capacityRps} rps`}</dd></div>
          <div><dt>Per-pod capacity</dt><dd>${service.podCapacityRps} rps</dd></div>
          <div><dt>Calls out</dt><dd>${esc(outbound.join('; ') || '—')}</dd></div>
          <div><dt>Depended on by</dt><dd>${esc(inbound.join('; ') || '—')}</dd></div>
        </dl><p class="ops-help">Pods: ${esc(pods)}</p>`;
    }
    if (selection.kind === 'edge') {
      const edge = model.edges.find((item) => item.id === selection.id);
      if (!edge) return '';
      const meaning = {
        CALLS: 'Synchronous call. If the callee is down, the caller is down.',
        CALLS_OPTIONAL: 'Optional call. The caller degrades but stays up.',
        READS_THROUGH: 'Reads go to the cache; while the cache is down they fall through to its backing store.',
        BACKED_BY: 'Cache misses (20% warm, 100% cold) land on this store.',
        WRITES: 'Writes need the primary, or its promoted replica after failover.',
        READS: 'Reads use the replica and fall back to the primary.',
        REPLICATES: 'The replica is promoted 1.5 s after the primary goes down.',
        PUBLISHES: 'Publishing fails if the queue is down or full (backpressure).',
        CONSUMES: 'Workers drain the queue; a stalled or slow consumer lets the backlog grow.',
      }[edge.type];
      return `<b>${esc(edge.from)} ${esc(edge.verb)} ${esc(edge.to)}</b> <span class="ops-tag">${esc(edge.type)} · ${edge.hard ? 'hard' : 'soft / async'}</span><p class="ops-help">${esc(meaning)}</p>`;
    }
    if (selection.kind === 'route') {
      const route = model.routes.find((item) => item.id === selection.id);
      return route ? `<b>Route ${esc(route.id)}</b> — ${route.sharePct}% of traffic (${route.rps} rps) enters <b>${esc(route.entry)}</b>. ${route.failing ? '<span style="color:var(--op-red)">Failing now.</span>' : 'Serving.'}` : '';
    }
    if (selection.kind === 'zone') {
      const zone = model.zones.find((item) => item.id === selection.id);
      return zone ? `<b>${esc(zone.id)}</b> ${zone.degraded ? '<span class="ops-tag" style="color:var(--op-red)">DEGRADED</span>' : ''} — nodes ${esc(zone.nodes.map((node) => `${node.id} (${node.pods.length} pods${node.crashed ? ', crashed' : ''}${node.cordoned ? ', cordoned' : ''})`).join(', '))}` : '';
    }
    if (selection.kind === 'node') {
      const node = model.zones.flatMap((zone) => zone.nodes).find((item) => item.id === selection.id);
      return node ? `<b>${esc(node.id)}</b> — ${node.pods.length}/${node.slots} pod slots${node.crashed ? ', crashed' : ''}${node.cordoned ? ', cordoned' : ''}. Pods: ${esc(node.pods.map((pod) => pod.id.replace('pod/', '')).join(', ') || 'none')}` : '';
    }
    return '';
  }

  /** A graph panel: a host, a view toggle, an inspect strip, and a current model. */
  function createGraphPanel({ host, viewToggle, inspect, ariaLabel }) {
    const panel = { model: null, options: {}, view: 'logical', selection: null };
    panel.draw = () => {
      if (!panel.model) { host.innerHTML = '<div class="ops-empty">No topology loaded.</div>'; return; }
      Graph.render(host, panel.model, {
        ...panel.options,
        view: panel.view,
        ariaLabel,
        selected: panel.selection ? `${panel.selection.kind}:${panel.selection.id}` : null,
        onSelect: (selection) => {
          panel.selection = selection;
          panel.draw();
          if (inspect) inspect.innerHTML = inspectHtml(panel.model, selection);
        },
      });
      if (inspect) inspect.innerHTML = inspectHtml(panel.model, panel.selection);
    };
    panel.show = (model, options = {}) => {
      panel.model = model;
      panel.options = options;
      panel.draw();
    };
    panel.setView = (view) => {
      panel.view = view;
      viewToggle?.querySelectorAll('[data-view]').forEach((button) => button.setAttribute('aria-checked', String(button.dataset.view === view)));
      panel.draw();
    };
    viewToggle?.querySelectorAll('[data-view]').forEach((button) => {
      button.addEventListener('click', () => panel.setView(button.dataset.view));
    });
    return panel;
  }

  // ---------------------------------------------------------------- player
  /**
   * The counterexample player: shrink progress, the minimal trace as steps,
   * the state at each step on the graph, and the deterministic "why".
   */
  function createPlayer({ host, graph, idPrefix, invariantsHost = null }) {
    const player = { data: null, cursor: 0, timer: null };
    host.innerHTML = `
      <header class="ops-panel-head"><h2 id="${idPrefix}-player-title">Counterexample replay</h2><span class="ops-tag" id="${idPrefix}-player-tag">WAITING</span></header>
      <div class="ops-player-grid">
        <div class="ops-player-main">
          <div class="ops-shrink" id="${idPrefix}-shrink"></div>
          <div class="ops-timeline" id="${idPrefix}-steps" role="list" aria-label="Counterexample steps"></div>
          <div class="ops-transport">
            <button type="button" class="ops-btn ghost" id="${idPrefix}-first" aria-label="First step">⏮</button>
            <button type="button" class="ops-btn ghost" id="${idPrefix}-prev" aria-label="Previous step">‹ PREV</button>
            <button type="button" class="ops-btn primary" id="${idPrefix}-play">REPLAY FAILURE</button>
            <button type="button" class="ops-btn ghost" id="${idPrefix}-next" aria-label="Next step">NEXT ›</button>
            <span id="${idPrefix}-clock">—</span>
          </div>
          <div class="ops-stepdetail" id="${idPrefix}-detail" aria-live="polite"></div>
        </div>
        <div class="ops-player-side ops-why" id="${idPrefix}-why"></div>
      </div>`;
    const el = (suffix) => $(`${idPrefix}-${suffix}`);
    const setEmpty = (message) => {
      el('shrink').innerHTML = '';
      el('steps').innerHTML = `<div class="ops-empty">${esc(message)}</div>`;
      el('detail').innerHTML = '';
      el('why').innerHTML = '';
      el('clock').textContent = '—';
      el('player-tag').textContent = 'WAITING';
      ['first', 'prev', 'play', 'next'].forEach((suffix) => { el(suffix).disabled = true; });
    };
    player.clear = (message = 'Run a verification. When the search finds a counterexample, it is minimized and replayed here step by step.') => {
      player.stop();
      player.data = null;
      setEmpty(message);
    };
    player.stop = () => {
      clearInterval(player.timer);
      player.timer = null;
      if (player.data) el('play').textContent = 'REPLAY FAILURE';
    };
    player.renderShrink = (steps, status, extra = '') => {
      if (!steps || !steps.length) { el('shrink').innerHTML = ''; return; }
      const max = Math.max(...steps.map((item) => item.actions));
      const unique = steps.filter((item, index) => index === 0 || item.actions !== steps[index - 1].actions || index === steps.length - 1);
      const bars = unique.map((item, index) => {
        const cls = index === 0 ? 'first' : (status === 'minimal' && index === unique.length - 1 ? 'last' : '');
        return `<div class="sh-bar ${cls}" style="height:${Math.max(6, Math.round((item.actions / max) * 44))}px" title="${esc(item.note)}"><span>${item.actions}</span></div>`;
      }).join('');
      const first = steps[0];
      const last = steps[steps.length - 1];
      el('shrink').innerHTML = `
        <div class="sh-stage"><span>Found failure → ${status === 'minimal' ? 'minimal replay' : 'reducing…'}</span><div class="sh-bars">${bars}</div></div>
        <p class="sh-copy">${status === 'minimal'
          ? `Shrunk from <b>${plural(first.actions, 'action')}</b> (${plural(first.transitions, 'transition')}) to <b>${plural(last.actions, 'action')}</b> (${plural(last.transitions, 'transition')}). Every remaining action is needed for the same invariant to fail.`
          : `Removing actions while the same invariant still fails… ${plural(last.actions, 'action')} left.`} ${extra}</p>`;
    };
    player.load = (data) => {
      player.stop();
      player.data = data;
      const events = data.timeline.events;
      el('player-tag').textContent = data.tag || 'LIVE REPLAY';
      const chips = events.map((event, index) => {
        const violation = event.violations.length > 0;
        const kind = event.origin === 'time' ? 'time passes' : event.origin;
        return `<button type="button" role="listitem" class="ops-step origin-${esc(event.origin)}${violation ? ' violation' : ''}" data-step="${index}">
          <small>${String(index + 1).padStart(2, '0')} · ${esc(kind.toUpperCase())} · ${fmtT(event.atMs)}</small>
          <b>${esc(event.title)}</b></button>`;
      });
      el('steps').innerHTML = chips.join('');
      el('steps').querySelectorAll('[data-step]').forEach((button) => {
        button.addEventListener('click', () => { player.stop(); player.select(Number(button.dataset.step)); });
      });
      ['first', 'prev', 'play', 'next'].forEach((suffix) => { el(suffix).disabled = false; });
      player.renderWhy();
      player.select(0);
    };
    player.renderWhy = () => {
      const explanation = player.data?.explanation;
      if (!explanation) { el('why').innerHTML = ''; return; }
      el('why').innerHTML = `
        <h3>WHY DID THIS FAIL?</h3>
        ${explanation.narrative.map((sentence) => `<p>${esc(sentence)}</p>`).join('')}
        <p class="src">Built from the simulator's recorded causes and pod states — not generated text.</p>
        <h3 style="margin-top:14px">ROOT CAUSE PATH</h3>
        <ol class="ops-path">${explanation.path.map((item) => `<li class="k-${esc(item.kind)}">${esc(item.label)}</li>`).join('')}</ol>`;
    };
    player.select = (index) => {
      if (!player.data) return;
      const events = player.data.timeline.events;
      const cursor = Math.max(0, Math.min(events.length - 1, index));
      player.cursor = cursor;
      const event = events[cursor];
      el('steps').querySelectorAll('[data-step]').forEach((button) => {
        if (Number(button.dataset.step) === cursor) {
          button.setAttribute('aria-current', 'step');
          button.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: reduceMotion ? 'auto' : 'smooth' });
        } else button.removeAttribute('aria-current');
      });
      el('clock').textContent = `STEP ${cursor + 1}/${events.length} · ${fmtT(event.endMs)}`;
      const explanation = player.data.explanation;
      const faultTargets = event.origin === 'fault' && event.target ? [event.target] : [];
      const changing = (player.data.changeTargets || []);
      graph.show(event.after, {
        pulse: event.affected,
        highlight: graph.view === 'failure' || cursor === events.length - 1 ? (explanation?.highlight || {}) : {},
        faultTargets,
        changing,
      });
      const byId = (model) => new Map(model.services.map((service) => [service.id, service]));
      const before = byId(event.before);
      const after = byId(event.after);
      const cards = event.affected.services.map((id) => {
        const was = before.get(id);
        const now = after.get(id);
        const load = now.kind === 'queue' ? `${was.backlog} → ${now.backlog} msgs` : `${Math.round(was.loadRps)}/${was.capacityRps} → ${Math.round(now.loadRps)}/${now.capacityRps} rps`;
        return `<div class="${now.up ? 'up' : 'down'}"><b>${esc(now.label)}</b>${was.healthy} → ${now.healthy} healthy<br>${load}<br>${esc(Graph.statusText(was))} → ${esc(Graph.statusText(now))}</div>`;
      });
      const violations = event.violations.map((item) => `<li style="color:#ffd2cc"><b>Invariant violated:</b> ${esc(ops.describeInvariant(player.data.invariants.find((inv) => inv.id === item.invariant), player.data.labels))} — expected ${esc(item.expected)}, observed ${esc(item.observed)}</li>`);
      el('detail').innerHTML = `
        <h3>${esc(event.title)}</h3>
        <ul>${event.notes.map((note) => `<li>${esc(note)}</li>`).join('') || '<li>No service changed state at this step.</li>'}${violations.join('')}</ul>
        ${cards.length ? `<div class="ops-delta">${cards.join('')}</div>` : ''}`;
      if (invariantsHost) player.renderInvariants(event);
      player.onSelect?.(cursor, event);
    };
    player.renderInvariants = (event) => {
      const title = $(`${idPrefix}-invariants-title`);
      if (title) title.textContent = `Modeled invariants · replay step ${player.cursor + 1} (${fmtT(event.endMs)})`;
      const violated = new Map(event.violations.map((item) => [item.invariant, item]));
      invariantsHost.innerHTML = player.data.invariants.map((invariant) => {
        const hit = violated.get(invariant.id);
        return `<li class="${hit ? 'violated' : 'held'}">${esc(ops.describeInvariant(invariant, player.data.labels))}${hit ? `<small>expected ${esc(hit.expected)}, observed ${esc(hit.observed)} at ${fmtT(hit.atMs)}</small>` : `<small>holding at ${fmtT(event.endMs)}</small>`}</li>`;
      }).join('');
    };
    player.play = () => {
      if (!player.data) return;
      if (player.timer) { player.stop(); return; }
      const events = player.data.timeline.events;
      if (player.cursor >= events.length - 1) player.select(0);
      if (reduceMotion) { player.select(events.length - 1); return; }
      el('play').textContent = 'PAUSE';
      player.timer = setInterval(() => {
        if (player.cursor >= events.length - 1) { player.stop(); return; }
        player.select(player.cursor + 1);
      }, 1300);
    };
    el('first').addEventListener('click', () => { player.stop(); player.select(0); });
    el('prev').addEventListener('click', () => { player.stop(); player.select(player.cursor - 1); });
    el('next').addEventListener('click', () => { player.stop(); player.select(player.cursor + 1); });
    el('play').addEventListener('click', () => player.play());
    host.addEventListener('keydown', (event) => {
      if (!player.data || /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName)) return;
      if (event.key === 'ArrowRight') { event.preventDefault(); player.stop(); player.select(player.cursor + 1); }
      if (event.key === 'ArrowLeft') { event.preventDefault(); player.stop(); player.select(player.cursor - 1); }
    });
    player.clear();
    return player;
  }

  /** Shrink a counterexample in slices, then build the replay data. */
  function minimizeAndExplain({ world, trace, invariants, target, requireChange, labels, versions, player, token, onDone }) {
    let shrinker;
    try {
      shrinker = ops.createShrinker({ world, trace, invariants, target, requireChange });
    } catch (error) {
      player.clear(`Could not minimize: ${error.message}`);
      return;
    }
    player.renderShrink(shrinker.progress().steps, 'running');
    pump(() => {
      const progress = shrinker.run({ sliceMs: 16 });
      player.renderShrink(progress.steps, progress.status === 'minimal' ? 'minimal' : 'running', `(${progress.candidatesTried} candidate replays)`);
      return shrinker.done;
    }, () => {
      const shrink = shrinker.result();
      const replay = ops.explainTrace({ world, trace: shrink.minimal.trace, invariants, labels, versions, target, requireChange });
      onDone({ shrink, replay });
    }, token);
  }

  // ---------------------------------------------------------------- remediation compare
  function createFixPanel({ host, idPrefix, title }) {
    host.innerHTML = `
      <header class="ops-panel-head"><h2 id="${idPrefix}-fix-title">${esc(title)}</h2><span class="ops-tag">RULE-BASED CANDIDATES · NO LLM</span></header>
      <div class="ops-body">
        <div>
          <p class="ops-help" style="margin:0 0 10px!important" id="${idPrefix}-fix-intro">Candidates appear once a counterexample has been minimized and explained. They are derived from its root cause by fixed rules; nothing claims a candidate works until the verifier has run it.</p>
          <div class="ops-candidates" id="${idPrefix}-candidates" role="radiogroup" aria-label="Candidate fixes"></div>
          <div class="ops-actions" style="margin-top:10px"><button type="button" class="ops-btn primary" id="${idPrefix}-fix-run" disabled>VERIFY CANDIDATE</button></div>
        </div>
        <div id="${idPrefix}-compare" aria-live="polite"></div>
      </div>`;
    return {
      intro: $(`${idPrefix}-fix-intro`),
      list: $(`${idPrefix}-candidates`),
      run: $(`${idPrefix}-fix-run`),
      compare: $(`${idPrefix}-compare`),
      candidates: [],
      selected: null,
      setCandidates(candidates) {
        this.candidates = candidates;
        this.selected = candidates[0]?.id || null;
        this.list.innerHTML = candidates.length ? candidates.map((item, index) => `
          <label class="ops-candidate"><input type="radio" name="${idPrefix}-candidate" value="${esc(item.id)}" ${index === 0 ? 'checked' : ''}>
            <span><b>${esc(item.title)}</b><p>${esc(item.rationale)}</p><code>${esc(item.diff.map((row) => `${row.field}: ${row.before} → ${row.after}`).join(' · '))}</code></span></label>`).join('')
          : '<div class="ops-empty">No rule applies to this root cause.</div>';
        this.list.querySelectorAll('input').forEach((input) => input.addEventListener('change', () => { this.selected = input.value; }));
        this.run.disabled = !candidates.length;
        this.compare.innerHTML = '';
      },
      clear(message) {
        this.candidates = [];
        this.selected = null;
        this.list.innerHTML = message ? `<div class="ops-empty">${esc(message)}</div>` : '';
        this.run.disabled = true;
        this.compare.innerHTML = '';
      },
      current() { return this.candidates.find((item) => item.id === this.selected) || null; },
    };
  }

  // ======================================================================
  // VERIFY CHANGE
  // ======================================================================
  const CHANGE_UI = [
    { id: 'rollout', label: 'Roll out version', type: 'rollout', kinds: ['api', 'cache', 'worker'] },
    { id: 'scale', label: 'Scale service / replica count', type: 'scale', kinds: ['api', 'cache', 'worker', 'queue'] },
    { id: 'resize-workers', label: 'Resize queue workers', type: 'scale', kinds: ['worker'] },
    { id: 'cache-capacity', label: 'Change cache capacity', type: 'scale', kinds: ['cache'] },
    { id: 'drain-node', label: 'Drain node', type: 'drain-node' },
    { id: 'drain-zone', label: 'Drain zone', type: 'drain-zone' },
    { id: 'db-failover', label: 'Fail over database', type: 'db-failover' },
    { id: 'move-replicas', label: 'Move replicas (not modeled yet)', disabled: true },
  ];
  const BUDGET_UI = [['quick', 'Quick'], ['standard', 'Standard'], ['deep', 'Deep'], ['exhaustive', 'Exhaustive']];

  const V = {
    scenarioId: 'checkout',
    scenario: null,
    imported: null,
    uiType: 'rollout',
    change: null,
    faults: new Set(),
    maxFaults: 1,
    budget: 'standard',
    seed: 1337,
    invariants: [],
    demoId: null,
    run: null,
  };
  const verifyGraph = createGraphPanel({ host: $('verify-graph'), viewToggle: $('graph-view'), inspect: $('verify-inspect'), ariaLabel: 'Service dependency graph for the selected scenario' });
  const verifyPlayer = createPlayer({ host: $('verify-player'), graph: verifyGraph, idPrefix: 'verify', invariantsHost: $('verify-invariants') });
  const verifyFix = createFixPanel({ host: $('verify-fix'), idPrefix: 'verify', title: 'Compare remediations · try a fix' });

  function scenarioOptions() {
    const list = ops.listScenarios().map((item) => ({ id: item.id, name: item.name }));
    if (V.imported) list.push({ id: 'imported', name: `Imported: ${V.imported.name}` });
    return list;
  }

  function loadScenarioState(id) {
    if (id === 'imported' && V.imported) {
      return {
        id: 'imported', name: V.imported.name, summary: 'Imported topology (validated by the CloudProof Mesh world checks).',
        world: JSON.parse(JSON.stringify(V.imported.world)),
        versions: {}, labels: Object.fromEntries(V.imported.world.services.map((service) => [service.id, service.id])),
        invariants: ops.topology.defaultInvariants(V.imported.world),
      };
    }
    return ops.loadScenario(id);
  }

  function world() { return V.scenario.world; }
  function servicesOfKinds(kinds) { return world().services.filter((service) => kinds.includes(service.kind)); }
  function nextVersion(version) {
    const match = /^(.*?)(\d+)$/.exec(version || '');
    return match ? `${match[1]}${Number(match[2]) + 1}` : 'next';
  }

  function defaultChange(uiId) {
    const ui = CHANGE_UI.find((item) => item.id === uiId);
    const w = world();
    if (ui.type === 'rollout') {
      const candidates = servicesOfKinds(ui.kinds);
      const service = candidates.find((item) => item.id === 'payment') || candidates[0];
      if (!service) return null;
      return { type: 'rollout', service: service.id, toVersion: nextVersion(V.scenario.versions[service.id] || 'v1'), maxSurge: 1, maxUnavailable: 1 };
    }
    if (ui.type === 'scale') {
      const service = servicesOfKinds(ui.kinds)[0];
      if (!service) return null;
      return { type: 'scale', service: service.id, replicas: service.replicas > 1 ? service.replicas - 1 : service.replicas + 1 };
    }
    if (ui.type === 'drain-node') return { type: 'drain-node', node: w.nodes[0].id };
    if (ui.type === 'drain-zone') return { type: 'drain-zone', zone: (w.zones[1] || w.zones[0]).id, intervalMs: 1500 };
    if (ui.type === 'db-failover') {
      const primary = w.services.find((service) => service.role === 'primary' && w.dependencies.some((edge) => edge.type === 'REPLICATES' && edge.from === service.id));
      return primary ? { type: 'db-failover', database: primary.id } : null;
    }
    return null;
  }

  function uiTypeFor(change) {
    if (change.type !== 'scale') return change.type;
    const kind = world().services.find((service) => service.id === change.service)?.kind;
    if (kind === 'worker') return 'resize-workers';
    if (kind === 'cache') return 'cache-capacity';
    return 'scale';
  }

  function applicableFamilies() {
    const w = world();
    return {
      'node-crash': true,
      'zone-degraded': true,
      'readiness-delay': true,
      'dependency-latency': false,
      'cache-loss': w.services.some((service) => service.kind === 'cache'),
      'consumer-stall': w.services.some((service) => service.kind === 'worker'),
      'db-failover': w.services.some((service) => service.role === 'primary' && w.dependencies.some((edge) => edge.type === 'REPLICATES' && edge.from === service.id)),
      'traffic-spike': true,
    };
  }

  function renderScenarioSelect() {
    $('scenario-select').innerHTML = scenarioOptions().map((item) => `<option value="${esc(item.id)}" ${item.id === V.scenarioId ? 'selected' : ''}>${esc(item.name)}</option>`).join('');
    $('scenario-summary').textContent = V.scenario.summary;
  }

  function renderChangeType() {
    $('change-type').innerHTML = CHANGE_UI.map((item) => {
      const disabled = item.disabled || !defaultChangeAvailable(item.id);
      return `<option value="${item.id}" ${item.id === V.uiType ? 'selected' : ''} ${disabled ? 'disabled' : ''}>${esc(item.label)}${!item.disabled && disabled ? ' (none in this topology)' : ''}</option>`;
    }).join('');
  }

  function defaultChangeAvailable(uiId) {
    const ui = CHANGE_UI.find((item) => item.id === uiId);
    if (ui.disabled) return false;
    try { return Boolean(defaultChange(uiId)); } catch (_) { return false; }
  }

  function field(label, control, full = false) {
    return `<div class="ops-field${full ? ' full' : ''}"><label>${esc(label)}${control}</label></div>`;
  }

  function renderChangeParams() {
    const host = $('change-params');
    const change = V.change;
    const w = world();
    const ui = CHANGE_UI.find((item) => item.id === V.uiType);
    const select = (key, options, value) => `<select data-key="${key}">${options.map(([id, text]) => `<option value="${esc(id)}" ${id === value ? 'selected' : ''}>${esc(text)}</option>`).join('')}</select>`;
    const number = (key, value, min, max, step = 1) => `<input type="number" data-key="${key}" value="${value}" min="${min}" max="${max}" step="${step}">`;
    const services = (kinds) => servicesOfKinds(kinds).map((service) => [service.id, `${V.scenario.labels[service.id] || service.id} (${service.replicas})`]);
    let html = '';
    if (change.type === 'rollout') {
      const target = w.services.find((service) => service.id === change.service);
      html += field('Service', select('service', services(ui.kinds), change.service), true);
      html += field(`Version (now ${V.scenario.versions[change.service] || 'current'})`, `<input type="text" data-key="toVersion" value="${esc(change.toVersion)}" maxlength="24">`);
      html += field('maxSurge', number('maxSurge', change.maxSurge, 0, 64));
      html += field('maxUnavailable', number('maxUnavailable', change.maxUnavailable, 0, target.replicas));
    } else if (change.type === 'scale') {
      html += field('Service', select('service', services(ui.kinds), change.service), true);
      html += field('Target replicas', number('replicas', change.replicas, 1, 64));
    } else if (change.type === 'drain-node') {
      html += field('Node', select('node', w.nodes.map((node) => [node.id, `${node.id} (${node.zone})`]), change.node), true);
    } else if (change.type === 'drain-zone') {
      html += field('Zone', select('zone', w.zones.map((zone) => [zone.id, zone.id]), change.zone));
      html += field('Node interval (ms)', number('intervalMs', change.intervalMs, 0, 30000, 100));
    } else if (change.type === 'db-failover') {
      const primaries = w.services.filter((service) => service.role === 'primary' && w.dependencies.some((edge) => edge.type === 'REPLICATES' && edge.from === service.id));
      html += field('Primary database', select('database', primaries.map((service) => [service.id, V.scenario.labels[service.id] || service.id]), change.database), true);
    }
    host.innerHTML = html;
    host.querySelectorAll('[data-key]').forEach((input) => {
      input.addEventListener('change', () => {
        const key = input.dataset.key;
        const value = input.type === 'number' ? Number(input.value) : input.value;
        V.change = { ...V.change, [key]: value };
        if (key === 'service' && V.change.type === 'rollout') V.change.toVersion = nextVersion(V.scenario.versions[value] || 'v1');
        if (key === 'service' && V.change.type === 'scale') {
          const target = w.services.find((service) => service.id === value);
          V.change.replicas = target.replicas > 1 ? target.replicas - 1 : target.replicas + 1;
        }
        V.demoId = null;
        onConfigChanged({ params: key === 'service' });
      });
    });
  }

  function renderDiff() {
    const host = $('change-diff');
    try {
      const diff = ops.describeChange(world(), V.change, V.scenario.versions);
      host.innerHTML = `<header><span>${esc(diff.title)}</span><span>${esc(diff.typeTitle)}</span></header>
        <table><tbody>${diff.rows.map((row) => `<tr class="${row.changed ? 'changed' : ''}${row.sensitive ? ' sensitive' : ''}"><td>${esc(row.field)}</td><td>${esc(row.before)}</td><td class="arrow">→</td><td>${esc(row.after)}${row.note ? `<span class="note">${esc(row.note)}</span>` : ''}</td></tr>`).join('')}</tbody></table>`;
      return null;
    } catch (error) {
      host.innerHTML = '';
      return error.message;
    }
  }

  function renderFaults() {
    const applicable = applicableFamilies();
    $('fault-families').innerHTML = Object.entries(ops.FAULT_FAMILIES).map(([id, family]) => {
      const usable = family.modeled && applicable[id];
      const note = !family.modeled ? 'not modeled' : !applicable[id] ? 'none in this topology' : '';
      return `<label class="ops-check${usable ? '' : ' disabled'}" title="${esc(family.detail)}"><input type="checkbox" value="${id}" ${V.faults.has(id) && usable ? 'checked' : ''} ${usable ? '' : 'disabled'}><span>${esc(family.title)}${note ? `<small>${esc(note)}</small>` : ''}</span></label>`;
    }).join('');
    $('fault-families').querySelectorAll('input').forEach((input) => {
      input.addEventListener('change', () => {
        if (input.checked) V.faults.add(input.value); else V.faults.delete(input.value);
        V.demoId = null;
        onConfigChanged();
      });
    });
  }

  function renderSegments(host, items, current, onPick) {
    host.innerHTML = items.map(([value, label, small]) => `<button type="button" role="radio" aria-checked="${String(value === current)}" data-value="${esc(value)}">${esc(label)}${small ? `<small>${esc(small)}</small>` : ''}</button>`).join('');
    host.querySelectorAll('button').forEach((button) => button.addEventListener('click', () => onPick(button.dataset.value)));
  }

  function markSegments(host, current) {
    host.querySelectorAll('button').forEach((button) => button.setAttribute('aria-checked', String(button.dataset.value === current)));
  }

  function renderBudgets() {
    renderSegments($('fault-budget'), [['1', 'N+1', '1 fault'], ['2', 'N+2', '≤ 2 faults'], ['3', 'N+3', '≤ 3 faults']], String(V.maxFaults), (value) => {
      V.maxFaults = Number(value);
      V.demoId = null;
      onConfigChanged();
    });
    renderSegments($('search-budget'), BUDGET_UI.map(([id, label]) => [id, label, `≤ ${ops.BUDGETS[id].toLocaleString('en-US')}`]), V.budget, (value) => {
      V.budget = value;
      V.demoId = null;
      onConfigChanged();
    });
  }

  function updateBudgetHelp() {
    markSegments($('fault-budget'), String(V.maxFaults));
    markSegments($('search-budget'), V.budget);
    $('fault-budget-help').textContent = V.maxFaults === 1
      ? 'N+1: each schedule injects one fault at a 500 ms step of the change. The whole single-fault space is enumerated when the budget allows.'
      : `N+${V.maxFaults}: schedules combine up to ${V.maxFaults} faults (a readiness delay counts as one). Two single-fault schedules run for every sampled combination.`;
  }

  /** Re-render every control from V (scenario, demo, URL or import changed). */
  function renderControls() {
    renderScenarioSelect();
    renderChangeType();
    renderChangeParams();
    renderFaults();
    renderBudgets();
    renderInvariantBuilder();
    $('seed-input').value = String(V.seed);
  }

  function renderInvariantBuilder() {
    const w = world();
    const optionsFor = (type) => {
      if (type === 'route') return w.routes.map((route) => [route.id, `${route.id} (${route.sharePct}%)`]);
      if (type === 'service') return w.services.map((service) => [service.id, V.scenario.labels[service.id] || service.id]);
      if (type === 'queue') return w.services.filter((service) => service.kind === 'queue').map((service) => [service.id, V.scenario.labels[service.id] || service.id]);
      if (type === 'primary') return w.services.filter((service) => service.role === 'primary').map((service) => [service.id, V.scenario.labels[service.id] || service.id]);
      return [];
    };
    $('invariant-builder').innerHTML = V.invariants.map((invariant, index) => {
      const kind = ops.INVARIANT_KINDS[invariant.kind];
      const inputs = kind.parameters.map((parameter) => {
        const value = invariant[parameter.key];
        const control = parameter.type === 'number'
          ? `<input type="number" data-index="${index}" data-key="${parameter.key}" value="${value}" min="${parameter.min}" max="${parameter.max}" step="${parameter.step}">`
          : `<select data-index="${index}" data-key="${parameter.key}">${optionsFor(parameter.type).map(([id, text]) => `<option value="${esc(id)}" ${id === value ? 'selected' : ''}>${esc(text)}</option>`).join('')}</select>`;
        return `<label>${esc(parameter.label)}${parameter.unit ? ` (${esc(parameter.unit)})` : ''}${control}</label>`;
      }).join('');
      return `<div class="ops-inv-edit"><label class="ops-check"><input type="checkbox" data-index="${index}" data-key="enabled" ${invariant.enabled ? 'checked' : ''}><span>${esc(kind.title)}</span></label>
        <div class="ops-inv-params">${inputs}</div><code>reads ${esc(kind.source)}</code></div>`;
    }).join('');
    $('invariant-builder').querySelectorAll('[data-key]').forEach((input) => {
      input.addEventListener('change', () => {
        const invariant = V.invariants[Number(input.dataset.index)];
        const key = input.dataset.key;
        if (key === 'enabled') invariant.enabled = input.checked;
        else invariant[key] = input.type === 'number' ? Number(input.value) : input.value;
        V.demoId = null;
        onConfigChanged();
      });
    });
  }

  function enabledInvariants() {
    return V.invariants.filter((item) => item.enabled).map(({ enabled, ...rest }) => rest);
  }

  function renderIdleInvariants() {
    $('verify-invariants').innerHTML = enabledInvariants().map((invariant) => `<li>${esc(ops.describeInvariant(invariant, V.scenario.labels))}<small>not yet checked</small></li>`).join('');
  }

  function changeTargets(change) {
    return change?.service ? [change.service] : change?.database ? [change.database] : [];
  }

  function drawIdleGraph() {
    verifyGraph.show(ops.initialGraph(world(), { labels: V.scenario.labels, versions: V.scenario.versions }), { changing: changeTargets(V.change) });
  }

  function configError() {
    const problems = [];
    const diffError = renderDiff();
    if (diffError) problems.push(diffError);
    try { ops.validateInvariants(world(), enabledInvariants()); } catch (error) { problems.push(error.message); }
    if (!V.faults.size) problems.push('Choose at least one fault family.');
    if (!Number.isInteger(V.seed) || V.seed < 0 || V.seed > 4294967295) problems.push('Seed must be a whole number between 0 and 4294967295.');
    return problems;
  }

  function setFlow(states) {
    document.querySelectorAll('#ops-flow [data-flow]').forEach((item) => {
      item.classList.remove('done', 'now', 'bad', 'good');
      const state = states[item.dataset.flow];
      if (state) item.classList.add(state);
    });
  }

  function onConfigChanged({ params: rerenderParams = false } = {}) {
    if (V.run && !V.run.done) cancelVerification();
    if (rerenderParams) renderChangeParams();
    $('invariant-count').textContent = `(${V.invariants.filter((item) => item.enabled).length} of ${V.invariants.length} on)`;
    updateBudgetHelp();
    const problems = configError();
    $('config-error').hidden = !problems.length;
    $('config-error').textContent = problems.join(' ');
    $('verify-run').disabled = problems.length > 0;
    $('config-tag').textContent = V.demoId ? 'DEMO' : 'CUSTOM';
    document.querySelectorAll('.ops-demo').forEach((button) => button.classList.toggle('active', button.dataset.demo === V.demoId));
    resetResults();
    drawIdleGraph();
    setFlow({ current: 'done', change: problems.length ? 'now' : 'done' });
    syncUrl();
  }

  // Load a scenario into V. `render` is false when the caller sets more state
  // (a demo's change and faults) before drawing the controls once.
  function selectScenario(id, { render = true } = {}) {
    V.scenarioId = id;
    V.scenario = loadScenarioState(id);
    V.invariants = V.scenario.invariants.map((item) => ({ ...item, enabled: true }));
    const firstUi = CHANGE_UI.find((item) => !item.disabled && defaultChangeAvailable(item.id));
    V.uiType = defaultChangeAvailable(V.uiType) ? V.uiType : firstUi.id;
    V.change = defaultChange(V.uiType);
    const applicable = applicableFamilies();
    V.faults = new Set(['node-crash', 'zone-degraded', 'traffic-spike'].filter((family) => applicable[family]));
    verifyGraph.selection = null;
    if (render) renderControls();
  }

  function applyDemo(id, { scroll = true } = {}) {
    const demo = ops.demoById(id);
    if (!demo) return;
    selectScenario(demo.scenario, { render: false });
    V.change = { ...demo.change };
    V.uiType = uiTypeFor(V.change);
    V.faults = new Set(demo.faults);
    V.maxFaults = demo.maxFaults || 1;
    V.budget = demo.budget;
    V.seed = 1337;
    V.demoId = demo.id;
    renderControls();
    onConfigChanged();
    if (scroll) $('ops-main').scrollIntoView({ block: 'start', behavior: reduceMotion ? 'auto' : 'smooth' });
  }

  // ------------------------------------------------ results
  function statusBlock(host, kind, label, copy) {
    host.className = `ops-status ${kind}`;
    host.innerHTML = `<div class="st-label">${esc(label)}</div>${copy ? `<p class="st-copy">${copy}</p>` : ''}`;
  }

  function renderCounters(progress) {
    const cells = [
      ['Schedules checked', progress ? `${progress.schedulesChecked.toLocaleString('en-US')} / ${progress.budget.toLocaleString('en-US')}` : `— / ${ops.BUDGETS[V.budget].toLocaleString('en-US')}`],
      ['Transitions executed', progress ? progress.transitions.toLocaleString('en-US') : '—'],
      ['Unique states', progress ? progress.uniqueStates.toLocaleString('en-US') : '—'],
      ['Fault combinations', progress ? progress.faultCombinations.toLocaleString('en-US') : '—'],
      ['Single-fault coverage', progress ? `${progress.singlesChecked}/${progress.singlesTotal}` : '—'],
      ['Current schedule', progress ? `#${progress.currentSchedule} · seed ${progress.seed}` : `seed ${V.seed}`],
    ];
    $('verify-counters').innerHTML = cells.map(([label, value]) => `<div><small>${esc(label)}</small><b>${esc(value)}</b></div>`).join('');
  }

  function renderSearchList(progress) {
    const rows = (progress?.recent || []).slice().reverse();
    $('verify-search').innerHTML = `<div class="sv-head"><span>SEARCH · LATEST ${rows.length || 0} OF ${progress ? progress.schedulesChecked : 0}</span><span>${progress && progress.preExisting ? `${progress.preExisting} PRE-EXISTING` : ''}</span></div>
      <ol>${rows.map((row) => `<li class="${esc(row.outcome)}"><span>#${row.index}</span><span title="${esc(row.label)}">${esc(row.label)}</span><b>${row.outcome === 'violation' ? 'VIOLATION' : row.outcome === 'pre-existing' ? 'PRE-EXISTING' : 'CHECKED'}</b></li>`).join('') || '<li><span></span><span>Order: seeded enumeration. Learned search priority: not available (no Phase III model has been trained).</span><b></b></li>'}</ol>`;
  }

  function resetResults() {
    statusBlock($('verify-status'), 'ready', 'READY TO VERIFY', `${esc(ops.changeSummary(V.change || { type: 'none' }))} — against ${plural(enabledInvariants().length, 'modeled invariant')}, fault budget N+${V.maxFaults}, up to ${ops.BUDGETS[V.budget].toLocaleString('en-US')} schedules.`);
    renderCounters(null);
    renderSearchList(null);
    $('verify-progress').style.width = '0';
    $('verify-progress-wrap').className = 'ops-progress';
    renderIdleInvariants();
    $('verify-invariants-title').textContent = 'Modeled invariants';
    $('verify-result').innerHTML = '';
    $('export-evidence').disabled = true;
    $('evidence-note').textContent = '';
    verifyPlayer.clear();
    verifyFix.clear('Candidates appear after a counterexample is found.');
    V.run = null;
  }

  function currentConfig() {
    return {
      scenarioId: V.scenarioId,
      world: world(),
      versions: V.scenario.versions,
      labels: V.scenario.labels,
      change: V.change,
      invariants: enabledInvariants(),
      faults: [...V.faults].sort(),
      maxFaults: V.maxFaults,
      budget: V.budget,
      seed: V.seed,
    };
  }

  function cancelVerification() {
    if (!V.run) return;
    V.run.token.cancelled = true;
    V.run.search?.cancel();
    V.run.done = true;
    $('verify-run').hidden = false;
    $('verify-cancel').hidden = true;
    const progress = V.run.search?.progress();
    statusBlock($('verify-status'), 'ready', 'VERIFICATION CANCELLED', progress ? `Stopped after ${plural(progress.schedulesChecked, 'schedule')}. No verdict.` : '');
  }

  function runVerification() {
    const problems = configError();
    if (problems.length) return;
    resetResults();
    const config = currentConfig();
    let search;
    try {
      search = ops.createVerification(config);
    } catch (error) {
      $('config-error').hidden = false;
      $('config-error').textContent = error.message;
      return;
    }
    const token = { cancelled: false };
    V.run = { config, search, token, done: false, result: null, shrink: null, replay: null };
    $('verify-run').hidden = true;
    $('verify-cancel').hidden = false;
    setFlow({ current: 'done', change: 'done', explore: 'now', verify: 'now' });
    statusBlock($('verify-status'), 'running', 'EXPLORING', `Running ${esc(ops.changeSummary(config.change))} against every fault placement in the model. Horizon ${fmtT(search.horizonMs).replace('T+', '')}; faults injected every ${search.options.slotMs} ms up to ${fmtT(search.slots[search.slots.length - 1] || 0)}.`);
    pump(() => {
      const progress = search.run({ sliceMs: 28 });
      renderCounters(progress);
      renderSearchList(progress);
      $('verify-progress').style.width = `${Math.min(100, (progress.schedulesChecked / progress.budget) * 100)}%`;
      return search.done;
    }, () => finishVerification(), token);
  }

  function finishVerification() {
    const run = V.run;
    run.done = true;
    run.result = run.search.result();
    $('verify-run').hidden = false;
    $('verify-cancel').hidden = true;
    const result = run.result;
    const config = run.config;
    $('export-evidence').disabled = false;
    if (result.status === 'verified') {
      $('verify-progress-wrap').className = 'ops-progress done';
      $('verify-progress').style.width = '100%';
      setFlow({ current: 'done', change: 'done', explore: 'done', verify: 'done', outcome: 'good' });
      const space = result.counters.schedulesChecked < result.budget.schedules
        ? `The search space was exhausted: every schedule the model defines for this fault budget was checked (${plural(result.space.singles, 'single-fault schedule')}).`
        : `${result.counters.singlesChecked} of ${result.space.singles} single-fault schedules and ${result.counters.multiChecked} multi-fault schedules were checked.`;
      statusBlock($('verify-status'), 'pass', 'VERIFIED WITHIN BOUND', `No modeled invariant violation found across ${plural(result.counters.schedulesChecked, 'explored schedule')}. ${esc(space)}`);
      $('verify-invariants').innerHTML = config.invariants.map((invariant) => `<li class="held">${esc(ops.describeInvariant(invariant, config.labels))}<small>held in all ${result.counters.schedulesChecked} schedules</small></li>`).join('');
      $('verify-result').innerHTML = `<div class="ops-card pass"><h3>Verified within bound</h3>
        <p>This is a statement about the model and the explored bound, not about production.</p>
        <dl><dt>Model</dt><dd>CloudProof Mesh (Phase III), ${esc(ops.version)}</dd>
        <dt>Search budget</dt><dd>${esc(result.budget.name)} (≤ ${result.budget.schedules}) · fault budget N+${result.maxFaults}</dd>
        <dt>Fault set</dt><dd>${esc(result.faults.join(', '))}</dd>
        <dt>Seed range</dt><dd>seed ${result.seed}, schedules #${result.scheduleRange[0]}–#${result.scheduleRange[1]}</dd>
        <dt>Horizon</dt><dd>${(result.horizonMs / 1000).toFixed(1)} s · faults at ${result.faultWindow.slotMs} ms steps to ${fmtT(result.faultWindow.toMs)}</dd></dl>
        ${preExistingHtml(result)}</div>`;
      verifyPlayer.clear('No counterexample in the explored bound, so there is nothing to replay. Raise the fault budget or the verification budget to search further.');
      verifyFix.clear('No counterexample to fix within this bound.');
      return;
    }
    if (result.status !== 'counterexample') return;
    $('verify-progress-wrap').className = 'ops-progress bad';
    const counterexample = result.counterexample;
    const primary = counterexample.primary;
    const invariant = config.invariants.find((item) => item.id === primary.invariant);
    setFlow({ current: 'done', change: 'done', explore: 'done', verify: 'done', outcome: 'bad', minimal: 'now' });
    statusBlock($('verify-status'), 'fail', 'COUNTEREXAMPLE FOUND', `${esc(ops.describeInvariant(invariant, config.labels))} — violated after ${plural(result.counters.schedulesChecked, 'explored schedule')}. The same faults without the change do not violate it.`);
    const violated = new Map(counterexample.violations.map((item) => [item.invariant, item]));
    $('verify-invariants').innerHTML = config.invariants.map((inv) => {
      const hit = violated.get(inv.id);
      return `<li class="${hit ? 'violated' : 'held'}">${esc(ops.describeInvariant(inv, config.labels))}<small>${hit ? `expected ${esc(hit.expected)}, observed ${esc(hit.observed)} at ${fmtT(hit.atMs)}` : `held until ${fmtT(counterexample.atMs)}`}</small></li>`;
    }).join('');
    renderCounterexampleCard(null);
    minimizeAndExplain({
      world: counterexample.world, trace: counterexample.trace, invariants: config.invariants, target: primary.invariant,
      requireChange: true, labels: config.labels, versions: config.versions, player: verifyPlayer, token: run.token,
      onDone: ({ shrink, replay }) => {
        run.shrink = shrink;
        run.replay = replay;
        renderCounterexampleCard(shrink);
        verifyPlayer.load({
          timeline: replay.timeline, explanation: replay.explanation, invariants: config.invariants,
          labels: config.labels, changeTargets: changeTargets(config.change), tag: `MINIMAL · ${shrink.minimal.actions} ACTIONS · LIVE REPLAY`,
        });
        verifyPlayer.renderShrink(shrink.steps, 'minimal');
        setFlow({ current: 'done', change: 'done', explore: 'done', verify: 'done', outcome: 'bad', minimal: 'done', fix: 'now' });
        const candidates = ops.remediationsFor({ world: config.world, change: config.change, labels: config.labels }, replay.explanation);
        verifyFix.setCandidates(candidates);
        verifyFix.intro.textContent = `Root cause: ${replay.explanation.root} (${String(replay.explanation.incidentClass || '').replace(/_/g, ' ').toLowerCase()}). Each candidate is re-run against the exact faults of this counterexample, then through the same search (seed ${config.seed}, ${result.budget.name} budget, N+${config.maxFaults}).`;
      },
    });
  }

  function preExistingHtml(result) {
    if (!result.counters.preExisting) return '';
    const top = (result.preExistingClasses || []).slice(0, 3).map((item) => `<li>${item.count}× ${esc(item.rootService || '—')} ${esc(String(item.incidentClass || '').replace(/_/g, ' ').toLowerCase())} → ${esc(item.invariant)} <span style="color:var(--op-faint)">(e.g. ${esc(item.example)})</span></li>`).join('');
    return `<p style="margin-top:10px!important"><b style="color:var(--op-amber)">${plural(result.counters.preExisting, 'pre-existing risk')}</b>: schedules that violate an invariant even without the change. Not caused by this change, but real in the model.</p><ul style="margin:6px 0 0;padding-left:16px;font-size:11.5px;color:var(--op-ink-2)">${top}</ul>`;
  }

  function renderCounterexampleCard(shrink) {
    const run = V.run;
    const result = run.result;
    const counterexample = result.counterexample;
    const primary = counterexample.primary;
    const invariant = run.config.invariants.find((item) => item.id === primary.invariant);
    const name = invariant.kind === 'route-available' ? `${invariant.route.toUpperCase()}_ROUTE_UNAVAILABLE`
      : invariant.kind === 'min-healthy' ? `${invariant.service.toUpperCase()}_CAPACITY_VIOLATION`
        : invariant.kind === 'queue-backlog' ? 'QUEUE_BACKLOG_VIOLATION'
          : invariant.kind === 'failover-deadline' ? 'FAILOVER_DEADLINE_MISSED' : 'ERROR_BUDGET_EXCEEDED';
    $('verify-result').innerHTML = `<div class="ops-card fail"><h3>${esc(name.replace(/-/g, '_'))}</h3>
      <p>${esc(ops.describeInvariant(invariant, run.config.labels))}</p>
      <dl><dt>Expected</dt><dd>${esc(primary.expected)}</dd><dt>Observed</dt><dd>${esc(primary.observed)}</dd>
      <dt>First appears</dt><dd>${fmtT(primary.atMs)}</dd>
      <dt>Found at</dt><dd>schedule #${counterexample.scheduleIndex} of ${result.counters.schedulesChecked}: ${esc(counterexample.label)}</dd>
      <dt>Original schedule</dt><dd>${plural(counterexample.trace.length, 'action')} · ${plural(counterexample.transitions, 'transition')}</dd>
      <dt>Minimized</dt><dd>${shrink ? `${plural(shrink.minimal.actions, 'action')} · ${plural(shrink.minimal.transitions, 'transition')}` : 'shrinking…'}</dd>
      <dt>Without the change</dt><dd>${counterexample.withoutChange.length ? `violates ${esc(counterexample.withoutChange.join(', '))} only` : 'no invariant violated'}</dd></dl>
      <button type="button" class="ops-btn primary wide" id="jump-replay" ${shrink ? '' : 'disabled'}>REPLAY FAILURE</button>
      ${preExistingHtml(result)}</div>`;
    $('jump-replay')?.addEventListener('click', () => {
      $('verify-player').scrollIntoView({ block: 'start', behavior: reduceMotion ? 'auto' : 'smooth' });
      verifyPlayer.play();
    });
  }

  // ------------------------------------------------ remediation compare (verify)
  function runCandidate() {
    const run = V.run;
    const remediation = verifyFix.current();
    if (!run?.result?.counterexample || !remediation) return;
    const config = run.config;
    let applied;
    try {
      applied = ops.applyRemediation({ world: config.world, change: config.change }, remediation);
    } catch (error) {
      verifyFix.compare.innerHTML = `<div class="ops-error">${esc(error.message)}</div>`;
      return;
    }
    const counterexample = run.result.counterexample;
    const environment = ops.replayEnvironment({
      world: applied.world, change: applied.change, versions: config.versions, invariants: config.invariants,
      placements: counterexample.placements, readiness: counterexample.readiness, faults: config.faults, horizonMs: run.result.horizonMs,
    });
    const candidateConfig = { ...config, world: applied.world, change: applied.change };
    const search = ops.createVerification(candidateConfig);
    const token = { cancelled: false };
    run.fixToken = token;
    verifyFix.run.disabled = true;
    const envText = environment.invalid ? `could not replay: ${esc(environment.reason)}`
      : environment.attributable.length ? `<b style="color:var(--op-red)">still violates</b> ${esc(environment.attributable[0].invariant)} at ${fmtT(environment.atMs)}`
        : environment.violated ? '<b style="color:var(--op-amber)">only pre-existing violations</b> (they also occur without the change)'
          : '<b style="color:var(--op-green)">no violation</b>';
    const render = (progress, final) => {
      const original = run.result;
      let candidateText;
      if (!final) candidateText = `<p>Exploring… ${progress.schedulesChecked} / ${progress.budget} schedules</p>`;
      else if (final.status === 'verified') candidateText = `<h3>Verified within bound</h3><p>No modeled violation found in ${plural(final.counters.schedulesChecked, 'schedule')}.</p>`;
      else if (final.status === 'counterexample') {
        const same = final.counterexample.primary.invariant === original.counterexample.primary.invariant;
        candidateText = `<h3>${same ? 'Same invariant still violated' : 'Different violation found'}</h3><p>${esc(final.counterexample.primary.invariant)} after ${plural(final.counters.schedulesChecked, 'schedule')}: ${esc(final.counterexample.label)}</p><button type="button" class="ops-btn ghost" id="inspect-candidate">INSPECT THIS COUNTEREXAMPLE</button>`;
      } else candidateText = `<p>${esc(final.status)}</p>`;
      const cls = !final ? '' : final.status === 'verified' ? 'pass' : 'fail';
      verifyFix.compare.innerHTML = `<div class="ops-compare">
        <div class="ops-card fail"><h4>ORIGINAL</h4><h3>Violation after ${plural(original.counters.schedulesChecked, 'schedule')}</h3><p>${esc(ops.changeSummary(config.change))}</p><p style="margin-top:6px!important">${esc(original.counterexample.primary.invariant)}: ${esc(original.counterexample.label)}</p></div>
        <div class="ops-card ${cls}"><h4>CANDIDATE</h4>${candidateText}${final ? '<button type="button" class="ops-btn ghost" id="export-candidate" style="margin-left:6px">EXPORT CANDIDATE BUNDLE</button>' : ''}</div>
        <div class="ops-compare-diff"><table><tbody>
          <tr><td>Same adversarial environment</td><td colspan="2">${envText} — the original counterexample's faults (${esc(counterexample.label)}) replayed against the candidate.</td></tr>
          ${remediation.diff.map((row) => `<tr><td>${esc(row.field)}</td><td>${esc(row.before)}</td><td>${esc(row.after)}</td></tr>`).join('')}
          <tr><td>Search</td><td colspan="2">same seed (${config.seed}), budget (${esc(run.result.budget.name)}), fault set and fault budget (N+${config.maxFaults})</td></tr>
        </tbody></table></div></div>`;
      if (final) {
        $('export-candidate')?.addEventListener('click', () => exportEvidence({ config: candidateConfig, result: final, shrink: null, suffix: 'candidate' }));
        $('inspect-candidate')?.addEventListener('click', () => inspectCandidate(candidateConfig, final));
      }
    };
    render({ schedulesChecked: 0, budget: search.budget.schedules }, null);
    pump(() => {
      const progress = search.run({ sliceMs: 28 });
      render(progress, null);
      return search.done;
    }, () => {
      verifyFix.run.disabled = false;
      const final = search.result();
      run.candidate = { config: candidateConfig, result: final };
      render(null, final);
      setFlow({ current: 'done', change: 'done', explore: 'done', verify: 'done', outcome: 'bad', minimal: 'done', fix: final.status === 'verified' ? 'good' : 'bad' });
      toast(final.status === 'verified' ? 'Candidate verified within bound' : 'Candidate still has a counterexample');
    }, token);
  }

  function inspectCandidate(config, final) {
    const counterexample = final.counterexample;
    verifyPlayer.clear('Minimizing the candidate counterexample…');
    $('verify-player').scrollIntoView({ block: 'start', behavior: reduceMotion ? 'auto' : 'smooth' });
    minimizeAndExplain({
      world: counterexample.world, trace: counterexample.trace, invariants: config.invariants, target: counterexample.primary.invariant,
      requireChange: true, labels: config.labels, versions: config.versions, player: verifyPlayer, token: { cancelled: false },
      onDone: ({ shrink, replay }) => {
        verifyPlayer.load({ timeline: replay.timeline, explanation: replay.explanation, invariants: config.invariants, labels: config.labels, changeTargets: changeTargets(config.change), tag: `CANDIDATE · MINIMAL · ${shrink.minimal.actions} ACTIONS` });
        verifyPlayer.renderShrink(shrink.steps, 'minimal');
      },
    });
  }

  // ------------------------------------------------ evidence + replay URL
  function exportEvidence({ config, result, shrink, suffix = '' }) {
    try {
      const bundle = ops.evidence.buildEvidence({
        scenario: { id: config.scenarioId, name: V.scenario.name }, config, result, shrink, exportedAt: new Date().toISOString(),
      });
      const check = ops.evidence.verifyEvidence(bundle);
      const text = `${JSON.stringify(bundle, null, 2)}\n`;
      const name = `cloudproof-evidence-${config.scenarioId}${suffix ? `-${suffix}` : ''}-${bundle.digests.bundle.slice(0, 12)}.json`;
      download(name, text);
      $('evidence-note').innerHTML = `${esc(name)} · bundle sha256 ${esc(bundle.digests.bundle.slice(0, 16))}… · ${check.checks.filter((item) => item.ok).length}/${check.checks.length} checks pass in this page. Re-verify offline: <code>node tools/cloudproof-ops.js check ${esc(name)} --rerun</code>`;
      toast('Proof bundle exported');
    } catch (error) {
      $('evidence-note').textContent = `Export failed: ${error.message}`;
    }
  }

  function replayUrl() {
    const url = new URL(location.href);
    const keep = new URLSearchParams();
    keep.set('mode', 'verify');
    if (V.demoId) keep.set('demo', V.demoId);
    keep.set('scenario', V.scenarioId);
    keep.set('change', V.change.type);
    for (const [key, value] of Object.entries(V.change)) if (key !== 'type') keep.set(key, String(value));
    keep.set('faults', [...V.faults].sort().join(','));
    keep.set('maxFaults', String(V.maxFaults));
    keep.set('budget', V.budget);
    keep.set('seed', String(V.seed));
    const defaults = V.scenario.invariants;
    const edited = V.invariants.filter((item, index) => !item.enabled || JSON.stringify({ ...item, enabled: undefined }) !== JSON.stringify({ ...defaults[index], enabled: undefined }));
    if (edited.length) keep.set('inv', JSON.stringify(V.invariants.map(({ enabled, ...rest }) => ({ ...rest, on: enabled }))));
    url.search = keep.toString();
    return url;
  }

  function syncUrl() {
    if (document.body.dataset.mode !== 'verify' || V.scenarioId === 'imported') return;
    history.replaceState(null, '', replayUrl());
  }

  $('export-evidence').addEventListener('click', () => {
    if (!V.run?.result) return;
    exportEvidence({ config: V.run.config, result: V.run.result, shrink: V.run.shrink });
  });
  $('copy-replay').addEventListener('click', async () => {
    if (V.scenarioId === 'imported') { toast('Imported topologies do not fit in a URL — export the proof bundle instead'); return; }
    const url = replayUrl();
    url.searchParams.set('run', '1');
    try {
      await navigator.clipboard.writeText(url.toString());
      toast('Replay URL copied');
    } catch (_) {
      $('evidence-note').textContent = url.toString();
      toast('Replay URL shown below');
    }
  });

  // ------------------------------------------------ import
  function openImport() {
    const dialog = $('import-dialog');
    $('import-errors').innerHTML = '';
    if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', '');
  }
  function exampleText() {
    const scenario = ops.loadScenario('checkout');
    return `${JSON.stringify(ops.topology.toSimplified(scenario.world, 'checkout-example'), null, 2)}\n`;
  }
  $('open-import').addEventListener('click', openImport);
  $('import-close').addEventListener('click', () => $('import-dialog').close?.());
  $('import-example').addEventListener('click', () => download('cloudproof-topology-example.json', exampleText()));
  $('import-fill').addEventListener('click', () => { $('import-text').value = exampleText(); });
  $('import-load').addEventListener('click', () => {
    const parsed = ops.topology.parseTopology($('import-text').value);
    if (!parsed.ok) {
      $('import-errors').innerHTML = `<p class="ops-help" style="color:var(--op-red)">The topology was rejected:</p><ul>${parsed.errors.map((error) => `<li>${esc(error)}</li>`).join('')}</ul>`;
      return;
    }
    V.imported = { world: parsed.world, name: parsed.world.template.replace(/^import:/, '') };
    $('import-dialog').close?.();
    selectScenario('imported');
    V.demoId = null;
    onConfigChanged();
    toast(`Imported ${parsed.world.services.length} services${parsed.warnings.length ? ` · ${parsed.warnings.join(' ')}` : ''}`);
  });

  // ------------------------------------------------ wiring
  $('scenario-select').addEventListener('change', (event) => { selectScenario(event.target.value); V.demoId = null; onConfigChanged(); });
  $('change-type').addEventListener('change', (event) => {
    V.uiType = event.target.value;
    V.change = defaultChange(V.uiType);
    V.demoId = null;
    renderChangeParams();
    onConfigChanged();
  });
  $('seed-input').addEventListener('change', (event) => { V.seed = Number(event.target.value); V.demoId = null; onConfigChanged(); });
  $('verify-run').addEventListener('click', runVerification);
  $('verify-cancel').addEventListener('click', cancelVerification);
  verifyFix.run.addEventListener('click', runCandidate);

  $('ops-demos').innerHTML = ops.DEMOS.map((demo) => `<button type="button" class="ops-demo" data-demo="${esc(demo.id)}"><b>${esc(demo.title)}</b><span>${esc(demo.caption)}</span></button>`).join('');
  $('ops-demos').querySelectorAll('[data-demo]').forEach((button) => button.addEventListener('click', () => applyDemo(button.dataset.demo)));
  $('ops-usecases').innerHTML = ops.USE_CASES.map((item, index) => `<button type="button" class="ops-usecase" data-usecase="${esc(item.id)}"><b>${String(index + 1).padStart(2, '0')} · ${esc(item.title.toUpperCase())}</b><span>${esc(item.copy)}</span><i>${item.mode === 'verify' ? `open: ${esc(ops.demoById(item.demo).title)}` : `open ${item.mode === 'incident' ? 'Incident Lab' : 'Architecture'}`} →</i></button>`).join('');
  $('ops-usecases').querySelectorAll('[data-usecase]').forEach((button) => button.addEventListener('click', () => {
    const item = ops.USE_CASES.find((useCase) => useCase.id === button.dataset.usecase);
    if (item.mode === 'verify') {
      setMode('verify');
      applyDemo(item.demo);
      if (item.remediate) toast('Run VERIFY CHANGE, then TRY A FIX: CloudProof checks the proposed remediation before it runs');
    } else setMode(item.mode, { focus: true });
  }));

  function readVerifyUrl() {
    const demo = params.get('demo');
    if (demo && ops.demoById(demo)) applyDemo(demo, { scroll: false });
    else selectScenario(ops.listScenarios().some((item) => item.id === params.get('scenario')) ? params.get('scenario') : 'checkout', { render: false });
    const scenario = params.get('scenario');
    if (scenario && scenario !== V.scenarioId && ops.listScenarios().some((item) => item.id === scenario)) selectScenario(scenario, { render: false });
    const type = params.get('change');
    if (type) {
      const change = { type };
      for (const key of ['service', 'toVersion', 'node', 'zone', 'database']) if (params.has(key)) change[key] = params.get(key);
      for (const key of ['maxSurge', 'maxUnavailable', 'replicas', 'intervalMs']) if (params.has(key)) change[key] = Number(params.get(key));
      try {
        ops.validateChange(world(), change);
        V.change = change;
        V.uiType = uiTypeFor(change);
      } catch (_) { /* fall back to the default change */ }
    }
    if (params.has('faults')) V.faults = new Set(params.get('faults').split(',').filter((family) => ops.FAULT_FAMILIES[family]?.modeled));
    if (params.has('maxFaults')) V.maxFaults = Math.min(3, Math.max(1, Number(params.get('maxFaults')) || 1));
    if (params.has('budget') && ops.BUDGETS[params.get('budget')]) V.budget = params.get('budget');
    if (params.has('seed')) V.seed = Number(params.get('seed'));
    if (params.has('inv')) {
      try {
        const list = JSON.parse(params.get('inv'));
        if (Array.isArray(list)) V.invariants = list.map(({ on, ...rest }) => ({ ...rest, enabled: on !== false }));
      } catch (_) { /* keep the scenario's invariants */ }
    }
    if (demo && V.demoId === demo) {
      const reference = ops.demoById(demo);
      const same = JSON.stringify(reference.change) === JSON.stringify(V.change) && reference.faults.slice().sort().join(',') === [...V.faults].sort().join(',');
      if (!same) V.demoId = null;
    }
    renderControls();
    onConfigChanged();
    if (params.get('run') === '1' && document.body.dataset.mode === 'verify') later(runVerification);
  }

  // ======================================================================
  // INCIDENT LAB
  // ======================================================================
  const I = { incident: null, token: null, result: null };
  let incidentGraph;
  let incidentPlayer;
  let incidentFix;
  let committedBundle = null;

  function initIncident() {
    incidentGraph = createGraphPanel({ host: $('incident-graph'), viewToggle: $('incident-graph-view'), inspect: $('incident-inspect'), ariaLabel: 'Topology during the incident' });
    incidentPlayer = createPlayer({ host: $('incident-player'), graph: incidentGraph, idPrefix: 'incident' });
    incidentPlayer.clear('Choose an incident and press REPLAY INCIDENT.');
    incidentFix = createFixPanel({ host: $('incident-fix'), idPrefix: 'incident', title: 'Compare with fix' });
    incidentFix.clear('Candidates appear after the incident is replayed and explained.');
    incidentFix.run.textContent = 'REPLAY THE SAME INCIDENT WITH THIS FIX';
    incidentFix.run.addEventListener('click', runIncidentFix);
    const items = ops.incidents.listIncidents().map((item) => ({ id: item.id, title: item.title, source: `${item.source} · ${item.template} · seed ${item.seed}` }));
    items.push({ id: 'committed-evidence', title: 'Roll out payment v42 — committed evidence bundle', source: 'apps/ops/fixtures · exported by tools/cloudproof-ops.js' });
    $('incident-list').innerHTML = items.map((item) => `<li><button type="button" class="ops-incident" data-incident="${esc(item.id)}" aria-pressed="false"><b>${esc(item.title)}</b><span>${esc(item.source)}</span></button></li>`).join('');
    $('incident-list').querySelectorAll('[data-incident]').forEach((button) => button.addEventListener('click', () => selectIncident(button.dataset.incident)));
    $('incident-replay').addEventListener('click', replayIncident);
    $('incident-load-paste').addEventListener('click', () => {
      try {
        const bundle = JSON.parse($('incident-paste').value);
        loadIncidentObject(fromBundle(bundle, 'pasted bundle'));
      } catch (error) {
        showIncidentError(error.message);
      }
    });
    const requested = params.get('incident');
    selectIncident(requested && items.some((item) => item.id === requested) ? requested : items[0].id);
  }

  function showIncidentError(message) {
    $('incident-error').hidden = !message;
    $('incident-error').textContent = message || '';
  }

  function fromBundle(bundle, origin) {
    const check = ops.evidence.verifyEvidence(bundle);
    const kind = check.checks.find((item) => item.name === 'bundle kind');
    if (kind && !kind.ok) throw new Error(`Not a CloudProof evidence bundle: ${kind.detail}.`);
    if (!bundle.counterexample) throw new Error('This bundle is a pass (verified within bound): there is no counterexample to replay.');
    const incident = ops.incidents.incidentFromEvidence(bundle);
    incident.checks = check;
    incident.origin = origin;
    return incident;
  }

  async function selectIncident(id) {
    showIncidentError('');
    $('incident-list').querySelectorAll('[data-incident]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.incident === id)));
    if (id === 'committed-evidence') {
      try {
        if (!committedBundle) {
          const response = await fetch('ops-evidence-rollout-payment.json');
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          committedBundle = await response.json();
        }
        loadIncidentObject(fromBundle(committedBundle, 'committed fixture'));
      } catch (error) {
        showIncidentError(`The committed bundle could not be loaded here (${error.message}). Paste it instead, or serve the page over HTTP.`);
      }
      return;
    }
    loadIncidentObject(ops.incidents.loadIncident(id));
  }

  function loadIncidentObject(incident) {
    if (I.token) I.token.cancelled = true;
    I.incident = incident;
    I.result = null;
    const url = new URL(location.href);
    if (document.body.dataset.mode === 'incident') { url.searchParams.set('incident', incident.id); history.replaceState(null, '', url); }
    $('incident-tag').textContent = incident.bundle ? 'EVIDENCE BUNDLE' : 'PHASE III RECORDING';
    $('incident-tag').className = `ops-tag ${incident.bundle ? 'fixture' : 'live'}`;
    incidentGraph.show(ops.initialGraph(incident.world, { labels: incident.labels, versions: incident.versions }), {});
    const duration = incident.trace.reduce((sum, entry) => sum + (entry.action.type === 'mesh.action.advance-time' ? entry.action.ms : 0), 0);
    statusBlock($('incident-status'), 'ready', 'READY TO REPLAY', `${esc(incident.title)}`);
    const checks = incident.checks ? `<dt>Bundle checks</dt><dd>${incident.checks.checks.filter((item) => item.ok).length}/${incident.checks.checks.length} pass (${esc(incident.checks.checks.filter((item) => !item.ok).map((item) => item.name).join(', ') || 'digests and replays match')})</dd>` : '';
    $('incident-summary').innerHTML = `<dt>Source</dt><dd>${esc(incident.source)}</dd><dt>Recording</dt><dd>${plural(incident.trace.length, 'action')} over ${(duration / 1000).toFixed(1)} s</dd>
      <dt>Invariants</dt><dd>${esc(incident.invariants.map((item) => ops.describeInvariant(item, incident.labels)).join('; '))}</dd>${checks}`;
    $('incident-replay').disabled = false;
    incidentPlayer.clear('Press REPLAY INCIDENT to run the recording, find the first violation and shrink it.');
    incidentFix.clear('Candidates appear after the incident is replayed and explained.');
  }

  function replayIncident() {
    const incident = I.incident;
    if (!incident) return;
    const token = { cancelled: false };
    I.token = token;
    const outline = ops.incidents.incidentOutline(incident.world, incident.trace, incident.invariants);
    if (!outline.firstViolation) {
      statusBlock($('incident-status'), 'pass', 'NO VIOLATION IN THE RECORDING', 'The recording replays without violating any modeled invariant.');
      return;
    }
    const prefix = ops.incidents.incidentPrefix(incident.world, incident.trace, incident.invariants, incident.target);
    statusBlock($('incident-status'), 'fail', 'INVARIANT VIOLATED', `First violation at ${fmtT(outline.firstViolation.atMs)} (action ${prefix.trace.length} of ${incident.trace.length}). Shrinking…`);
    minimizeAndExplain({
      world: incident.world, trace: prefix.trace, invariants: incident.invariants, target: prefix.violation.invariant,
      requireChange: incident.requireChange, labels: incident.labels, versions: incident.versions, player: incidentPlayer, token,
      onDone: ({ shrink, replay }) => {
        I.result = { outline, prefix, shrink, replay };
        const explanation = replay.explanation;
        const affected = [...new Set([explanation.root, ...explanation.chain].filter(Boolean))].map((id) => incident.labels[id] || id);
        const recovery = outline.recovered ? `${fmtT(outline.recoveredAtMs)} (violating for ${(outline.violatingMs / 1000).toFixed(1)} s in total)` : `not recovered by the end of the recording (${fmtT(outline.endMs)})`;
        statusBlock($('incident-status'), 'fail', 'INCIDENT REPRODUCED', `${esc(explanation.invariantText)} — expected ${esc(explanation.expected)}, observed ${esc(explanation.observed)}.`);
        $('incident-summary').innerHTML += `<dt>First violated</dt><dd>${esc(explanation.invariantText)} at ${fmtT(outline.firstViolation.atMs)}</dd>
          <dt>Causal chain</dt><dd>${esc(explanation.chain.slice().reverse().map((id) => incident.labels[id] || id).join(' → '))}${explanation.route ? ` → ${esc(explanation.route)} route` : ''}</dd>
          <dt>Affected services</dt><dd>${esc(affected.join(', '))}</dd>
          <dt>Recovery point</dt><dd>${recovery}</dd>
          <dt>Minimal trace</dt><dd>${plural(shrink.original.actions, 'action')} → ${plural(shrink.minimal.actions, 'action')}</dd>`;
        incidentPlayer.load({ timeline: replay.timeline, explanation, invariants: incident.invariants, labels: incident.labels, changeTargets: [], tag: `MINIMAL · ${shrink.minimal.actions} ACTIONS · LIVE REPLAY` });
        incidentPlayer.renderShrink(shrink.steps, 'minimal');
        const change = incident.bundle ? incident.bundle.change : null;
        const candidates = ops.remediationsFor({ world: incident.world, change: change || null, labels: incident.labels }, explanation);
        incidentFix.setCandidates(candidates);
        incidentFix.intro.textContent = change
          ? 'The candidate is replayed against the exact faults recorded in the bundle.'
          : `The fixed topology is replayed against the same ${incident.trace.length} recorded actions. Nothing else changes.`;
      },
    });
  }

  function runIncidentFix() {
    const incident = I.incident;
    const remediation = incidentFix.current();
    if (!incident || !remediation || !I.result) return;
    const bundle = incident.bundle;
    let text;
    try {
      if (bundle) {
        const applied = ops.applyRemediation({ world: bundle.topology.world, change: bundle.change }, remediation);
        const counterexample = bundle.counterexample;
        const invariants = incident.invariants;
        const environment = ops.replayEnvironment({ world: applied.world, change: applied.change, versions: bundle.versions, invariants, placements: counterexample.placements, readiness: counterexample.readinessDelay, faults: bundle.faultModel.families, horizonMs: bundle.search.horizonMs });
        text = environment.attributable.length ? { cls: 'fail', head: 'Still violates', body: `${environment.attributable[0].invariant} at ${fmtT(environment.atMs)} under the recorded faults.` }
          : { cls: 'pass', head: 'No violation under the recorded faults', body: 'The same fault schedule no longer violates a modeled invariant. Run it through Verify Change for a full bounded search.' };
      } else {
        const applied = ops.applyRemediation({ world: incident.world, change: null }, remediation);
        const outline = ops.incidents.incidentOutline(applied.world, incident.trace, incident.invariants);
        if (!outline.firstViolation) {
          text = { cls: 'pass', head: 'The same recording replays clean', body: `All ${incident.trace.length} recorded actions replay without violating a modeled invariant.` };
        } else {
          // Say whether it is the same failure or a different one.
          const prefix = ops.incidents.incidentPrefix(applied.world, incident.trace, incident.invariants);
          const after = ops.explainTrace({ world: applied.world, trace: prefix.trace, invariants: incident.invariants, labels: incident.labels, requireChange: false }).explanation;
          const before = I.result.replay.explanation;
          const same = after && after.root === before.root && after.incidentClass === before.incidentClass;
          const name = (id) => incident.labels[id] || id;
          const cls = (value) => String(value || '').replace(/_/g, ' ').toLowerCase();
          text = {
            cls: 'fail',
            head: same ? 'Same failure remains' : 'A different failure appears',
            body: `${outline.firstViolation.invariant} at ${fmtT(outline.firstViolation.atMs)} (was ${fmtT(I.result.outline.firstViolation.atMs)}). Root cause now: ${name(after?.root)} (${cls(after?.incidentClass)})${same ? '' : `; before: ${name(before.root)} (${cls(before.incidentClass)})`}.`,
          };
        }
      }
    } catch (error) {
      text = { cls: 'warn', head: 'Could not apply', body: error.message };
    }
    incidentFix.compare.innerHTML = `<div class="ops-compare">
      <div class="ops-card fail"><h4>AS RECORDED</h4><h3>Violated at ${fmtT(I.result.outline.firstViolation.atMs)}</h3><p>${esc(I.result.replay.explanation.invariantText)}</p></div>
      <div class="ops-card ${text.cls}"><h4>WITH FIX</h4><h3>${esc(text.head)}</h3><p>${esc(text.body)}</p></div>
      <div class="ops-compare-diff"><table><tbody>${remediation.diff.map((row) => `<tr><td>${esc(row.field)}</td><td>${esc(row.before)}</td><td>${esc(row.after)}</td></tr>`).join('')}</tbody></table></div></div>`;
  }

  // ======================================================================
  // ARCHITECTURE WHAT-IF
  // ======================================================================
  const A = { replay: null, timer: null, step: 0 };
  let archGraphs;

  function initArchitecture() {
    archGraphs = {
      A: createGraphPanel({ host: $('arch-graph-a'), inspect: null, ariaLabel: 'Topology A' }),
      B: createGraphPanel({ host: $('arch-graph-b'), inspect: null, ariaLabel: 'Topology B' }),
    };
    $('arch-family').innerHTML = ops.architecture.families().map((family) => `<option value="${esc(family.id)}">${esc(family.title)} (${esc(family.relation)})</option>`).join('');
    $('arch-template').innerHTML = ops.architecture.templates().map((id) => `<option value="${esc(id)}" ${id === 'T1' ? 'selected' : ''}>${esc(id)}</option>`).join('');
    $('arch-find').addEventListener('click', findPair);
    $('arch-run').addEventListener('click', runPair);
    ['arch-family', 'arch-template'].forEach((id) => $(id).addEventListener('change', findPair));
    findPair();
  }

  function stopPair() {
    clearInterval(A.timer);
    A.timer = null;
  }

  function findPair() {
    stopPair();
    const family = $('arch-family').value;
    const templateId = $('arch-template').value;
    const seed = Math.max(1, Number($('arch-seed').value) || 1);
    const found = ops.architecture.findDecisivePair({ family, templateId, seed });
    if (!found) {
      $('arch-claim').innerHTML = `<div class="ops-error">No decisive pair in 40 seeds from ${seed}. Try another start seed or template.</div>`;
      $('arch-run').disabled = true;
      return;
    }
    A.replay = ops.architecture.pairReplay(found);
    A.step = 0;
    const replay = A.replay;
    const assertions = [
      ['P1_pooledIdentical', 'same pooled node features'],
      ['P2_degreeAwareIdentical', 'same degrees and co-location'],
      ['P3_sameActions', 'same fault schedule'],
      ['P4_onlySwappedRelationDiffers', `only ${replay.swappedRelation} edges differ`],
      ['P5_sameNodesNoPreFaultViolation', 'same nodes, no violation before the fault'],
    ];
    $('arch-claim').innerHTML = `<p class="claim">Same resources. Same fault. <em>Different ${esc(replay.swappedRelation)} wiring.</em></p>
      <div class="ops-asserts">${assertions.map(([key, text]) => `<span class="${replay.assertions[key] ? 'ok' : 'no'}">${esc(text)}</span>`).join('')}</div>`;
    for (const member of ['A', 'B']) {
      const data = replay.members[member];
      $(`arch-${member.toLowerCase()}-tag`).textContent = `WIRING ${data.wiring === 'W' ? 'W' : 'W′'}`;
      const first = data.timeline.events[0];
      archGraphs[member].show(first.before, { diffEdges: replay.differing[member], idPrefix: `arch-${member}` });
      const out = $(`arch-outcome-${member.toLowerCase()}`);
      out.className = 'ops-outcome idle';
      out.innerHTML = `<b>NOT RUN YET</b>Fault: ${esc(faultText(replay.fault))}. Violet edges are the only difference from the other topology.`;
    }
    const fault = replay.fault;
    $('arch-facts').innerHTML = `<div class="ops-summary"><dl>
      <dt>Pair</dt><dd>${esc(replay.pairId)}</dd>
      <dt>Generator</dt><dd>packages/cloudproof-mesh/pairs.js · template ${esc(replay.template)} · seed ${replay.seed}${replay.skippedSeeds.length ? ` (${replay.skippedSeeds.length} earlier seed${replay.skippedSeeds.length === 1 ? '' : 's'} not decisive)` : ''}</dd>
      <dt>Swapped relation</dt><dd>${esc(replay.swappedRelation)} — one degree-preserving double-edge swap</dd>
      <dt>Fault</dt><dd>${esc(faultText(fault))} after 0.5 s warm-up, then 5 s observed</dd>
      <dt>Critical route</dt><dd>${esc(replay.criticalRoute)}</dd>
      <dt>Hops fault → route</dt><dd>${replay.hopsFromFaultToCriticalRoute ?? '—'}</dd>
      <dt>Verdict</dt><dd>decided by the simulator; which member is riskier is not known until it runs</dd></dl></div>`;
    $('arch-why').innerHTML = '<p class="ops-help">Run the same failure on both to see where it propagates.</p>';
    $('arch-step').textContent = 'STEP —';
    $('arch-run').disabled = false;
  }

  function faultText(fault) {
    if (fault.nodeId) return `${fault.nodeId} crashes`;
    if (fault.zoneId) return `${fault.zoneId} degrades`;
    if (fault.serviceId) return `cache ${fault.serviceId.replace('svc-', '')} is flushed`;
    return fault.type;
  }

  function runPair() {
    stopPair();
    const replay = A.replay;
    if (!replay) return;
    const length = Math.max(replay.members.A.timeline.events.length, replay.members.B.timeline.events.length);
    const show = (step) => {
      A.step = step;
      $('arch-step').textContent = `STEP ${step + 1}/${length}`;
      for (const member of ['A', 'B']) {
        const data = replay.members[member];
        const events = data.timeline.events;
        const event = events[Math.min(step, events.length - 1)];
        const ended = step >= events.length - 1;
        archGraphs[member].show(event.after, {
          diffEdges: replay.differing[member],
          pulse: step < events.length ? event.affected : {},
          highlight: data.violated && ended ? data.explanation?.highlight || {} : {},
          idPrefix: `arch-${member}`,
        });
        const out = $(`arch-outcome-${member.toLowerCase()}`);
        if (data.violated && ended) {
          const route = replay.members[member].world.routes.find((item) => item.id === data.explanation?.route);
          out.className = 'ops-outcome fail';
          out.innerHTML = `<b>FAILS AT ${fmtT(data.violation.atMs)}</b>${esc(route ? `${route.id} (${route.sharePct}% of traffic) fails` : 'error budget exceeded')}: ${esc(data.violation.observed)} of traffic failing, budget ${esc(data.violation.expected)}.`;
        } else if (step >= length - 1) {
          // Degraded if anything was down or any route failed at any step.
          const degraded = events.some((item) => item.after.services.some((service) => !service.up) || item.after.routes.some((route) => route.failing));
          const worst = Math.max(...events.map((item) => item.after.routes.filter((route) => route.failing).reduce((sum, route) => sum + route.sharePct, 0)));
          out.className = 'ops-outcome pass';
          out.innerHTML = `<b>${degraded ? 'DEGRADED BUT SURVIVES' : 'SURVIVES'}</b>${worst ? `At worst ${worst}% of traffic failed, within the 20% budget.` : 'No route failed.'} Observed for ${fmtT(event.endMs).replace('T+', '')} after the same fault.`;
        } else {
          const failing = event.after.routes.filter((route) => route.failing);
          const down = event.after.services.filter((service) => !service.up).map((service) => service.label);
          out.className = 'ops-outcome idle';
          out.innerHTML = `<b>RUNNING · ${fmtT(event.endMs)}</b>${failing.length ? `${esc(failing.map((route) => `${route.id} (${route.sharePct}%)`).join(', '))} failing` : 'all routes serving'}${down.length ? ` · down: ${esc(down.join(', '))}` : ''}`;
        }
      }
      if (step >= length - 1) {
        stopPair();
        const failing = ['A', 'B'].find((member) => replay.members[member].violated);
        const explanation = failing ? replay.members[failing].explanation : null;
        const survivor = failing === 'A' ? 'B' : 'A';
        const survivorWorst = Math.max(0, ...replay.members[survivor].timeline.events.map((item) => item.after.routes
          .filter((route) => route.failing).reduce((sum, route) => sum + route.sharePct, 0)));
        $('arch-why').innerHTML = explanation
          ? `<div class="ops-why"><h3>TOPOLOGY ${failing} FAILS · WHY</h3>${explanation.narrative.map((sentence) => `<p>${esc(sentence)}</p>`).join('')}<ol class="ops-path">${explanation.path.map((item) => `<li class="k-${esc(item.kind)}">${esc(item.label)}</li>`).join('')}</ol>
             <p class="ops-help" style="margin-top:10px!important">In topology ${survivor} the same fault hits the same component. With its ${esc(replay.swappedRelation)} wiring, what fails as a result carries ${survivorWorst ? `at most ${survivorWorst}%` : 'none'} of traffic, within the 20% budget.</p></div>`
          : '<p class="ops-help">Neither member violated the SLO.</p>';
      }
    };
    if (reduceMotion) { show(length - 1); return; }
    show(0);
    A.timer = setInterval(() => show(Math.min(length - 1, A.step + 1)), 260);
  }

  // ======================================================================
  // RESEARCH
  // ======================================================================
  async function initResearch() {
    const host = $('research-body');
    let pilot = null;
    try {
      const response = await fetch('phase-iii-pilot.json');
      if (response.ok) pilot = await response.json();
    } catch (_) { pilot = null; }
    const rows = pilot?.natural ? Object.entries(pilot.natural).map(([template, item]) => `<tr><td>${esc(template)}</td><td>${esc(item.split)}</td><td>${item.trajectories}</td><td>${(item.unsafeRate * 100).toFixed(0)}%</td><td>${esc(Object.entries(item.incidentClasses).map(([name, count]) => `${name.toLowerCase().replace(/_/g, ' ')} ${count}`).join(', '))}</td></tr>`).join('') : '';
    const repo = 'https://github.com/RaghhavMalani/cloudproof/blob/main';
    host.innerHTML = `
      <section class="ops-panel"><h3>What the console runs</h3><p>CloudProof Mesh (<code>packages/cloudproof-mesh</code>): zones, nodes, pods, services, routes and volumes on a 100 ms tick, with eviction, rescheduling, database failover, cache warm-up and queue backlog. The console's product layer (<code>packages/cloudproof-ops</code>) adds change controllers, modeled invariants, bounded search, shrinking and explanations on top, without changing simulator semantics.</p></section>
      <section class="ops-panel"><h3>What a verdict means</h3><p>"Verified within bound" means no modeled invariant was violated in the schedules the search explored, for the stated fault set, fault budget, seed and horizon. It says nothing about behaviour the model does not include (latency, partial failures, real schedulers).</p></section>
      <section class="ops-panel"><h3>Learned search priority</h3><p><b>Not enabled.</b> Phase III is preregistered and no model has been trained on it yet. Earlier graph models (Phase II-B) are research artifacts; the console does not use any learned score, and never uses one to decide a verdict.</p></section>
      <section class="ops-panel wide"><h3>Phase III pilot: simulator outcomes only</h3><p>Natural, outcome-blind schedules on generated worlds, used to freeze the template ranges before any model exists. ${pilot ? `Elapsed ${pilot.elapsedSeconds}s.` : 'The pilot summary could not be loaded in this context.'}</p>
        ${rows ? `<table><thead><tr><th>Template</th><th>Split</th><th>Trajectories</th><th>Unsafe</th><th>Incident classes</th></tr></thead><tbody>${rows}</tbody></table>` : ''}</section>
      <section class="ops-panel"><h3>Preregistered design</h3><p>The Phase III question, pair construction, controls and pass criteria were committed before any simulator code.</p><ul><li><a href="${repo}/CLOUDPROOF-PHASE-III-MULTISERVICE.md" target="_blank" rel="noreferrer">Phase III design and preregistration</a></li><li><a href="${repo}/CLOUDPROOF-PHASE-II-B2.md" target="_blank" rel="noreferrer">Phase II-B.2 frozen-corpus attribution</a></li><li><a href="${repo}/RESEARCH.md" target="_blank" rel="noreferrer">Research overview</a></li></ul></section>
      <section class="ops-panel"><h3>Reproduce from a terminal</h3><p>Every console verification runs identically in Node:</p><ul><li><code>node tools/cloudproof-ops.js verify --demo rollout-payment</code></li><li><code>node tools/cloudproof-ops.js export --demo rollout-payment --out b.json</code></li><li><code>node tools/cloudproof-ops.js check b.json --rerun</code></li></ul></section>
      <section class="ops-panel"><h3>Agent Reliability Lab</h3><p>The deterministic agent and distributed-systems workloads, the Bug Museum, and the simulator-versus-recorded-Docker comparison live under <b>AGENT LAB</b>, unchanged.</p><button type="button" class="ops-btn" style="margin-top:10px" id="research-to-agent">OPEN AGENT LAB</button></section>`;
    $('research-to-agent')?.addEventListener('click', () => setMode('agent', { focus: true }));
  }

  // ---------------------------------------------------------------- boot
  const requested = params.get('mode');
  const initial = MODES.includes(requested) ? requested
    : (params.has('workload') || params.has('museum') || params.has('theme')) ? 'agent' : 'verify';
  // Set before reading the verify URL, so that an Agent Lab replay URL is not
  // rewritten with console parameters while the console initialises.
  document.body.dataset.mode = initial;
  try {
    readVerifyUrl();
  } catch (error) {
    console.error(error);
    selectScenario('checkout');
    onConfigChanged();
  }
  setMode(initial, { updateUrl: initial !== 'verify' });
  if (initial === 'verify') syncUrl();

  window.cloudProofConsole = { setMode, applyDemo, runVerification, state: V };
})();
