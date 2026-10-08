'use strict';
const fs=require('node:fs'),path=require('node:path');
const {run,Failure}=require('./engine');
async function main() {
  const args=process.argv.slice(2);
  if(args.includes('--help')){console.log('Local: node main.js --local --check|--execute. Cloud: use the daily GitHub workflow.');return;}
  if(args.includes('--cloud')){await (await import('./buddy_ci.mjs')).main(['tasks']);return;}
  if(args.length!==2 || !args.includes('--local') || (!args.includes('--check') && !args.includes('--execute')))throw new Failure('INVALID_ARGUMENTS');
  const transport=await require('./ipc').connect();let report;
  try {const config=JSON.parse(fs.readFileSync(path.join(__dirname,'config.json'),'utf8'));report=await run(transport,{...config,execute:args.includes('--execute')});}
  finally {transport.close();}
  console.log(JSON.stringify(report,null,2));if(!report.ok)process.exitCode=1;
}
if(require.main===module)main().catch(e=>{console.error(JSON.stringify({ok:false,reason:e instanceof Failure ? e.reason:'INTERNAL_ERROR'}));process.exitCode=1;});
