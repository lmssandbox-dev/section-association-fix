'use strict';

const { once } = require('node:events');
const { deploymentGuard } = require('../shared/deploymentGuard');

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Section Association Fix</title><style>
:root{color-scheme:light;--ink:#202a35;--muted:#5c6670;--line:#d6dce1;--surface:#fff;--page:#f5f6f7;--accent:#006fbf;--ok:#287d3c;--bad:#b21f2d}
*{box-sizing:border-box}body{margin:0;background:var(--page);color:var(--ink);font:15px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}main{max-width:900px;margin:20px auto;padding:0 20px}header{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:12px}h1{font-size:1.4rem;line-height:1.25;font-weight:600;margin:0}h2{font-size:1rem;line-height:1.35;font-weight:600;margin:0}section{background:var(--surface);border:1px solid var(--line);border-radius:4px;padding:14px 16px;margin:10px 0}.status-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px 20px}.label{display:block;color:var(--muted);font-size:.84rem}.state{display:inline-flex;align-items:center;gap:7px;font-weight:600}.state:before{content:"";width:8px;height:8px;border-radius:50%;background:#68737d}.state.available:before,.state.idle:before{background:var(--ok)}.state.running:before{background:var(--accent)}.state.error:before,.state.unavailable:before{background:var(--bad)}.latest{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px 18px;margin-top:10px;padding-top:9px;border-top:1px solid var(--line)}.value{overflow-wrap:anywhere}.metrics{display:flex;align-items:stretch;margin-top:10px;border-top:1px solid var(--line);padding-top:8px}.metric{flex:1;min-width:0;padding:0 12px;border-left:1px solid var(--line)}.metric:first-child{padding-left:0;border-left:0}.metric-value{display:block;font-size:1.12rem;font-weight:600;font-variant-numeric:tabular-nums}.metric-label{color:var(--muted);font-size:.84rem}.outcome{display:inline-flex;align-items:center;border:1px solid #cdd5dc;border-radius:3px;padding:1px 7px;font-size:.82rem;font-weight:600;line-height:1.35;white-space:nowrap}.outcome.completed{color:#205d30;background:#f1f8f2;border-color:#b9d8c0}.outcome.failed{color:#8b1d27;background:#fcf1f2;border-color:#e7bdc1}.outcome.skipped,.outcome.unknown{color:#46515a;background:#f5f6f7}.outcome.pending{color:#795000;background:#fff8e8;border-color:#ead39e}.actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}button{border:1px solid #006fbf;border-radius:4px;padding:6px 11px;background:var(--accent);color:white;font:inherit;font-weight:600;cursor:pointer}button.secondary{background:white;color:var(--accent)}button:hover{filter:brightness(.94)}button:focus-visible,a:focus-visible,summary:focus-visible{outline:3px solid #1f7fba;outline-offset:2px}.export-action{display:flex;align-items:center;gap:8px;min-width:0}#updated,#notice,#exportFeedback{color:var(--muted);font-size:.82rem}#exportFeedback{max-width:210px}.feedback.success{color:var(--ok)}.feedback.error{color:var(--bad)}#notice{min-height:1.35em;margin:6px 0 0}.history-header{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:8px}.history-table{width:100%}.history-row{display:grid;grid-template-columns:minmax(145px,1.5fr) minmax(76px,.7fr) minmax(86px,.8fr) repeat(3,minmax(78px,.65fr));gap:10px;align-items:center}.history-head{padding:5px 8px;border-bottom:1px solid #aeb8c1;color:var(--muted);font-size:.78rem;font-weight:600}.execution{border-bottom:1px solid var(--line)}.execution summary{list-style:none;cursor:pointer}.execution summary::-webkit-details-marker{display:none}.execution summary:focus-visible{outline-offset:-2px}.execution-summary{position:relative;padding:8px 8px 8px 20px}.execution-summary:before{content:"›";position:absolute;left:5px;top:50%;transform:translateY(-50%);color:var(--muted);font-size:1.2rem;line-height:1}.execution[open] .execution-summary:before{content:"⌄"}.execution summary span{min-width:0;overflow-wrap:anywhere}.numeric{text-align:right;font-variant-numeric:tabular-nums}.execution .numeric{font-weight:500}.execution[open]{background:#fbfcfd}.detail-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px 14px;padding:3px 12px 12px 25px}.empty{color:var(--muted);margin:0}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}[hidden]{display:none!important}
@media(max-width:620px){main{margin:12px auto;padding:0 12px}section{padding:12px}.latest{gap:7px 12px}.metrics{margin-top:8px;padding-top:7px}.metric{padding:0 8px}.metric-value{font-size:1rem}.metric-label{font-size:.78rem}.history-head{display:none}.history-row{grid-template-columns:minmax(0,1fr) auto;gap:4px 10px}.execution-summary{padding:9px 4px}.execution-summary .date{grid-column:1}.execution-summary .source{grid-column:2;grid-row:1;text-align:right}.execution-summary .outcome-cell{grid-column:1/-1}.execution-summary .numeric{display:flex;justify-content:space-between;gap:10px;text-align:right}.execution-summary .numeric::before{content:attr(data-label);color:var(--muted);font-size:.78rem;font-weight:400;text-align:left}.detail-grid{grid-template-columns:1fr 1fr;gap:8px 12px;padding:4px 8px 11px}.history-header{align-items:flex-start;flex-direction:column}.export-action{flex-wrap:wrap}#exportFeedback{max-width:none}}
</style></head><body><main><header><h1>Section Association Fix</h1><div class="actions"><button id="refresh" type="button">Refresh</button><div class="export-action"><button id="export" class="secondary" type="button">Download CSV</button><span id="exportFeedback" role="status" aria-live="polite"></span></div></div></header>
<section aria-labelledby="service-heading"><h2 id="service-heading">Service status</h2><div class="status-list"><div><span class="label">Availability</span><span id="availability" class="state unknown" role="status">Loading</span></div><div><span class="label">Current worker state</span><span id="worker" class="state unknown" role="status">Loading</span></div></div>
<div id="latest" hidden><div class="latest"><div><span class="label">Last execution</span><span id="latestDate" class="value">—</span></div><div><span class="label">Outcome</span><span id="outcome" class="outcome" role="status" aria-label="Execution outcome">—</span></div><div><span class="label">Source</span><span id="source" class="value">—</span></div></div><div id="latestMetrics" class="metrics"><div class="metric"><span id="checked" class="metric-value">—</span><span class="metric-label">Associations checked</span></div><div class="metric"><span id="corrections" class="metric-value">—</span><span class="metric-label">Corrections applied</span></div><div class="metric"><span id="errors" class="metric-value">—</span><span class="metric-label">Errors</span></div></div><p id="zeroWork" class="empty" role="status" hidden>No associations needed processing.</p></div><p id="emptyLatest" class="empty" hidden>No maintenance execution recorded yet.</p></section>
<section aria-labelledby="history-heading"><div class="history-header"><h2 id="history-heading">Execution history</h2><span id="updated" aria-live="polite">Not updated yet</span></div><div role="table" aria-label="Recent maintenance executions" class="history-table"><div role="rowgroup"><div role="row" class="history-row history-head"><span role="columnheader">Date and time</span><span role="columnheader">Source</span><span role="columnheader">Outcome</span><span role="columnheader" class="numeric">Checked</span><span role="columnheader" class="numeric">Corrections</span><span role="columnheader" class="numeric">Errors</span></div></div><p id="historyEmpty" class="empty" hidden>No executions recorded yet.</p><div id="history" role="rowgroup"></div></div></section><p id="notice" role="status" aria-live="polite"></p>
</main><script>
const ltiToken=__LTI_TOKEN__;
function set(id,value){document.getElementById(id).textContent=value}
function statusText(value){if(typeof value!=='string'||!value.trim())return 'Unknown';return value.trim().replace(/(^|[-_\\s])\\w/g,letter=>letter.toUpperCase()).replace(/-/g,' ')}
function renderState(id,value,availability=false){const node=document.getElementById(id),label=statusText(value),state=label.toLowerCase();node.textContent=label;node.className='state '+(availability?(state==='available'?'available':'unavailable'):['running','idle','error'].includes(state)?state:'unknown')}
function formatDate(value){if(!value)return '—';const date=new Date(value);return Number.isNaN(date.getTime())?'—':new Intl.DateTimeFormat(undefined,{dateStyle:'medium',timeStyle:'short'}).format(date)}
const numberFormat=new Intl.NumberFormat(undefined,{maximumFractionDigits:0});
function count(value){return Number.isSafeInteger(value)&&value>=0?numberFormat.format(value):'—'}
function outcomeClass(value){return ['completed','failed','skipped','pending'].includes(String(value).toLowerCase())?String(value).toLowerCase():'unknown'}
function showOutcome(id,value){const node=document.getElementById(id),label=statusText(value);node.textContent=label;node.className='outcome '+outcomeClass(value);node.setAttribute('aria-label','Outcome: '+label)}
function exportMessage(value,type=''){const node=document.getElementById('exportFeedback');node.textContent=value;node.className='feedback '+type}
function duration(start,end){const a=new Date(start).getTime(),b=new Date(end).getTime();if(!Number.isFinite(a)||!Number.isFinite(b)||b<a)return '—';const seconds=Math.floor((b-a)/1000);return seconds<60?seconds+' seconds':Math.floor(seconds/60)+' min'+(seconds%60?' '+seconds%60+' sec':'')}
function safe(value){return String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function sourceName(value){return value==='manual'?'Manual':value==='automatic'?'Automatic':'Unknown'}
function executionHtml(run){const label=safe(statusText(run.status));return '<details class="execution"><summary class="history-row execution-summary"><span class="date">'+safe(formatDate(run.startedAt))+'</span><span class="source">'+sourceName(run.source)+'</span><span class="outcome-cell"><span class="outcome '+outcomeClass(run.status)+'" aria-label="Outcome: '+label+'">'+label+'</span></span><span class="numeric" data-label="Checked">'+safe(count(run.associationsChecked))+'</span><span class="numeric" data-label="Corrections">'+safe(count(run.correctionsApplied))+'</span><span class="numeric" data-label="Errors">'+safe(count(run.errors))+'</span></summary><div class="detail-grid"><div><span class="label">Duration</span>'+safe(duration(run.startedAt,run.completedAt))+'</div><div><span class="label">Already compliant associations</span>'+safe(count(run.alreadyCompliant))+'</div><div><span class="label">Start time</span>'+safe(formatDate(run.startedAt))+'</div><div><span class="label">Finish time</span>'+safe(formatDate(run.completedAt))+'</div></div></details>'}
async function refresh(){set('notice','Refreshing…');try{const response=await fetch('/api/section-association/status',{credentials:'same-origin',headers:{Accept:'application/json',Authorization:'Bearer '+ltiToken}});if(!response.ok){if(response.status===401)set('notice','LTI session expired. Relaunch this tool from Brightspace.');else if(response.status===403)set('notice','This LTI deployment is not authorized.');else if(response.status>=500)set('notice','Status service temporarily unavailable. Retry shortly.');else set('notice','Status request failed (HTTP '+response.status+').');renderState('availability','Unavailable',true);renderState('worker','Unavailable');return}const data=await response.json();renderState('availability',data.availability,true);renderState('worker',data.worker);const latest=data.latestExecution;document.getElementById('latest').hidden=!latest;document.getElementById('emptyLatest').hidden=!!latest;if(latest){set('latestDate',formatDate(latest.startedAt));showOutcome('outcome',latest.status);set('source',sourceName(latest.source));set('checked',count(latest.associationsChecked));set('corrections',count(latest.correctionsApplied));set('errors',count(latest.errors));const noWork=latest.status==='completed'&&latest.associationsChecked===0&&latest.errors===0;document.getElementById('latestMetrics').hidden=noWork;document.getElementById('zeroWork').hidden=!noWork}const runs=Array.isArray(data.executions)?data.executions.slice(0,50):[];document.getElementById('historyEmpty').hidden=runs.length>0;document.getElementById('history').innerHTML=runs.map(executionHtml).join('');set('updated','Last refreshed '+new Intl.DateTimeFormat(undefined,{hour:'numeric',minute:'2-digit'}).format(new Date()));set('notice','')}catch{set('notice','Could not reach the status service. Check your connection and retry.');renderState('availability','Unavailable',true);renderState('worker','Unavailable')}}
async function exportCsv(){exportMessage('Preparing CSV…');try{const response=await fetch('/api/section-association/executions.csv',{credentials:'same-origin',headers:{Accept:'text/csv',Authorization:'Bearer '+ltiToken}});if(!response.ok){exportMessage(response.status===401?'Session expired. Relaunch Brightspace.':response.status===403?'Deployment not authorized.':'CSV export failed. Retry.','error');return}const blob=await response.blob(),url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=response.headers.get('Content-Disposition')?.match(/filename="?([^";]+)"?/i)?.[1]||'section-association-executions.csv';link.click();URL.revokeObjectURL(url);exportMessage('CSV downloaded.','success')}catch{exportMessage('Could not download CSV. Retry.','error')}}
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
