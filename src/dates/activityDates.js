'use strict';
const { randomBytes, createHash } = require('node:crypto');
const { id } = require('../shared/id');
const { validateDates } = require('./activityWriters');
const { deploymentGuard } = require('../shared/deploymentGuard');
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const zone = 'America/Sao_Paulo';
function brazilDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(value)) throw new Error('Invalid local date');
  const local = value.length === 16 ? `${value}:00` : value;
  const iso = `${local}-03:00`;
  const date = new Date(iso);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {timeZone:zone, year:'numeric', month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(date).map(p=>[p.type,p.value]));
  if (`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}` !== local) throw new Error('Unsupported local date');
  return iso;
}
function createActivityDates({ writer, writers = { assignment: writer }, deploymentId, writeEnabled = false, now = Date.now }) {
  const enabled = type => typeof writeEnabled === 'function' ? writeEnabled(type) : writeEnabled;
  const labels = { assignment: 'Assignment', quiz: 'Quiz', discussionTopic: 'Discussion Topic' };
  const guard = deploymentGuard(deploymentId), tickets = new Map();
  const session = res => createHash('sha256').update(String(res.locals.ltik)).digest('hex');
  function issue(res, stage, data = null) {
    for (const [key,ticket] of tickets) if (ticket.expires <= now()) tickets.delete(key);
    if (tickets.size >= 1000) tickets.delete(tickets.keys().next().value);
    const token = randomBytes(32).toString('hex');
    tickets.set(token,{stage,data,session:session(res),expires:now()+10*60*1000});
    return token;
  }
  function consume(res, token, stage) {
    if (typeof token !== 'string') return null;
    const ticket = tickets.get(token);
    if (!ticket || ticket.stage !== stage || ticket.session !== session(res) || ticket.expires <= now()) return null;
    tickets.delete(token); // Consume synchronously before the first API await.
    return ticket;
  }
  const hidden = (name,value) => `<input type="hidden" name="${name}" value="${escape(value)}">`;
  function form(res, courseId = '') {
    return `<hr><h2>Single activity date update</h2>
      <p>Update one Assignment, Quiz or Discussion Topic. Times are Brasília time (America/Sao_Paulo, UTC−03:00).</p>
      <p>For Discussion Topics, enter the Forum ID and choose a Due date later than Start. Assignments require Start earlier than End.</p>
      <p>Available write scopes: ${Object.keys(labels).filter(enabled).map(type=>labels[type]).join(', ') || 'none configured'}. Preview does not change dates.</p>
      <form method="post" action="/diagnostics/activity-dates/preview">
        ${hidden('ltik',res.locals.ltik)}${hidden('ticket',issue(res,'form'))}
        <p><label>Course Offering ID <input name="orgUnitId" pattern="[1-9][0-9]*" required value="${escape(courseId)}"></label>
        <label>Activity type <select name="type">${Object.entries(labels).map(([type,label])=>`<option value="${type}">${label}</option>`).join('')}</select></label>
        <label>Activity ID <input name="activityId" pattern="[1-9][0-9]*" required></label></p>
        <p><label>Forum ID (Discussion Topic only; discovery parentId) <input name="parentId" pattern="[1-9][0-9]*"></label></p>
        ${['start','due','end'].map(field=>`<p><label>${field[0].toUpperCase()+field.slice(1)} <input type="datetime-local" step="1" name="${field}"></label></p>`).join('')}
        <button name="mode" value="selected" type="submit">Preview selected dates</button>
      </form>`;
  }
  function authorize(req,res) {
    res.set('Cache-Control','no-store');res.set('Referrer-Policy','no-referrer');
    if (!guard(res.locals.token,req,res)) return false;
    if (!res.locals.ltik) {res.status(403).send('A validated LTI session is required.');return false;}
    return true;
  }
  const summary = result => `<h2>Activity ${escape(result.activityKey)}</h2><p>${escape(result.name)}</p>
    <p>Status: <strong>${escape(result.status)}</strong></p>
    ${['assignment','discussionTopic'].includes(result.type) ? '<p>Existing availability modes are preserved. Where no mode is configured, Brightspace uses the course default when dates are applied.</p>' : ''}
    <table><thead><tr><th>Date</th><th>Requested — Brasília</th><th>Current / verified — Brasília</th></tr></thead><tbody>
    ${['start','due','end'].map(field=>`<tr><td>${field}</td><td>${escape(display(result.requestedDates?.[field]))}</td><td>${escape(display(result.verifiedDates?.[field]))}</td></tr>`).join('')}</tbody></table>
    ${result.error ? `<p>${escape(result.error.message)}</p>${result.error.validation?.length ? `<ul>${result.error.validation.map(message=>`<li>${escape(message)}</li>`).join('')}</ul>` : ''}` : ''}
    <details><summary>Technical result (UTC)</summary><pre>${escape(JSON.stringify(result,null,2))}</pre></details>`;
  function display(value) {return value ? new Intl.DateTimeFormat('pt-BR',{timeZone:zone,dateStyle:'short',timeStyle:'medium'}).format(new Date(value)) : '—';}
  return { form,
    async preview(req,res) {
      if (!authorize(req,res)) return;
      if (!consume(res,req.body?.ticket,'form')) return res.status(409).send('Form expired or already submitted. Relaunch the tool and preview again.');
      let data;
      try {
        const orgUnitId=id(req.body.orgUnitId), activityId=id(req.body.activityId ?? req.body.assignmentId);
        const type=req.body.type ?? 'assignment';
        if (!Object.hasOwn(labels,type) || !Object.hasOwn(writers,type)) throw new Error('Invalid type');
        const parentId=type==='discussionTopic'?id(req.body.parentId):null;
        if (!['now','selected'].includes(req.body.mode)) throw new Error('Invalid mode');
        const instant=new Date(now()).toISOString();
        const dates=validateDates(Object.fromEntries(['start','due','end'].map(field=>[field, req.body.mode==='now' ? instant : brazilDate(req.body[field])])));
        data={orgUnitId,activity:{type,id:activityId,...(parentId?{parentId}:{})},dates};
      } catch {return res.status(400).send(`<p>Enter valid IDs and all three dates in order: Start ≤ Due ≤ End.</p>${form(res)}`);}
      try {
        const result=await writers[data.activity.type].updateActivityDates({...data,dryRun:true});
        let confirmation='';
        if(result.status==='ready' && enabled(data.activity.type)) confirmation=`<form method="post" action="/diagnostics/activity-dates/apply">
          ${hidden('ltik',res.locals.ltik)}${hidden('ticket',issue(res,'apply',data))}<button type="submit">Apply these dates</button></form>`;
        if(result.status==='ready' && !enabled(data.activity.type)) confirmation='<p>Apply is unavailable: configure the matching write scope for this activity type in the OAuth registration and Render.</p>';
        const same=data.dates.start===data.dates.end ? '<p>Start and End are equal: this creates a zero-duration availability window.</p>' : '';
        res.send(`<h1>Activity date preview — no changes made</h1>${summary(result)}${same}${confirmation}${form(res,data.orgUnitId)}`);
      } catch {res.status(502).send(`<p>Preview failed. No update was requested.</p>${form(res,data.orgUnitId)}`);}
    },
    async apply(req,res) {
      if (!authorize(req,res)) return;
      const ticket=consume(res,req.body?.ticket,'apply');
      if(!ticket) return res.status(409).send('Preview expired or already applied. Preview again before applying.');
      if (!enabled(ticket.data.activity.type)) return res.status(403).send('Write scope is not configured for this activity type.');
      try {
        const result=await writers[ticket.data.activity.type].updateActivityDates({...ticket.data,dryRun:false});
        res.send(`<h1>Activity date result</h1>${summary(result)}${form(res,ticket.data.orgUnitId)}`);
      } catch {res.status(502).send('<p>Update outcome could not be verified. Read the activity before retrying.</p>');}
    }
  };
}
module.exports = { createActivityDates, brazilDate };
