import { DbConnection } from './module_bindings/index.ts';
import { projectRun, replayFrame } from '../sandbox/src/projection.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const node = (tag: string, text: unknown, cls = '') => { const n = document.createElement(tag); n.textContent = String(text ?? '—'); n.className = cls; return n; };
let current: any, recorded: any, source: 'live' | 'recorded' = 'live', closeConnection = () => {}, lastUpdate = 0, connected = false;
let connectionVersion = 0;
let selectedEvent: number | null = null;
const hostedReplay = document.body.dataset.mode === 'recorded';
let playback: ReturnType<typeof setInterval> | undefined;
function pauseReplay() { clearInterval(playback); playback = undefined; $('play').textContent = 'Play replay'; }
function inspect(event: any) {
  selectedEvent = event.id;
  const ids = ['evidenceId','sourceRequestId','attackEventId','normalEventId','readEventId','updateEventId'].map(k => event.detail[k]).filter(Boolean);
  const decision = current.agentTraces.findLast((t: any) => t.eventId === event.id || t.actor === event.actor && t.action?.evidenceId === event.detail.evidenceId && t.action?.kind === 'write_rule');
  $('evidence').textContent = JSON.stringify({ event, supportingRequests: current.events.filter((e: any) => ids.includes(e.id)), decision }, null, 2);
}
function render(run: any) {
  if (!run) return;
  if (current?.id !== run.id) { selectedEvent = null; $('evidence').textContent = 'Select an event.'; }
  current = run;
  $('decision').textContent = run.engine === 'fixture' ? 'FIXTURE DECISIONS · NO LLM' : `BITDEER · ${run.model}`;
  $('connection').textContent = source === 'recorded' ? 'RECORDED' : !connected ? 'DISCONNECTED' : run.live ? 'LIVE' : 'COMPLETED';
  const agents = run.actors.filter((a: any) => !['client','probe'].includes(a.role));
  $('metadata').textContent = `${run.config.mode.toUpperCase()} · ${(run.elapsedMs / 1000).toFixed(1)}s · ${agents.length} security agents · ${run.actors.filter((a: any) => a.role === 'client').length} clients · ${run.config.loadProfile} load · ${run.id.slice(0,8)}`;
  $('errors').textContent = `${run.summary.agentErrors} decision errors · ${run.infrastructureErrorCount ?? 0} runtime errors`;
  $('download').removeAttribute('disabled');
  $('teams').replaceChildren(...['red','blue'].map(team => {
    const card = node('section','', 'team'); card.style.setProperty('--accent',team === 'red' ? '#ee8580' : '#84b8fa');
    card.append(node('h2', `${team.toUpperCase()} / application namespace`));
    const asset = run.assets.find((a: any) => a.home === team), m = run.summary.metrics[team];
    const control = node('div','Current asset control','asset'); control.append(node('strong',`${asset?.controlledBy?.toUpperCase() ?? 'UNKNOWN'} TEAM`)); card.append(control);
    const stats = node('div','','stats');
    for (const [label,value] of [['Breaches of this asset',m.verifiedCaptures],['Verified recoveries',m.verifiedReclaims],['Team handoffs',m.completedHandoffs],['Legitimate success',m.legitimateSuccessPct == null ? '—' : `${m.legitimateSuccessPct}%`],['Legitimate requests',m.legitimateRequests],['Latency p95',m.legitimateP95Ms == null ? '—' : `${m.legitimateP95Ms} ms`]]) {
      const s = node('div','','stat'); s.append(node('span',label),node('strong',value)); stats.append(s);
    }
    card.append(stats,node('h3','SECURITY TEAM'));
    const roster = node('ul','','roster');
    agents.filter((a: any) => a.team === team).forEach((actor: any) => {
      const trace = run.agentTraces.findLast((t: any) => t.actor === actor.id), row = node('li','');
      const action = trace?.error ? 'Decision error' : trace?.action ? `${trace.action.kind} ${trace.action.scenario ?? trace.action.rule ?? ''} · ${trace.status}` : 'Awaiting decision';
      row.append(node('span',actor.id,'role'),node('span',action,'activity')); roster.append(row);
    }); card.append(roster); return card;
  }));
  const showRequests = $('requests') as HTMLInputElement;
  $('events').replaceChildren(...run.events.filter((e: any) => showRequests.checked || !['request','untrusted_telemetry'].includes(e.kind)).slice(-120).reverse().map((e: any) => {
    const button = node('button',`#${e.id} · ${e.kind.replaceAll('_',' ')}${e.detail.rule ? ' · '+e.detail.rule : ''}`,'event');
    button.append(node('small',`${(e.at/1000).toFixed(2)}s · ${e.actor} → ${e.target || 'match'}${e.detail.status ? ' · HTTP '+e.detail.status : ''}`));
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
$('live').onclick = () => void live().catch(disconnect);
$('requests').onchange = () => current && render(current);
$('scrub').oninput = () => { pauseReplay(); drawReplay(); };
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
