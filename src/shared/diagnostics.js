'use strict';
// Never log request bodies, URLs, headers, credentials, or upstream error messages.
const MONGODB_OPERATIONS=new Set(['api_gate_completion']);
const SAFE_MONGO_FIELDS=new Set(['costs','route','requests','timedRequests','lastSeenAt','totalLatencyMs','totalGateWaitMs','maxLatencyMs','gateTimingRequests','observedRequests','totalCredits','minCost','maxCost','costObservationSequence','fallbackCost','completionPersistenceTotalMs','completionPersistenceSamples','localReservationQueueTotalMs','localReservationQueueSamples','mongoReservationTotalMs','mongoReservationSamples','deniedReservationReadTotalMs','deniedReservationReadSamples','permitContentionWaitTotalMs','permitContentionWaitSamples','pacingBudgetWaitTotalMs','pacingBudgetWaitSamples','mixedWaitTotalMs','mixedWaitSamples']);
function sanitizeConflictPath(path){
 if(typeof path!=='string'||!path.length||path.length>512)return null;
 const parts=path.split('.');if(parts.length>24)return null;
 return parts.map((part,index)=>{
  if(index>0&&parts[index-1]==='costs'&&/^[a-f\d]{64}$/i.test(part))return '<routeHash>';
  if(/^\d+$/.test(part))return '<index>';
  if(/^[a-f\d]{24}$/i.test(part)||/^[a-f\d-]{36}$/i.test(part))return '<id>';
  return SAFE_MONGO_FIELDS.has(part)?part:'<redacted>';
 }).join('.');
}
function sanitizedMongoMessage(message){
 if(typeof message!=='string'||message.length>2048)return undefined;
 const match=/^Updating the path '([^']{1,512})' would create a conflict at '([^']{1,512})'/.exec(message);
 if(!match)return undefined;
 const path=sanitizeConflictPath(match[1]),conflict=sanitizeConflictPath(match[2]);
 return path&&conflict?`Updating the path '${path}' would create a conflict at '${conflict}'`:undefined;
}
function logMongoOperationFailure(operation,error){
 try{
  if(!MONGODB_OPERATIONS.has(operation)||!error||typeof error!=='object'||!(typeof error.name==='string'&&error.name.startsWith('Mongo')))return;
  const name=typeof error.name==='string'&&/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(error.name)?error.name:'MongoError';
  const code=Number.isSafeInteger(error.code)?error.code:undefined;
  const codeName=typeof error.codeName==='string'&&/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(error.codeName)?error.codeName:undefined;
  const message=sanitizedMongoMessage(error.message);
  console.error(JSON.stringify({event:'mongodb_operation_failed',time:new Date().toISOString(),operation,error:name,code,codeName,message}));
 }catch{}
}
module.exports={logMongoOperationFailure};
