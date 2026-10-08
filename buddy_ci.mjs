// GitHub-hosted execution. Plain credentials never leave memory or GitHub Secrets.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import engine from './engine.js';
import gateway from './gateway.js';
import vault from './auth-state.js';
const root=path.dirname(fileURLToPath(import.meta.url));
const {Failure}=engine;
function output(values,env=process.env) {
  if(env.GITHUB_OUTPUT)fs.appendFileSync(env.GITHUB_OUTPUT,Object.entries(values).map(([k,v])=>`${k}=${v}`).join('\n')+'\n');
}
function summary(value,env=process.env) {
  if(env.GITHUB_STEP_SUMMARY)fs.appendFileSync(env.GITHUB_STEP_SUMMARY,'```json\n'+JSON.stringify(value,null,2)+'\n```\n');
}
export async function prepare({env=process.env,file=vault.stateFile,http=gateway.request,now=Date.now()/1000,checkpoint=vault.save,emit=output}={}) {
  const restored=vault.restore(env,file,now);let state=restored.state,refreshed=false,renewal;
  const store=()=>{state.snapshotAt=new Date().toISOString();checkpoint(state,env.WB_REFRESH_TOKEN,env.GITHUB_REPOSITORY,file);emit({state_written:'true'},env);};
  const renew=async()=> {
    const before=state.auth;
    const auth=await gateway.refresh(state.auth,http,now);
    const oldAT=gateway.jwtExpiry(before.accessToken),newAT=gateway.jwtExpiry(auth.accessToken);
    const oldRT=gateway.jwtExpiry(before.refreshToken),newRT=gateway.jwtExpiry(auth.refreshToken);
    renewal={accessTokenChanged:auth.accessToken!==before.accessToken,refreshTokenChanged:auth.refreshToken!==before.refreshToken,
      accessExpiryExtended:oldAT!==null && newAT!==null ? newAT>oldAT:null,
      refreshExpiryExtended:oldRT!==null && newRT!==null ? newRT>oldRT:null};
    state={...state,generation:state.generation+1,auth,refreshedAt:new Date().toISOString()};refreshed=true;
    // Write encrypted checkpoint before any further request, even if subsequent verification fails.
    store();
  };
  if(env.WB_FORCE_REFRESH==='true' || vault.due(state.auth,now))await renew();else store();
  const probe=async()=> {
    const status=await engine.call(gateway.transport(state.auth,http),['/v2/billing/meter/checkin-activity-status'],'POST',{},true);
    if(typeof status.today_checked_in!=='boolean')throw new Failure('SIGN_STATUS_CHANGED');
  };
  try{await probe();}
  catch(e){if(e.reason!=='AUTH_REJECTED' || refreshed)throw e;await renew();await probe();}
  return {ok:true,stage:'auth',source:restored.source,refreshed,...vault.info(state,now),...(renewal ? {renewal}:{})};
}
export async function tasks({env=process.env,file=vault.stateFile,http=gateway.request}={}) {
  if(!/^\d+$/.test(env.WB_PERSISTED_ARTIFACT_ID || ''))throw new Failure('STATE_NOT_PERSISTED');
  const state=vault.load(env.WB_REFRESH_TOKEN,env.GITHUB_REPOSITORY,file);
  const config=JSON.parse(fs.readFileSync(path.join(root,'config.json'),'utf8'));
  const execute=env.WB_ACTION!=='check';
  const report=await engine.run(gateway.transport(state.auth,http),{...config,execute});
  report.auth={source:'encrypted_artifact',...vault.info(state)};
  report.persistence={saved:true,artifactId:Number(env.WB_PERSISTED_ARTIFACT_ID)};
  return report;
}
export async function main(args=process.argv.slice(2)) {
  let report;
  try {
    if(args[0]==='select'){const selected=await vault.select();output(selected);console.log(JSON.stringify({ok:true,stage:'restore',found:selected.found==='true'}));return;}
    if(args[0]==='prepare')report=await prepare();
    else if(args.length===0 || args[0]==='tasks')report=await tasks();
    else throw new Failure('INVALID_ARGUMENTS');
  } catch(e) {report={ok:false,stage:args[0] || 'tasks',reason:e instanceof Failure ? e.reason:'INTERNAL_ERROR',code:e instanceof Failure ? e.code:undefined};}
  console.log(JSON.stringify(report,null,2));summary(report);
  if(!report.ok)process.exitCode=1;
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
