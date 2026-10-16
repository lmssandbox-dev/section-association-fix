'use strict';
const DEFAULT_ZONE='America/Sao_Paulo';
const ZONES=[...new Set([DEFAULT_ZONE,'UTC',...Intl.supportedValuesOf('timeZone')])].sort();
const invalid=message=>Object.assign(new Error(message),{code:'INVALID_DATE'});
function validateZone(zone=DEFAULT_ZONE){if(typeof zone!=='string'||!ZONES.includes(zone))throw invalid('Choose a valid time zone from the list.');return zone;}
function localDateToUtc(value,zone=DEFAULT_ZONE){
 validateZone(zone);
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(value))throw invalid('Enter a valid date and time for Start, Due and End.');
 const local=value.length===16?value+':00':value,nominal=Date.parse(local+'Z');
 if(!Number.isFinite(nominal)||new Date(nominal).toISOString().slice(0,19)!==local)throw invalid('Enter a valid calendar date and time.');
 const formatter=new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
 const wall=t=>{const p=Object.fromEntries(formatter.formatToParts(new Date(t)).map(p=>[p.type,p.value]));return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;};
 const offsets=new Set();
 for(let h=-48;h<=48;h+=6){const t=nominal+h*3600000;offsets.add(Date.parse(wall(t)+'Z')-t);}
 const candidates=[...offsets].map(offset=>nominal-offset).filter(t=>wall(t)===local);
 if(!candidates.length)throw invalid(`${value} does not exist in ${zone} because the clocks change. Choose another time.`);
 if(candidates.length!==1)throw invalid(`${value} occurs twice in ${zone} because the clocks change. Choose an unambiguous time, or select UTC and enter the intended UTC time.`);
 return new Date(candidates[0]).toISOString();
}
module.exports={DEFAULT_ZONE,ZONES,validateZone,localDateToUtc};
