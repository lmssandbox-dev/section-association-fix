'use strict';

const { deploymentGuard } = require('../shared/deploymentGuard');

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Section Association Fix</title><style>
:root{color-scheme:light;--ink:#202a35;--muted:#5d6975;--line:#dce2e8;--surface:#fff;--accent:#075985}
*{box-sizing:border-box}body{margin:0;background:#f5f7f9;color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:760px;margin:32px auto;padding:0 18px}h1{font-size:1.45rem;margin:0 0 18px}h2{font-size:1rem;margin:0 0 12px}
section{background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:16px;margin:12px 0}
dl{display:grid;grid-template-columns:minmax(145px,1fr) 2fr;gap:7px 14px;margin:0}dt{color:var(--muted)}dd{margin:0;overflow-wrap:anywhere}
button{border:0;border-radius:5px;padding:9px 14px;background:var(--accent);color:#fff;font:inherit;cursor:pointer}button:focus-visible{outline:3px solid #7dd3fc;outline-offset:2px}
#notice{min-height:1.5em;color:var(--muted);margin:8px 0 0}.muted{color:var(--muted)}@media(max-width:520px){main{margin:18px auto}section{padding:13px}dl{grid-template-columns:1fr;gap:0}dd{margin:0 0 8px}}
</style></head><body><main><h1>Section Association Fix</h1>
<section><h2>Service status</h2><dl><dt>Availability</dt><dd id="availability">Loading</dd><dt>Worker</dt><dd id="worker">Loading</dd><dt>Latest execution</dt><dd id="latest">Loading</dd></dl></section>
<section><h2>Latest execution</h2><dl><dt>Associations checked</dt><dd id="checked">Unavailable</dd><dt>Already compliant</dt><dd id="compliant">Unavailable</dd><dt>Corrections applied</dt><dd id="corrections">Unavailable</dd><dt>Errors</dt><dd id="errors">Unavailable</dd><dt>Coverage</dt><dd id="coverage">Unavailable</dd><dt>CSV report</dt><dd>Unavailable</dd></dl></section>
<section><h2>Actions</h2><button id="refresh" type="button">Refresh</button><p id="notice" role="status" aria-live="polite"></p><p class="muted">Validation and corrective actions are not available in this interface.</p></section>
</main><script>
const ltiToken=__LTI_TOKEN__;
const fields=['availability','worker','latest','checked','compliant','corrections','errors','coverage'];
function set(id,value){document.getElementById(id).textContent=value}
function unavailable(message,worker='Unavailable'){set('availability','Unavailable');set('worker',worker);set('latest','Unavailable');for(const id of fields.slice(3))set(id,'Unavailable');set('notice',message)}
async function refresh(){set('notice','Refreshing…');try{const response=await fetch('/api/section-association/status',{credentials:'same-origin',headers:{Accept:'application/json',Authorization:'Bearer '+ltiToken}});if(!response.ok){if(response.status===401)unavailable('LTI session expired. Relaunch this tool from Brightspace.','Authentication required');else if(response.status===403)unavailable('This LTI deployment is not authorized.','Not authorized');else if(response.status>=500)unavailable('Status service temporarily unavailable. Retry shortly.','Unavailable');else unavailable('Status request failed (HTTP '+response.status+').');return}const data=await response.json();
set('availability',data.availability);set('worker',data.worker);set('latest',data.latestExecution?.summary||'Unavailable for this worker process');
const result=data.latestExecution?.result; if(result){set('checked',String(result.processedThisRun??'Unavailable'));set('compliant',String(result.alreadyInactive??'Unavailable'));set('corrections',String(result.writesVerified??'Unavailable'));set('errors',String(result.blocked??(result.status==='failed'?'Execution failed':'Unavailable')));set('coverage',result.status==='failed'?'Execution failed':(result.remainingHistoricalBacklog>0?'Partial: historical backlog remains':'Bounded cycle; full scan completion is not tracked'));}
else{for(const id of fields.slice(3))set(id,'Unavailable')};set('notice','Updated');
}catch{unavailable('Could not reach the status service. Check your connection and retry.')}}
document.getElementById('refresh').addEventListener('click',refresh);refresh();
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
