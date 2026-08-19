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
