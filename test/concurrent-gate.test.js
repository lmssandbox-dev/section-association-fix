'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const {createConcurrentGate}=require('../src/shared/concurrentGate');
const {createRateLimitedHttp}=require('../src/shared/rateLimit');
const hash=s=>createHash('sha256').update(s).digest('hex');
const REMOVE=Symbol('remove');
// Small expression model for the operators used by the atomic Mongo reservation.
// This exercises the actual generated filter/pipeline, not a replacement gate algorithm.
function mongoModel(onDbCall=()=>{}){
 const calls={initialize:0,reserve:0,read:0,complete:0};let doc;const get=(o,path)=>path.split('.').reduce((v,k)=>v?.[k],o);
 const put=(o,path,value)=>{const keys=path.split('.'),last=keys.pop();for(const key of keys)o=o[key]||=( {} );o[last]=value;};
 function evalExpr(v,vars={}){
  if(v==='$$REMOVE')return REMOVE;
  if(typeof v==='string'&&v.startsWith('$$'))return get(vars,v.slice(2));
  if(typeof v==='string'&&v.startsWith('$'))return get(doc,v.slice(1));
  if(Array.isArray(v))return v.map(x=>evalExpr(x,vars));
  if(!v||typeof v!=='object')return v;
  const [op,arg]=Object.entries(v)[0];
  if(op==='$filter')return evalExpr(arg.input,vars).filter(item=>evalExpr(arg.cond,{...vars,[arg.as]:item}));
  const a=evalExpr(arg,vars);
  switch(op){
   case '$ifNull':return a[0]??a[1];case '$max':return Math.max(...a);case '$add':return a.reduce((x,y)=>x+y,0);case '$multiply':return a.reduce((x,y)=>x*y,1);
   case '$eq':return a[0]===a[1];case '$ne':return a[0]!==a[1];case '$cond':return a[0]?a[1]:a[2];case '$lte':return a[0]<=a[1];case '$lt':return a[0]<a[1];case '$gte':return a[0]>=a[1];case '$gt':return a[0]>a[1];case '$and':return a.every(Boolean);case '$or':return a.some(Boolean);case '$size':return a.length;case '$concatArrays':return a.flat();
   default:return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,evalExpr(x,vars)]));
  }
 }
 const collection={
  async updateOne(filter,update){
   const kind=!Array.isArray(update)&&update.$setOnInsert?'initialize':'complete';calls[kind]++;await onDbCall(kind);
   if(!doc&&!Array.isArray(update)&&update.$setOnInsert)doc={_id:filter._id,...structuredClone(update.$setOnInsert)};
   if(!doc||filter['permits.token']&&!doc.permits.some(p=>p.token===filter['permits.token']))return {matchedCount:0};
   if(Array.isArray(update)){
    for(const stage of update){const changes=evalExpr(stage.$set);for(const [k,v] of Object.entries(changes)){if(v===REMOVE){const keys=k.split('.'),last=keys.pop(),parent=keys.reduce((o,key)=>o?.[key],doc);if(parent)delete parent[last];}else put(doc,k,v);}}
   }else for(const [k,v] of Object.entries(update.$set||{}))put(doc,k,v);
   if(Array.isArray(update))return {matchedCount:1};
   for(const [k,v] of Object.entries(update.$inc||{}))put(doc,k,(get(doc,k)||0)+v);
   for(const [k,v] of Object.entries(update.$max||{}))put(doc,k,Math.max(get(doc,k)??-Infinity,v));
   for(const [k,v] of Object.entries(update.$min||{}))put(doc,k,Math.min(get(doc,k)??Infinity,v));
   if(update.$pull)doc.permits=doc.permits.filter(p=>p.token!==update.$pull.permits.token);
   return {matchedCount:1};
  },
  async findOneAndUpdate(filter,pipeline){
   calls.reserve++;await onDbCall('reserve');
   if(!doc||doc.nextAt>filter.nextAt.$lte||!evalExpr(filter.$expr))return {value:null};
   Object.assign(doc,evalExpr(pipeline[0].$set));return {value:structuredClone(doc)};
 },async findOne(){calls.read++;await onDbCall('read');return structuredClone(doc);}
 };
 return {calls,client:{connect:async()=>{},db:()=>({collection:()=>collection}),close:async()=>{}},get doc(){return doc;}};
}
const route='PUT /d2l/api/lp/1.53/courses/:id';
const sample={route,status:200,cost:10,remaining:49000,latencyMs:100,gateWaitMs:20,resetMs:60000};
test('atomic reservations share four permits across gate instances and release records timing',async()=>{
 let now=0;const m=mongoModel(),create=()=>createConcurrentGate({uri:'mongodb://unused/app',key:'k',now:()=>now,mongoClient:m.client});const a=create(),b=create(),permits=[];
 for(let i=0;i<4;i++){const permit=await (i%2?a:b).reserve(route);assert.ok(permit.token);permits.push(permit);now+=250;}
 assert.ok((await b.reserve(route)).wait>0);await a.complete(permits[0],sample);now+=250;assert.ok((await b.reserve(route)).token);
 const metrics=m.doc.costs[hash(route)];assert.equal(metrics.requests,1);assert.equal(metrics.timedRequests,1);assert.equal(metrics.totalLatencyMs,100);assert.equal(metrics.totalGateWaitMs,20);
 now=50000;assert.ok((await a.reserve(route)).token);await assert.rejects(()=>a.complete(permits[1],sample),/permit lost/);
});
test('local reservation slots transfer to waiters without leaking capacity',async()=>{
 let active=0,peak=0;const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
 const m=mongoModel(async kind=>{if(kind!=='reserve')return;active++;peak=Math.max(peak,active);await pause(5);active--;});
 const gate=createConcurrentGate({key:'bounded-local-reservations',now:()=>Date.now(),mongoClient:m.client});
 await Promise.all(Array.from({length:8},()=>gate.reserve(route)));
 assert.equal(peak,2);
 const result=await Promise.race([gate.reserve(route),pause(50).then(()=>null)]);
 assert.ok(result,'a new reservation must not wait on a leaked local slot');
});
test('concurrent reservations from multiple gate instances retain global and ordinary ceilings',async()=>{
 let clock=100000;const m=mongoModel(),a=createConcurrentGate({key:'concurrent-shared',now:()=>clock+=300,mongoClient:m.client}),b=createConcurrentGate({key:'concurrent-shared',now:()=>clock+=300,mongoClient:m.client});
 const work=Array.from({length:12},(_,i)=>(i%2?a:b).reserve(i<6?route:'GET lookup'));
 const results=await Promise.all(work),granted=results.filter(result=>result.token).length;
 assert.ok(granted<=8);assert.ok(m.doc.permits.length<=8);
 assert.ok(m.doc.budgetUsed<=30000);
 assert.ok(m.doc.permits.filter(permit=>!permit.resolution).length<=4);
});
test('gate timing separates reservation, denied-read, deliberate waits, and buffered completion persistence',async()=>{
 let mono=0,now=0;
 const m=mongoModel(kind=>{mono+=({initialize:2,reserve:4,read:3,complete:5}[kind]||0);});
 const gate=createConcurrentGate({key:'timings',now:()=>now,monotonicNow:()=>mono,mongoClient:m.client});
 const first=await gate.reserve(route);assert.equal(first.mongoReservationMs,4);assert.equal(first.deniedReservationReadMs,0);
 await gate.complete(first,{...sample,gateTimings:{localReservationQueue:2,mongoReservation:4,deniedReservationRead:0,permitContentionWait:0,pacingBudgetWait:0,mixedWait:0}});
 let metrics=m.doc.costs[hash(route)];assert.equal(metrics.localReservationQueueTotalMs,2);assert.equal(metrics.mongoReservationTotalMs,4);assert.equal(metrics.completionPersistenceSamples,undefined);
 now=250;const second=await gate.reserve(route);assert.equal(second.mongoReservationMs,4);
 await gate.complete(second,{...sample,gateTimings:{localReservationQueue:1,mongoReservation:4,deniedReservationRead:0,permitContentionWait:0,pacingBudgetWait:0,mixedWait:0}});
 metrics=m.doc.costs[hash(route)];assert.equal(metrics.completionPersistenceSamples,1);assert.equal(metrics.completionPersistenceTotalMs,5);
 const pacing=await gate.reserve(route);assert.equal(pacing.waitReason,'pacingBudget');
});
test('denied atomic reservations separately measure their follow-up read and permit wait',async()=>{
 let mono=0,now=0;const m=mongoModel(kind=>{mono+=({reserve:4,read:3}[kind]||0);});
 const gate=createConcurrentGate({key:'denied-timing',now:()=>now,monotonicNow:()=>mono,mongoClient:m.client});
 for(let i=0;i<4;i++){assert.ok((await gate.reserve(route)).token);now+=250;}
 const denied=await gate.reserve(route);assert.equal(denied.mongoReservationMs,4);assert.equal(denied.deniedReservationReadMs,3);assert.equal(denied.waitReason,'permitContention');
});
test('reserved credit budget blocks starts until its window resets',async()=>{
 let now=0;const m=mongoModel(),gate=createConcurrentGate({key:'k',now:()=>now,mongoClient:m.client});const initial=await gate.reserve(route);await gate.complete(initial,sample);
 m.doc.budgetUsed=29990;now=250;
 const last=await gate.reserve(route);assert.ok(last.token);assert.equal(m.doc.budgetUsed,30000);await gate.complete(last,sample);now=270;
 assert.ok((await gate.reserve(route)).wait);now=60000;assert.ok((await gate.reserve(route)).token);assert.equal(m.doc.budgetUsed,10);
});
test('429 pause is durable and cannot be shortened by an older successful response',async()=>{
 let now=0;const m=mongoModel(),gate=createConcurrentGate({key:'k',now:()=>now,mongoClient:m.client});const a=await gate.reserve(route);now=250;const b=await gate.reserve(route);
 await gate.complete(a,{...sample,status:429,pauseMs:75000});await gate.complete(b,sample);now=75000;assert.ok((await gate.reserve(route)).wait);now=76250;assert.ok((await gate.reserve(route)).token);
});
test('missing headers activate fallback and later measured costs supersede it',async()=>{
 let now=0;const m=mongoModel(),gate=createConcurrentGate({key:'k',now:()=>now,mongoClient:m.client});let p=await gate.reserve(route);assert.equal(p.reservedCost,125);await gate.complete(p,sample);assert.equal(m.doc.budgetUsed,10);assert.equal(m.doc.costs[hash(route)].fallbackCost,undefined);
 now=250;p=await gate.reserve(route);assert.equal(p.reservedCost,10);await gate.complete(p,{...sample,cost:null});assert.equal(m.doc.costs[hash(route)].fallbackCost,125);
 now=500;p=await gate.reserve(route);assert.equal(p.reservedCost,125);await gate.complete(p,sample);assert.equal(m.doc.budgetUsed,30);assert.equal(m.doc.costs[hash(route)].fallbackCost,undefined);
 now=750;p=await gate.reserve(route);assert.equal(p.reservedCost,10);assert.equal(m.doc.costs[hash(route)].maxCost,10);
});
test('measured costs above the reservation raise budget use and future estimates',async()=>{
 let now=0;const m=mongoModel(),gate=createConcurrentGate({key:'under-reserved',now:()=>now,mongoClient:m.client});const initial=await gate.reserve(route);await gate.complete(initial,sample);now=250;const p=await gate.reserve(route);assert.equal(p.reservedCost,10);await gate.complete(p,{...sample,cost:150});assert.equal(m.doc.budgetUsed,160);assert.equal(m.doc.costs[hash(route)].maxCost,150);
});
test('late completion cannot adjust an expired or newer credit window or make its budget negative',async()=>{
 let now=0;const m=mongoModel(),gate=createConcurrentGate({key:'window-rollover',now:()=>now,mongoClient:m.client}),old=await gate.reserve(route);assert.equal(old.budgetStart,0);m.doc.permits[0].until=120000;now=60000;
 const current=await gate.reserve(route);assert.equal(current.budgetStart,60000);assert.equal(m.doc.budgetUsed,125);await gate.complete(old,{...sample,cost:10});assert.equal(m.doc.budgetUsed,125);await gate.complete(current,{...sample,cost:0});assert.equal(m.doc.budgetUsed,0);assert.ok(m.doc.budgetUsed>=0);
});
test('legacy permits without budget-window metadata retain their conservative reservation',async()=>{
 let now=0;const m=mongoModel(),gate=createConcurrentGate({key:'legacy-permit',now:()=>now,mongoClient:m.client}),permit=await gate.reserve(route);delete permit.budgetStart;delete permit.reservationSequence;await gate.complete(permit,sample);assert.equal(m.doc.budgetUsed,125);
});
test('reservation order keeps concurrent measured and missing-header completions safe',async()=>{
 let now=0;const m=mongoModel(),a=createConcurrentGate({key:'completion-order',now:()=>now,mongoClient:m.client}),b=createConcurrentGate({key:'completion-order',now:()=>now,mongoClient:m.client}),older=await a.reserve(route);now=250;const newer=await b.reserve(route);
 await b.complete(newer,sample);await a.complete(older,{...sample,cost:null});assert.equal(m.doc.costs[hash(route)].fallbackCost,undefined);
 now=500;const third=await a.reserve(route);now=750;const fourth=await b.reserve(route);await b.complete(fourth,{...sample,cost:null});await a.complete(third,sample);assert.equal(m.doc.costs[hash(route)].fallbackCost,125);
 now=1000;const next=await b.reserve(route);assert.equal(next.reservedCost,125);
});
test('gate completion logs one sanitized Mongo error and propagates the original error',async t=>{
 const lines=[],original=console.error;console.error=line=>lines.push(line);t.after(()=>{console.error=original;});
 let now=0;const failure=Object.assign(new Error(`Updating the path 'costs.${hash(route)}.fallbackCost' would create a conflict at 'costs.${hash(route)}'`),{name:'MongoServerError',code:40,codeName:'ConflictingUpdateOperators'}),m=mongoModel(kind=>{if(kind==='complete')throw failure;}),gate=createConcurrentGate({key:'diagnostic',now:()=>now,mongoClient:m.client}),permit=await gate.reserve(route);
 await assert.rejects(()=>gate.complete(permit,sample),error=>error===failure);assert.equal(m.calls.complete,1);assert.equal(lines.length,1);
 const event=JSON.parse(lines[0]);assert.equal(event.operation,'api_gate_completion');assert.equal(event.code,40);assert.equal(event.codeName,'ConflictingUpdateOperators');assert.ok(!lines[0].includes(hash(route)));
});
test('successful API gate completion emits no Mongo diagnostic',async t=>{
 const lines=[],original=console.error;console.error=line=>lines.push(line);t.after(()=>{console.error=original;});
 let now=0;const m=mongoModel(),gate=createConcurrentGate({key:'diagnostic-success',now:()=>now,mongoClient:m.client}),permit=await gate.reserve(route);await gate.complete(permit,sample);assert.equal(lines.length,0);
});
test('a newly observed cost above the local budget fails closed rather than waiting forever',async()=>{
 let now=0;const m=mongoModel(),gate=createConcurrentGate({key:'k',now:()=>now,mongoClient:m.client});const p=await gate.reserve(route);await gate.complete(p,{...sample,cost:40000});now=100000;await assert.rejects(()=>gate.reserve(route),/exceeds/);
});
const config={method:'PUT',url:'https://tenant.example/d2l/api/lp/1.53/courses/123'};
test('production transport never repeats ambiguous writes and poisons scheduling on lost persistence',async()=>{
 for(const fail of ['timeout','reserve','complete']){
  let calls=0;const request=createRateLimitedHttp({baseUrl:'https://tenant.example',gate:{reserve:async()=>{if(fail==='reserve')throw Error('db');return {token:'t',reservedCost:10};},complete:async()=>{if(fail==='complete')throw Error('db');}},http:async()=>{calls++;if(fail==='timeout')throw Error('timeout');return {status:202,headers:{}};}});
  await assert.rejects(()=>request(config),error=>{
   if(fail==='timeout')return true;
   assert.equal(error.phase,'database');
   return fail!=='complete'||(error.requestDispatched===true&&error.responseReceived===true&&error.httpStatus===202&&error.responseConfirmedSuccess===false);
  });assert.equal(calls,fail==='reserve'?0:1);
  if(fail!=='timeout'){await assert.rejects(()=>request(config));assert.equal(calls,fail==='reserve'?0:1);}
 }
});
test('transport aggregates gate timing categories without counting one wait twice',async()=>{
 let mono=0;const samples=[];let reservations=0;
 const request=createRateLimitedHttp({baseUrl:'https://tenant.example',monotonicNow:()=>mono,delay:async ms=>{mono+=ms;},gate:{reserve:async()=>++reservations===1
  ?{wait:10,waitReason:'permitContention',localReservationQueueMs:2,mongoReservationMs:4,deniedReservationReadMs:3}
  :{token:'t',reservedCost:10,localReservationQueueMs:1,mongoReservationMs:5,deniedReservationReadMs:0},complete:async(_permit,sample)=>samples.push(sample)},http:async()=>({status:200,headers:{'x-request-cost':'10'}})});
 await request(config);assert.deepEqual(samples[0].gateTimings,{localReservationQueue:3,mongoReservation:9,deniedReservationRead:3,permitContentionWait:10,pacingBudgetWait:0,mixedWait:0});
});
test('production transport respects global reset waits before retrying an explicit 429',async()=>{
 let now=0,pauseUntil=0,calls=0;const samples=[];
 const request=createRateLimitedHttp({baseUrl:'https://tenant.example',now:()=>now,delay:async ms=>{now+=ms;},gate:{reserve:async()=>now<pauseUntil?{wait:pauseUntil-now}:{token:'t',reservedCost:10},complete:async(_p,s)=>{samples.push(s);if(s.pauseMs)pauseUntil=now+s.pauseMs+1000;}},http:async()=>{if(++calls===1)throw {response:{status:429,headers:{'retry-after':'75'}}};assert.ok(now>=76000);return {status:202,headers:{'x-request-cost':'10'}};}});
 await request(config);assert.equal(calls,2);assert.equal(samples[0].pauseMs,75000);
});

