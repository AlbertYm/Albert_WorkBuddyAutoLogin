'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const vault=require('../auth-state'),gateway=require('../gateway');
const {Failure}=require('../engine');
const jwt=exp=>`header.${Buffer.from(JSON.stringify({exp})).toString('base64url')}.sig`;
const auth=(at,rt)=>({accessToken:jwt(at),refreshToken:jwt(rt)});
const repo='test/private-repo',seed=jwt(30*86400),initial=auth(28*86400,30*86400);
const env={GITHUB_REPOSITORY:repo,WB_ACCESS_TOKEN:initial.accessToken,WB_REFRESH_TOKEN:seed};
const reply=data=>({status:200,json:{code:0,data}});
function temporary(t) {
  const directory=fs.mkdtempSync(path.join(__dirname,'tmp-'));
  t.after(()=> {
    const resolved=path.resolve(directory);
    if(!resolved.startsWith(path.resolve(__dirname)+path.sep+'tmp-'))throw Error('unsafe test cleanup');
    fs.rmSync(resolved,{recursive:true});
  });
  return path.join(directory,'auth-state.json');
}
test('AES-GCM round trip stores neither raw AT nor RT',()=> {
  const state={schema:1,generation:7,auth:auth(60*86400,62*86400)};
  const encoded=vault.encode(state,seed,repo),serialized=JSON.stringify(encoded);
  assert.ok(!serialized.includes(state.auth.accessToken));assert.ok(!serialized.includes(state.auth.refreshToken));
  assert.deepEqual(vault.decode(encoded,seed,repo),state);
});
test('ciphertext tampering fails authenticated decryption',()=> {
  const encoded=vault.encode({schema:1,generation:1,auth:initial},seed,repo);
  const bytes=Buffer.from(encoded.ciphertext,'base64');bytes[0]^=1;encoded.ciphertext=bytes.toString('base64');
  assert.throws(()=>vault.decode(encoded,seed,repo),/STATE_AUTHENTICATION_FAILED/);
});
test('different repository or seed cannot decode the checkpoint',()=> {
  const encoded=vault.encode({schema:1,generation:1,auth:initial},seed,repo);
  assert.throws(()=>vault.decode(encoded,seed,'other/repo'),/STATE_KEY_CHANGED/);
  assert.throws(()=>vault.decode(encoded,'other-seed',repo),/STATE_KEY_CHANGED/);
});
test('each snapshot has a new random nonce',()=> {
  const state={schema:1,generation:0,auth:initial};
  assert.notEqual(vault.encode(state,seed,repo).iv,vault.encode(state,seed,repo).iv);
});
test('expired 30-day seed still decrypts renewed state at day 40',t=> {
  const file=temporary(t),current={schema:1,generation:1,auth:auth(65*86400,67*86400)};
  vault.save(current,seed,repo,file);
  const restored=vault.restore({...env,WB_ARTIFACT_FOUND:'true'},file,40*86400);
  assert.equal(restored.source,'artifact');assert.deepEqual(restored.state.auth,current.auth);
});
test('missing state with expired seed fails instead of reusing old RT',t=> {
  assert.throws(()=>vault.restore(env,temporary(t),40*86400),/STATE_MISSING_AND_SEED_EXPIRED/);
});
test('failed download never falls back to seed',t=> {
  assert.throws(()=>vault.restore({...env,WB_ARTIFACT_FOUND:'true'},temporary(t),1),/STATE_DOWNLOAD_MISSING/);
});
test('rotated pair is saved before probe, even when probe fails',async t=> {
  const {prepare}=await import('../buddy_ci.mjs'),file=temporary(t);const outputs=[];
  let calls=0;
  await assert.rejects(prepare({env:{...env,WB_FORCE_REFRESH:'true'},file,now:1,emit:value=>outputs.push(value),http:async(_method,pathname)=> {
    calls++;
    if(pathname.endsWith('/refresh'))return reply(auth(60*86400,62*86400));
    assert.equal(vault.load(seed,repo,file).generation,1);
    return {status:401,json:{}};
  }}),/AUTH_REJECTED/);
  assert.equal(calls,2);assert.equal(vault.load(seed,repo,file).generation,1);assert.ok(outputs.some(x=>x.state_written==='true'));
});
test('401 with unexpired AT renews exactly once and verifies again',async t=> {
  const {prepare}=await import('../buddy_ci.mjs');let probes=0,refreshes=0;
  const result=await prepare({env,file:temporary(t),now:1,emit:()=>{},http:async(_method,pathname)=> {
    if(pathname.endsWith('/refresh')){refreshes++;return reply(auth(60*86400,62*86400));}
    probes++;return probes===1 ? {status:401,json:{}}:reply({today_checked_in:true});
  }});
  assert.equal(result.refreshed,true);assert.equal(refreshes,1);assert.equal(probes,2);
});
test('separate second invocation restores new pair without refresh',async t=> {
  const {prepare}=await import('../buddy_ci.mjs'),file=temporary(t);let refreshes=0;
  const http=async(_method,pathname)=> {
    if(pathname.endsWith('/refresh')){refreshes++;return reply(auth(60*86400,62*86400));}
    return reply({today_checked_in:true});
  };
  const first=await prepare({env:{...env,WB_FORCE_REFRESH:'true'},file,now:1,http,emit:()=>{}});
  const second=await prepare({env:{...env,WB_ARTIFACT_FOUND:'true'},file,now:40*86400,http,emit:()=>{}});
  assert.equal(first.generation,1);assert.equal(second.generation,1);assert.equal(second.source,'artifact');assert.equal(second.refreshed,false);assert.equal(refreshes,1);
});
test('state persistence failure prevents business probe',async t=> {
  const {prepare}=await import('../buddy_ci.mjs');let calls=0;
  await assert.rejects(prepare({env:{...env,WB_FORCE_REFRESH:'true'},file:temporary(t),now:1,emit:()=>{},checkpoint:()=>{throw new Failure('DISK_WRITE_FAILED');},
    http:async()=>{calls++;return reply(auth(60*86400,62*86400));}}),/DISK_WRITE_FAILED/);
  assert.equal(calls,1);
});
test('tasks never execute without successful artifact upload',async()=> {
  const {tasks}=await import('../buddy_ci.mjs');let called=false;
  await assert.rejects(tasks({env,http:()=>{called=true;}}),/STATE_NOT_PERSISTED/);assert.equal(called,false);
});
test('latest includes checkpoint from a failed business run',()=> {
  const artifact=(id,expired=false,branch='main')=>({id,name:vault.ARTIFACT,expired,workflow_run:{id:id+100,head_branch:branch},conclusion:'failure'});
  assert.equal(vault.latest([artifact(1),artifact(4,true),artifact(5,false,'feature'),artifact(3)]).id,3);
});
test('artifact API errors abort instead of bootstrapping old seed',async()=> {
  await assert.rejects(vault.select({...env,GITHUB_TOKEN:'mock'},async()=>({status:403})),/ARTIFACT_LIST_REJECTED/);
});
test('seed rotation starts a separate artifact family',()=> {
  assert.notEqual(vault.artifactName(seed,repo),vault.artifactName(jwt(90*86400),repo));
});
test('normal auth does not refresh prematurely, but checks both expiry dates',()=> {
  assert.equal(vault.due(initial,1),false);
  assert.equal(vault.due(auth(50*86400,6*86400),1),true);
  assert.equal(vault.due(auth(4*86400,60*86400),1),true);
});
test('refresh rejects missing RT and unexpected response schema',async()=> {
  await assert.rejects(gateway.refresh(initial,async()=>reply({accessToken:jwt(60*86400)}),1),/AUTH_FORMAT_INVALID/);
  await assert.rejects(gateway.refresh(initial,async()=>({status:200,json:{}}),1),/INVALID_ENVELOPE/);
});
test('refresh transport error is not blindly retried',async()=> {
  let calls=0;await assert.rejects(gateway.refresh(initial,async()=>{calls++;throw new Failure('NETWORK_ERROR');},1),/NETWORK_ERROR/);assert.equal(calls,1);
});
test('HTTPS is validated and redirects are not followed',async()=> {
  const https=require('node:https'),{EventEmitter}=require('node:events');const original=https.request;let calls=0;
  https.request=(options,callback)=> {
    calls++;assert.equal(options.hostname,'copilot.tencent.com');assert.equal(options.rejectUnauthorized,true);
    const req=new EventEmitter();req.setTimeout=()=>{};req.write=()=>{};req.end=()=>{const res=new EventEmitter();res.statusCode=302;callback(res);res.emit('end');};return req;
  };
  try{const result=await gateway.request('GET','/test');assert.equal(result.status,302);assert.equal(calls,1);}
  finally{https.request=original;}
});
