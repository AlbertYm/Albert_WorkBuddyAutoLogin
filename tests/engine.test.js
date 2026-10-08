'use strict';
const test=require('node:test'), assert=require('node:assert/strict');
const {Failure,envelope,sign,travel,completed,run}=require('../engine');
const cloud=require('../cloud');
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
const jwt=exp=>`header.${Buffer.from(JSON.stringify({exp})).toString('base64url')}.sig`;
const auth={uid:'test-user',domain:'www.workbuddy.cn',accessToken:jwt(101),refreshToken:'test-rt'};
const env={GITHUB_REPOSITORY:'test/repo',WB_SECRET_WRITE_TOKEN:'test-write'};
test('credentials reject untrusted host and encrypted JSON values',()=> {
  assert.throws(()=>cloud.validate({...auth,domain:'attacker.example'}),/INVALID_AUTH/);
  assert.throws(()=>cloud.validate({...auth,accessToken:{$wbEncrypted:1}}),/INVALID_AUTH/);
});
test('expired access-only token fails',async()=> {
  await assert.rejects(cloud.prepare({...auth,refreshToken:''},{execute:true,now:200}),/ACCESS_TOKEN_EXPIRED/);
});
test('check does not refresh or write secrets',async()=> {
  let touched=false;await cloud.prepare(auth,{execute:false,now:100,http:()=>{touched=true;},persist:()=>{touched=true;}});assert.equal(touched,false);
});
test('missing secret writer stops BEFORE consuming refresh token',async()=> {
  let touched=false;
  await assert.rejects(cloud.prepare(auth,{execute:true,now:100,env:{},http:()=>{touched=true;}}),/SECRET_WRITER_REQUIRED/);assert.equal(touched,false);
});
test('rotated AT and RT persist together before returning transport auth',async()=> {
  let stored;
  const prepared=await cloud.prepare(auth,{execute:true,now:100,env,http:async()=>reply({accessToken:jwt(200000),refreshToken:'new-rt'}),persist:async value=>{stored=value;}});
  assert.equal(stored.refreshToken,'new-rt');assert.equal(stored.accessToken,prepared.auth.accessToken);assert.equal(prepared.info.refresh,'saved');
});
test('secret write failure aborts; never continue with old/new unsaved auth',async()=> {
  await assert.rejects(cloud.prepare(auth,{execute:true,now:100,env,http:async()=>reply({accessToken:jwt(200000),refreshToken:'new-rt'}),persist:async()=>{throw new Failure('SECRET_PERSIST_FAILED');}}),/SECRET_PERSIST_FAILED/);
});
test('missing rotated RT fails explicitly',async()=> {
  await assert.rejects(cloud.prepare(auth,{execute:true,now:100,env,http:async()=>reply({accessToken:jwt(200000)}),persist:()=>{throw Error('must not persist');}}),/REFRESH_SCHEMA_CHANGED/);
});
test('https redirect is not followed',async()=> {
  const https=require('https'),{EventEmitter}=require('events');const original=https.request;let requests=0;
  https.request=(options,callback)=> {
    requests++;assert.equal(options.rejectUnauthorized,true);assert.equal(options.hostname,'www.workbuddy.cn');
    const req=new EventEmitter();req.setTimeout=()=>{};req.write=()=>{};req.end=()=> {
      const res=new EventEmitter();res.statusCode=302;res.headers={location:'https://attacker.example'};callback(res);res.emit('end');
    };return req;
  };
  try {const result=await cloud.request('www.workbuddy.cn','GET','/test',{},{});assert.equal(result.status,302);assert.equal(requests,1);assert.throws(()=>envelope(result),/HTTP_REJECTED/);}
  finally {https.request=original;}
});
