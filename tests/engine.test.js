'use strict';
const test=require('node:test'), assert=require('node:assert/strict');
const {Failure,envelope,sign,travel,completed,run}=require('../engine');
const reply=data=>({status:200,json:{code:0,data}});
function sequence(entries) {
  const calls=[];
  return {calls,request:async(method,path,body)=> {
    calls.push({method,path,body});assert.ok(entries.length,'unexpected request');
    const item=entries.shift();if(item instanceof Error) throw item;return reply(item);
  }};
}
test('HTTP 401 / empty data / unexpected envelope fail instead of success',()=> {
  assert.throws(()=>envelope({status:401,json:{code:0,data:{}}}),/AUTH_REJECTED/);
  assert.throws(()=>envelope({status:200,json:{}}),/INVALID_ENVELOPE/);
  assert.throws(()=>envelope({status:200,json:{code:0}}),/MISSING_DATA/);
});
test('already signed does not issue claim',async()=> {
  const t=sequence([{today_checked_in:true}]);assert.equal((await sign(t,true)).result,'already');assert.equal(t.calls.length,1);
});
test('read-only sign check never claims',async()=> {
  const t=sequence([{today_checked_in:false}]);assert.equal((await sign(t,false)).result,'pending');assert.equal(t.calls.length,1);
});
test('unknown credit is null, no invented +100',async()=> {
  const t=sequence([{today_checked_in:false},{},{today_checked_in:true}]);
  const result=await sign(t,true);assert.equal(result.gained,null);assert.equal(result.result,'success');
});
test('ambiguous sign write reconciles without replay',async()=> {
  const t=sequence([{today_checked_in:false},new Failure('NETWORK_ERROR'),{today_checked_in:true}]);
  assert.equal((await sign(t,true)).result,'confirmed_after_error');
  assert.equal(t.calls.filter(x=>x.path.endsWith('/daily-checkin')).length,1);
});
test('successful claim rechecks daily limit before departure',async()=> {
  const t=sequence([{state:'completed'}, {reward_credit:8}, {state:'idle',daily_limit_reached:true}]);
  const result=await travel(t,true);assert.equal(result.result,'daily_limit');assert.equal(result.claim.gained,8);assert.equal(t.calls.length,3);
});
test('traveling skips departure',async()=> {
  const t=sequence([{state:'traveling'}]);assert.equal((await travel(t,true)).result,'waiting');assert.equal(t.calls.length,1);
});
test('departure timeout does not try another write path',async()=> {
  const t=sequence([{state:'idle',daily_limit_reached:false},{locations:[{id:1,unlocked:true}]},new Failure('NETWORK_ERROR'),{state:'traveling'}]);
  assert.equal((await travel(t,true)).result,'depart_confirmed_after_error');
  assert.equal(t.calls.filter(x=>x.path.endsWith('/depart')).length,1);
});
test('arrived alias claims; unknown state fails',async()=> {
  const t=sequence([{state:'arrived'},{reward_credit:3},{state:'idle',daily_limit_reached:true}]);
  assert.equal((await travel(t,true)).claim.gained,3);
  await assert.rejects(travel(sequence([{state:'new_unrecognized_state'}]),true),/TRAVEL_STATE_CHANGED/);
});
test('only completed tasks on allowlist claim; no accept/report/model calls',async()=> {
  const t=sequence([{tasks:[{task_code:'one',accept_status:'completed'},{task_code:'two',accept_status:'completed'},{task_code:'three',accept_status:'accepted'}]},
    {credit:5},{tasks:[{task_code:'one',accept_status:'claimed'}]}]);
  assert.equal((await completed(t,true,['one','three'])).claimed,1);
  assert.deepEqual(t.calls.filter(x=>x.method==='POST').map(x=>x.path),['/activity/growth/tasks/one/claim']);
});
test('business failure makes report fail; raw message and tokens are absent',async()=> {
  const t={request:async()=>({status:200,json:{code:400,msg:'SECRET_IN_ERROR',data:{accessToken:'PRIVATE_TOKEN'}}})};
  const report=await run(t,{execute:true,travel:false,completed:false});
  assert.equal(report.ok,false);assert.equal(report.actions.signin.reason,'BUSINESS_REJECTED');assert.ok(!JSON.stringify(report).includes('SECRET'));
});
test('wildcard only claims completed tasks with valid path codes',async()=> {
  const t=sequence([{tasks:[{task_code:'earned',accept_status:'completed'},{task_code:'pending',accept_status:'accepted'},{task_code:'../invalid',accept_status:'completed'}]},
    {credit:2},{tasks:[{task_code:'earned',accept_status:'claimed'}]}]);
  assert.equal((await completed(t,true,['*'])).claimed,1);
  assert.equal(t.calls.filter(x=>x.method==='POST').length,1);
});
test('business-envelope 401 is identified as an auth failure',()=> {
  assert.throws(()=>envelope({status:200,json:{code:401,data:{}}}),/AUTH_REJECTED/);
});
