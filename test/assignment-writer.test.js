'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createActivityWriter, buildAssignmentPayload, validateDates } = require('../src/dates/activityWriters');
const { createAssignmentPut } = require('../src/shared/client');
const fixture = require('./fixtures/assignment-write.json');
const dates = { start:'2027-01-01T00:00:00.000Z', due:'2027-01-02T00:00:00.000Z', end:'2027-01-03T00:00:00.000Z' };
const request = { orgUnitId:'999', activity:{ type:'assignment', id:'11', key:'assignment:999:11', orgUnitId:'999' }, dates };
function setup(options = {}) {
  const current = structuredClone(options.current || fixture), calls = [];
  let readCount = 0;
  const api = { supportsLeVersion: () => options.newVersion ?? true,
    coursePath: (org,suffix) => `https://tenant.example/d2l/api/le/1.98/${org}/${suffix}`,
    async read(path) { calls.push({method:'GET',path}); readCount++;
      if (options.readError || (readCount > 1 && options.verifyError)) throw new Error('SECRET');
      return structuredClone(current); } };
  const put = async (path, payload) => {
    calls.push({method:'PUT',path,payload});
    if (!options.ignoreWrite) {
      current.Availability = structuredClone(payload.Availability); current.DueDate = payload.DueDate;
      for (const key of ['StartDateAvailabilityType','EndDateAvailabilityType']) {
        if (!Object.hasOwn(current.Availability,key)) current.Availability[key]=options.defaultType ?? 0;
      }
      if(options.changeAvailability) current.Availability.EndDateAvailabilityType=99;
      if (options.changeSettings) current.IsHidden = !current.IsHidden;
    }
    if (options.putError) throw Object.assign(new Error('SECRET'), {status: options.putError});
  };
  return { writer:createActivityWriter({api,put,type:'assignment'}), calls, current };
}
test('maps complete payload without replaying read-only fields or altering source', () => {
  const before = structuredClone(fixture);
  const p = buildAssignmentPayload(fixture, dates, () => true);
  assert.deepEqual(p.CustomInstructions, {Content:fixture.CustomInstructions.Html, Type:'Html'});
  for (const field of ['Name','CategoryId','GroupTypeId','NotificationEmail','IsHidden','IsAnonymous','DropboxType','SubmissionType','CompletionType','GradeItemId','AllowOnlyUsersWithSpecialAccess','SubmissionRule','DisplayInCalendar']) assert.deepEqual(p[field],fixture[field]);
  assert.deepEqual(p.Assessment,{ScoreDenominator:100});
  assert.equal(p.Availability.StartDateAvailabilityType,fixture.Availability.StartDateAvailabilityType);
  assert.equal(p.Availability.EndDateAvailabilityType,fixture.Availability.EndDateAvailabilityType);
  for (const field of ['Id','Attachments','ActivityId','TotalFiles']) assert.equal(Object.hasOwn(p,field),false);
  assert.deepEqual(fixture,before);
});
test('Assignment writer reads, writes and verifies dates with stable identity', async () => {
  const {writer,calls}=setup(); const r=await writer.updateActivityDates(request);
  assert.equal(r.status,'updated'); assert.deepEqual(r.verifiedDates,dates); assert.equal(r.activityKey,'assignment:999:11');
  assert.deepEqual(calls.map(c=>c.method),['GET','PUT','GET']);
});
test('dry run validates preservation but never writes', async () => {
  const {writer,calls}=setup(); const r=await writer.updateActivityDates({...request,dryRun:true});
  assert.equal(r.status,'ready'); assert.equal(r.writeAttempted,false); assert.equal(calls.length,1);
});
test('equal dates in other timezone and precision return unchanged without PUT', async () => {
  const {writer,current,calls}=setup();
  current.Availability.StartDate='2026-12-31T21:00:00-03:00'; current.DueDate='2027-01-02T00:00:00.0000000Z';current.Availability.EndDate=dates.end;
  assert.equal((await writer.updateActivityDates(request)).status,'unchanged'); assert.equal(calls.length,1);
});
test('all dates required, ordered at full precision; invalid requests never read', async () => {
  for (const invalid of [null,{}, {...dates,start:null}, {...dates,start:'2027-02-30T00:00:00Z'}, {...dates,end:dates.start}, {...dates,unexpected:true},
    {start:'2027-01-01T00:00:00.0000002Z',due:'2027-01-01T00:00:00.0000001Z',end:dates.end}]) {
    const {writer,calls}=setup(); assert.equal((await writer.updateActivityDates({...request,dates:invalid})).status,'failed');assert.equal(calls.length,0);
  }
  assert.deepEqual(validateDates({start:dates.start,due:dates.start,end:dates.start}),{start:dates.start,due:dates.start,end:dates.start});
});
test('wrong course, key, type and returned identity are rejected', async () => {
  for (const activity of [{...request.activity,orgUnitId:'998'},{...request.activity,key:'assignment:999:12'},{...request.activity,type:'quiz'}]) {
    const {writer,calls}=setup();assert.equal((await writer.updateActivityDates({...request,activity})).error.category,'INVALID_IDENTITY');assert.equal(calls.length,0);
  }
  const {writer,current,calls}=setup();current.Id=12;
  assert.equal((await writer.updateActivityDates(request)).error.category,'INVALID_IDENTITY');assert.equal(calls.length,1);
});
test('undated Assignments retain every known availability type', async () => {
  for (const type of [0,1,2,'0','1','2']) {
    const {writer,current,calls}=setup();current.Availability={StartDate:null,EndDate:null,StartDateAvailabilityType:type,EndDateAvailabilityType:type};current.DueDate=null;
    assert.equal((await writer.updateActivityDates(request)).status,'updated');
    assert.equal(calls[1].payload.Availability.StartDateAvailabilityType,type);
  }
});
test('missing settings and unknown availability block writes instead of defaulting', async () => {
  for (const modify of [c=>delete c.Name,c=>delete c.CustomInstructions,c=>delete c.Availability.EndDateAvailabilityType,c=>c.Availability.StartDateAvailabilityType=99]) {
    const {writer,current,calls}=setup();modify(current);assert.equal((await writer.updateActivityDates(request)).status,'failed');assert.equal(calls.length,1);
  }
});
test('plain instructions, null assessment and pre-1.98 payload are preserved', () => {
  const c=structuredClone(fixture);c.CustomInstructions={Text:'Plain instructions',Html:null};c.Assessment=null;delete c.SubmissionRule;
  const p=buildAssignmentPayload(c,dates,()=>false);
  assert.deepEqual(p.CustomInstructions,{Content:'Plain instructions',Type:'Text'});assert.equal(Object.hasOwn(p,'Assessment'),false);assert.equal(Object.hasOwn(p,'SubmissionRule'),false);
});
test('read-back mismatch and unrelated changes are failures, not false success', async () => {
  for (const [options,category] of [[{ignoreWrite:true},'VERIFICATION_MISMATCH'],[{changeSettings:true},'SETTINGS_CHANGED']]) {
    const {writer}=setup(options);const r=await writer.updateActivityDates(request);assert.equal(r.status,'failed');assert.equal(r.error.category,category);assert.equal(r.writeAttempted,true);
  }
});
test('uncertain PUT is reconciled without automatic retries', async () => {
  const {writer,calls}=setup({putError:503});const r=await writer.updateActivityDates(request);
  assert.equal(r.status,'updated');assert.equal(r.reconciled,true);assert.equal(calls.filter(c=>c.method==='PUT').length,1);
});
test('API and verification failures are sanitized and preserve uncertainty', async () => {
  for (const options of [{readError:true},{putError:403,ignoreWrite:true},{verifyError:true}]) {
    const {writer}=setup(options);const r=await writer.updateActivityDates(request);
    assert.equal(r.status,'failed');assert.equal(JSON.stringify(r).includes('SECRET'),false);
    if(options.verifyError) {assert.equal(r.verifiedDates,null);assert.equal(r.writeAttempted,true);}
  }
});
test('PUT transport permits only Assignment URLs and sanitizes upstream failures', async () => {
  let tokens=0;const calls=[];
  const put=createAssignmentPut({leRoot:'https://tenant.example/d2l/api/le/1.98',oauth:{async getAccessToken(){tokens++;return 'SECRET';}},http:async r=>{calls.push(r);return {data:{}};}});
  for(const url of ['http://tenant.example/d2l/api/le/1.98/999/dropbox/folders/11','https://evil.example/d2l/api/le/1.98/999/dropbox/folders/11','https://tenant.example/d2l/api/le/1.98/999/quizzes/11','https://tenant.example/d2l/api/le/1.98/999/dropbox/folders/11?x=1']) await assert.rejects(()=>put(url,{}));
  assert.equal(tokens,0);
  await put('https://tenant.example/d2l/api/le/1.98/999/dropbox/folders/11',{Name:'x'});
  assert.equal(calls[0].method,'PUT');assert.equal(calls[0].maxRedirects,0);assert.equal(calls[0].timeout,15000);
  const broken=createAssignmentPut({leRoot:'https://tenant.example/d2l/api/le/1.98',oauth:{getAccessToken:async()=> 'SECRET'},http:async()=>{throw Object.assign(new Error('SECRET'),{response:{status:403}});}});
  await assert.rejects(()=>broken('https://tenant.example/d2l/api/le/1.98/999/dropbox/folders/11',{}),e=>e.status===403&&!e.message.includes('SECRET'));
});

