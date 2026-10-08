'use strict';
const fs=require('fs'), path=require('path'), os=require('os');
const {run,Failure}=require('./engine');
async function main() {
  const args=process.argv.slice(2);
  if(args.includes('--help')) {console.log('node main.js --cloud|--local --check|--execute');return;}
  if(args.some(x => !['--cloud','--local','--check','--execute'].includes(x)) ||
    args.filter(x=>['--local','--cloud'].includes(x)).length!==1 || args.filter(x=>['--execute','--check'].includes(x)).length!==1) throw new Failure('INVALID_ARGUMENTS');
  const execute=args.includes('--execute');
  const config=JSON.parse(fs.readFileSync(path.join(__dirname,'config.json'),'utf8'));
  // Same-user lock also protects concurrent old/new GitHub runs on this machine.
  const lockPath=path.join(os.tmpdir(),'workbuddy-unified.lock');
  let lock;
  try {lock=fs.openSync(lockPath,'wx',0o600);fs.writeFileSync(lock,String(process.pid));}
  catch {throw new Failure('LOCAL_RUN_LOCKED');}
  let transport,report;
  try {
    let authInfo;
    if(args.includes('--cloud')) {
      const cloud=require('./cloud');let input;
      try {input=JSON.parse(process.env.WORKBUDDY_AUTH || '');} catch {throw new Failure('AUTH_SECRET_MISSING_OR_INVALID');}
      const prepared=await cloud.prepare(input,{execute});transport=cloud.transport(prepared.auth);authInfo=prepared.info;
    } else {transport=await require('./ipc').connect();authInfo={source:'local_ipc'};}
    report=await run(transport,{...config,execute});report.auth=authInfo;
  } catch(e) {report={version:1,time:new Date().toISOString(),ok:false,reason:e instanceof Failure ? e.reason:'INTERNAL_ERROR'};}
  finally {transport?.close();fs.closeSync(lock);fs.unlinkSync(lockPath);}
  fs.mkdirSync(path.join(__dirname,'runtime'),{recursive:true});
  fs.writeFileSync(path.join(__dirname,'runtime','report.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
  if(process.env.GITHUB_STEP_SUMMARY) {
    const lines=['### WorkBuddy execution',`Time: ${report.time}`,`Result: ${report.ok ? 'OK':'FAILED'}`];
    for(const [name,item] of Object.entries(report.actions || {})) lines.push(`- ${name}: ${item.result}${item.reason ? ' / '+item.reason:''}${item.gained !== null && item.gained !== undefined ? ' / credit '+item.gained:''}`);
    if(report.reason) lines.push(`Reason: ${report.reason}`);
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,lines.join('\n')+'\n');
  }
  if(!report.ok) process.exitCode=1;
}
if(require.main===module) main().catch(e => {console.error(JSON.stringify({ok:false,reason:e instanceof Failure ? e.reason:'INTERNAL_ERROR'}));process.exitCode=1;});
module.exports={main};
