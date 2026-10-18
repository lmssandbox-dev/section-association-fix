'use strict';

const { deploymentGuard } = require('../shared/deploymentGuard');

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Section Association Fix</title><style>
:root{color-scheme:light;--ink:#202a35;--muted:#5c6670;--line:#cdd5dc;--surface:#fff;--page:#f5f6f7;--accent:#006fbf;--ok:#287d3c;--warn:#8a5a00;--bad:#b21f2d}
*{box-sizing:border-box}body{margin:0;background:var(--page);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:820px;margin:24px auto;padding:0 20px}header{margin:0 0 16px}h1{font-size:1.45rem;line-height:1.25;font-weight:600;margin:0}h2{font-size:1rem;line-height:1.35;font-weight:600;margin:0 0 14px}
section{background:var(--surface);border:1px solid var(--line);border-radius:4px;padding:18px;margin:12px 0}
.status-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px 24px}.status-item,.execution-item{min-width:0}.label{display:block;color:var(--muted);font-size:.875rem;margin-bottom:2px}.state{display:inline-flex;align-items:center;gap:8px;font-weight:600}.state::before{content:"";width:9px;height:9px;flex:0 0 9px;border-radius:50%;background:#68737d}.state.available::before,.state.idle::before{background:var(--ok)}.state.running::before{background:var(--accent)}.state.error::before,.state.unavailable::before{background:var(--bad)}.state.unknown::before{background:#68737d}
.execution-meta{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px 24px;margin-top:16px;padding-top:14px;border-top:1px solid var(--line)}.execution-value{overflow-wrap:anywhere}
.metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));border-top:1px solid var(--line);border-left:1px solid var(--line)}.metric{min-width:0;padding:12px;border-right:1px solid var(--line);border-bottom:1px solid var(--line)}.metric.backlog{background:#f0f7fc;border-top:3px solid var(--accent);padding-top:9px}.metric-value{display:block;font-size:1.45rem;line-height:1.25;font-weight:600;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}.metric-label{display:block;color:var(--muted);font-size:.875rem;margin-top:4px}.coverage-note,.empty-state{color:var(--muted);margin:12px 0 0}.empty-state{margin:0}
.actions{display:flex;align-items:center;gap:14px;flex-wrap:wrap}button{border:1px solid #006fbf;border-radius:4px;padding:8px 16px;background:var(--accent);color:#fff;font:inherit;font-weight:600;cursor:pointer}button:hover{background:#005a9e}button:focus-visible{outline:3px solid #1f7fba;outline-offset:3px}#updated,#notice{color:var(--muted);font-size:.875rem;margin:0}#notice{min-height:1.5em;margin-top:10px}.placeholder{color:var(--muted)}[hidden]{display:none!important}
@media(max-width:520px){main{margin:16px auto;padding:0 12px}section{padding:14px}.status-list{grid-template-columns:1fr 1fr;gap:10px 14px}.execution-meta{grid-template-columns:1fr;gap:8px}.metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.actions{gap:10px}}
</style></head><body><main><header><h1>Section Association Fix</h1></header>
<section aria-labelledby="service-heading"><h2 id="service-heading">Service status</h2><div class="status-list">
<div class="status-item"><span class="label">Availability</span><span id="availability" class="state unknown" role="status">Loading</span></div>
<div class="status-item"><span class="label">Worker</span><span id="worker" class="state unknown" role="status">Loading</span></div></div>
<div id="executionMeta" class="execution-meta" hidden>
<div class="execution-item"><span class="label">Last execution</span><span id="latestDate" class="execution-value placeholder">—</span></div>
<div class="execution-item"><span class="label">Outcome</span><span id="outcome" class="execution-value placeholder">—</span></div>
<div class="execution-item"><span class="label">Source</span><span id="source" class="execution-value placeholder">—</span></div>
</div></section>
<section aria-labelledby="latest-heading"><h2 id="latest-heading">Latest execution</h2><p id="empty" class="empty-state" hidden>No maintenance execution recorded yet.</p>
<div id="metrics" class="metrics" hidden>
<div class="metric"><span id="checked" class="metric-value">—</span><span class="metric-label">Associations checked</span></div>
<div class="metric"><span id="compliant" class="metric-value">—</span><span class="metric-label">Already compliant</span></div>
<div class="metric"><span id="corrections" class="metric-value">—</span><span class="metric-label">Corrections applied</span></div>
<div class="metric"><span id="errors" class="metric-value">—</span><span class="metric-label">Errors</span></div>
<div id="backlogMetric" class="metric backlog"><span id="backlog" class="metric-value">—</span><span class="metric-label">Remaining historical backlog</span></div>
</div><p id="coverageNote" class="coverage-note" hidden></p><p id="backlogProgress" class="coverage-note" hidden></p>
<details id="executionDetails" hidden><summary id="executionDetailsSummary">View details</summary><div class="execution-meta"><div><span class="label">Started</span><span id="detailStarted">—</span></div><div><span class="label">Finished</span><span id="detailFinished">—</span></div><div><span class="label">Duration</span><span id="duration">—</span></div><div><span class="label">Already compliant</span><span id="detailCompliant">—</span></div><div><span class="label">Coverage</span><span id="detailCoverage">—</span></div></div></details></section>
<section aria-labelledby="recent-heading"><h2 id="recent-heading">Recent executions</h2><p id="recentEmpty" class="empty-state" hidden>No recent executions recorded yet.</p><div id="recentList"></div></section>
<section aria-labelledby="schedule-heading"><h2 id="schedule-heading">Next scheduled execution</h2><p id="nextRun">Unavailable</p><p class="coverage-note">This is an expected time based on the configured schedule, not confirmation that a run will execute.</p><p id="backlogMeaning" class="coverage-note">Remaining historical backlog is outstanding processing work; it does not necessarily indicate incorrect associations.</p></section>
<section aria-labelledby="actions-heading"><h2 id="actions-heading">Actions</h2><div class="actions"><button id="refresh" type="button">Refresh</button><span id="updated" aria-live="polite">Not updated yet</span></div><p id="notice" role="status" aria-live="polite"></p></section>
</main><script>
const ltiToken=__LTI_TOKEN__;
function set(id,value){document.getElementById(id).textContent=value}
function neutral(id){set(id,'—')}
function statusText(value){if(typeof value!=='string'||!value.trim())return 'Unknown';return value.trim().replace(/(^|[-_\\s])\\w/g,letter=>letter.toUpperCase()).replace(/-/g,' ')}
function renderState(id,value,category){const node=document.getElementById(id);const label=statusText(value);node.textContent=label;const state=label.toLowerCase();node.className='state '+(category==='availability'?(state==='available'?'available':'unavailable'):['running','idle','error'].includes(state)?state:'unknown')}
function clearExecution(){document.getElementById('executionMeta').hidden=true;document.getElementById('metrics').hidden=true;document.getElementById('empty').hidden=true;document.getElementById('coverageNote').hidden=true;document.getElementById('backlogProgress').hidden=true;document.getElementById('executionDetails').hidden=true;for(const id of ['latestDate','outcome','source','checked','compliant','corrections','errors','backlog','detailStarted','detailFinished','duration','detailCompliant','detailCoverage'])neutral(id)}
function unavailable(message,worker='Unavailable'){renderState('availability','Unavailable','availability');renderState('worker',worker,'worker');clearExecution();set('updated','');set('notice',message)}
function formatDate(value){if(!value)return '—';const date=new Date(value);return Number.isNaN(date.getTime())?'—':new Intl.DateTimeFormat(undefined,{dateStyle:'medium',timeStyle:'short'}).format(date)}
function metricValue(id,value){set(id,Number.isSafeInteger(value)&&value>=0?String(value):'—')}
function duration(start,end){const a=new Date(start).getTime(),b=new Date(end).getTime();if(!Number.isFinite(a)||!Number.isFinite(b)||b<a)return '—';const seconds=Math.floor((b-a)/1000);return seconds<60?seconds+' seconds':Math.floor(seconds/60)+' min'+(seconds%60?' '+seconds%60+' sec':'')}
function safe(value){return String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
async function refresh(){set('notice','Refreshing…');try{const response=await fetch('/api/section-association/status',{credentials:'same-origin',headers:{Accept:'application/json',Authorization:'Bearer '+ltiToken}});if(!response.ok){if(response.status===401)unavailable('LTI session expired. Relaunch this tool from Brightspace.','Authentication required');else if(response.status===403)unavailable('This LTI deployment is not authorized.','Not authorized');else if(response.status>=500)unavailable('Status service temporarily unavailable. Retry shortly.','Unavailable');else unavailable('Status request failed (HTTP '+response.status+').');return}const data=await response.json();
renderState('availability',data.availability,'availability');renderState('worker',data.worker,'worker');const execution=data.latestExecution;
if(!execution){clearExecution();document.getElementById('empty').hidden=false}
else{document.getElementById('executionMeta').hidden=false;document.getElementById('metrics').hidden=false;document.getElementById('empty').hidden=true;set('latestDate',formatDate(execution.startedAt));set('outcome',execution.status?statusText(execution.status):'—');set('source',execution.source==='manual'?'Manual maintenance':execution.source==='automatic'?'Automatic maintenance':'—');metricValue('checked',execution.associationsChecked);metricValue('compliant',execution.alreadyCompliant);metricValue('corrections',execution.correctionsApplied);metricValue('errors',execution.errors);const coverage=execution.coverage;const hasBacklog=coverage?.type==='bounded-cycle'&&Number.isSafeInteger(coverage.remainingHistoricalBacklog)&&coverage.remainingHistoricalBacklog>=0;set('backlog',hasBacklog?String(coverage.remainingHistoricalBacklog):'—');document.getElementById('coverageNote').hidden=!hasBacklog;if(hasBacklog)set('coverageNote','Bounded processing cycle. Full coverage is unknown.');document.getElementById('executionDetails').hidden=false;set('detailStarted',formatDate(execution.startedAt));set('detailFinished',formatDate(execution.completedAt));set('duration',duration(execution.startedAt,execution.completedAt));metricValue('detailCompliant',execution.alreadyCompliant);set('detailCoverage',hasBacklog?'Bounded processing cycle':'Coverage unknown')}
const runs=Array.isArray(data.executions)?data.executions.slice(0,5):[];document.getElementById('recentEmpty').hidden=runs.length>0;document.getElementById('recentList').innerHTML=runs.map(run=>{const src=run.source==='manual'?'Manual maintenance':run.source==='automatic'?'Automatic maintenance':'Unknown source';return '<details><summary>'+safe(formatDate(run.startedAt))+' · '+src+' · '+safe(statusText(run.status))+'</summary><p>Checked: '+safe(Number.isSafeInteger(run.associationsChecked)?run.associationsChecked:'—')+' · Corrections: '+safe(Number.isSafeInteger(run.correctionsApplied)?run.correctionsApplied:'—')+' · Errors: '+safe(Number.isSafeInteger(run.errors)?run.errors:'—')+' · Duration: '+safe(duration(run.startedAt,run.completedAt))+'</p></details>'}).join('');set('nextRun',data.nextScheduledExecution?formatDate(data.nextScheduledExecution):'Unavailable');const previous=runs[1]?.coverage,currentCoverage=execution?.coverage,old=previous?.remainingHistoricalBacklog,current=currentCoverage?.remainingHistoricalBacklog;const valid=previous?.type==='bounded-cycle'&&currentCoverage?.type==='bounded-cycle'&&Number.isSafeInteger(old)&&old>=0&&Number.isSafeInteger(current)&&current>=0;document.getElementById('backlogProgress').hidden=!valid;if(valid)set('backlogProgress',current===old?'No change since the previous execution.':Math.abs(current-old)+' '+(current<old?'fewer':'more')+' remaining since the previous execution.');
set('updated','Last updated '+new Intl.DateTimeFormat(undefined,{hour:'numeric',minute:'2-digit'}).format(new Date()));set('notice','');
}catch{unavailable('Could not reach the status service. Check your connection and retry.')}}
document.getElementById('executionDetails').addEventListener('toggle',event=>set('executionDetailsSummary',event.target.open?'Hide details':'View details'));document.getElementById('refresh').addEventListener('click',refresh);refresh();
</script></body></html>`;

function pageForLaunch(ltik) {
  const serializedToken = JSON.stringify(ltik).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  return PAGE.replace('__LTI_TOKEN__', serializedToken);
}

function registerSectionAssociationLtiInterface(provider, { deploymentId, getStatus }) {
  const authorize = deploymentGuard(deploymentId);
  provider.app.get('/api/section-association/status', async (req, res) => {
    if (!authorize(res.locals?.token, req, res)) return;
    try { res.set('Cache-Control', 'no-store').json(await getStatus()); }
    catch { res.status(503).json({ availability: 'Unavailable', worker: 'Unavailable', latestExecution: null }); }
  });
  provider.onConnect((token, req, res) => {
    if (!authorize(token, req, res)) return;
    const ltik = res.locals?.ltik;
    if (typeof ltik !== 'string' || !ltik) return res.status(401).send('LTI launch token unavailable. Relaunch this tool from Brightspace.');
    res.set('Cache-Control', 'no-store').type('html').send(pageForLaunch(ltik));
  });
}

module.exports = { registerSectionAssociationLtiInterface, pageForLaunch };