test('documented optional missing settings do not block preview or invent defaults', async () => {
  const {writer,current,calls}=setup();
  for (const key of ['IsHidden','IsAnonymous','DropboxType','SubmissionType','CompletionType','GradeItemId','AllowOnlyUsersWithSpecialAccess','Assessment','SubmissionRule']) delete current[key];
  const result=await writer.updateActivityDates(request);
  assert.equal(result.status,'updated');
  const payload=calls[1].payload;
  assert.equal(payload.SubmissionRule,null);
  for (const key of ['Assessment','GradeItemId','AllowOnlyUsersWithSpecialAccess','IsHidden']) assert.equal(Object.hasOwn(payload,key),false);
});
test('missing required field names are reported without native data', async () => {
  const {writer,current,calls}=setup(); delete current.NotificationEmail; delete current.CustomInstructions;
  const result=await writer.updateActivityDates(request);
  assert.deepEqual(result.error.fields,['NotificationEmail','CustomInstructions']);
  assert.match(result.error.message,/NotificationEmail, CustomInstructions/);
  assert.equal(result.writeAttempted,false);assert.equal(calls.length,1);
});

test('HTTP 400 preserves selected validation messages but removes payload secrets', async () => {
  const {createActivityPut}=require('../src/shared/client');
  const put=createActivityPut({type:'assignment',leRoot:'https://tenant.example/d2l/api/le/1.98',
    oauth:{getAccessToken:async()=> 'private-access-token'},http:async()=>{throw Object.assign(new Error('RAW SECRET'),{
      config:{headers:{Authorization:'Bearer private-access-token'}},response:{status:400,data:{
        Message:'EndDate must be later than StartDate.',Errors:[{Message:'Invalid password supersecret; contact teacher@example.invalid. Bearer private-access-token'}],
        Debug:'RAW SECRET',Password:'supersecret'}}});}});
  await assert.rejects(()=>put('https://tenant.example/d2l/api/le/1.98/999/dropbox/folders/11',{Password:'supersecret'}),error=>{
    assert.equal(error.status,400);assert.ok(error.validation.includes('EndDate must be later than StartDate.'));
    for(const value of ['supersecret','teacher@example.invalid','private-access-token','RAW SECRET'])assert.equal(JSON.stringify(error).includes(value),false);
    return true;
  });
});
test('Assignment propagates sanitized HTTP 400 reason after unchanged read-back',async()=>{
  const current=structuredClone(fixture);const calls=[];
  const api={coursePath:()=> 'path',supportsLeVersion:()=>true,read:async()=>structuredClone(current)};
  const writer=createActivityWriter({api,type:'assignment',put:async()=>{calls.push('PUT');throw Object.assign(new Error('not displayed'),{status:400,validation:['Invalid date interval.']});}});
  const result=await writer.updateActivityDates(request);
  assert.equal(result.status,'failed');assert.equal(result.error.httpStatus,400);assert.deepEqual(result.error.validation,['Invalid date interval.']);assert.equal(calls.length,1);
});

