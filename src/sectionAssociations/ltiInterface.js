'use strict';

const { once } = require('node:events');
const { deploymentGuard } = require('../shared/deploymentGuard');

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Section Association Fix</title><style>
:root{color-scheme:light;--ink:#202a35;--muted:#5c6670;--line:#cdd5dc;--surface:#fff;--page:#f5f6f7;--accent:#006fbf;--ok:#287d3c;--bad:#b21f2d}
*{box-sizing:border-box}body{margin:0;background:var(--page);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}main{max-width:900px;margin:24px auto;padding:0 20px}header{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:14px}h1{font-size:1.45rem;line-height:1.25;font-weight:600;margin:0}h2{font-size:1rem;line-height:1.35;font-weight:600;margin:0 0 12px}section{background:var(--surface);border:1px solid var(--line);border-radius:4px;padding:16px;margin:12px 0}.status-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px 22px}.label{display:block;color:var(--muted);font-size:.875rem}.state{display:inline-flex;align-items:center;gap:8px;font-weight:600}.state:before{content:"";width:9px;height:9px;border-radius:50%;background:#68737d}.state.available:before,.state.idle:before{background:var(--ok)}.state.running:before{background:var(--accent)}.state.error:before,.state.unavailable:before{background:var(--bad)}.latest{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px 20px;margin-top:14px;padding-top:12px;border-top:1px solid var(--line)}.value{overflow-wrap:anywhere}.metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin-top:14px}.metric{padding:8px 10px;background:#f5f6f7}.metric-value{display:block;font-size:1.2rem;font-weight:600;font-variant-numeric:tabular-nums}.metric-label{color:var(--muted);font-size:.875rem}.actions{display:flex;gap:8px;align-items:center}button{border:1px solid #006fbf;border-radius:4px;padding:7px 12px;background:var(--accent);color:white;font:inherit;font-weight:600;cursor:pointer}button.secondary{background:white;color:var(--accent)}button:hover{filter:brightness(.94)}button:focus-visible,a:focus-visible,summary:focus-visible{outline:3px solid #1f7fba;outline-offset:3px}#updated,#notice{color:var(--muted);font-size:.875rem}#notice{min-height:1.5em;margin:8px 0 0}.execution{border-top:1px solid var(--line)}.execution:first-of-type{border-top:0}.execution summary{cursor:pointer;padding:10px 2px;display:grid;grid-template-columns:minmax(150px,1.3fr) minmax(90px,.7fr) minmax(90px,.7fr) repeat(3,minmax(70px,.6fr));gap:10px;align-items:center}.execution summary span{min-width:0;overflow-wrap:anywhere}.subhead,.empty{color:var(--muted)}.subhead{font-size:.78rem}.detail-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px 18px;padding:4px 12px 14px}.empty{margin:0}.history-header{display:flex;justify-content:space-between;align-items:center;gap:12px} [hidden]{display:none!important}
@media(max-width:620px){main{margin:14px auto;padding:0 12px}section{padding:13px}.latest{grid-template-columns:1fr 1fr}.metrics{gap:5px}.metric{padding:7px}.execution summary{grid-template-columns:1fr 1fr;gap:2px 10px;padding:10px 2px}.execution summary .subhead{display:none}.detail-grid{grid-template-columns:1fr 1fr;padding-left:8px;padding-right:8px}header{align-items:flex-start;flex-direction:column}}
</style></head><body><main><header><h1>Section Association Fix</h1><div class="actions"><button id="refresh" type="button">Refresh</button><button id="export" class="secondary" type="button">Download CSV</button></div></header>
<section aria-labelledby="service-heading"><h2 id="service-heading">Service status</h2><div class="status-list"><div><span class="label">Availability</span><span id="availability" class="state unknown" role="status">Loading</span></div><div><span class="label">Current worker state</span><span id="worker" class="state unknown" role="status">Loading</span></div></div>
<div id="latest" hidden><div class="latest"><div><span class="label">Last execution</span><span id="latestDate" class="value">—</span></div><div><span class="label">Outcome</span><span id="outcome" class="value">—</span></div><div><span class="label">Source</span><span id="source" class="value">—</span></div></div><div class="metrics"><div class="metric"><span id="checked" class="metric-value">—</span><span class="metric-label">Associations checked</span></div><div class="metric"><span id="corrections" class="metric-value">—</span><span class="metric-label">Corrections applied</span></div><div class="metric"><span id="errors" class="metric-value">—</span><span class="metric-label">Errors</span></div></div></div><p id="emptyLatest" class="empty" hidden>No maintenance execution recorded yet.</p></section>
<section aria-labelledby="history-heading"><div class="history-header"><h2 id="history-heading">Execution history</h2><span id="updated" aria-live="polite">Not updated yet</span></div><div class="execution subhead" aria-hidden="true"><div class="execution summary"><span>Date and time</span><span>Source</span><span>Outcome</span><span>Checked</span><span>Corrections</span><span>Errors</span></div></div><p id="historyEmpty" class="empty" hidden>No executions recorded yet.</p><div id="history"></div></section><p id="notice" role="status" aria-live="polite"></p>
</main><script>
const ltiToken=__LTI_TOKEN__;
function set(id,value){document.getElementById(id).textContent=value}
function statusText(value){if(typeof value!=='string'||!value.trim())return 'Unknown';return value.trim().replace(/(^|[-_\\s])\\w/g,letter=>letter.toUpperCase()).replace(/-/g,' ')}
function renderState(id,value,availability=false){const node=document.getElementById(id),label=statusText(value),state=label.toLowerCase();node.textContent=label;node.className='state '+(availability?(state==='available'?'available':'unavailable'):['running','idle','error'].includes(state)?state:'unknown')}
function formatDate(value){if(!value)return '—';const date=new Date(value);return Number.isNaN(date.getTime())?'—':new Intl.DateTimeFormat(undefined,{dateStyle:'medium',timeStyle:'short'}).format(date)}
function count(value){return Number.isSafeInteger(value)&&value>=0?String(value):'—'}
function duration(start,end){const a=new Date(start).getTime(),b=new Date(end).getTime();if(!Number.isFinite(a)||!Number.isFinite(b)||b<a)return '—';const seconds=Math.floor((b-a)/1000);return seconds<60?seconds+' seconds':Math.floor(seconds/60)+' min'+(seconds%60?' '+seconds%60+' sec':'')}
function safe(value){return String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function sourceName(value){return value==='manual'?'Manual':value==='automatic'?'Automatic':'Unknown'}
function executionHtml(run){const coverage=run.coverage?.type==='bounded-cycle'?'Bounded cycle':'Unknown';const backlog=run.coverage?.type==='bounded-cycle'&&Number.isSafeInteger(run.coverage.remainingHistoricalBacklog)?run.coverage.remainingHistoricalBacklog:'—';return '<details class="execution"><summary><span>'+safe(formatDate(run.startedAt))+'</span><span>'+sourceName(run.source)+'</span><span>'+safe(statusText(run.status))+'</span><span>'+safe(count(run.associationsChecked))+'</span><span>'+safe(count(run.correctionsApplied))+'</span><span>'+safe(count(run.errors))+'</span></summary><div class="detail-grid"><div><span class="label">Execution ID</span>'+safe(run.executionId||'—')+'</div><div><span class="label">Started</span>'+safe(formatDate(run.startedAt))+'</div><div><span class="label">Finished</span>'+safe(formatDate(run.completedAt))+'</div><div><span class="label">Duration</span>'+safe(duration(run.startedAt,run.completedAt))+'</div><div><span class="label">Already compliant</span>'+safe(count(run.alreadyCompliant))+'</div><div><span class="label">Coverage</span>'+coverage+'</div><div><span class="label">Historical backlog remaining</span>'+safe(backlog)+'</div></div></details>'}
async function refresh(){set('notice','Refreshing…');try{const response=await fetch('/api/section-association/status',{credentials:'same-origin',headers:{Accept:'application/json',Authorization:'Bearer '+ltiToken}});if(!response.ok){if(response.status===401)set('notice','LTI session expired. Relaunch this tool from Brightspace.');else if(response.status===403)set('notice','This LTI deployment is not authorized.');else if(response.status>=500)set('notice','Status service temporarily unavailable. Retry shortly.');else set('notice','Status request failed (HTTP '+response.status+').');renderState('availability','Unavailable',true);renderState('worker','Unavailable');return}const data=await response.json();renderState('availability',data.availability,true);renderState('worker',data.worker);const latest=data.latestExecution;document.getElementById('latest').hidden=!latest;document.getElementById('emptyLatest').hidden=!!latest;if(latest){set('latestDate',formatDate(latest.startedAt));set('outcome',statusText(latest.status));set('source',sourceName(latest.source));set('checked',count(latest.associationsChecked));set('corrections',count(latest.correctionsApplied));set('errors',count(latest.errors))}const runs=Array.isArray(data.executions)?data.executions.slice(0,50):[];document.getElementById('historyEmpty').hidden=runs.length>0;document.getElementById('history').innerHTML=runs.map(executionHtml).join('');set('updated','Last refreshed '+new Intl.DateTimeFormat(undefined,{hour:'numeric',minute:'2-digit'}).format(new Date()));set('notice','')}catch{set('notice','Could not reach the status service. Check your connection and retry.');renderState('availability','Unavailable',true);renderState('worker','Unavailable')}}
async function exportCsv(){set('notice','Preparing CSV…');try{const response=await fetch('/api/section-association/executions.csv',{credentials:'same-origin',headers:{Accept:'text/csv',Authorization:'Bearer '+ltiToken}});if(!response.ok){set('notice',response.status===401?'LTI session expired. Relaunch this tool from Brightspace.':response.status===403?'This LTI deployment is not authorized.':'CSV export failed. Retry shortly.');return}const blob=await response.blob(),url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=response.headers.get('Content-Disposition')?.match(/filename="?([^";]+)"?/i)?.[1]||'section-association-executions.csv';link.click();URL.revokeObjectURL(url);set('notice','CSV downloaded.')}catch{set('notice','Could not download the CSV. Check your connection and retry.')}}
document.getElementById('refresh').addEventListener('click',refresh);document.getElementById('export').addEventListener('click',exportCsv);refresh();
</script></body></html>`;

function pageForLaunch(ltik) {
  const serializedToken = JSON.stringify(ltik).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  return PAGE.replace('__LTI_TOKEN__', serializedToken);
}

const CSV_COLUMNS = [
  ['Execution ID', run => run.executionId], ['Execution source', run => run.source],
  ['Start timestamp', run => run.startedAt], ['Finish timestamp', run => run.completedAt],
  ['Duration in seconds', run => {
    const start = new Date(run.startedAt).getTime(), finish = new Date(run.completedAt).getTime();
    return Number.isFinite(start) && Number.isFinite(finish) && finish >= start ? (finish - start) / 1000 : '';
  }],
  ['Final status', run => run.status], ['Associations checked', run => run.associationsChecked],
  ['Already compliant', run => run.alreadyCompliant], ['Corrections applied', run => run.correctionsApplied],
  ['Errors', run => run.errors], ['Historical backlog remaining', run => run.coverage?.remainingHistoricalBacklog],
  ['Coverage', run => run.coverage?.type]
];

function csvCell(value) {
  if (value == null) return '""';
  const text = value instanceof Date ? value.toISOString() : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function registerSectionAssociationLtiInterface(provider, { deploymentId, getStatus, getExecutionHistory }) {
  const authorize = deploymentGuard(deploymentId);
  provider.app.get('/api/section-association/status', async (req, res) => {
    if (!authorize(res.locals?.token, req, res)) return;
    try { res.set('Cache-Control', 'no-store').json(await getStatus()); }
    catch { res.status(503).json({ availability: 'Unavailable', worker: 'Unavailable', latestExecution: null, executions: [] }); }
  });
  provider.app.get('/api/section-association/executions.csv', async (req, res) => {
    if (!authorize(res.locals?.token, req, res)) return;
    const date = new Date().toISOString().slice(0, 10);
    res.set('Cache-Control', 'no-store').set('Content-Type', 'text/csv; charset=utf-8')
      .set('Content-Disposition', `attachment; filename="section-association-executions-${date}.csv"`);
    try {
      res.write(CSV_COLUMNS.map(([name]) => csvCell(name)).join(',') + '\r\n');
      for await (const run of getExecutionHistory()) {
        const line = CSV_COLUMNS.map(([, getValue]) => csvCell(getValue(run))).join(',') + '\r\n';
        if (!res.write(line)) await once(res, 'drain');
      }
      res.end();
    } catch {
      if (res.headersSent) res.destroy?.();
      else res.status(503).send('Execution history is temporarily unavailable.');
    }
  });
  provider.onConnect((token, req, res) => {
    if (!authorize(token, req, res)) return;
    const ltik = res.locals?.ltik;
    if (typeof ltik !== 'string' || !ltik) return res.status(401).send('LTI launch token unavailable. Relaunch this tool from Brightspace.');
    res.set('Cache-Control', 'no-store').type('html').send(pageForLaunch(ltik));
  });
}

module.exports = { registerSectionAssociationLtiInterface, pageForLaunch, CSV_COLUMNS, csvCell };
