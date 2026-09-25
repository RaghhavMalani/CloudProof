/* CloudProof Operations Console — service graph renderer.
 *
 * Draws the canonical graph data returned by cloudProof.ops.graphModel() as
 * SVG. It never reads simulator state and never decides anything: health,
 * load, placement and causes all arrive in the model. Three views share one
 * model: LOGICAL (dependencies), PLACEMENT (zones → nodes → pods) and FAILURE
 * PATH (logical, with everything off the causal path dimmed).
 */
(() => {
  'use strict';

  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);

  const KIND_TAG = { api: 'API', cache: 'CACHE', queue: 'QUEUE', worker: 'WORKER', database: 'DB' };
  const ZONE_BAR = 50;

  function setOf(list) {
    return new Set(Array.isArray(list) ? list : []);
  }

  function serviceState(service) {
    if (!service.up) return 'failed';
    const podsDown = service.pods.some((pod) => !pod.serving);
    if (service.overloaded || service.cacheCold || service.stalled || service.queueFull || podsDown || service.healthy < service.desired) return 'degraded';
    return 'healthy';
  }

  function statusText(service) {
    if (!service.up) {
      if (!service.intrinsicUp) return service.volume && !service.volume.available ? 'DOWN · storage' : 'DOWN · pods';
      if (service.overloaded) return 'DOWN · overload';
      if (service.cause?.kind === 'dependency') return `DOWN · via ${service.cause.via}`;
      if (service.cause?.kind === 'backpressure') return 'DOWN · queue full';
      return 'DOWN';
    }
    if (service.cacheCold) return 'COLD';
    if (service.stalled) return 'STALLED';
    if (service.promoted) return 'FAILED OVER';
    if (service.healthy < service.desired) return 'DEGRADED';
    return 'UP';
  }

  function podClass(pod) {
    if (pod.serving) return 'pod-serving';
    if (pod.phase === 'STARTING') return 'pod-starting';
    if (pod.phase === 'PENDING') return 'pod-pending';
    return 'pod-down';
  }

  function zoneBadges(service) {
    return Object.entries(service.zones).filter(([, count]) => count.total > 0)
      .map(([zone, count]) => `${zone.replace(/^zone-/, '')}${count.serving}${count.serving < count.total ? `/${count.total}` : ''}`).join(' ');
  }

  function edgeGeometry(model, edge, width, height) {
    const byId = new Map(model.services.map((service) => [service.id, service]));
    const from = byId.get(edge.flowFrom).position;
    const to = byId.get(edge.flowTo).position;
    if (Math.abs(from.y - to.y) < 1) {
      // Same row (a primary replicating to its replica): a side arc under the pair.
      const leftToRight = from.x < to.x;
      const x1 = leftToRight ? from.x + width : from.x;
      const x2 = leftToRight ? to.x : to.x + width;
      const y = from.y + height * 0.62;
      return { d: `M${x1},${y} C${(x1 + x2) / 2},${y + 26} ${(x1 + x2) / 2},${y + 26} ${x2},${y}`, mx: (x1 + x2) / 2, my: y + 20 };
    }
    const down = to.y > from.y;
    const x1 = from.x + width / 2;
    const y1 = down ? from.y + height : from.y;
    const x2 = to.x + width / 2;
    const y2 = down ? to.y : to.y + height;
    const bend = (y2 - y1) * 0.5;
    return { d: `M${x1},${y1} C${x1},${y1 + bend} ${x2},${y2 - bend} ${x2},${y2}`, mx: (x1 + x2) / 2, my: (y1 + y2) / 2 };
  }

  function renderLogical(model, options) {
    const { width: nodeW, height: nodeH } = model.layout.node;
    const W = model.layout.width;
    const H = model.layout.height + ZONE_BAR;
    const hl = options.highlight || {};
    const pulse = options.pulse || {};
    const failureView = options.view === 'failure';
    const pathServices = setOf(hl.services);
    const pathEdges = setOf(hl.edges);
    const pathRoutes = setOf(hl.routes);
    const pathZones = setOf(hl.zones);
    const pathNodes = setOf(hl.nodes);
    const pulseServices = setOf(pulse.services);
    const pulseEdges = setOf(pulse.edges);
    const pulseRoutes = setOf(pulse.routes);
    const pulseZones = setOf(pulse.zones);
    const pulseNodes = setOf(pulse.nodes);
    const diffEdges = setOf(options.diffEdges);
    const faultTargets = setOf(options.faultTargets);
    const changing = setOf(options.changing);
    const selected = options.selected || null;
    const dim = (inPath) => (failureView && !inPath ? ' dim' : '');
    const parts = [];
    parts.push(`<svg class="cg-svg" viewBox="0 0 ${W} ${H}" role="group" aria-label="${esc(options.ariaLabel || 'Service dependency graph')}" preserveAspectRatio="xMidYMin meet">`);
    parts.push(`<defs>
      <marker id="${options.idPrefix}-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="cg-arrow"/></marker>
      <marker id="${options.idPrefix}-arrow-hot" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="cg-arrow hot"/></marker>
    </defs>`);

    // Routes and their entry links.
    for (const route of model.routes) {
      const entry = model.services.find((service) => service.id === route.entry);
      const x = route.position.x;
      const y = route.position.y;
      const entryX = entry.position.x + nodeW / 2;
      const entryY = entry.position.y;
      const inPath = pathRoutes.has(route.id);
      const diff = diffEdges.has(`ENTERS:${route.id}->${route.entry}`);
      const cls = `cg-route${route.failing ? ' failing' : ''}${inPath ? ' on-path' : ''}${pulseRoutes.has(route.id) ? ' pulse' : ''}${diff ? ' diff' : ''}${selected === `route:${route.id}` ? ' selected' : ''}${dim(inPath)}`;
      parts.push(`<path class="cg-entry${route.failing ? ' failing' : ''}${diff ? ' diff' : ''}${dim(inPath)}" d="M${x},${y + 26} C${x},${y + 44} ${entryX},${entryY - 22} ${entryX},${entryY}" marker-end="url(#${options.idPrefix}-arrow${route.failing ? '-hot' : ''})"/>`);
      parts.push(`<g class="${cls}" data-kind="route" data-id="${esc(route.id)}" tabindex="0" role="button" aria-label="Route ${esc(route.id)}, ${route.sharePct} percent of traffic, ${route.failing ? 'failing' : 'serving'}">
        <title>${esc(route.id)} · ${route.sharePct}% of traffic · ${route.rps} rps${route.failing ? ' · FAILING' : ''}</title>
        <rect x="${x - 56}" y="${y}" width="112" height="26" rx="13"/>
        <text x="${x}" y="${y + 17}" text-anchor="middle">${esc(route.id)} · ${route.sharePct}%</text>
      </g>`);
    }

    // Dependency edges.
    for (const edge of model.edges) {
      const geometry = edgeGeometry(model, edge, nodeW, nodeH);
      const inPath = pathEdges.has(edge.id);
      const hot = inPath || pulseEdges.has(edge.id);
      const to = model.services.find((service) => service.id === edge.flowTo);
      const broken = !to.up && edge.hard;
      const cls = `cg-edge ${edge.hard ? 'hard' : 'soft'}${broken ? ' broken' : ''}${inPath ? ' on-path' : ''}${pulseEdges.has(edge.id) ? ' pulse' : ''}${diffEdges.has(edge.id) ? ' diff' : ''}${selected === `edge:${edge.id}` ? ' selected' : ''}${dim(inPath)}`;
      parts.push(`<g class="${cls}" data-kind="edge" data-id="${esc(edge.id)}" tabindex="0" role="button" aria-label="${esc(edge.from)} ${esc(edge.verb)} ${esc(edge.to)}">
        <title>${esc(edge.from)} ${esc(edge.verb)} ${esc(edge.to)} (${edge.type}${edge.hard ? ', hard dependency' : ', soft'})</title>
        <path class="cg-hit" d="${geometry.d}"/>
        <path class="cg-line" d="${geometry.d}" marker-end="url(#${options.idPrefix}-arrow${hot || broken ? '-hot' : ''})"/>
        <text class="cg-edge-label" x="${geometry.mx}" y="${geometry.my}" text-anchor="middle">${esc(edge.type.replace('_', ' ').toLowerCase())}</text>
      </g>`);
    }

    // Services.
    for (const service of model.services) {
      const { x, y } = service.position;
      const state = serviceState(service);
      const inPath = pathServices.has(service.id);
      const cls = `cg-service state-${state} kind-${service.kind}${inPath ? ' on-path' : ''}${pulseServices.has(service.id) ? ' pulse' : ''}${faultTargets.has(service.id) ? ' fault-target' : ''}${changing.has(service.id) ? ' changing' : ''}${selected === `service:${service.id}` ? ' selected' : ''}${dim(inPath)}`;
      const pods = service.pods.slice(0, 9);
      const dots = pods.map((pod, index) => `<circle class="cg-pod ${podClass(pod)}" cx="${x + 14 + index * 11}" cy="${y + 40}" r="4"><title>${esc(pod.id)} · ${esc(pod.phase)}${pod.node ? ` on ${esc(pod.node)}` : ''}${pod.serving ? ' · serving' : ''}</title></circle>`).join('');
      const extra = service.pods.length > pods.length ? `<text class="cg-small" x="${x + 16 + pods.length * 11}" y="${y + 43}">+${service.pods.length - pods.length}</text>` : '';
      let meter;
      let meterText;
      if (service.kind === 'queue') {
        const fraction = Math.min(1, (service.backlog || 0) / service.queueCapacity);
        meter = fraction;
        meterText = `${service.backlog}/${service.queueCapacity} msgs`;
      } else {
        meter = service.capacityRps ? Math.min(1, service.loadRps / service.capacityRps) : 1;
        meterText = `${Math.round(service.loadRps)}/${service.capacityRps} rps`;
      }
      const meterClass = meter >= 1 ? 'over' : meter > 0.8 ? 'hot' : '';
      const role = service.role ? (service.promoted ? 'promoted' : service.role) : null;
      parts.push(`<g class="${cls}" data-kind="service" data-id="${esc(service.id)}" tabindex="0" role="button" aria-label="${esc(service.label)}, ${esc(service.kind)}, ${service.healthy} of ${service.desired} pods healthy, minimum ${service.minHealthy}, ${esc(statusText(service))}">
        <title>${esc(service.label)} (${esc(service.id)})\n${service.healthy}/${service.desired} healthy · min ${service.minHealthy}\n${esc(meterText)}\n${esc(statusText(service))}</title>
        <rect class="cg-box" x="${x}" y="${y}" width="${nodeW}" height="${nodeH}" rx="7"/>
        <text class="cg-kind" x="${x + 10}" y="${y + 16}">${KIND_TAG[service.kind]}${role ? ` · ${esc(role.toUpperCase())}` : ''}</text>
        ${service.version ? `<text class="cg-version" x="${x + nodeW - 10}" y="${y + 16}" text-anchor="end">${esc(service.version)}</text>` : ''}
        <text class="cg-label" x="${x + 10}" y="${y + 31}">${esc(service.label.length > 22 ? `${service.label.slice(0, 21)}…` : service.label)}</text>
        ${dots}${extra}
        <text class="cg-count" x="${x + nodeW - 10}" y="${y + 44}" text-anchor="end">${service.healthy}/${service.desired} · min ${service.minHealthy}</text>
        <rect class="cg-meter-bg" x="${x + 10}" y="${y + 52}" width="${nodeW - 20}" height="4" rx="2"/>
        <rect class="cg-meter ${meterClass}" x="${x + 10}" y="${y + 52}" width="${Math.max(2, (nodeW - 20) * meter)}" height="4" rx="2"/>
        <text class="cg-small" x="${x + 10}" y="${y + 68}">${esc(meterText)}</text>
        <text class="cg-status" x="${x + nodeW - 10}" y="${y + 68}" text-anchor="end">${esc(statusText(service))}</text>
        <text class="cg-zones" x="${x + 10}" y="${y + 82}"><title>serving pods per zone</title>${esc(zoneBadges(service) ? `zones ${zoneBadges(service)}` : 'no pods placed')}</text>
      </g>`);
    }

    // Zone and node strip: faults on infrastructure are visible in this view too.
    const zoneY = model.layout.height + 6;
    const zoneW = (W - 24 - (model.zones.length - 1) * 8) / model.zones.length;
    model.zones.forEach((zone, index) => {
      const x = 12 + index * (zoneW + 8);
      const inPath = pathZones.has(zone.id) || zone.nodes.some((node) => pathNodes.has(node.id));
      parts.push(`<g class="cg-zone${zone.degraded ? ' degraded' : ''}${pulseZones.has(zone.id) ? ' pulse' : ''}${pathZones.has(zone.id) ? ' on-path' : ''}${selected === `zone:${zone.id}` ? ' selected' : ''}${dim(inPath)}" data-kind="zone" data-id="${esc(zone.id)}" tabindex="0" role="button" aria-label="${esc(zone.id)}${zone.degraded ? ', degraded' : ''}">
        <title>${esc(zone.id)}${zone.degraded ? ' · DEGRADED' : ''}</title>
        <rect x="${x}" y="${zoneY}" width="${zoneW}" height="${ZONE_BAR - 12}" rx="5"/>
        <text x="${x + 8}" y="${zoneY + 15}">${esc(zone.id)}${zone.degraded ? ' · DEGRADED' : ''}</text>
      </g>`);
      const nodeW2 = (zoneW - 12 - (zone.nodes.length - 1) * 4) / Math.max(1, zone.nodes.length);
      zone.nodes.forEach((node, nodeIndex) => {
        const nx = x + 6 + nodeIndex * (nodeW2 + 4);
        const flags = [node.crashed ? 'crashed' : '', node.cordoned ? 'cordoned' : ''].filter(Boolean).join(' · ');
        parts.push(`<g class="cg-node${!node.ready ? ' down' : ''}${node.cordoned ? ' cordoned' : ''}${pulseNodes.has(node.id) ? ' pulse' : ''}${pathNodes.has(node.id) ? ' on-path' : ''}${selected === `node:${node.id}` ? ' selected' : ''}" data-kind="node" data-id="${esc(node.id)}" tabindex="0" role="button" aria-label="${esc(node.id)}, ${node.pods.length} pods${flags ? `, ${esc(flags)}` : ''}">
          <title>${esc(node.id)} · ${node.pods.length}/${node.slots} pods${flags ? ` · ${esc(flags)}` : ''}</title>
          <rect x="${nx}" y="${zoneY + 20}" width="${nodeW2}" height="13" rx="3"/>
          <text x="${nx + nodeW2 / 2}" y="${zoneY + 30}" text-anchor="middle">${esc(node.id)}${flags ? ` ${node.crashed ? '✕' : '⊘'}` : ''}</text>
        </g>`);
      });
    });
    parts.push('</svg>');
    return parts.join('');
  }

  function renderPlacement(model, options) {
    const pulse = options.pulse || {};
    const hl = options.highlight || {};
    const pulseZones = setOf(pulse.zones);
    const pulseNodes = setOf(pulse.nodes);
    const pathPods = setOf(hl.pods);
    const pathNodes = setOf(hl.nodes);
    const pathZones = setOf(hl.zones);
    const pulseServices = setOf(pulse.services);
    const labels = new Map(model.services.map((service) => [service.id, service]));
    const colW = 214;
    const gap = 14;
    const chipW = 94;
    const chipH = 20;
    const W = Math.max(model.layout.width, 24 + model.zones.length * colW + (model.zones.length - 1) * gap);
    const nodeHeight = (node) => 30 + Math.max(1, Math.ceil(node.pods.length / 2)) * (chipH + 4);
    const zoneHeights = model.zones.map((zone) => 36 + zone.nodes.reduce((sum, node) => sum + nodeHeight(node) + 8, 0));
    const unplaced = model.unplaced || [];
    const H = 24 + Math.max(...zoneHeights) + (unplaced.length ? 54 : 12);
    const offset = (W - (model.zones.length * colW + (model.zones.length - 1) * gap)) / 2;
    const parts = [`<svg class="cg-svg placement" viewBox="0 0 ${W} ${H}" role="group" aria-label="${esc(options.ariaLabel || 'Placement by zone and node')}" preserveAspectRatio="xMidYMin meet">`];
    const chip = (pod, x, y) => {
      const service = labels.get(pod.service);
      const short = (service?.label || pod.service).replace(/ \((primary|replica)\)$/, '');
      return `<g class="cg-chip ${podClass(pod)} kind-${service?.kind || 'api'}${pathPods.has(pod.id) ? ' on-path' : ''}${pulseServices.has(pod.service) ? ' pulse' : ''}" data-kind="service" data-id="${esc(pod.service)}" tabindex="0" role="button" aria-label="${esc(pod.id)}, ${esc(pod.phase)}">
        <title>${esc(pod.id)} · ${esc(pod.phase)}${pod.serving ? ' · serving' : ''}</title>
        <rect x="${x}" y="${y}" width="${chipW}" height="${chipH}" rx="4"/>
        <text x="${x + 6}" y="${y + 14}">${esc(short.length > 13 ? `${short.slice(0, 12)}…` : short)}</text>
      </g>`;
    };
    model.zones.forEach((zone, index) => {
      const x = offset + index * (colW + gap);
      parts.push(`<g class="cg-zone-col${zone.degraded ? ' degraded' : ''}${pulseZones.has(zone.id) ? ' pulse' : ''}${pathZones.has(zone.id) ? ' on-path' : ''}" data-kind="zone" data-id="${esc(zone.id)}" tabindex="0" role="button" aria-label="${esc(zone.id)}${zone.degraded ? ', degraded' : ''}">
        <rect x="${x}" y="12" width="${colW}" height="${zoneHeights[index]}" rx="8"/>
        <text x="${x + 12}" y="32">${esc(zone.id)}${zone.degraded ? ' · DEGRADED' : ''}</text>
      </g>`);
      let y = 44;
      for (const node of zone.nodes) {
        const h = nodeHeight(node);
        const flags = [node.crashed ? 'CRASHED' : '', node.cordoned ? 'CORDONED' : '', !node.ready && !node.crashed ? 'NOT READY' : ''].filter(Boolean).join(' · ');
        parts.push(`<g class="cg-node-box${!node.ready ? ' down' : ''}${node.cordoned ? ' cordoned' : ''}${pulseNodes.has(node.id) ? ' pulse' : ''}${pathNodes.has(node.id) ? ' on-path' : ''}" data-kind="node" data-id="${esc(node.id)}" tabindex="0" role="button" aria-label="${esc(node.id)}${flags ? `, ${esc(flags)}` : ''}">
          <rect x="${x + 8}" y="${y}" width="${colW - 16}" height="${h}" rx="5"/>
          <text x="${x + 16}" y="${y + 17}">${esc(node.id)} <tspan class="cg-small">${node.pods.length}/${node.slots}</tspan>${flags ? ` <tspan class="cg-flag">${esc(flags)}</tspan>` : ''}</text>
        </g>`);
        node.pods.forEach((pod, podIndex) => {
          parts.push(chip(pod, x + 14 + (podIndex % 2) * (chipW + 4), y + 26 + Math.floor(podIndex / 2) * (chipH + 4)));
        });
        y += h + 8;
      }
    });
    if (unplaced.length) {
      const y = H - 44;
      parts.push(`<text class="cg-small" x="${offset}" y="${y - 6}">WAITING FOR A NODE</text>`);
      unplaced.forEach((pod, index) => parts.push(chip(pod, offset + index * (chipW + 4), y)));
    }
    parts.push('</svg>');
    return parts.join('');
  }

  /**
   * Render into `host`. `options.onSelect({kind, id})` is called on click or
   * Enter/Space. Returns nothing; call again with a new model to update.
   */
  function render(host, model, options = {}) {
    const prefix = options.idPrefix || host.id || 'cg';
    const view = options.view || 'logical';
    const opts = { ...options, idPrefix: prefix, view };
    host.innerHTML = view === 'placement' ? renderPlacement(model, opts) : renderLogical(model, opts);
    host.classList.toggle('cg-failure-view', view === 'failure');
    if (!host.dataset.cgWired) {
      host.dataset.cgWired = '1';
      const pick = (target) => {
        const node = target.closest?.('[data-kind]');
        if (!node || !host.contains(node)) return;
        host._cgOnSelect?.({ kind: node.dataset.kind, id: node.dataset.id });
      };
      host.addEventListener('click', (event) => pick(event.target));
      host.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        pick(event.target);
      });
    }
    host._cgOnSelect = options.onSelect || null;
  }

  window.CloudGraph = { render, serviceState, statusText };
})();
