import { DbConnection } from './module_bindings/index.ts';
import { projectRun, replayFrame } from '../sandbox/src/projection.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const node = (tag: string, text: unknown, cls = '') => { const n = document.createElement(tag); n.textContent = String(text ?? '—'); n.className = cls; return n; };
let current: any, recorded: any, source: 'live' | 'recorded' = 'live', closeConnection = () => {}, lastUpdate = 0, connected = false;
let connectionVersion = 0;
let selectedEvent: number | null = null;
let motionRun = "", motionEvent = 0;
let perspective: "attack" | "defense" = "attack";
const hostedReplay = document.body.dataset.mode === 'recorded';
let playback: ReturnType<typeof setInterval> | undefined;
function pauseReplay() { clearInterval(playback); playback = undefined; $('play').textContent = 'Play replay'; }
function inspect(event: any) {
  selectedEvent = event.id;
  document.querySelectorAll('.event').forEach(el => el.classList.toggle('selected', (el as HTMLElement).dataset.eventId === String(event.id)));
  document.querySelectorAll('.mapnode').forEach(el => el.classList.toggle('selected', (el as HTMLElement).dataset.actor === event.actor));
  const ids = ['evidenceId','sourceRequestId','attackEventId','normalEventId','readEventId','updateEventId'].map(k => event.detail[k]).filter(Boolean);
  const decision = current.agentTraces.findLast((t: any) => t.eventId === event.id || t.actor === event.actor && t.action?.evidenceId === event.detail.evidenceId && t.action?.kind === 'write_rule');
  $('evidence').textContent = JSON.stringify({ event, supportingRequests: current.events.filter((e: any) => ids.includes(e.id)), decision }, null, 2);
}
function render(run: any) {
  if (!run) return;
  if (current?.id !== run.id) { selectedEvent = null; $('evidence').textContent = 'Select an event.'; }
  const previousEvent = motionRun === run.id ? motionEvent : Infinity;
  motionRun = run.id; motionEvent = run.events.at(-1)?.id ?? 0;
  current = run;
  $('decision').textContent = run.engine === 'fixture' ? 'FIXTURE DECISIONS · NO LLM' : `BITDEER · ${run.model}`;
  $('connection').textContent = source === 'recorded' ? 'RECORDED' : !connected ? 'DISCONNECTED' : run.live ? 'LIVE' : 'COMPLETED';
  const agents = run.actors.filter((a: any) => !['client','probe'].includes(a.role));
  $('metadata').textContent = `${run.config.mode.toUpperCase()} · ${(run.elapsedMs / 1000).toFixed(1)}s · ${agents.length} security agents · ${run.actors.filter((a: any) => a.role === 'client').length} clients · ${run.config.loadProfile} load · ${run.id.slice(0,8)}`;
  $('errors').textContent = `${run.summary.agentErrors} decision errors · ${run.infrastructureErrorCount ?? 0} runtime errors`;
  $('download').removeAttribute('disabled');
  const attacker = (actor: any) => ['scout','deceiver','pressure'].includes(actor.role);
  const totals = Object.values(run.summary.metrics) as any[];
  for (const side of ['attack','defense']) {
    const roster = $(side+'-roster');
    const members = agents.filter((a: any) => attacker(a) === (side === 'attack'));
    $(side+'-count').textContent = `${members.length} AGENTS`;
    roster.replaceChildren(...members.map((actor: any) => {
      const trace = run.agentTraces.findLast((t: any) => t.actor === actor.id);
      const row = node('li',''); row.append(node('span',actor.id,'role'),node('small',trace?.error ? 'Decision error' : trace?.action ? `${trace.action.kind} ${trace.action.scenario ?? trace.action.rule ?? ''} · ${trace.status}` : 'Awaiting decision','activity')); return row;
    }));
  }
  $('captures').textContent = String(totals.reduce((n,m)=>n+m.verifiedCaptures,0));
  $('recoveries').textContent = String(totals.reduce((n,m)=>n+m.verifiedReclaims,0));
  const requests = totals.reduce((n,m)=>n+m.legitimateRequests,0);
  $('success').textContent = requests ? `${(100*totals.reduce((n,m)=>n+m.legitimateSucceeded,0)/requests).toFixed(1)}%` : '—';
  $('handoffs').textContent = String(totals.reduce((n,m)=>n+m.completedHandoffs,0));
  $('clock').textContent = `${(run.elapsedMs/1000).toFixed(1)}s`;
  $('mapnodes').replaceChildren(...agents.map((actor: any,i: number) => {
    const isAttack = attacker(actor), group = agents.filter((a: any)=>attacker(a)===isAttack), index = group.findIndex((a:any)=>a.id===actor.id);
    const n = node('button','','mapnode '+(isAttack?'attacker':'defender'));
    n.dataset.actor = actor.id;
    const latest = run.events.findLast((e:any)=>e.actor===actor.id);
    const recent = latest && run.elapsedMs-latest.at < 450 && latest.id > previousEvent;
    n.classList.toggle('signal',Boolean(recent));
    n.classList.toggle('selected',run.events.find((e:any)=>e.id===selectedEvent)?.actor===actor.id);
    n.setAttribute('aria-label',`${actor.id}: inspect latest measured event`);
    n.style.left = `${isAttack ? 12+(index%2)*18 : 70+(index%2)*18}%`; n.style.top = `${15+Math.floor(index/2)*26}%`;
    n.append(node('span',isAttack?'⌁':'◇','glyph'),node('small',actor.id));
    n.onclick = () => { const event = run.events.findLast((e:any)=>e.actor===actor.id); if(event) inspect(event); }; return n;
  }));
  $('assets').replaceChildren(...run.assets.map((asset: any) => {
    const breached = asset.controlledBy !== asset.home;
    const n = node('div','', 'assetnode '+(breached?'breached':'secured'));
    const transition = run.events.findLast((e:any)=>['capture','reclaim'].includes(e.kind) && e.target===asset.home);
    n.classList.toggle('changed',Boolean(transition && transition.id>previousEvent));
    n.append(node('span',asset.home.toUpperCase()+' NAMESPACE'),node('strong',breached?'COMPROMISED':'HOME CONTROL'),node('small',`Owner: ${asset.controlledBy.toUpperCase()}`)); return n;
  }));
  document.body.dataset.perspective = perspective;
  $('view-title').textContent = perspective === 'attack' ? 'ATTACKER VIEW · EXPOSURE & IMPACT' : 'DEFENDER VIEW · DETECTION & RECOVERY';
  $('view-detail').textContent = perspective === 'attack' ? 'Trace attempted access → leaked artifact → capture. Select an agent or event for supporting requests.' : 'Trace hostile request → policy response → verified recovery. Client success shows whether the application stayed usable.';
  for (const side of ['attack','defense']) $(side+'-view').setAttribute('aria-pressed',String(side===perspective));
  const relevant = (e:any) => {
    const actor = agents.find((a:any)=>a.id===e.actor);
    if (['capture','reclaim','match_started','match_stopped'].includes(e.kind)) return true;
    if (perspective === 'attack') return actor && attacker(actor);
    return ['rule_change','untrusted_telemetry'].includes(e.kind) || actor && !attacker(actor) || e.kind==='request' && e.detail.status>=400;
  };
  const showRequests = $('requests') as HTMLInputElement;
  $('events').replaceChildren(...run.events.filter(relevant).filter((e: any) => showRequests.checked || !['request','untrusted_telemetry'].includes(e.kind)).slice(-120).reverse().map((e: any) => {
    const button = node('button','','row event');
    button.dataset.tone = e.kind==='capture' ? 'comp' : e.kind==='reclaim' ? 'recovered' : e.kind==='rule_change' ? 'contained' : e.detail.status>=400 ? 'blocked' : '';
    button.append(node('span',`${(e.at/1000).toFixed(2)}s`),node('span',e.actor),node('strong',e.kind.replaceAll('_',' ').toUpperCase()),node('span',e.detail.rule ?? e.detail.scenario ?? e.target ?? 'match'),node('span',e.detail.status ? `HTTP ${e.detail.status}` : `#${e.id}`));
    button.dataset.eventId = String(e.id);
    button.classList.toggle('selected',e.id===selectedEvent);
    button.setAttribute('aria-pressed',String(e.id===selectedEvent));
    button.onclick = () => inspect(e); return button;
  }));
  if (selectedEvent) { const event = run.events.find((e: any) => e.id === selectedEvent); if (event) inspect(event); }
}
async function recordings() {
  const entries = await fetch(hostedReplay ? '/recordings/index.json' : '/api/runs').then(r => r.json());
  const select = $('recordings') as HTMLSelectElement, value = select.value;
  select.replaceChildren(new Option('Select a completed run',''),...entries.map((r: any) => new Option(`${r.mode} · ${r.engine} · ${r.id.slice(0,8)}`,r.id))); select.value = value;
}
function receive(raw: any) {
  if (source !== 'live' || !raw) return;
  const run = projectRun(raw);
  if (current?.id === run.id && run.events.length < current.events.length) return;
  connected = true; lastUpdate = Date.now(); $('notice').textContent = ''; render(run);
  if (!run.live) void recordings();
}
function disconnect() { if (source !== 'live') return; connected = false; $('connection').textContent = 'DISCONNECTED'; $('notice').textContent = 'Connection lost. The last measured state is frozen.'; }
async function live() {
  pauseReplay();
  const version = ++connectionVersion; closeConnection(); source = 'live'; recorded = null; current = null; $('replay').classList.add('hidden'); $('connection').textContent = 'CONNECTING';
  const config = await fetch('/api/config').then(r => r.json());
  if (version !== connectionVersion) return;
  const lost = () => { if (version === connectionVersion) disconnect(); };
  const accept = (raw: any) => { if (version === connectionVersion) receive(raw); };
  if (config.spacetime) {
    $('transport').textContent = 'SPACETIME SUBSCRIPTION';
    const conn = DbConnection.builder().withUri(config.spacetime.uri).withDatabaseName(config.spacetime.database)
      .onConnect(c => {
        const apply = () => { const rows = [...c.db.arenaSnapshot.iter()]; if (rows[0]) accept(JSON.parse(rows[0].payload)); };
        c.db.arenaSnapshot.onInsert(apply); c.db.arenaSnapshot.onUpdate(apply);
        c.subscriptionBuilder().onApplied(apply).onError(lost).subscribe(['SELECT * FROM arena_snapshot']);
      }).onDisconnect(lost).onConnectError(lost).build();
    closeConnection = () => conn.disconnect();
  } else {
    $('transport').textContent = 'LOCAL EVENT STREAM';
    const stream = new EventSource('/api/events'); stream.onmessage = e => { try { accept(JSON.parse(e.data)); } catch { lost(); } }; stream.onerror = lost;
    closeConnection = () => stream.close();
  }
}
function replay(raw: any) {
  pauseReplay();
  connectionVersion++; source = 'recorded'; closeConnection(); connected = false; recorded = projectRun(raw); selectedEvent = null;
  $('replay').classList.remove('hidden'); const slider = $('scrub') as HTMLInputElement;
  slider.max = String(recorded.elapsedMs); slider.value = slider.max; $('transport').textContent = 'SAVED EVIDENCE'; $('notice').textContent = '';
  drawReplay();
}
function drawReplay() { const at = Number(($('scrub') as HTMLInputElement).value); $('replaytime').textContent = `${(at/1000).toFixed(1)}s`; render(replayFrame(recorded,at)); }
for (const side of ['attack','defense'] as const) $(side+'-view').onclick = () => { perspective = side; selectedEvent = null; $('evidence').textContent = 'Select an event or agent.'; motionRun = ''; if(current) render(current); };
$('live').onclick = () => void live().catch(disconnect);
$('requests').onchange = () => current && render(current);
$('scrub').oninput = () => { pauseReplay(); motionRun = ''; drawReplay(); };
$('play').onclick = () => {
  if (playback) return pauseReplay();
  const slider = $('scrub') as HTMLInputElement;
  if (Number(slider.value) >= Number(slider.max)) slider.value = '0';
  $('play').textContent = 'Pause replay'; drawReplay();
  playback = setInterval(() => { slider.value = String(Math.min(Number(slider.max),Number(slider.value)+100)); drawReplay(); if (Number(slider.value) >= Number(slider.max)) pauseReplay(); },100);
};
$('recordings').onchange = async () => { const id = ($('recordings') as HTMLSelectElement).value; if (id) replay(await fetch(hostedReplay ? `/recordings/${id}.json` : `/api/runs/${id}`).then(r => r.json())); };
$('upload').onchange = async () => { try { const file = ($('upload') as HTMLInputElement).files?.[0]; if (!file) return; if (file.size > 15e6) throw Error('File exceeds 15 MB'); replay(JSON.parse(await file.text())); } catch { $('notice').textContent = 'Could not read the run. Choose a SudoKO result JSON file under 15 MB.'; } };
$('download').onclick = () => { const a = document.createElement('a'); const url = URL.createObjectURL(new Blob([JSON.stringify(recorded ?? current,null,2)],{type:'application/json'})); a.href=url; a.download=`sudoko-${current.id}.json`; a.click(); setTimeout(()=>URL.revokeObjectURL(url),1000); };
setInterval(() => { if (source === 'live' && current?.live && Date.now()-lastUpdate > 5000) disconnect(); },1000);
if (hostedReplay) {
  $('live').classList.add('hidden');
  void recordings().then(async () => { const select = $('recordings') as HTMLSelectElement; select.selectedIndex = 1; if (select.value) replay(await fetch(`/recordings/${select.value}.json`).then(r => r.json())); }).catch(() => { $('notice').textContent = 'Could not load the recording. Reload or import a saved result.'; });
} else { void live().catch(disconnect); void recordings(); }
