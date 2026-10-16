'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {localDateToUtc,validateZone}=require('../src/dates/timeZone');
test('converts named zones with seasonal and fractional offsets',()=>{
 for(const [local,zone,expected] of [
 ['2027-01-15T09:00','America/Sao_Paulo','2027-01-15T12:00:00.000Z'],
 ['2027-01-15T09:00','America/New_York','2027-01-15T14:00:00.000Z'],
 ['2027-07-15T09:00','America/New_York','2027-07-15T13:00:00.000Z'],
 ['2027-07-15T09:00','Europe/London','2027-07-15T08:00:00.000Z'],
 ['2027-01-15T09:00','Asia/Katmandu','2027-01-15T03:15:00.000Z'],
 ['2027-01-15T09:00:12','UTC','2027-01-15T09:00:12.000Z']])assert.equal(localDateToUtc(local,zone),expected);
});
test('rejects impossible calendar dates, unknown zones, DST gaps and overlaps',()=>{
 assert.throws(()=>validateZone('Invalid/Zone'));
 assert.throws(()=>localDateToUtc('2027-02-30T09:00','UTC'),/calendar/);
 assert.throws(()=>localDateToUtc('2027-03-14T02:30','America/New_York'),/does not exist/);
 assert.throws(()=>localDateToUtc('2027-11-07T01:30','America/New_York'),/occurs twice/);
});
test('review formats dates using saved zone',()=>{
 const {createDateView}=require('../src/dates/view');
 const html=createDateView({writeEnabled:()=>true}).render({}, {_id:'j',status:'completed',timeZone:'Asia/Tokyo',dates:{start:'2027-01-15T00:00:00Z'},rows:[],courses:[],tasks:[]},{button:()=>'',now:()=>0});
 assert.match(html,/Asia\/Tokyo/);assert.match(html,/09:00:00/);
});
