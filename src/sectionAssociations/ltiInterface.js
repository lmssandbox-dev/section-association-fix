'use strict';

const { once } = require('node:events');
const { deploymentGuard } = require('../shared/deploymentGuard');

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Section Association Fix</title><style>
:root{color-scheme:light;--ink:#202a35;--muted:#5c6670;--line:#d6dce1;--surface:#fff;--page:#f5f6f7;--accent:#006fbf;--ok:#287d3c;--bad:#b21f2d}
*{box-sizing:border-box}body{margin:0;background:var(--page);color:var(--ink);font:15px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}main{max-width:900px;margin:20px auto;padding:0 20px}header{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:12px}h1{font-size:1.4rem;line-height:1.25;font-weight:600;margin:0}h2{font-size:1rem;line-height:1.35;font-weight:600;margin:0}section{background:var(--surface);border:1px solid var(--line);border-radius:4px;padding:14px 16px;margin:10px 0}.status-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px 20px}.label{display:block;color:var(--muted);font-size:.84rem}.state{display:inline-flex;align-items:center;gap:7px;font-weight:600}.state:before{content:"";width:8px;height:8px;border-radius:50%;background:#68737d}.state.available:before,.state.idle:before{background:var(--ok)}.state.running:before{background:var(--accent)}.state.error:before,.state.unavailable:before{background:var(--bad)}.latest{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px 18px;margin-top:10px;padding-top:9px;border-top:1px solid var(--line)}.value{overflow-wrap:anywhere}.metrics{display:flex;align-items:stretch;margin-top:10px;border-top:1px solid var(--line);padding-top:8px}.metric{flex:1;min-width:0;padding:0 12px;border-left:1px solid var(--line)}.metric:first-child{padding-left:0;border-left:0}.metric-value{display:block;font-size:1.12rem;font-weight:600;font-variant-numeric:tabular-nums}.metric-label{color:var(--muted);font-size:.84rem}.outcome{display:inline-flex;align-items:center;border:1px solid #cdd5dc;border-radius:3px;padding:1px 7px;font-size:.82rem;font-weight:600;line-height:1.35;white-space:nowrap}.outcome.completed{color:#205d30;background:#f1f8f2;border-color:#b9d8c0}.outcome.failed{color:#8b1d27;background:#fcf1f2;border-color:#e7bdc1}.outcome.skipped,.outcome.unknown{color:#46515a;background:#f5f6f7}.outcome.pending{color:#795000;background:#fff8e8;border-color:#ead39e}.actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}button{border:1px solid #006fbf;border-radius:4px;padding:6px 11px;background:var(--accent);color:white;font:inherit;font-weight:600;cursor:pointer}button.secondary{background:white;color:var(--accent)}button:hover{filter:brightness(.94)}button:focus-visible,a:focus-visible,summary:focus-visible{outline:3px solid #1f7fba;outline-offset:2px}.export-action{display:flex;align-items:center;gap:8px;min-width:0}#updated,#notice,#exportFeedback{color:var(--muted);font-size:.82rem}#exportFeedback{max-width:210px}.feedback.success{color:var(--ok)}.feedback.error{color:var(--bad)}#notice{min-height:1.35em;margin:6px 0 0}.history-header{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:8px}.history-table{width:100%}.history-row{display:grid;grid-template-columns:minmax(145px,1.5fr) minmax(76px,.7fr) minmax(86px,.8fr) repeat(3,minmax(78px,.65fr));gap:10px;align-items:center}.history-head{padding:5px 8px;border-bottom:1px solid #aeb8c1;color:var(--muted);font-size:.78rem;font-weight:600}.execution{border-bottom:1px solid var(--line)}.execution summary{list-style:none;cursor:pointer}.execution summary::-webkit-details-marker{display:none}.execution summary:focus-visible{outline-offset:-2px}.execution-summary{position:relative;padding:8px 8px 8px 20px}.execution-summary:before{content:"";position:absolute;left:6px;top:50%;width:8px;height:8px;border-right:2px solid currentColor;border-bottom:2px solid currentColor;transform:translateY(-50%) rotate(-45deg);transform-origin:center;color:var(--muted);transition:transform .16s ease}.execution[open] .execution-summary:before{transform:translateY(-50%) rotate(45deg)}.execution summary span{min-width:0;overflow-wrap:anywhere}.numeric{text-align:right;font-variant-numeric:tabular-nums}.execution .numeric{font-weight:500}.execution[open]{background:#fbfcfd}.detail-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px 14px;padding:3px 12px 12px 25px}.empty{color:var(--muted);margin:0}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}[hidden]{display:none!important}
@media(max-width:620px){main{margin:12px auto;padding:0 12px}section{padding:12px}.latest{gap:7px 12px}.metrics{margin-top:8px;padding-top:7px}.metric{padding:0 8px}.metric-value{font-size:1rem}.metric-label{font-size:.78rem}.history-head{display:none}.history-row{grid-template-columns:minmax(0,1fr) auto;gap:4px 10px}.execution-summary{padding:9px 4px}.execution-summary .date{grid-column:1}.execution-summary .source{grid-column:2;grid-row:1;text-align:right}.execution-summary .outcome-cell{grid-column:1/-1}.execution-summary .numeric{display:flex;justify-content:space-between;gap:10px;text-align:right}.execution-summary .numeric::before{content:attr(data-label);color:var(--muted);font-size:.78rem;font-weight:400;text-align:left}.detail-grid{grid-template-columns:1fr 1fr;gap:8px 12px;padding:4px 8px 11px}.history-header{align-items:flex-start;flex-direction:column}.export-action{flex-wrap:wrap}#exportFeedback{max-width:none}}
/* Compact, Brightspace-like history and report controls. */
main{margin-top:16px}section{padding:12px 15px}.history-head{font-size:.76rem;padding:4px 8px}.execution{border-bottom-color:#e3e7ea}.execution-summary{padding-top:7px;padding-bottom:7px}.outcome.completed{color:#46515a;background:#f5f6f7;border-color:#e4e8eb}.execution.quiet-work{background:#fcfcfc}.detail-grid{gap:6px 12px;padding-top:2px;padding-bottom:8px}.report-entry{position:relative;display:flex;align-items:center;gap:10px;padding:0 12px 9px 25px}.reports-menu{position:relative}.reports-menu>summary{list-style:none;cursor:pointer;display:inline-flex;align-items:center;gap:8px;border:1px solid #aeb8c1;border-radius:3px;background:#fff;padding:4px 9px;font-size:.86rem;font-weight:600}.reports-menu>summary::-webkit-details-marker{display:none}.reports-menu>summary:after{content:"⌄";color:var(--muted)}.reports-options{position:absolute;right:0;top:calc(100% + 4px);z-index:5;display:grid;min-width:190px;gap:2px;padding:5px;background:#fff;border:1px solid var(--line);border-radius:4px;box-shadow:0 3px 9px #202a3526}.reports-options button{width:100%;text-align:left;background:transparent;border:0;border-radius:2px;color:var(--ink);padding:7px 9px;font-size:.88rem;font-weight:500}.reports-options button:hover,.reports-options button:focus-visible{background:#eef6fb;filter:none}.report-feedback,.audit-unavailable{color:var(--muted);font-size:.8rem}.report-feedback.error{color:var(--bad)}.audit-unavailable{padding:0 12px 9px 25px}#exportFeedback{font-size:.8rem}.feedback.error{color:var(--bad)}
@media(max-width:620px){main{margin:11px auto;padding:0 12px}section{padding:11px}.history-header{align-items:flex-start;flex-direction:column}.detail-grid{gap:5px 10px;padding:3px 7px 7px}.report-entry{padding:0 7px 8px}.reports-options{right:auto;left:0;min-width:min(190px,calc(100vw - 48px))}.audit-unavailable{padding:0 7px 8px}}
.detail-strip{display:flex;align-items:center;gap:10px;min-height:36px;margin:0 8px 8px 25px;padding:7px 10px;background:#f7f8f9;border-radius:3px;font-size:.82rem;line-height:1.4}.execution-info{min-width:0;overflow-wrap:anywhere}.report-entry{margin-left:auto;padding:0;flex:0 0 auto}.audit-unavailable{margin-left:auto;padding:0;color:var(--muted);font-size:.78rem}.report-feedback{max-width:230px}
@media(max-width:620px){.detail-strip{flex-wrap:wrap;gap:7px 10px;margin:0 7px 8px;padding:7px 9px}.report-entry{margin-left:auto}.audit-unavailable{margin-left:0}}
.status-list{grid-template-columns:repeat(3,minmax(0,1fr));gap:8px 18px}.status-list .label{margin-bottom:2px}.periods{display:flex;flex-wrap:wrap;gap:5px}.period-chip{display:inline-flex;align-items:center;gap:5px;padding:1px 7px;border:1px solid #e3e7ea;border-radius:10px;background:#fafbfc;color:var(--muted);font-size:.78rem}.period-chip strong{color:var(--ink);font-weight:600;font-variant-numeric:tabular-nums}.latest{display:flex;align-items:baseline;gap:8px 12px;margin-top:11px;padding:2px 0 0;border:0}.latest .label{display:inline;color:var(--muted);font-size:.84rem}.latest-message{min-width:0;overflow-wrap:anywhere}.latest-message:empty{display:none}.scope{overflow-wrap:anywhere;white-space:nowrap}.history-head{padding-top:5px;padding-bottom:5px}.execution-summary{padding-top:7px;padding-bottom:7px}.outcome.completed{color:#46515a;background:#f5f6f7;border-color:#e4e8eb}.actions button{padding:5px 9px;font-size:.9rem}section{padding:14px 16px;margin:12px 0}
@media(max-width:620px){.status-list{grid-template-columns:repeat(2,minmax(0,1fr))}.latest{align-items:flex-start;gap:4px 8px}.latest-message{flex-basis:100%}.scope{white-space:normal}section{padding:12px 13px;margin:10px 0}}
/* Final spacing and alignment pass. */
section{padding:16px 18px;margin:14px 0}h2{font-size:1.05rem;font-weight:650;letter-spacing:-.01em}section>h2{margin-bottom:12px}.status-list{gap:11px 22px}.status-list .label{margin-bottom:4px}.latest{margin-top:14px;padding-top:12px;gap:9px 14px}.history-header{margin-bottom:12px}.history-row{grid-template-columns:minmax(145px,1.45fr) minmax(92px,.85fr) minmax(112px,.9fr) repeat(3,minmax(78px,.65fr));gap:12px}.history-head{padding:7px 8px}.history-head> :nth-child(3){text-align:center}.execution-summary{padding-top:9px;padding-bottom:9px}.execution-summary .outcome-cell{display:flex;justify-content:center}.detail-strip{gap:14px;min-height:40px;padding:8px 12px}.execution-info{flex:1}.reports-menu>summary{padding:5px 10px}.actions{gap:10px}.actions button{padding:6px 11px}
@media(max-width:620px){section{padding:14px 14px;margin:12px 0}.status-list{gap:10px 16px}.latest{margin-top:12px;padding-top:10px}.history-header{margin-bottom:10px}.history-row{grid-template-columns:minmax(0,1fr) auto;gap:6px 12px}.history-head{padding:7px 8px}.execution-summary{padding:10px 4px}.execution-summary .outcome-cell{justify-content:flex-start}.detail-strip{gap:8px 12px;padding:9px 10px}.execution-info{flex-basis:100%}.actions{gap:8px}.actions button{padding:6px 10px}}
.date-filters{display:flex;align-items:end;flex-wrap:wrap;gap:8px;margin:0 0 10px}.date-filters label{display:grid;gap:2px;color:var(--muted);font-size:.8rem}.date-filters input{min-height:34px;border:1px solid #aeb8c1;border-radius:3px;padding:4px 7px;color:var(--ink);font:inherit}.date-filters button{padding:5px 9px;font-size:.86rem}.date-filters #filterError{color:var(--bad);font-size:.8rem}.pagination{display:flex;align-items:center;justify-content:center;gap:12px;padding-top:12px}.pagination button:disabled{opacity:.5;cursor:default}
.execution-summary:before{left:5px;width:7px;height:7px;border-width:1.75px;transition:none}.execution-summary{padding-left:22px}.execution[open] .execution-summary:before{transform:translateY(-50%) rotate(45deg)}
.reports-menu>summary:after{content:"";width:7px;height:7px;border-right:1.75px solid currentColor;border-bottom:1.75px solid currentColor;transform:rotate(-45deg);transform-origin:center;color:var(--muted);transition:none}.reports-menu[open]>summary:after{transform:rotate(45deg)}
@media(max-width:620px){.execution-summary{padding-left:22px}}
</style></head><body><main><header><h1>Section Association Fix</h1><div class="actions"><button id="refresh" type="button">Refresh</button><div class="export-action"><button id="export" class="secondary" type="button">Export History CSV</button><span id="exportFeedback" role="status" aria-live="polite"></span></div></div></header>
<section aria-labelledby="service-heading"><h2 id="service-heading">Service status</h2><div class="status-list"><div><span class="label">Availability</span><span id="availability" class="state unknown" role="status">Loading</span></div><div><span class="label">Current worker state</span><span id="worker" class="state unknown" role="status">Loading</span></div><div><span class="label">Discovery periods</span><span id="discoveryScope" class="periods">—</span></div></div>
<div id="latest" class="latest" hidden><span class="label">Last execution</span><span id="latestDate" class="value">—</span><span id="outcome" class="outcome" role="status" aria-label="Execution outcome">—</span><span id="latestMessage" class="latest-message">—</span></div><p id="emptyLatest" class="empty" hidden>No maintenance execution recorded yet.</p></section>
<section aria-labelledby="history-heading"><div class="history-header"><h2 id="history-heading">Execution history</h2><span id="updated" aria-live="polite">Not updated yet</span></div><form id="dateFilters" class="date-filters"><label>From <input id="fromDate" type="date"></label><label>To <input id="toDate" type="date"></label><button type="submit" class="secondary">Apply</button><button id="clearFilters" type="button" class="secondary">Clear</button><span id="filterError" role="status" aria-live="polite"></span></form><div role="table" aria-label="Maintenance executions" class="history-table"><div role="rowgroup"><div role="row" class="history-row history-head"><span role="columnheader">Date and time</span><span role="columnheader">Periods / Scope</span><span role="columnheader">Outcome</span><span role="columnheader" class="numeric">Checked</span><span role="columnheader" class="numeric">Corrections</span><span role="columnheader" class="numeric">Errors</span></div></div><p id="historyEmpty" class="empty" hidden>No executions recorded yet.</p><div id="history" role="rowgroup"></div></div><nav class="pagination" aria-label="Execution history pages"><button id="previousPage" class="secondary" type="button">Previous</button><span id="pageNumber" aria-live="polite">Page 1</span><button id="nextPage" class="secondary" type="button">Next</button></nav></section><p id="notice" role="status" aria-live="polite"></p>
</main><script>
const ltiToken=__LTI_TOKEN__;
function set(id,value){document.getElementById(id).textContent=value}
function statusText(value){if(typeof value!=='string'||!value.trim())return 'Unknown';return value.trim().replace(/(^|[-_\\s])\\w/g,letter=>letter.toUpperCase()).replace(/-/g,' ')}
function renderState(id,value,availability=false){const node=document.getElementById(id),label=statusText(value),state=label.toLowerCase();node.textContent=label;node.className='state '+(availability?(state==='available'?'available':'unavailable'):['running','idle','error'].includes(state)?state:'unknown')}
function formatDate(value){if(!value)return '—';const date=new Date(value);return Number.isNaN(date.getTime())?'—':new Intl.DateTimeFormat(undefined,{dateStyle:'medium',timeStyle:'short'}).format(date)}
function formatShortDate(value){if(!value)return '—';const date=new Date(value);return Number.isNaN(date.getTime())?'—':new Intl.DateTimeFormat(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}).format(date)}
const numberFormat=new Intl.NumberFormat(undefined,{maximumFractionDigits:0});
function count(value){return Number.isSafeInteger(value)&&value>=0?numberFormat.format(value):'—'}
function outcomeClass(value){return ['failed','skipped','pending'].includes(String(value).toLowerCase())?String(value).toLowerCase():String(value).toLowerCase()==='completed'?'completed':'unknown'}
function showOutcome(id,value){const node=document.getElementById(id),label=statusText(value);node.textContent=label;node.className='outcome '+outcomeClass(value);node.setAttribute('aria-label','Outcome: '+label)}
let exportFeedbackTimer;let currentPage=1;let hasMore=false;
function exportMessage(value,type='',node=document.getElementById('exportFeedback')){node.textContent=value;node.className='feedback '+type;if(exportFeedbackTimer)clearTimeout(exportFeedbackTimer);if(type==='success')exportFeedbackTimer=setTimeout(()=>{node.textContent='';node.className='feedback'},1800)}
function duration(start,end){const a=new Date(start).getTime(),b=new Date(end).getTime();if(!Number.isFinite(a)||!Number.isFinite(b)||b<a)return '—';const seconds=Math.floor((b-a)/1000);return seconds<60?seconds+' seconds':Math.floor(seconds/60)+' min'+(seconds%60?' '+seconds%60+' sec':'')}
function compactDuration(start,end){const a=new Date(start).getTime(),b=new Date(end).getTime();if(!Number.isFinite(a)||!Number.isFinite(b)||b<a)return '';const seconds=Math.floor((b-a)/1000);return seconds<60?seconds+' sec':Math.floor(seconds/60)+' min'+(seconds%60?' '+seconds%60+' sec':'')}
function safe(value){return String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function discoveryActivityNames(run){const activities=run.discoveryActivities||{},names=[];if(activities.periods===true||activities.currentPrevious===true)names.push('Periods');if(activities.historical===true)names.push('Historical');if(activities.reverification===true)names.push('Re-verification');return names}
function discoveryScope(run){const names=discoveryActivityNames(run),periods=run.discoveryPeriods,mode=periods?.mode;let labels=[];if(mode==='all')labels=['All periods'];else if(Array.isArray(periods?.periods)&&periods.periods.every(period=>/^\\d{2}0[12]$/.test(period)))labels=periods.periods;else if(/^\\d{4}$/.test(periods?.current||'')&&/^\\d{4}$/.test(periods?.previous||''))labels=[periods.current,periods.previous];if(labels.length){const otherActivities=names.filter(name=>name!=='Periods'&&!(mode==='all'&&name==='Historical'));return [...labels,...(otherActivities.length?['Mixed']:[])].join(' · ')}if(!names.length)return '—';return names.length>1?'Mixed':names[0]}
function renderDiscoveryPeriods(scope){const node=document.getElementById('discoveryScope');if(!scope){node.textContent='—';return}if(scope.mode==='all'){node.textContent='All periods';return}const entries=scope.mode==='auto'?[['Previous',scope.previous],['Current',scope.current],['Next',scope.next]]:Array.isArray(scope.periods)?scope.periods.map(period=>['',period]):[];if(!entries.length||entries.some(([,period])=>!/^\\d{2}0[12]$/.test(period||''))){node.textContent='—';return}node.innerHTML=entries.map(([label,period])=>'<span class="period-chip"'+(label?' title="'+label+' academic period"':'')+'>'+(label?label+' ':'')+'<strong>'+period+'</strong></span>').join(' ')}
function latestMessage(run){if(run.status==='completed'&&run.associationsChecked===0&&run.errors===0)return '';const explanation=[run.error,run.failureReason,run.lastError].find(value=>typeof value==='string'&&value.trim());if(run.status!=='completed'&&explanation)return explanation.trim().replace(/\\s+/g,' ').slice(0,180);return 'Checked: '+count(run.associationsChecked)+' · Corrections: '+count(run.correctionsApplied)+' · Errors: '+count(run.errors)}
function executionHtml(run){
  const label=safe(statusText(run.status)),quiet=run.status==='completed'&&run.associationsChecked===0&&run.errors===0;
  const durationValue=compactDuration(run.startedAt,run.completedAt),parts=[];
  if(quiet){parts.push('No work required');if(durationValue)parts.push(durationValue)}
  else{
    if(run.status==='completed'&&Number.isSafeInteger(run.alreadyCompliant)&&run.alreadyCompliant>=0)parts.push('Already compliant: '+count(run.alreadyCompliant));
    if(durationValue)parts.push(durationValue);
    const explanation=[run.error,run.failureReason,run.lastError].find(value=>typeof value==='string'&&value.trim());
    if(run.status!=='completed'&&explanation)parts.push(explanation.trim().replace(/ +/g,' ').slice(0,180));
  }
  const info=parts.map(safe).join(' · ');
  const reports=run.detailedAuditAvailable===true?'<div class="report-entry"><details class="reports-menu"><summary aria-label="Reports for this execution">Reports</summary><div class="reports-options" role="group" aria-label="Execution reports"><button type="button" data-audit="corrections" data-execution="'+safe(run.executionId||'')+'">Corrections CSV</button><button type="button" data-audit="exceptions" data-execution="'+safe(run.executionId||'')+'">Exceptions CSV</button></div></details><span class="report-feedback" role="status" aria-live="polite"></span></div>':'<span class="audit-unavailable">Detailed reports unavailable.</span>';
  return '<details class="execution'+(quiet?' quiet-work':'')+'"><summary class="history-row execution-summary"><span class="date">'+safe(formatShortDate(run.startedAt))+'</span><span class="scope">'+safe(discoveryScope(run))+'</span><span class="outcome-cell"><span class="outcome '+outcomeClass(run.status)+'" aria-label="Outcome: '+label+'">'+label+'</span></span><span class="numeric" data-label="Checked">'+safe(count(run.associationsChecked))+'</span><span class="numeric" data-label="Corrections">'+safe(count(run.correctionsApplied))+'</span><span class="numeric" data-label="Errors">'+safe(count(run.errors))+'</span></summary><div class="detail-strip"><span class="execution-info">'+info+'</span>'+reports+'</div></details>'
}
async function refresh(){
  set('notice','Refreshing…');
  try{
    const query=new URLSearchParams({page:String(currentPage)});if(document.getElementById('fromDate').value)query.set('from',document.getElementById('fromDate').value);if(document.getElementById('toDate').value)query.set('to',document.getElementById('toDate').value);
    const response=await fetch('/api/section-association/status?'+query.toString(),{credentials:'same-origin',headers:{Accept:'application/json',Authorization:'Bearer '+ltiToken}});
    if(!response.ok){
      if(response.status===400){const problem=await response.json().catch(()=>({}));set('filterError',problem.error||'History filter is invalid.');}
      if(response.status===401)set('notice','LTI session expired. Relaunch this tool from Brightspace.');
      else if(response.status===403)set('notice','This LTI deployment is not authorized.');
      else if(response.status>=500)set('notice','Status service temporarily unavailable. Retry shortly.');
      else set('notice','Status request failed (HTTP '+response.status+').');
      renderState('availability','Unavailable',true);renderState('worker','Unavailable');
      renderDiscoveryPeriods(null);return;
    }
    const data=await response.json();
    renderState('availability',data.availability,true);renderState('worker',data.worker);
    renderDiscoveryPeriods(data.discoveryPeriods);
    const latest=data.latestExecution;
    document.getElementById('latest').hidden=!latest;document.getElementById('emptyLatest').hidden=!!latest;
    if(latest){set('latestDate',formatDate(latest.startedAt));showOutcome('outcome',latest.status);set('latestMessage',latestMessage(latest))}
    const runs=Array.isArray(data.executions)?data.executions:[];currentPage=data.history?.page||currentPage;hasMore=data.history?.hasMore===true;
    document.getElementById('historyEmpty').hidden=runs.length>0;document.getElementById('history').innerHTML=runs.map(executionHtml).join('');
    set('pageNumber','Page '+currentPage);document.getElementById('previousPage').disabled=currentPage<=1;document.getElementById('nextPage').disabled=!hasMore;
    set('updated','Last refreshed '+new Intl.DateTimeFormat(undefined,{hour:'numeric',minute:'2-digit'}).format(new Date()));set('notice','');
  }catch{
    set('notice','Could not reach the status service. Check your connection and retry.');
    renderState('availability','Unavailable',true);renderState('worker','Unavailable');renderDiscoveryPeriods(null);
  }
}
async function exportCsv(){exportMessage('Preparing CSV…');try{const response=await fetch('/api/section-association/executions.csv',{credentials:'same-origin',headers:{Accept:'text/csv',Authorization:'Bearer '+ltiToken}});if(!response.ok){exportMessage(response.status===401?'Session expired. Relaunch Brightspace.':response.status===403?'Deployment not authorized.':'CSV export failed. Retry.','error');return}const blob=await response.blob(),url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=response.headers.get('Content-Disposition')?.match(/filename="?([^";]+)"?/i)?.[1]||'section-association-executions.csv';link.click();URL.revokeObjectURL(url);exportMessage('CSV downloaded.','success')}catch{exportMessage('Could not download CSV. Retry.','error')}}
async function exportAudit(kind,executionId,feedback){const show=(message,type='')=>exportMessage(message,type,feedback);show('Preparing CSV…');try{const response=await fetch('/api/section-association/'+kind+'.csv?executionId='+encodeURIComponent(executionId),{credentials:'same-origin',headers:{Accept:'text/csv',Authorization:'Bearer '+ltiToken}});if(!response.ok){show(response.status===401?'Session expired. Relaunch Brightspace.':response.status===403?'Deployment not authorized.':'CSV export failed. Retry.','error');return}const blob=await response.blob(),url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=response.headers.get('Content-Disposition')?.match(/filename="?([^";]+)"?/i)?.[1]||'section-association-'+kind+'.csv';link.click();URL.revokeObjectURL(url);show('CSV downloaded.','success')}catch{show('Could not download CSV. Retry.','error')}}
document.getElementById('history').addEventListener('click',event=>{const button=event.target.closest('[data-audit]');if(!button)return;const menu=button.closest('.reports-menu'),entry=button.closest('.report-entry');menu.open=false;menu.querySelector('summary').focus();return exportAudit(button.dataset.audit,button.dataset.execution,entry.querySelector('.report-feedback'))});
document.addEventListener('click',event=>{if(event.target.closest('.reports-menu'))return;document.querySelectorAll('.reports-menu[open]').forEach(menu=>menu.open=false)});
document.addEventListener('keydown',event=>{if(event.key!=='Escape')return;const menu=document.querySelector('.reports-menu[open]');if(menu){menu.open=false;menu.querySelector('summary').focus();event.stopPropagation()}});
document.getElementById('dateFilters').addEventListener('submit',event=>{event.preventDefault();const from=document.getElementById('fromDate').value,to=document.getElementById('toDate').value;if(from&&to&&from>to){set('filterError','From date must be on or before To date.');return}set('filterError','');currentPage=1;return refresh()});document.getElementById('clearFilters').addEventListener('click',()=>{document.getElementById('fromDate').value='';document.getElementById('toDate').value='';set('filterError','');currentPage=1;return refresh()});document.getElementById('previousPage').addEventListener('click',()=>{if(currentPage>1){currentPage--;return refresh()}});document.getElementById('nextPage').addEventListener('click',()=>{if(hasMore){currentPage++;return refresh()}});document.getElementById('refresh').addEventListener('click',refresh);document.getElementById('export').addEventListener('click',exportCsv);refresh();
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
  ['Coverage', run => run.coverage?.type],
  ['Discovery period identifiers', run => {const periods=run.discoveryPeriods;if(periods?.mode==='all')return 'All periods';if(Array.isArray(periods?.periods))return periods.periods.join(' + ');return periods ? `${periods.current || ''} + ${periods.previous || ''}` : ''}],
  ['Discovery activities', run => Object.entries(run.discoveryActivities || {}).filter(([, performed]) => performed === true)
    .map(([activity]) => ({ periods: 'configured periods', currentPrevious: 'current + previous', historical: 'historical', reverification: 're-verification' }[activity] || activity)).join('; ')]
];

function csvCell(value) {
  if (value == null) return '""';
  const text = value instanceof Date ? value.toISOString() : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

const AUDIT_COLUMNS = {
  corrections: [['Execution ID','executionId'],['Execution source','source'],['Correction timestamp','timestamp'],['Parent Association Offering D2L ID','parentAssociationD2lId'],['Parent Association Offering Org Code','parentAssociationOrgCode'],['Parent Association Offering Name','parentAssociationName'],['Updated Course Offering D2L ID','affectedCourseOfferingD2lId'],['Updated Course Offering Org Code','affectedCourseOfferingOrgCode'],['Updated Course Offering Name','affectedCourseOfferingName'],['Previous isActive','previousIsActive'],['Verified isActive','verifiedIsActive'],['Result','result']],
  exceptions: [['Execution ID','executionId'],['Execution source','source'],['Timestamp','timestamp'],['Parent Association Offering D2L ID','parentAssociationD2lId'],['Parent Association Offering Org Code','parentAssociationOrgCode'],['Parent Association Offering Name','parentAssociationName'],['Affected Course Offering D2L ID','affectedCourseOfferingD2lId'],['Affected Course Offering Org Code','affectedCourseOfferingOrgCode'],['Affected Course Offering Name','affectedCourseOfferingName'],['Exception category','category'],['Explanation','explanation'],['Final outcome','finalOutcome']]
};
function auditCsvCell(value) {
  if (value == null) return '""';
  let text = value instanceof Date ? value.toISOString() : String(value);
  if (/^[\s\u0000-\u001f]*[=+@-]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function registerSectionAssociationLtiInterface(provider, { deploymentId, getStatus, getExecutionHistory, getExecutionAudit, getAuditAvailability }) {
  const authorize = deploymentGuard(deploymentId);
  provider.app.get('/api/section-association/status', async (req, res) => {
    if (!authorize(res.locals?.token, req, res)) return;
    try {
      const parsed = parseHistoryQuery(req.query || {});
      if (parsed.error) return res.status(400).json({ error: parsed.error });
      res.set('Cache-Control', 'no-store').json(await getStatus(parsed));
    }
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
  for (const kind of ['corrections', 'exceptions']) provider.app.get(`/api/section-association/${kind}.csv`, async (req, res) => {
    if (!authorize(res.locals?.token, req, res)) return;
    const executionId = String(req.query?.executionId || '');
    if (!/^[a-f0-9-]{36}$/i.test(executionId) || typeof getExecutionAudit !== 'function') return res.status(400).send('A valid execution ID is required.');
    try { if (typeof getAuditAvailability !== 'function' || !await getAuditAvailability(executionId)) return res.status(404).send('Detailed audit reporting was not recorded for this execution.'); }
    catch { return res.status(503).send('Audit report is temporarily unavailable.'); }
    res.set('Cache-Control', 'no-store').set('Content-Type', 'text/csv; charset=utf-8')
      .set('Content-Disposition', `attachment; filename="section-association-${kind}-${executionId}.csv"`);
    const columns = AUDIT_COLUMNS[kind];
    try {
      res.write(columns.map(([name]) => auditCsvCell(name)).join(',') + '\r\n');
      for await (const row of getExecutionAudit(executionId, kind.slice(0, -1))) {
        const line = columns.map(([, field]) => auditCsvCell(row[field])).join(',') + '\r\n';
        if (!res.write(line)) await once(res, 'drain');
      }
      res.end();
    } catch { if (res.headersSent) res.destroy?.(); else res.status(503).send('Audit report is temporarily unavailable.'); }
  });
  provider.onConnect((token, req, res) => {
    if (!authorize(token, req, res)) return;
    const ltik = res.locals?.ltik;
    if (typeof ltik !== 'string' || !ltik) return res.status(401).send('LTI launch token unavailable. Relaunch this tool from Brightspace.');
    res.set('Cache-Control', 'no-store').type('html').send(pageForLaunch(ltik));
  });
}

function parseHistoryQuery(query) {
  const pageRaw = query.page === undefined ? '1' : query.page;
  if (typeof pageRaw !== 'string' || !/^[1-9]\d*$/.test(pageRaw) || !Number.isSafeInteger(Number(pageRaw)) || Number(pageRaw) > Math.floor(Number.MAX_SAFE_INTEGER / 50)) return { error: 'Page must be a positive integer.' };
  const from = query.from === undefined || query.from === '' ? null : query.from;
  const to = query.to === undefined || query.to === '' ? null : query.to;
  const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0,10) === value;
  if ((from && !validDate(from)) || (to && !validDate(to))) return { error: 'Dates must be valid calendar dates.' };
  if (from && to && from > to) return { error: 'From date must be on or before To date.' };
  return { page: Number(pageRaw), from: from ? saoPauloMidnight(from) : null,
    to: to ? saoPauloMidnight(nextDate(to)) : null };
}
function nextDate(value) { const date = new Date(`${value}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + 1); return date.toISOString().slice(0,10); }
function saoPauloMidnight(dateText) {
  const target = Date.parse(`${dateText}T00:00:00Z`);
  let instant = target;
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hourCycle:'h23' });
  for (let i=0;i<3;i++) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(instant)).map(part=>[part.type,part.value]));
    const represented = Date.UTC(Number(parts.year), Number(parts.month)-1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
    instant += target - represented;
  }
  return new Date(instant);
}

module.exports = { registerSectionAssociationLtiInterface, pageForLaunch, CSV_COLUMNS, csvCell, AUDIT_COLUMNS, auditCsvCell };
