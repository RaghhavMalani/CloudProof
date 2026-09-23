(() => {
  'use strict';
  const { SimCluster } = cloudProof.cluster;
  const { ScenarioRunner, parseScenario, serializeScenario, branchScenario } = cloudProof.scenario;
  const NS = 'http://www.w3.org/2000/svg';
  const POS = [{x:450,y:92},{x:215,y:365},{x:685,y:365}];
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  let seed = Number(params.get('seed')) || 42;
  let cluster = null;
  let unsubscribe = null;
  let paused = false;
  let events = [];
  let selectedIndex = -1;
  let invariantState = new Map();
  let latestSnapshot = null;
  let lastScenario = null;
  let renderTimer = null;

  const PRESETS = {
    stale:`0.0s start cluster(3)\n0.8s write("model/current", v1)\n1.3s isolate(node0)\n2.5s write("model/current", v2)\n3.4s heal-all()`,
    quorum:`0.0s start cluster(3)\n0.8s write("system/status", healthy)\n1.4s crash(node1)\n1.5s crash(node2)\n2.8s restart(node1)\n3.5s heal-all()`,
    repair:`0.0s start cluster(3)\n0.8s write("doc/1", alpha)\n1.2s isolate(node2)\n1.5s write("doc/2", beta)\n2.0s write("doc/3", gamma)\n2.8s heal-all()`,
  };

  function nodeId(url){const m=String(url||'').match(/node(\d+)/);return m?Number(m[1]):-1}
  function toast(message){const el=$('toast');el.textContent=message;el.classList.add('show');setTimeout(()=>el.classList.remove('show'),1700)}
  function replayUrl(){const u=new URL(location.href);u.searchParams.set('seed',seed);return u.toString()}
  function setSeedUi(){
    $('seed-value').textContent=String(seed).padStart(8,'0');
    const u=new URL(location.href);u.searchParams.set('seed',seed);history.replaceState(null,'',u);
  }

  function resetTrace(){
    events=[];selectedIndex=-1;invariantState=new Map();latestSnapshot=null;
    $('event-strip').innerHTML='';$('timeline-marks').innerHTML='';$('scrubber').max=0;$('scrubber').value=0;
    $('inspect-content').hidden=true;$('inspect-empty').hidden=false;
  }

  function connectRecorder(recorder){
    if(unsubscribe)unsubscribe();
    unsubscribe=recorder.subscribe(onEvent,{replay:true});
  }

  function onEvent(event){
    events.push(event);
    const index=events.length-1;
    if(event.type==='cluster.snapshot')latestSnapshot=event;
    if(event.type==='invariant.checked'){
      invariantState.set(event.data.id,event.data);renderInvariants();
    }
    if(event.type==='rpc.sent'||event.type==='rpc.reply')flyPacket(event,index);
    if(!event.type.startsWith('cluster.')&&!event.type.startsWith('invariant.'))addTraceRow(event,index);
    $('metric-events').textContent=events.length.toLocaleString();
    $('scrubber').max=Math.max(0,index);$('scrubber').value=index;selectedIndex=index;
    if(index%6===0||event.type.startsWith('fault.'))renderTimeline();
  }

  function addTraceRow(event,index){
    const strip=$('event-strip');const row=document.createElement('div');
    row.className='trace-row '+(event.type.startsWith('rpc.')?'rpc':event.type.startsWith('fault.')?'fault':'');
    row.innerHTML=`<strong>${event.type}</strong><span>T+${(event.time.elapsedMs/1000).toFixed(3)} · ${event.source.nodeId||event.source.component}</span>`;
    row.onclick=()=>selectEvent(index);strip.appendChild(row);while(strip.children.length>7)strip.firstChild.remove();
  }

  function renderTimeline(){
    const host=$('timeline-marks');host.innerHTML='';
    const max=Math.max(1,events.length-1);const start=Math.max(0,events.length-400);
    for(let i=start;i<events.length;i+=1){
      const e=events[i];if(!e.type.startsWith('rpc.')&&!e.type.startsWith('fault.')&&!e.type.startsWith('node.role'))continue;
      const mark=document.createElement('i');mark.className='timeline-mark '+(e.type.startsWith('rpc.')?'rpc':e.type.startsWith('fault.')?'fault':'');
      mark.style.left=`${(i/max)*100}%`;mark.title=e.type;mark.onclick=()=>selectEvent(i);host.appendChild(mark);
    }
  }

  function selectEvent(index){
    const event=events[index];if(!event)return;selectedIndex=index;$('scrubber').value=index;
    $('inspect-empty').hidden=true;$('inspect-content').hidden=false;
    $('event-name').textContent=event.type.toUpperCase();
    $('event-route').textContent=`${event.id} · T+${(event.time.elapsedMs/1000).toFixed(3)}s`;
    const wire=event.data||{};const request=wire.request||{};
    const fields={from:wire.from||event.source.nodeId||'—',to:wire.to||'—',rpc:wire.kind||wire.route||'—',term:request.term??wire.response?.term??'—',prevLogIndex:request.prevLogIndex??'—',entries:Array.isArray(request.entries)?request.entries.length:'—',leaderCommit:request.leaderCommit??'—',result:(wire.reason||wire.response?.success)??'—'};
    $('event-fields').innerHTML=Object.entries(fields).map(([k,v])=>`<dt>${k}</dt><dd>${escapeHtml(String(v))}</dd>`).join('');
    $('event-raw').textContent=JSON.stringify(event,null,2);
    $('cursor-label').textContent=`EVENT ${event.sequence}`;$('clock-label').textContent=`T+${(event.time.elapsedMs/1000).toFixed(3)}s`;
    const snapshot=findSnapshot(index);if(snapshot)renderTopology(snapshot.data.nodes,snapshot.data);
  }

  function findSnapshot(index){for(let i=index;i>=0;i-=1)if(events[i].type==='cluster.snapshot')return events[i];return null}
  function escapeHtml(text){return text.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}

  function renderInvariants(){
    const host=$('invariants');host.innerHTML='';let failed=false;let watch=false;
    for(const item of invariantState.values()){
      failed ||= item.status==='fail';watch ||= item.status==='watch';
      const row=document.createElement('div');row.className=`invariant ${item.status}`;
      row.innerHTML=`<b>${escapeHtml(item.id.replaceAll('-',' '))} · ${item.status}</b><span>${escapeHtml(item.summary)}</span>`;row.onclick=()=>{ $('event-raw').textContent=JSON.stringify(item.evidence,null,2) };host.appendChild(row);
    }
    const metric=$('metric-safe');metric.textContent=failed?'VIOLATION':watch?'WATCH':'PROVEN';metric.style.color=failed?'var(--red)':watch?'var(--amber)':'var(--green)';
  }

  function renderTopology(states=null,snapshot=null){
    if(!states&&cluster)states=cluster.states();states=states||[];
    const edgeHost=$('edges'),nodeHost=$('nodes');edgeHost.innerHTML='';nodeHost.innerHTML='';
    const partitions=snapshot?.partitions||cluster?.network?.partitions?.map(g=>[...g])||[];
    const cut=(a,b)=>partitions.length>0&&partitions.findIndex(g=>g.some(u=>nodeId(u)===a))!==partitions.findIndex(g=>g.some(u=>nodeId(u)===b));
    for(let a=0;a<3;a++)for(let b=a+1;b<3;b++){const line=document.createElementNS(NS,'line');line.setAttribute('x1',POS[a].x);line.setAttribute('y1',POS[a].y);line.setAttribute('x2',POS[b].x);line.setAttribute('y2',POS[b].y);line.setAttribute('class','edge'+(cut(a,b)?' cut':''));edgeHost.appendChild(line)}
    for(let i=0;i<3;i++){
      const state=states.find(s=>nodeId(s.url)===i);const g=document.createElementNS(NS,'g');const role=state?.state?.toLowerCase()||'offline';g.setAttribute('class',`node ${role}`);g.setAttribute('transform',`translate(${POS[i].x} ${POS[i].y})`);
      const ring=document.createElementNS(NS,'circle');ring.setAttribute('r','55');ring.setAttribute('class','node-ring');g.appendChild(ring);
      const title=document.createElementNS(NS,'text');title.setAttribute('class','node-title');title.setAttribute('y','-8');title.textContent=`NODE ${i}`;g.appendChild(title);
      const roleText=document.createElementNS(NS,'text');roleText.setAttribute('class','node-role');roleText.setAttribute('y','12');roleText.textContent=role;g.appendChild(roleText);
      const meta=document.createElementNS(NS,'text');meta.setAttribute('class','node-meta');meta.setAttribute('y','77');meta.textContent=state?`term ${state.term} · log ${state.logLength} · commit ${state.commitIndex}`:'process offline';g.appendChild(meta);nodeHost.appendChild(g);
    }
  }

  function flyPacket(event,index){
    const from=nodeId(event.data.from),to=nodeId(event.data.to);if(from<0||to<0||!POS[from]||!POS[to])return;
    const host=$('packets'),g=document.createElementNS(NS,'g');g.setAttribute('class','packet '+(event.type==='rpc.reply'?'reply':''));
    const c=document.createElementNS(NS,'circle');c.setAttribute('r','5');g.appendChild(c);g.onclick=()=>selectEvent(index);host.appendChild(g);
    const started=performance.now(),duration=Math.max(220,Math.min(900,(event.data.latency||20)*12));
    function frame(now){const p=Math.min(1,(now-started)/duration),e=1-Math.pow(1-p,3);c.setAttribute('cx',POS[from].x+(POS[to].x-POS[from].x)*e);c.setAttribute('cy',POS[from].y+(POS[to].y-POS[from].y)*e);if(p<1)requestAnimationFrame(frame);else g.remove()}
    requestAnimationFrame(frame);
  }

  function renderMetrics(){
    if(!cluster)return;const leader=cluster.leader?.node;const states=cluster.states();
    $('metric-leader').textContent=leader?.replicaId||'electing';$('metric-term').textContent=leader?.currentTerm??Math.max(0,...states.map(s=>s.term));
    $('metric-quorum').textContent=`${states.length} / ${Math.floor((leader?.members?.length||3)/2)+1}`;$('metric-commit').textContent=leader?.commitIndex??'—';
    if(selectedIndex===events.length-1){$('clock-label').textContent=`T+${((cluster.clock.now()-(cluster.recorder?.startedAt||cluster.clock.now()))/1000).toFixed(3)}s`;$('cursor-label').textContent='LIVE';if(latestSnapshot)renderTopology(latestSnapshot.data.nodes,latestSnapshot.data)}
  }

  function importArtifact(payload){
    const trace=payload.trace||payload;
    if(!trace||!Array.isArray(trace.events))throw new Error('JSON does not contain a Flight Deck trace');
    if(cluster)cluster.stop();cluster=null;if(unsubscribe)unsubscribe();unsubscribe=null;paused=true;resetTrace();
    events=trace.events.slice();
    for(const event of events){
      if(event.type==='cluster.snapshot')latestSnapshot=event;
      if(event.type==='invariant.checked')invariantState.set(event.data.id,event.data);
    }
    const visible=events.map((event,index)=>({event,index})).filter(({event})=>
      !event.type.startsWith('cluster.')&&!event.type.startsWith('invariant.')).slice(-7);
    for(const item of visible)addTraceRow(item.event,item.index);
    document.getElementById('metric-events').textContent=events.length.toLocaleString();
    const scrubber=document.getElementById('scrubber');
    scrubber.max=Math.max(0,events.length-1);scrubber.value=Math.max(0,events.length-1);
    renderInvariants();renderTimeline();
    if(events.length)selectEvent(events.length-1);
    document.getElementById('play-pause').textContent='▶';
    document.getElementById('run-state').textContent='PAUSED · MINIMAL REPRODUCER';
    const failure=payload.expectedFailure||payload.result?.failure;
    document.getElementById('scenario-status').textContent=payload.explanation?.summary
      ||(failure
        ? 'replayed '+failure.signature+' · '+events.length+' causal events'
        : 'imported '+events.length+' causal events');
    toast('Failure artifact loaded');
  }

  async function loadArtifactFile(file){
    if(!file)return;
    try{
      const payload=JSON.parse(await file.text());
      importArtifact(payload);
    }catch(error){
      toast(error.message);document.getElementById('scenario-status').textContent=error.message;
    }finally{
      document.getElementById('trace-file').value='';
    }
  }

  async function startFresh(){
    if(cluster)cluster.stop();resetTrace();cluster=new SimCluster({size:3,seed,recording:true,minLatency:12,maxLatency:42});connectRecorder(cluster.recorder);paused=false;cluster.start({speed:1,intervalMs:45});$('play-pause').textContent='Ⅱ';$('run-state').textContent='RUNNING · 1×';setSeedUi();renderTopology();
  }

  async function runScenario(actions=null){
    const source=actions||$('scenario').value;$('scenario-status').textContent='executing deterministic schedule…';
    try{if(cluster)cluster.stop();resetTrace();const runner=new ScenarioRunner({clusterOptions:{seed,minLatency:12,maxLatency:42}});const result=await runner.run(source);cluster=result.cluster;connectRecorder(cluster.recorder);paused=true;lastScenario=typeof source==='string'?source:serializeScenario(source);$('play-pause').textContent='▶';$('run-state').textContent='PAUSED · REPLAY COMPLETE';$('scenario-status').textContent=`${result.results.length} actions · ${result.trace.events.length} events`;renderMetrics();toast('Scenario replay complete')}
    catch(error){$('scenario-status').textContent=error.message;toast('Scenario failed')}
  }

  document.querySelectorAll('[data-fault]').forEach(button=>button.onclick=()=>{
    if(!cluster)return;const leader=cluster.leader;const i=leader?nodeId(leader.url):0;const action=button.dataset.fault;
    if(action==='isolate')cluster.isolate(i);if(action==='crash')cluster.crash(i);if(action==='split')cluster.isolate(0);
    if(action==='latency'){cluster.network.minLatency=180;cluster.network.maxLatency=260;cluster.recorder.record('fault.applied',{data:{fault:'latency',minMs:180,maxMs:260}})}
    if(action==='loss'){cluster.network.dropRate=.3;cluster.recorder.record('fault.applied',{data:{fault:'packet-loss',rate:.3}})}
    if(action==='heal'){cluster.heal();cluster.network.minLatency=12;cluster.network.maxLatency=42;cluster.network.dropRate=0;for(const url of [...cluster.network.crashed])cluster.restart(nodeId(url))}
    cluster.recorder.captureCluster(cluster);toast(`${action} applied`);
  });
  $('play-pause').onclick=()=>{if(!cluster)return;if(paused){cluster.start({speed:1,intervalMs:45});paused=false;$('play-pause').textContent='Ⅱ';$('run-state').textContent='RUNNING · 1×'}else{cluster.stopDriver();paused=true;$('play-pause').textContent='▶';$('run-state').textContent='PAUSED'}};
  $('step').onclick=async()=>{if(!cluster)return;paused=true;await cluster.step();$('play-pause').textContent='▶';$('run-state').textContent='PAUSED · SINGLE STEP'};
  $('rewind').onclick=()=>lastScenario?runScenario(lastScenario):startFresh();
  $('run-scenario').onclick=()=>runScenario();
  $('fork-here').onclick=()=>{try{const at=events[selectedIndex]?.time.elapsedMs||0;const leader=cluster?.leader?nodeId(cluster.leader.url):0;const branch=branchScenario($('scenario').value,at,`0.0s crash(node${leader})\n0.8s heal-all()`);$('scenario').value=serializeScenario(branch);runScenario(branch)}catch(e){toast(e.message)}};
  document.querySelectorAll('[data-preset]').forEach(b=>b.onclick=()=>{$('scenario').value=PRESETS[b.dataset.preset]});
  $('scrubber').oninput=(e)=>selectEvent(Number(e.target.value));
  $('copy-seed').onclick=async()=>{await navigator.clipboard.writeText(replayUrl());toast('Replay URL copied')};
  document.getElementById('import-trace').onclick=()=>document.getElementById('trace-file').click();
  document.getElementById('trace-file').onchange=(event)=>loadArtifactFile(event.target.files?.[0]);
  $('export-trace').onclick=()=>{if(!cluster?.recorder)return;const blob=new Blob([JSON.stringify(cluster.recorder.export(),null,2)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`cloudproof-trace-seed-${seed}.json`;a.click();URL.revokeObjectURL(a.href)};
  addEventListener('keydown',e=>{if(e.code==='Space'&&e.target.tagName!=='TEXTAREA'){e.preventDefault();$('play-pause').click()}if(e.key==='ArrowRight'&&paused)$('step').click()});

  renderTimer=setInterval(renderMetrics,160);
  startFresh();
})();