test('gate initializes once and cached cooldown waits do not query MongoDB',async()=>{
 let now=0;const m=mongoModel(),gate=createConcurrentGate({key:'k',now:()=>now,mongoClient:m.client});
 const p=await gate.reserve(route);await gate.complete(p,{...sample,status:429,pauseMs:75000});const before={...m.calls};
 for(let i=0;i<100;i++){const wait=await gate.reserve(route);assert.equal(wait.wait,76000);}
 assert.deepEqual(m.calls,before);now=76000;const next=await gate.reserve(route);assert.ok(next.token);assert.equal(m.calls.initialize,1);
});
test('budget waits account for the next request cost, even below the full credit ceiling',async()=>{
 let now=0;const m=mongoModel(),gate=createConcurrentGate({key:'k',now:()=>now,mongoClient:m.client});const p=await gate.reserve(route);await gate.complete(p,{...sample,cost:100});m.doc.budgetUsed=29950;now=250;
 assert.equal((await gate.reserve(route)).wait,59750);const reads=m.calls.read;now=1000;assert.equal((await gate.reserve(route)).wait,59000);assert.equal(m.calls.read,reads);
});

test('resolution permits share an eight-request ceiling and ordinary requests retain four across instances',async()=>{
 let now=0;const m=mongoModel(),make=()=>createConcurrentGate({uri:'mongodb://unused/app',key:'mixed',now:()=>now,mongoClient:m.client}),a=make(),b=make();
 for(let i=0;i<4;i++){assert.ok((await a.reserve(route)).token);now+=250;}
 assert.ok((await b.reserve(route)).wait);now+=1000;
 for(let i=0;i<4;i++){assert.ok((await b.reserve('GET /d2l/api/lp/1.63/orgstructure/',{resolution:true})).token);now+=250;}
 assert.equal(m.doc.permits.length,8);assert.ok((await a.reserve('GET lookup',{resolution:true})).wait);
 now+=50000;
 for(let i=0;i<8;i++){assert.ok((await a.reserve('GET lookup',{resolution:true})).token);now+=250;}
 assert.ok((await b.reserve('GET lookup',{resolution:true})).wait);assert.ok((await b.reserve(route)).wait);
});

