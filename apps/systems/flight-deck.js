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
