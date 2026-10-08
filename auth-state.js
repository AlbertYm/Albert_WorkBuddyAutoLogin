'use strict';
const crypto=require('node:crypto'),fs=require('node:fs'),path=require('node:path');
const {Failure}=require('./engine');
const {validate,jwtExpiry}=require('./gateway');
const ARTIFACT='wb-auth-state-v1';
const stateFile=path.join(__dirname,'runtime','auth-state.json');
function context(seed,repo) {
  if(typeof seed!=='string' || !seed || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo || '')) throw new Failure('STATE_KEY_MISSING');
  const key=Buffer.from(crypto.hkdfSync('sha256',Buffer.from(seed),Buffer.from('workbuddy-unified'),Buffer.from(`state-v1:${repo}`),32));
  return {key,keyId:crypto.createHash('sha256').update(key).digest('hex').slice(0,16),aad:Buffer.from(`${ARTIFACT}:${repo}`)};
}
function encode(state,seed,repo) {
  const {key,keyId,aad}=context(seed,repo);
  const iv=crypto.randomBytes(12);
  try {
    const cipher=crypto.createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(aad);
    const ciphertext=Buffer.concat([cipher.update(JSON.stringify(state),'utf8'),cipher.final()]);
    return {schema:1,repo,keyId,iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext:ciphertext.toString('base64')};
  } finally {key.fill(0);}
}
function bytes(value,length) {
  if(typeof value!=='string' || value.length>131072) throw new Failure('STATE_INVALID');
  const data=Buffer.from(value,'base64');
  if(data.toString('base64')!==value || (length!==undefined && data.length!==length)) throw new Failure('STATE_INVALID');
  return data;
}
function decode(encoded,seed,repo) {
  const {key,keyId,aad}=context(seed,repo);
  let plaintext;
  try {
    if(!encoded || encoded.schema!==1 || encoded.repo!==repo || encoded.keyId!==keyId) throw new Failure('STATE_KEY_CHANGED');
    const decipher=crypto.createDecipheriv('aes-256-gcm',key,bytes(encoded.iv,12));decipher.setAAD(aad);decipher.setAuthTag(bytes(encoded.tag,16));
    plaintext=Buffer.concat([decipher.update(bytes(encoded.ciphertext)),decipher.final()]);
    const state=JSON.parse(plaintext.toString('utf8'));validate(state.auth);
    if(state.schema!==1 || !Number.isSafeInteger(state.generation) || state.generation<0) throw new Failure('STATE_INVALID');
    return state;
  } catch(e) {throw e instanceof Failure ? e:new Failure('STATE_AUTHENTICATION_FAILED');}
  finally {key.fill(0);plaintext?.fill(0);}
}
function save(state,seed,repo,file=stateFile) {
  fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
  const temporary=file+'.tmp';
  fs.writeFileSync(temporary,JSON.stringify(encode(state,seed,repo))+'\n',{mode:0o600});fs.renameSync(temporary,file);
}
function load(seed,repo,file=stateFile) {
  try {return decode(JSON.parse(fs.readFileSync(file,'utf8')),seed,repo);}
  catch(e) {if(e instanceof Failure)throw e;throw new Failure('STATE_READ_FAILED');}
}
function restore(env=process.env,file=stateFile,now=Date.now()/1000) {
  if(fs.existsSync(file)) return {state:load(env.WB_REFRESH_TOKEN,env.GITHUB_REPOSITORY,file),source:'artifact'};
  if(env.WB_ARTIFACT_FOUND==='true') throw new Failure('STATE_DOWNLOAD_MISSING');
  const auth=validate({accessToken:env.WB_ACCESS_TOKEN,refreshToken:env.WB_REFRESH_TOKEN});
  const exp=jwtExpiry(auth.refreshToken);
  if(exp!==null && exp<=now) throw new Failure('STATE_MISSING_AND_SEED_EXPIRED');
  return {state:{schema:1,generation:0,auth},source:'initial_secrets'};
}
function due(auth,now=Date.now()/1000) {
  const at=jwtExpiry(auth.accessToken),rt=jwtExpiry(auth.refreshToken);
  return at===null || rt===null || at-now<=5*86400 || rt-now<=7*86400;
}
function info(state,now=Date.now()/1000) {
  const days=token=>{const exp=jwtExpiry(token);return exp===null ? null:Math.floor((exp-now)/86400);};
  return {generation:state.generation,accessRemainingDays:days(state.auth.accessToken),refreshRemainingDays:days(state.auth.refreshToken)};
}
function artifactName(seed,repo) {
  const {key,keyId}=context(seed,repo);key.fill(0);return `${ARTIFACT}-${keyId}`;
}
function latest(artifacts,name=ARTIFACT) {
  if(!Array.isArray(artifacts)) throw new Failure('ARTIFACT_LIST_INVALID');
  return artifacts.filter(x=>x.name===name && x.expired===false && Number.isSafeInteger(x.id) &&
    Number.isSafeInteger(x.workflow_run?.id) && x.workflow_run?.head_branch==='main' && Number.isFinite(Date.parse(x.created_at)))
    .sort((a,b)=>Date.parse(b.created_at)-Date.parse(a.created_at) || b.workflow_run.id-a.workflow_run.id || b.id-a.id)[0] || null;
}
async function select(env=process.env,http=fetch) {
  if(!env.GITHUB_TOKEN || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(env.GITHUB_REPOSITORY || '')) throw new Failure('GITHUB_STATE_ACCESS_MISSING');
  const name=artifactName(env.WB_REFRESH_TOKEN,env.GITHUB_REPOSITORY);
  const artifacts=[];
  for(let page=1;page<=100;page++) {
    let response;
    try {response=await http(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}/actions/artifacts?name=${name}&per_page=100&page=${page}`, {
      headers:{Authorization:`Bearer ${env.GITHUB_TOKEN}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'},redirect:'error',signal:AbortSignal.timeout(25000),
    });} catch {throw new Failure('ARTIFACT_LIST_NETWORK_FAILED');}
    if(response.status!==200) throw new Failure('ARTIFACT_LIST_REJECTED',response.status);
    let data;try{data=await response.json();}catch{throw new Failure('ARTIFACT_LIST_INVALID');}
    if(!Array.isArray(data.artifacts)) throw new Failure('ARTIFACT_LIST_INVALID');
    artifacts.push(...data.artifacts);
    if(data.artifacts.length<100) break;
    if(page===100) throw new Failure('ARTIFACT_LIST_LIMIT');
  }
  const selected=latest(artifacts,name);
  return selected ? {found:'true',artifact_name:name,artifact_id:String(selected.id),run_id:String(selected.workflow_run.id)}:{found:'false',artifact_name:name};
}
module.exports={ARTIFACT,stateFile,encode,decode,save,load,restore,due,info,latest,select,artifactName};
