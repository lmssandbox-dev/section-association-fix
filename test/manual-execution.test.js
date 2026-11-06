'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createManualExecutionController } = require('../src/sectionAssociations/manualExecution');

function deferred(){let resolve;const promise=new Promise(done=>{resolve=done});return{promise,resolve}}

test('manual controller dispatches immediately through the shared one-shot runner',async()=>{
  const started=deferred(),finish=deferred(),calls=[];let state={requestId:'r1',status:'requested'};
  const store={async requestManualExecution(requester){calls.push(['request',requester]);return{accepted:true,...state}},
    async getManualExecutionRequest(){return state}};
  const controller=createManualExecutionController({service:{},store,recoveryIntervalHours:4,maxReconciliationsPerRun:50,
    async run(options){calls.push(['run',options.source,options.manualRequestId]);started.resolve();await finish.promise;return{status:'completed'}}});
  const accepted=await controller.request({subjectHash:'hash'});await started.promise;
  assert.equal(accepted.status,'requested');assert.deepEqual(calls[1],['run','manual','r1']);
  finish.resolve();
});

test('recovery poll dispatches durable requested and interrupted running requests',async()=>{
  const statuses=['requested','running'];let runCount=0;
  const store={async getManualExecutionRequest(){const status=statuses.shift();return status?{requestId:'recover-'+status,status}:null}};
  const controller=createManualExecutionController({service:{},store,recoveryIntervalHours:4,maxReconciliationsPerRun:50,
    async run({manualRequestId}){runCount++;assert.match(manualRequestId,/^recover-/);return{status:'completed'}}});
  await controller.recoverPending();await new Promise(resolve=>setImmediate(resolve));
  await controller.recoverPending();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(runCount,2);
});

test('concurrent clicks accept one request and do not start a duplicate run',async()=>{
  let active=false,runs=0;
  const store={async requestManualExecution(){if(active)return{accepted:false,alreadyRunning:true,request:{requestId:'one',status:'running'}};active=true;return{accepted:true,requestId:'one',status:'requested'}},
    async getManualExecutionRequest(){return{requestId:'one',status:'running'}}};
  const controller=createManualExecutionController({service:{},store,recoveryIntervalHours:4,maxReconciliationsPerRun:50,
    async run(){runs++;return{status:'completed'}}});
  const results=await Promise.all([controller.request({}),controller.request({})]);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(results.filter(result=>result.accepted).length,1);assert.equal(runs,1);
});