test('transport permits eight exact-code reads but only four other calls with a shared total of eight',async()=>{
 let active=0,ordinary=0,peak=0,ordinaryPeak=0;const releases=[],classes=[];
 const request=createRateLimitedHttp({baseUrl:'https://tenant.example',gate:{reserve:async(_route,options)=>{classes.push(options.resolution);return {token:'t'};},complete:async()=>{}},http:async config=>{
  const lookup=new URL(config.url).searchParams.has('exactOrgUnitCode');active++;if(!lookup)ordinary++;peak=Math.max(peak,active);ordinaryPeak=Math.max(ordinaryPeak,ordinary);
  await new Promise(resolve=>releases.push(resolve));active--;if(!lookup)ordinary--;return {status:200,headers:{'x-request-cost':'10'}};
 }});
 const work=Array.from({length:12},(_,i)=>request({method:'GET',url:i<6?'https://tenant.example/d2l/api/le/1.99/1/quizzes/1':'https://tenant.example/d2l/api/lp/1.63/orgstructure/?exactOrgUnitCode=C'+i}));
 await new Promise(r=>setImmediate(r));assert.equal(active,8);assert.equal(ordinary,4);
 while(releases.length){releases.splice(0).forEach(r=>r());await new Promise(r=>setImmediate(r));}await Promise.all(work);assert.equal(peak,8);assert.equal(ordinaryPeak,4);assert.equal(classes.filter(Boolean).length,6);
});
