'use strict';
const test=require('node:test'), assert=require('node:assert/strict');
const {createActivityDates,brazilDate}=require('../src/dates/activityDates');
function response(ltik='session',token={deploymentId:'d',user:'u'}) {return {locals:{ltik,token},code:200,headers:{},set(k,v){this.headers[k]=v;return this;},status(c){this.code=c;return this;},send(body){this.body=body;return this;}};}
const ticket=html=>html.match(/name="ticket" value="([a-f0-9]+)"/)[1];
function setup(options={}) {
 const calls=[];let time=Date.parse('2026-10-01T12:00:00Z');
 const writer={async updateActivityDates(data){calls.push(data); if(options.throws)throw new Error('SECRET');return {status:options.status || (data.dryRun?'ready':'updated'),activityKey:'assignment:9524:983',name:'<script>bad</script>',requestedDates:data.dates,verifiedDates:data.dates};}};
 const routes=createActivityDates({writer,deploymentId:'d',writeEnabled:options.writeEnabled ?? true,now:()=>time});
 return {routes,calls,advance(){time+=600001;}};
}
async function preview(s,extra={}) {
 const res=response();const nonce=ticket(s.routes.form(res));
 await s.routes.preview({body:{ticket:nonce,orgUnitId:'9524',assignmentId:'983',mode:'now',...extra}},res);return res;
}
test('preview uses one current instant and apply uses stored values, ignoring altered body',async()=>{
 const s=setup();const p=await preview(s);assert.equal(s.calls[0].dryRun,true);
 assert.deepEqual(s.calls[0].dates,{start:'2026-10-01T12:00:00.000Z',due:'2026-10-01T12:00:00.000Z',end:'2026-10-01T12:00:00.000Z'});
 assert.match(p.body,/zero-duration/);assert.doesNotMatch(p.body,/<script>/);assert.match(p.body,/&lt;script&gt;/);
 const nonce=ticket(p.body);const applied=response();await s.routes.apply({body:{ticket:nonce,orgUnitId:'1',assignmentId:'2'}},applied);
 assert.equal(s.calls[1].orgUnitId,'9524');assert.equal(s.calls[1].activity.id,'983');assert.equal(s.calls[1].dryRun,false);
 const repeated=response();await s.routes.apply({body:{ticket:nonce}},repeated);assert.equal(repeated.code,409);assert.equal(s.calls.length,2);
});
test('Brazil local dates convert explicitly; invalid order and missing fields cannot call writer',async()=>{
 assert.equal(brazilDate('2026-10-01T09:00'),'2026-10-01T09:00:00-03:00');
 assert.throws(()=>brazilDate('2026-02-30T09:00'));assert.throws(()=>brazilDate('2026-10-01T09:00Z'));
 const s=setup();const p=await preview(s,{mode:'selected',start:'2026-10-01T09:00',due:'2026-10-01T10:00',end:'2026-10-01T11:00'});
 assert.equal(p.code,200);assert.equal(s.calls[0].dates.start,'2026-10-01T12:00:00.000Z');
 for(const input of [{mode:'selected'},{mode:'other'},{orgUnitId:'../1'},{mode:'selected',start:'2026-10-02T09:00',due:'2026-10-01T09:00',end:'2026-10-01T09:00'}]){
  const b=setup();const r=await preview(b,input);assert.equal(r.code,400);assert.equal(b.calls.length,0);
 }
});
test('wrong deployment and forged, cross-session, expired tickets block calls',async()=>{
 const s=setup();for(const method of ['preview','apply']){
  const res=response('session',{deploymentId:'wrong'});await s.routes[method]({body:{}},res);assert.equal(res.code,403);
 }
 const noTicket=response();await s.routes.preview({body:{}},noTicket);assert.equal(noTicket.code,409);
 const p=await preview(s);const nonce=ticket(p.body);const other=response('different');await s.routes.apply({body:{ticket:nonce}},other);assert.equal(other.code,409);
 s.advance();const expired=response();await s.routes.apply({body:{ticket:nonce}},expired);assert.equal(expired.code,409);assert.equal(s.calls.length,1);
});
test('disabled scope permits preview but not apply; failed preview cannot issue approval',async()=>{
 for(const options of [{writeEnabled:false},{status:'failed'},{status:'unchanged'}]) {
  const s=setup(options),p=await preview(s);assert.doesNotMatch(p.body,/Apply these dates/);
  const res=response();await s.routes.apply({body:{ticket:ticket(p.body)}},res);assert.ok([403,409].includes(res.code));assert.equal(s.calls.length,1);
 }
});
test('unexpected writer failure is sanitized and authorization headers are set',async()=>{
 const s=setup({throws:true});const p=await preview(s);assert.equal(p.code,502);assert.doesNotMatch(p.body,/SECRET/);assert.equal(p.headers['Cache-Control'],'no-store');
});
test('discovery launch includes the Assignment form without executing writer',()=>{
 const s=setup(),res=response();
 const {createDiagnostics}=require('../src/dates/discoveryDiagnostics');
 const d=createDiagnostics({client:{},deploymentId:'d',activityForm:s.routes.form});d.launch(res.locals.token,{},res);
 assert.match(res.body,/Single activity date update/);assert.match(res.body,/Preview selected dates/);assert.equal(s.calls.length,0);
});

test('form routes each activity type and enforces its own scope and preview identity',async()=>{
 for(const type of ['quiz','discussionTopic']){
  const calls=[];const writer={async updateActivityDates(data){calls.push(data);return {status:data.dryRun?'ready':'updated',type,activityKey:`${type}:9524:11`,requestedDates:data.dates,verifiedDates:data.dates};}};
  const routes=createActivityDates({writers:{[type]:writer},deploymentId:'d',writeEnabled:t=>t===type});
  const res=response();await routes.preview({body:{ticket:ticket(routes.form(res)),type,activityId:'11',parentId:'31',orgUnitId:'9524',mode:'selected',start:'2027-01-01T09:00',due:'2027-01-02T09:00',end:'2027-01-03T09:00'}},res);
  assert.match(res.body,/Apply these dates/);
  await routes.apply({body:{ticket:ticket(res.body),type:'assignment',activityId:'999'}},response());
  assert.equal(calls.length,2);assert.equal(calls[1].activity.type,type);assert.equal(calls[1].activity.id,'11');
  if(type==='discussionTopic')assert.equal(calls[1].activity.parentId,'31');
 }
});

test('form no longer offers the invalid same-time preview shortcut', () => {
  const s=setup();const html=s.routes.form(response());
  assert.doesNotMatch(html,/value="now"/);assert.match(html,/Assignments require Start earlier than End/);
});
