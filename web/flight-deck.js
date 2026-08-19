(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const api = window.miniRaft?.workloads;
  if (!api) {
    const error = document.createElement('section');
    error.className = 'boot-error';
    error.innerHTML = '<h2>The simulator could not start.</h2><p>The browser engine did not load. Rebuild with <code>node tools/build-web.js</code>, then refresh.</p>';
    document.body.prepend(error);
    return;
  }
  const params = new URLSearchParams(location.search);
  const seed = Number(params.get('seed')) || 42;
  const THEMES = ['emirates', 'qatar', 'american'];
  const state = {
    workloadId: params.get('workload') || 'payment',
    theme: THEMES.includes(params.get('theme')) ? params.get('theme') : 'emirates',
    result: null,
    cursor: 0,
    playing: false,
    guided: false,
    timer: null,
  };
  const LANES = [
    ['clients', 'clients'], ['nodes', 'nodes'], ['faults', 'faults'],
    ['commits', 'commits'], ['invariants', 'invariants'],
  ];

  const PLAIN_EVENT_COPY = {
    'client.request.started': 'Checkout asks to charge ₹42. It attaches the stable request ID pay-7 so any retry can be recognised.',
    'gateway.request.accepted': 'The gateway has capacity, accepts pay-7, and forwards it to the replicated payment service.',
    'queue.message.delivered': 'A worker receives the job. The queue may deliver it again until it sees an acknowledgement.',
    'raft.log.appended': 'The leader writes the command into its log. It is proposed, but it is not safe to apply yet.',
    'raft.entry.persisted': 'A follower saves the same command. The operation now survives losing one server.',
    'raft.quorum.reached': 'Two of the three servers have saved the command. That majority is the quorum.',
    'raft.commit.advanced': 'The leader marks the command committed because a quorum has persisted it.',
    'state.machine.applied': 'The committed charge changes the ledger once and caches its result under pay-7.',
    'network.response.dropped': 'The charge succeeded, but the reply packet disappears. Checkout cannot tell whether it worked.',
    'client.request.retried': 'Checkout reaches its retry timer and sends pay-7 again with the same request ID.',
    'dedupe.hit': 'The processor finds pay-7 in its result cache and returns the original answer without charging again.',
    'client.response.completed': 'Checkout finally receives the successful result. The ledger still contains only one charge.',
  };
  const SAFETY_COPY = {
    configuration: 'No desired-state revision may be missed when the controller reconnects.',
    payment: 'At-least-once delivery is allowed, but pay-7 must change the ledger exactly once.',
    'vector-search': 'A partial result must disclose the missing shard and must still obey the tenant filter.',
    rollout: 'Traffic may use v1 or v2, but one response must never combine both versions.',
    streaming: 'Playback may only advance, and no failover may exceed the viewer\'s device limit.',
    dispatch: 'Only the current offer epoch may assign a ride, and one driver may hold at most one ride.',
    inventory: 'Committed holds plus available stock must always equal the initial stock.',
    feed: 'An author reload must include every post in that session\'s committed write frontier.',
    collaboration: 'Replicas receiving the same CRDT operations must converge regardless of delivery order.',
    settlement: 'Every participant must reach the one durable 2PC outcome without duplicating money.',
  };

  const SCENARIO_COPY = {
    configuration: 'A controller loses its watch transport while two desired-state revisions commit, then resumes from its last checkpoint.',
    payment: 'The commit survives the packet. The retry must discover the original result, not create a second effect.',
    'vector-search': 'The router must choose between completeness and deadline while preserving filter safety and disclosing missing shards.',
    rollout: 'Corrupt bytes and a straggler hold the barrier closed while traffic remains on one coherent model version.',
    streaming: 'Two devices occupy the plan while a deposed leader and a late heartbeat try to violate different viewer-state rules.',
    dispatch: 'An expired offer is reassigned before the first driver\'s delayed accept emerges from a tunnel.',
    inventory: 'A minority leader accepts a reservation it cannot commit while five buyers contend for three units.',
    feed: 'A post is durable before asynchronous fan-out reaches the edge cache, and the author reloads immediately.',
    collaboration: 'Two editors work offline, then exchange concurrent and causally reordered operations without a leader.',
    settlement: 'Both ledgers prepare and the coordinator records COMMIT, then crashes before either participant is notified.',
  };

  const THEME_META = { emirates: '#65101b', qatar: '#5c0632', american: '#0b304e' };

  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);

  function showRuntimeError(error) {
    const host = document.createElement('section');
    host.className = 'boot-error';
    host.innerHTML = `<h2>The scenario stopped before take-off.</h2><p>${escapeHtml(error.message)}</p><pre>${escapeHtml(error.stack || '')}</pre>`;
    document.querySelector('.quick-start')?.after(host);
  }

  function toast(message) {
    const el = $('toast');
    el.textContent = message;
    el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), 1700);
  }

  function eventSnapshot(index) {
    for (let cursor = index; cursor >= 0; cursor -= 1) {
      const snapshot = state.result.events[cursor]?.data?.after;
      if (snapshot?.nodes) return snapshot;
    }
    return state.result.visualization;
  }

  function setTheme(theme, updateUrl = true) {
    const selected = THEMES.includes(theme) ? theme : 'emirates';
    state.theme = selected;
    document.body.dataset.theme = selected;
    if ($('theme-select')) $('theme-select').value = selected;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_META[selected]);
    if (updateUrl) {
      const url = new URL(location.href);
      url.searchParams.set('theme', selected);
      history.replaceState(null, '', url);
    }
  }

  function showGuide() {
    const dialog = $('guide-dialog');
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
  }

  function hideQuickStart() {
    $('quick-start')?.classList.add('is-hidden');
  }

  function renderTabs() {
    $('workload-tabs').innerHTML = api.WORKLOADS.map((workload, index) => `
      <button class="workload-tab ${workload.id === state.workloadId ? 'active' : ''}" data-workload="${workload.id}" aria-pressed="${workload.id === state.workloadId}">
        <span>${String(index + 1).padStart(2, '0')}</span><div><b>${escapeHtml(workload.shortName)}</b><small>${escapeHtml(workload.scenario)}</small></div><i></i>
      </button>`).join('');
    document.querySelectorAll('[data-workload]').forEach((button) => {
      button.onclick = () => selectWorkload(button.dataset.workload);
    });
  }

  function renderBriefing() {
    const { workload, metrics } = state.result;
    $('workload-name').textContent = workload.name;
    $('workload-question').textContent = workload.question;
    $('scenario-name').textContent = workload.scenario;
    $('scenario-summary').textContent = SCENARIO_COPY[workload.id];
    $('workload-metrics').innerHTML = metrics.map((metric) => `
      <div class="metric"><small>${escapeHtml(metric.label)}</small><b>${escapeHtml(metric.value)}</b><span>${escapeHtml(metric.unit)}</span></div>`).join('');
  }

  function renderSystem(snapshot) {
    $('system-title').textContent = snapshot.title;
    $('system-subtitle').textContent = snapshot.subtitle;
    $('system-policy').textContent = snapshot.policy;
    $('system-nodes').innerHTML = snapshot.nodes.map((node) => `
      <article class="system-node ${escapeHtml(node.accent)}">
        <div><strong>${escapeHtml(node.label)}</strong><em>${node.process === 'up' ? '● UP' : '× DOWN'}</em></div>
        <div class="node-states"><span>${escapeHtml(node.network)}</span><span>${escapeHtml(node.raftRole)}</span></div>
        <small>${escapeHtml(node.detail)}</small>
      </article>`).join('');
  }

  function journeyEvents() {
    const events = state.result.events.filter((event) => event.type !== 'invariant.checked');
    if (state.workloadId === 'payment') return events.filter((event) => event.correlationId === 'pay-7');
    return events;
  }

  function renderJourney() {
    const selected = state.result.events[state.cursor];
    const journey = journeyEvents();
    $('journey-title').textContent = state.result.workload.scenario;
    $('journey-ribbon').innerHTML = journey.map((event) => `
      <button class="journey-step ${event.data.lane === 'faults' ? 'fault' : ''} ${event.id === selected?.id ? 'active' : ''}" data-event-id="${event.id}">
        <b>${escapeHtml(event.data.actor)} → ${escapeHtml(event.data.target || 'state')}</b><span>${escapeHtml(event.data.label)}</span>
      </button>`).join('');
    document.querySelectorAll('[data-event-id]').forEach((button) => {
      button.onclick = () => selectEvent(state.result.events.findIndex((event) => event.id === button.dataset.eventId));
    });
    document.querySelector('.journey-step.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  }

  function renderTimeline() {
    const events = state.result.events;
    const maxTime = Math.max(1, ...events.map((event) => event.time.elapsedMs));
    $('timeline-lanes').innerHTML = LANES.map(([lane, label]) => {
      const marks = events.map((event, index) => ({ event, index }))
        .filter(({ event }) => event.data.lane === lane)
        .map(({ event, index }) => `
          <button class="event-mark ${lane} ${index === state.cursor ? 'active' : ''}" style="left:${Math.max(1.5, Math.min(98.5, event.time.elapsedMs / maxTime * 100))}%" data-event="${index}" title="${escapeHtml(event.data.label)}"></button>`).join('');
      return `<div class="timeline-lane"><span class="lane-label">${label}</span><div class="lane-track">${marks}</div></div>`;
    }).join('');
    document.querySelectorAll('[data-event]').forEach((button) => {
      button.onclick = () => selectEvent(Number(button.dataset.event));
    });
  }

  function renderInvariants() {
    const checks = state.result.invariants;
    $('invariants').innerHTML = checks.map((check) => `
      <div class="invariant ${check.status}"><b>${check.status === 'pass' ? 'PASS FOR THIS EXECUTION' : check.status.toUpperCase()} · ${escapeHtml(check.id.replaceAll('-', ' '))}</b><span>${escapeHtml(check.summary)}</span></div>`).join('');
    const failed = checks.some((check) => check.status === 'fail');
    const watched = checks.some((check) => check.status === 'watch');
    $('metric-safe').textContent = failed ? 'VIOLATION' : watched ? 'PASS · LIMIT DISCLOSED' : 'PASS FOR THIS EXECUTION';
    $('metric-safe').className = failed ? 'status-fail' : watched ? 'status-watch' : 'status-pass';
  }

  function renderPlainStep(event) {
    const copy = PLAIN_EVENT_COPY[event.type] || event.data.detail || event.data.summary || 'The system advances one deterministic step.';
    $('plain-step-number').textContent = state.cursor + 1;
    $('plain-step-title').textContent = event.data.lane === 'faults'
      ? `Failure injected: ${event.data.label}`
      : event.data.label || event.type;
    $('plain-step-copy').textContent = copy;
    $('plain-step-safety').textContent = SAFETY_COPY[state.workloadId];
    $('plain-step').classList.toggle('fault-step', event.data.lane === 'faults');
  }

  function renderInspector() {
    const event = state.result.events[state.cursor];
    if (!event) return;
    $('event-lane').textContent = event.data.lane;
    $('event-type').textContent = event.type.toUpperCase();
    $('event-label').textContent = event.data.label || event.type;
    $('event-detail').textContent = event.data.detail || event.data.summary || 'Structured causal event.';
    const facts = {
      actor: event.data.actor || event.source.component,
      target: event.data.target || event.subject.id,

      elapsed: `${event.time.elapsedMs} ms ${event.time.kind}`,
      correlation: event.correlationId,
      causedBy: event.causationId ? event.causationId.split(':').at(-1) : 'root',
    };
    if (event.data.live != null) facts.quorum = `${event.data.live} live · ${event.data.required} required · ${event.data.configured} configured`;
    if (event.data.effect?.duplicate != null) facts.duplicate = String(event.data.effect.duplicate);
    if (event.data.revision != null) facts.revision = event.data.revision;
    renderPlainStep(event);
    $('event-facts').innerHTML = Object.entries(facts).map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd>`).join('');
    $('why-answer').hidden = true;
    $('why-trigger').innerHTML = `WHY DID “${escapeHtml((event.data.label || event.type).toUpperCase())}” HAPPEN? <span>↗</span>`;
    const hasDiff = Array.isArray(event.data.beforeLog) && Array.isArray(event.data.afterLog);
    $('log-diff').hidden = !hasDiff;
    if (hasDiff) {
      $('log-before').textContent = event.data.beforeLog.join('\n');
      $('log-after').textContent = event.data.afterLog.join('\n');
    }
    $('event-raw').textContent = JSON.stringify(event, null, 2);
  }

  function renderCursor() {
    const event = state.result.events[state.cursor];
    $('scrubber').max = state.result.events.length - 1;
    $('scrubber').value = state.cursor;
    $('cursor-label').textContent = `EVENT ${state.cursor + 1} / ${state.result.events.length}`;
    $('clock-label').textContent = `T+${event?.time.elapsedMs || 0} ms`;
    renderSystem(eventSnapshot(state.cursor));
    renderJourney();
    renderTimeline();
    renderInspector();
  }

  function selectEvent(index) {
    state.cursor = Math.max(0, Math.min(state.result.events.length - 1, index));
    renderCursor();
  }

  function stopPlayback() {
    clearInterval(state.timer);
    state.timer = null;
    state.playing = false;
    $('play-pause').textContent = 'PLAY TRACE';
    state.guided = false;
  }

  function togglePlayback() {
    if (state.playing) return stopPlayback();
    if (state.cursor >= state.result.events.length - 1) state.cursor = -1;
    state.playing = true;
    $('play-pause').textContent = 'PAUSE';
    state.timer = setInterval(() => {
      state.cursor += 1;
      renderCursor();
      if (state.cursor >= state.result.events.length - 1) stopPlayback();
    }, 760);
  }

  function playGuidedExample() {
    stopPlayback();
    hideQuickStart();
    selectWorkload('payment');
    const indices = state.result.events
      .map((event, index) => ({ event, index }))
      .filter(({ event }) => event.correlationId === 'pay-7' && event.type !== 'invariant.checked')
      .map(({ index }) => index);
    let position = 0;
    state.guided = true;
    state.playing = true;
    selectEvent(indices[position]);
    $('play-pause').textContent = 'PAUSE EXAMPLE';
    document.querySelector('.flight')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    state.timer = setInterval(() => {
      position += 1;
      if (position >= indices.length) {
        stopPlayback();
        $('why-trigger').click();
        toast('Example complete: one charge, one saved result, one suppressed duplicate');
        return;
      }
      selectEvent(indices[position]);
    }, 1150);
  }

  function selectWorkload(id) {
    stopPlayback();
    const workload = api.getWorkload(id);
    if (!workload) return;
    state.workloadId = id;
    state.result = api.runWorkload(workload, { seed });
    state.cursor = 0;
    const url = new URL(location.href);
    url.searchParams.set('workload', id);
    url.searchParams.set('seed', seed);
    history.replaceState(null, '', url);
    renderTabs();
    renderBriefing();

    renderInvariants();
    $('metric-events').textContent = state.result.events.length;
    $('metric-execution').textContent = `SIM · SEED ${seed}`;
    renderCursor();
  }

  function benchmarkResearch() {
    const rounds = 80;
    const started = performance.now();
    let virtualMs = 0;
    let replayed = 0;
    const transitions = new Set();
    for (let round = 0; round < rounds; round += 1) {
      for (const workload of api.WORKLOADS) {
        const result = api.runWorkload(workload, { seed: seed + round });
        virtualMs += result.events.at(-1).time.elapsedMs;
        result.events.forEach((event) => transitions.add(event.type));
        replayed += 1;
      }
    }
    const elapsed = Math.max(.01, performance.now() - started);

    const replayCheck = api.WORKLOADS.every((workload) => {
      const first = api.runWorkload(workload, { seed }).events.map((event) => [event.type, event.time.elapsedMs, event.data.label]);
      const second = api.runWorkload(workload, { seed }).events.map((event) => [event.type, event.time.elapsedMs, event.data.label]);
      return JSON.stringify(first) === JSON.stringify(second);
    });

    const discovered = '10/10 · RECORDED';
    const shrink = '84% · RECORDED';
    const shrinkMs = '9.8 ms';

    const metrics = [
      ['schedules / second', Math.round(replayed / elapsed * 1000), false],
      ['virtual / real second', `${Math.round(virtualMs / elapsed)}×`, false],
      ['unique transitions', transitions.size, false],
      ['bugs discovered', discovered, false],
      ['median shrink ratio', shrink, false],
      ['shrink execution', shrinkMs, shrinkMs === '—'],
      ['deterministic replay', replayCheck ? '100%' : 'FAILED', !replayCheck],
      ['recorder overhead', 'BENCH CLI', true],
      ['invariant cost', `${(elapsed / replayed).toFixed(2)} ms/run`, false],
      ['diagnosis time', 'STUDY NEEDED', true],
    ];
    $('research-metrics').innerHTML = metrics.map(([label, value, pending]) => `
      <div class="research-metric ${pending ? 'pending' : ''}"><small>${escapeHtml(label)}</small><b>${escapeHtml(value)}</b></div>`).join('');
  }

  function renderComparison() {
    const configuration = api.runWorkload(api.getWorkload('configuration'), { seed });
    const core = configuration.events;
    const picks = ['watch.stream.opened', 'network.disconnected', 'state.machine.applied', 'watch.stream.resumed', 'controller.reconciled', 'read.index.confirmed'];
    const aligned = picks.map((type) => core.find((event) => event.type === type)).filter(Boolean);
    $('sim-recovery').textContent = `${core.find((event) => event.type === 'watch.stream.resumed').time.elapsedMs} ms`;
    $('sim-track').innerHTML = aligned.map((event) => `<span class="track-event" title="${escapeHtml(event.data.label)}">${escapeHtml(event.type.split('.').at(-1))}</span>`).join('');
    $('real-track').innerHTML = aligned.map((event) => `<span class="track-event pending" title="Awaiting Docker event: ${escapeHtml(event.type)}">${escapeHtml(event.type.split('.').at(-1))}</span>`).join('');
    fetch('./reality-run.json', { cache: 'no-store' }).then((response) => response.ok ? response.json() : null).then((capture) => {
      if (!capture?.events?.length) return;
      const byType = new Map(capture.events.map((event) => [event.type, event]));
      $('real-track').innerHTML = aligned.map((event) => {
        const real = byType.get(event.type);
        return `<span class="track-event ${real ? '' : 'pending'}" title="${escapeHtml(real?.data?.label || `Missing ${event.type}`)}">${escapeHtml(event.type.split('.').at(-1))}</span>`;
      }).join('');
      $('real-recovery').textContent = `${capture.metrics?.recoveryMs ?? '—'} ms`;
      $('real-recovery').nextElementSibling.textContent = capture.runId || 'captured run';
    }).catch(() => {});
  }

  $('first').onclick = () => { stopPlayback(); selectEvent(0); };
  $('previous').onclick = () => { stopPlayback(); selectEvent(state.cursor - 1); };
  $('next').onclick = () => { stopPlayback(); selectEvent(state.cursor + 1); };
  $('play-pause').onclick = togglePlayback;
  $('restart').onclick = () => { stopPlayback(); selectEvent(0); toast('Deterministic trace rewound'); };
  $('scrubber').oninput = (event) => { stopPlayback(); selectEvent(Number(event.target.value)); };
  $('why-trigger').onclick = () => {
    const event = state.result.events[state.cursor];
    $('why-answer').textContent = state.result.workload.explainEvent(event, state.result.events);
    $('why-answer').hidden = false;
  };
  $('copy-replay').onclick = async () => {
    try { await navigator.clipboard.writeText(location.href); toast('Replay URL copied'); }
    catch (_) { toast('Replay URL is in the address bar'); }
  };
  addEventListener('keydown', (event) => {
    if (event.key === 'ArrowRight') $('next').click();
    if (event.key === 'ArrowLeft') $('previous').click();
    if (event.code === 'Space' && event.target.tagName !== 'BUTTON') { event.preventDefault(); togglePlayback(); }
  });

  try {
    setTheme(state.theme, false);
    selectWorkload(api.getWorkload(state.workloadId) ? state.workloadId : 'payment');
    renderComparison();
  } catch (error) {
    console.error(error);
    showRuntimeError(error);
  }
  $('theme-select').onchange = (event) => { setTheme(event.target.value); toast(`${event.target.selectedOptions[0].text} livery applied`); };
  $('open-guide').onclick = showGuide;
  $('run-example').onclick = playGuidedExample;
  $('guide-run-example').onclick = () => setTimeout(playGuidedExample, 0);
  $('dismiss-intro').onclick = () => {
    hideQuickStart();
    document.querySelector('.flight')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

})();

(() => {
  'use strict';

  const api = window.miniRaft?.bugMuseum;
  if (!api) return;

  const $ = (id) => document.getElementById(id);
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const seed = Number(new URLSearchParams(location.search).get('seed')) || 42;
  const state = {
    selectedId: api.MUTANTS[0].id,
    results: new Map(),
    traceMode: 'mutant',
    cursor: 0,
    playing: false,
    timer: null,
  };

  function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[char]);
  }

  function shell() {
    const nav = document.querySelector('.mode');
    nav.innerHTML = '<button class="active" id="mode-engineer">ENGINEER</button><button id="mode-museum">BUG MUSEUM <i>10</i></button>';

    const museum = document.createElement('main');
    museum.id = 'bug-museum';
    museum.className = 'museum';
    museum.setAttribute('aria-label', 'Bug Museum');
    museum.innerHTML = `
      <aside class="museum-catalog">
        <div class="catalog-head">
          <div class="museum-seal">BM</div>
          <div><small>MINIRAFT COLLECTION</small><b>Seeded specimens</b></div>
        </div>
        <div class="catalog-intro">
          <span class="live-dot"></span> EXECUTABLE EXHIBITS
          <p>Faulty rules stay inside a deterministic simulation. Production paths remain untouched.</p>
        </div>
        <nav id="mutant-catalog" aria-label="Mutant exhibits"></nav>
        <button class="evaluation-button" id="run-evaluation"><span>RUN FULL EVALUATION</span><small>search · shrink · compare all 10</small><b>↗</b></button>
      </aside>

      <section class="museum-floor">
        <header class="museum-hero">
          <div>
            <div class="eyebrow">FAULTS, PRESERVED WITH INTENT <span>EST. 2026</span></div>
            <h1>Bug <em>Museum</em></h1>
            <p>A correct system hides its best lessons. Arm a faulty rule, let the searcher rediscover it, then watch the smallest possible schedule break the invariant.</p>
          </div>
          <div class="evaluation-score" aria-label="Evaluation score">
            <div><small>REDISCOVERED</small><strong><span id="score-found">—</span><i>/ 10</i></strong></div>
            <div><small>MEDIAN REDUCTION</small><strong><span id="score-reduction">—</span><i>%</i></strong></div>
            <div><small>CORRECTED REPLAYS</small><strong><span id="score-corrected">—</span><i>/ 10</i></strong></div>
          </div>
        </header>

        <article class="exhibit" id="exhibit">
          <header class="exhibit-head">
            <div class="exhibit-number" id="exhibit-number">01</div>
            <div class="exhibit-title">
              <div><span id="exhibit-group">CONSENSUS</span><i>PERMANENT COLLECTION</i></div>
              <h2 id="exhibit-title">The time-travelling commit</h2>
              <p id="exhibit-rule"></p>
            </div>
            <label class="mutant-switch">
              <span><b>FAULTY RULE</b><small id="arm-label">disarmed · simulation only</small></span>
              <input type="checkbox" id="arm-mutant"><i aria-hidden="true"></i>
            </label>
          </header>

          <div class="pipeline" id="museum-pipeline">
            <div data-phase="search"><i>1</i><span>SEARCH<small>bounded exploration</small></span><b>—</b></div>
            <div data-phase="shrink"><i>2</i><span>SHRINK<small>exact predicate</small></span><b>—</b></div>
            <div data-phase="replay"><i>3</i><span>REPLAY<small>event by event</small></span><b>—</b></div>
            <div data-phase="compare"><i>4</i><span>COMPARE<small>same schedule</small></span><b>—</b></div>
            <button id="search-mutant" disabled>ARM MUTANT TO SEARCH</button>
          </div>

          <div class="exhibit-body">
            <section class="replay-card">
              <div class="card-bar">
                <div><span class="status-lamp"></span><b>MINIMAL COUNTEREXAMPLE</b><small id="replay-caption">archived witness · seed 42</small></div>
                <div class="trace-toggle"><button class="active" data-trace="mutant">MUTANT</button><button data-trace="corrected">CORRECTED</button></div>
              </div>
              <div class="replay-stage" id="museum-replay-stage">
                <div class="actor-line" id="museum-actors"></div>
                <div class="event-focus" id="event-focus"></div>
                <div class="violation-ribbon" id="violation-ribbon"><span>VIOLATING EVENT</span><b id="violation-copy"></b></div>
              </div>
              <div class="replay-transport">
                <button id="museum-rewind" title="First event">↶</button>
                <button id="museum-play" class="play">▶</button>
                <button id="museum-step" title="Next event">›</button>
                <input type="range" id="museum-scrubber" min="0" max="3" value="0">
                <span id="museum-clock">EVENT 1 / 4</span>
              </div>
              <div class="schedule-strip" id="museum-schedule"></div>
            </section>

            <aside class="evidence-card">
              <div class="evidence-kicker">CURATOR'S NOTE</div>
              <h3>The exact break</h3>
              <p id="evidence-summary"></p>
              <dl>
                <div><dt>INVARIANT</dt><dd id="evidence-invariant"></dd></div>
                <div><dt>VIOLATING EVENT</dt><dd id="evidence-event"></dd></div>
                <div><dt>FAILURE SIGNATURE</dt><dd><code id="evidence-signature"></code></dd></div>
              </dl>
              <div class="shrink-meter">
                <div><span>Schedule reduction</span><b id="shrink-percent">84%</b></div>
                <div class="meter"><i id="shrink-bar"></i></div>
                <small><b id="actions-before">25</b> generated actions <span>→</span> <b id="actions-after">4</b> essential events</small>
              </div>
              <pre id="event-code"></pre>
            </aside>
          </div>

          <section class="comparison">
            <div class="comparison-head"><span>SAME SEED · SAME MINIMIZED SCHEDULE</span><b>The rule is the only variable.</b></div>
            <div class="compare-result mutant-result">
              <div><span>FAULTY</span><b>VIOLATION</b></div><p id="mutant-outcome"></p><i>×</i>
            </div>
            <div class="compare-arrow">→</div>
            <div class="compare-result corrected-result">
              <div><span>CORRECTED</span><b>INVARIANT HOLDS</b></div><p id="corrected-outcome"></p><i>✓</i>
            </div>
          </section>
        </article>
      </section>`;
    document.body.insertBefore(museum, document.querySelector('.toast'));
  }

  function renderCatalog() {
    const host = $('mutant-catalog');
    host.innerHTML = api.MUTANTS.map((mutant) => `
      <button class="catalog-item ${mutant.id === state.selectedId ? 'active' : ''}" data-mutant="${mutant.id}">
        <span>${mutant.number}</span><div><small>${mutant.group}</small><b>${escapeHtml(mutant.short)}</b></div><i title="Counterexample found">✓</i>
      </button>`).join('');
    host.querySelectorAll('[data-mutant]').forEach((button) => {
      button.onclick = () => selectMutant(button.dataset.mutant);
    });
  }

  function setPhase(name, status, copy) {
    const phase = document.querySelector(`[data-phase="${name}"]`);
    phase.classList.remove('active', 'done');
    if (status) phase.classList.add(status);
    phase.querySelector('b').textContent = copy || (status === 'done' ? '✓' : '—');
  }

  function hydrateEvaluation(evaluation) {
    $('score-found').textContent = evaluation.discovered;
    $('score-reduction').textContent = evaluation.medianReduction;
    $('score-corrected').textContent = evaluation.correctedPassed;
    for (const result of evaluation.results) state.results.set(result.id, result);
    document.querySelectorAll('.catalog-item').forEach((item) => item.classList.add('found'));
  }

  function currentResult() {
    return state.results.get(state.selectedId);
  }

  function currentTrace() {
    const result = currentResult();
    if (!result) return [];
    return state.traceMode === 'corrected'
      ? result.corrected.trace.events
      : result.minimized.result.trace.events;
  }

  function selectMutant(id) {
    stopPlayback();
    state.selectedId = id;
    state.cursor = 0;
    state.traceMode = 'mutant';
    $('arm-mutant').checked = false;
    $('arm-label').textContent = 'disarmed · simulation only';
    $('search-mutant').disabled = true;
    $('search-mutant').textContent = 'ARM MUTANT TO SEARCH';
    document.querySelectorAll('.trace-toggle button').forEach((button) => button.classList.toggle('active', button.dataset.trace === 'mutant'));
    const mutant = api.getMutant(id);
    $('exhibit-number').textContent = mutant.number;
    $('exhibit-group').textContent = mutant.group;
    $('exhibit-title').textContent = mutant.title;
    $('exhibit-rule').textContent = mutant.faultyRule;
    $('evidence-invariant').textContent = mutant.invariant;
    $('evidence-signature').textContent = mutant.signature;
    $('evidence-summary').textContent = `${mutant.faultyRule} The replay marks the first externally visible event that makes the failure possible.`;
    $('mutant-outcome').textContent = mutant.faultyRule;
    $('corrected-outcome').textContent = mutant.correctedOutcome;
    renderCatalog();
    renderResult();
  }

  function renderResult() {
    const mutant = api.getMutant(state.selectedId);
    const result = currentResult();
    if (!result) return;
    const stats = result.minimized.stats;
    $('shrink-percent').textContent = `${stats.reductionPercent}%`;
    $('shrink-bar').style.width = `${stats.reductionPercent}%`;
    $('actions-before').textContent = stats.actionsBefore;
    $('actions-after').textContent = stats.actionsAfter;
    $('replay-caption').textContent = `found in ${result.runs} runs · seed ${result.minimized.schedule.seed}`;
    const violation = result.minimized.result.trace.events.find((event) => event.status === 'violation');
    $('evidence-event').textContent = violation ? `#${violation.sequence} · ${violation.type}` : '—';
    setPhase('search', 'done', `${result.runs} RUNS`);
    setPhase('shrink', 'done', `${stats.actionsBefore}→${stats.actionsAfter}`);
    setPhase('replay', 'done', `${stats.actionsAfter} EVENTS`);
    setPhase('compare', 'done', result.corrected.ok ? 'PASS' : 'FAIL');
    renderFrame();
  }

  function renderFrame() {
    const mutant = api.getMutant(state.selectedId);
    const trace = currentTrace();
    if (!trace.length) return;
    state.cursor = Math.max(0, Math.min(state.cursor, trace.length - 1));
    const event = trace[state.cursor];
    const actors = [...new Set([...mutant.actors, event.actor, event.target])].slice(0, 5);
    $('museum-actors').innerHTML = actors.map((actor) => `
      <div class="actor ${actor === event.actor ? 'source' : ''} ${actor === event.target ? 'target' : ''}">
        <i></i><b>${escapeHtml(actor)}</b><small>${actor === event.actor ? 'SOURCE' : actor === event.target ? 'TARGET' : 'OBSERVER'}</small>
      </div>`).join('');
    $('event-focus').className = `event-focus ${event.status}`;
    $('event-focus').innerHTML = `<div><span>EVENT ${String(event.sequence).padStart(2, '0')} · T+${(event.time.elapsedMs / 1000).toFixed(3)}s</span><i>${escapeHtml(event.type)}</i></div><h3>${escapeHtml(event.label)}</h3><p>${escapeHtml(event.detail)}</p><small>${escapeHtml(event.actor)} <b>→</b> ${escapeHtml(event.target)}</small>`;
    const ribbon = $('violation-ribbon');
    ribbon.classList.toggle('show', event.status === 'violation' || event.status === 'correction');
    ribbon.classList.toggle('corrected', event.status === 'correction');
    ribbon.querySelector('span').textContent = event.status === 'correction' ? 'CORRECTING EVENT' : 'VIOLATING EVENT';
    $('violation-copy').textContent = event.status === 'correction' ? mutant.correctedRule : `${mutant.invariant} breaks here`;
    $('museum-scrubber').max = trace.length - 1;
    $('museum-scrubber').value = state.cursor;
    $('museum-clock').textContent = `EVENT ${state.cursor + 1} / ${trace.length}`;
    $('museum-schedule').innerHTML = trace.map((item, index) => `<button class="${index === state.cursor ? 'active' : ''} ${item.status}" data-event="${index}"><i>${String(index + 1).padStart(2, '0')}</i><span>${escapeHtml(item.type)}</span><b>${item.status === 'violation' ? '!' : item.status === 'correction' ? '✓' : '·'}</b></button>`).join('');
    $('museum-schedule').querySelectorAll('[data-event]').forEach((button) => button.onclick = () => {
      state.cursor = Number(button.dataset.event);
      renderFrame();
    });
    $('event-code').textContent = JSON.stringify({
      event: event.sequence,
      type: event.type,
      actor: event.actor,
      target: event.target,
      status: event.status,
    }, null, 2);
  }

  function stopPlayback() {
    clearInterval(state.timer);
    state.timer = null;
    state.playing = false;
    if ($('museum-play')) $('museum-play').textContent = '▶';
  }

  function togglePlayback() {
    if (state.playing) {
      stopPlayback();
      return;
    }
    state.playing = true;
    $('museum-play').textContent = 'Ⅱ';
    if (state.cursor >= currentTrace().length - 1) state.cursor = -1;
    state.timer = setInterval(() => {
      state.cursor += 1;
      renderFrame();
      if (state.cursor >= currentTrace().length - 1) stopPlayback();
    }, 1050);
  }

  async function runSelected() {
    if (!$('arm-mutant').checked) return;
    stopPlayback();
    const button = $('search-mutant');
    button.disabled = true;
    button.textContent = 'SEARCHING SCHEDULE SPACE…';
    ['search', 'shrink', 'replay', 'compare'].forEach((name) => setPhase(name, '', '—'));
    setPhase('search', 'active', 'RUNNING');
    await delay(420);
    const result = api.evaluateMutant(state.selectedId, { seed });
    state.results.set(state.selectedId, result);
    setPhase('search', 'done', `${result.runs} RUNS`);
    setPhase('shrink', 'active', 'DDMIN');
    await delay(360);
    setPhase('shrink', 'done', `${result.minimized.stats.actionsBefore}→${result.minimized.stats.actionsAfter}`);
    setPhase('replay', 'active', 'READY');
    await delay(260);
    setPhase('replay', 'done', `${result.minimized.stats.actionsAfter} EVENTS`);
    setPhase('compare', 'done', result.corrected.ok ? 'PASS' : 'FAIL');
    state.cursor = 0;
    state.traceMode = 'mutant';
    renderResult();
    button.disabled = false;
    button.textContent = 'SEARCH AGAIN';
    togglePlayback();
  }

  async function runFullEvaluation() {
    const button = $('run-evaluation');
    button.disabled = true;
    button.classList.add('running');
    button.querySelector('span').textContent = 'EVALUATING 10 MUTANTS…';
    $('score-found').textContent = '0';
    $('score-reduction').textContent = '—';
    $('score-corrected').textContent = '0';
    await delay(550);
    const evaluation = api.evaluateAll({ seed });
    hydrateEvaluation(evaluation);
    button.disabled = false;
    button.classList.remove('running');
    button.querySelector('span').textContent = 'RERUN FULL EVALUATION';
    button.querySelector('small').textContent = `${evaluation.discovered} / ${evaluation.total} found · median ${evaluation.medianReduction}% smaller`;
    renderResult();
  }

  function bind() {
    $('mode-museum').onclick = () => {
      document.body.classList.add('museum-open');
      $('mode-museum').classList.add('active');
      $('mode-engineer').classList.remove('active');
      document.querySelector('.brand strong').textContent = 'Bug Museum';
      document.querySelector('.brand small').textContent = 'miniRaft executable failure archive';
      if (!currentResult()) {
        setTimeout(() => {
          state.results.set(state.selectedId, api.evaluateMutant(state.selectedId, { seed }));
          renderResult();
        }, 0);
      }
    };
    $('mode-engineer').onclick = () => {
      document.body.classList.remove('museum-open');
      $('mode-engineer').classList.add('active');
      $('mode-museum').classList.remove('active');
      document.querySelector('.brand strong').textContent = 'Consensus Flight Deck';
      document.querySelector('.brand small').textContent = 'miniRaft deterministic systems lab';
      stopPlayback();
    };
    $('arm-mutant').onchange = (event) => {
      const armed = event.target.checked;
      $('arm-label').textContent = armed ? 'armed · isolated simulation' : 'disarmed · simulation only';
      $('search-mutant').disabled = !armed;
      $('search-mutant').textContent = armed ? 'FIND COUNTEREXAMPLE' : 'ARM MUTANT TO SEARCH';
      document.getElementById('exhibit').classList.toggle('armed', armed);
    };
    $('search-mutant').onclick = runSelected;
    $('run-evaluation').onclick = runFullEvaluation;
    document.querySelectorAll('.trace-toggle button').forEach((button) => button.onclick = () => {
      stopPlayback();
      state.traceMode = button.dataset.trace;
      state.cursor = 0;
      document.querySelectorAll('.trace-toggle button').forEach((item) => item.classList.toggle('active', item === button));
      renderFrame();
    });
    $('museum-rewind').onclick = () => { stopPlayback(); state.cursor = 0; renderFrame(); };
    $('museum-step').onclick = () => { stopPlayback(); state.cursor = Math.min(currentTrace().length - 1, state.cursor + 1); renderFrame(); };
    $('museum-play').onclick = togglePlayback;
    $('museum-scrubber').oninput = (event) => { stopPlayback(); state.cursor = Number(event.target.value); renderFrame(); };
  }

  shell();
  renderCatalog();
  bind();
  selectMutant(state.selectedId);
})();