test('Assignment equal start and end fail before any API call', async () => {
  const {writer,calls}=setup();
  const result=await writer.updateActivityDates({...request,dates:{start:dates.start,due:dates.start,end:dates.start},dryRun:true});
  assert.equal(result.status,'failed');assert.equal(result.error.category,'INVALID_DATES');
  assert.equal(result.error.message,'Assignment Start must be earlier than End.');
  assert.equal(result.writeAttempted,false);assert.equal(calls.length,0);
});

test('null Assignment availability uses course defaults, previews safely and reruns unchanged', async () => {
  for (const defaultType of [0,1,2]) {
    const s=setup({defaultType});s.current.Availability=null;s.current.DueDate=null;
    const preview=await s.writer.updateActivityDates({...request,dryRun:true});
    assert.equal(preview.status,'ready');assert.equal(preview.writeAttempted,false);
    assert.equal((await s.writer.updateActivityDates(request)).status,'updated');
    const payload=s.calls.find(c=>c.method==='PUT').payload;
    assert.deepEqual(payload.Availability,{StartDate:dates.start,EndDate:dates.end});
    assert.equal((await s.writer.updateActivityDates(request)).status,'unchanged');
    assert.equal(s.calls.filter(c=>c.method==='PUT').length,1);
  }
});
test('mixed Assignment availability preserves known values and rejects invalid read-back', async () => {
  const row=structuredClone(fixture);row.Availability.StartDateAvailabilityType=null;
  const p=buildAssignmentPayload(row,dates,()=>true);
  assert.equal(Object.hasOwn(p.Availability,'StartDateAvailabilityType'),false);
  assert.equal(p.Availability.EndDateAvailabilityType,row.Availability.EndDateAvailabilityType);
  const s=setup({changeAvailability:true});s.current.Availability=null;
  assert.equal((await s.writer.updateActivityDates(request)).error.category,'UNKNOWN_AVAILABILITY');
});
