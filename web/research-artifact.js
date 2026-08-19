(() => {
  'use strict';

  const host = document.getElementById('research-metrics');
  if (!host) return;

  fetch('./research-metrics.json', { cache: 'no-store' })
    .then((response) => response.ok ? response.json() : null)
    .then((report) => {
      if (!report?.measures) return;
      const measure = report.measures;
      const diagnosis = measure.userDiagnosisTime.status === 'measured'
        ? `${Math.round(measure.userDiagnosisTime.medianWithFlightDeckMs / 1000)}s deck`
        : 'STUDY NEEDED';
      const values = [
        ['schedules / second', measure.schedulesExploredPerSecond.toFixed(1), false],
        ['virtual / real second', `${Math.round(measure.virtualTimePerRealSecond)}×`, false],
        ['transition coverage', `${measure.uniqueStateTransitionCoverage.target.covered}/${measure.uniqueStateTransitionCoverage.target.total}`, false],
        ['bugs discovered', `${measure.bugsDiscovered.discovered}/${measure.bugsDiscovered.totalSeeded}`, false],
        ['median shrink ratio', `${Math.round(measure.shrinkRatio * 100)}%`, false],
        ['shrink execution', `${measure.shrinkExecutionTimeMs.toFixed(1)} ms`, false],
        ['deterministic replay', `${Math.round(measure.deterministicReplaySuccessRate * 100)}%`, false],
        ['recorder overhead', `${measure.recorderOverhead.ratio.toFixed(2)}×`, false],
        ['invariant cost', `${measure.invariantCheckingCost.microsecondsPerCheck.toFixed(2)} μs`, false],
        ['diagnosis time', diagnosis, measure.userDiagnosisTime.status !== 'measured'],
      ];
      host.replaceChildren(...values.map(([label, value, pending]) => {
        const card = document.createElement('div');
        card.className = `research-metric ${pending ? 'pending' : ''}`;
        const small = document.createElement('small');
        const strong = document.createElement('b');
        small.textContent = label;
        strong.textContent = value;
        card.append(small, strong);
        return card;
      }));
      host.dataset.source = report.measuredAt;
    })
    .catch(() => { /* browser-only fallback metrics remain visible */ });
})();
