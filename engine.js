'use strict';
// Shared task engine. Transport and credentials stay outside business logic.
class Failure extends Error {
  constructor(reason, code) { super(reason); this.reason = reason; this.code = typeof code === 'number' ? code : undefined; }
}
const obj = x => x && typeof x === 'object' && !Array.isArray(x);
const number = x => typeof x === 'number' && Number.isFinite(x) ? x : null;
function envelope(r) {
  if (!r || !Number.isInteger(r.status)) throw new Failure('INVALID_HTTP_RESPONSE');
  if ([401, 403].includes(r.status)) throw new Failure('AUTH_REJECTED', r.status);
  if (r.status === 404) throw new Failure('PATH_NOT_FOUND', 404);
  if (r.status < 200 || r.status >= 300) throw new Failure('HTTP_REJECTED', r.status);
  if (!obj(r.json) || typeof r.json.code !== 'number') throw new Failure('INVALID_ENVELOPE');
  if (r.json.code !== 0) throw new Failure([401,403].includes(r.json.code) ? 'AUTH_REJECTED' : r.json.code === 404 ? 'PATH_NOT_FOUND' : 'BUSINESS_REJECTED', r.json.code);
  if (!obj(r.json.data) && !Array.isArray(r.json.data)) throw new Failure('MISSING_DATA');
  return r.json.data;
}
const P = {
  signStatus: ['/v2/billing/meter/checkin-activity-status', '/v2/billing/meter/checkin-status', '/billing/meter/checkin-status'],
  sign: ['/v2/billing/meter/daily-checkin', '/billing/meter/daily-checkin'],
  travelStatus: ['/activity/growth/buddy/travel/status', '/v2/activity/growth/buddy/travel/status'],
  travelConfig: ['/activity/growth/buddy/travel/config', '/v2/activity/growth/buddy/travel/config'],
  travelClaim: ['/activity/growth/buddy/travel/claim', '/v2/activity/growth/buddy/travel/claim'],
  depart: ['/activity/growth/buddy/travel/depart', '/v2/activity/growth/buddy/travel/depart'],
  tasks: ['/v2/activity/growth/tasks'],
};
async function call(transport, paths, method, body = {}, read = false) {
  for (let index = 0; index < paths.length; index++) {
    try {
      let response;
      for (let attempt = 0; ; attempt++) {
        try { response = await transport.request(method, paths[index], body); break; }
        catch (e) {
          if (!read || attempt >= 2 || e.reason !== 'NETWORK_ERROR') throw e;
        }
      }
      return envelope(response);
    } catch (e) {
      // A timeout can mean the write succeeded. Only an explicit 404 permits path fallback.
      if (e.reason !== 'PATH_NOT_FOUND' || index === paths.length - 1) throw e;
    }
  }
}
async function sign(transport, execute) {
  const status = () => call(transport, P.signStatus, 'POST', {}, true);
  const before = await status();
  if (typeof before.today_checked_in !== 'boolean') throw new Failure('SIGN_STATUS_CHANGED');
  if (before.today_checked_in) return {result:'already', gained:0, streakDays:number(before.streak_days)};
  if (!execute) return {result:'pending', gained:null};
  let reply, pendingError;
  try { reply = await call(transport, P.sign, 'POST'); }
  catch (e) { pendingError = e; }
  // Reconcile even an ambiguous write. Never replay the write in this invocation.
  const after = await status();
  if (after.today_checked_in !== true) throw pendingError || new Failure('SIGN_NOT_CONFIRMED');
  return {result: pendingError ? 'confirmed_after_error' : 'success', gained:number(reply?.credit), streakDays:number(after.streak_days)};
}
const stateOf = data => data.state || data.status || data.travel_status;
const moving = state => ['traveling','in_progress'].includes(state);
const arrived = state => ['completed','arrived'].includes(state);
const idle = state => ['idle','accepted','claimed','not_accepted'].includes(state);
async function travel(transport, execute) {
  const status = () => call(transport, P.travelStatus, 'GET', {}, true);
  let current = await status();
  let state = stateOf(current);
  const report = {state: moving(state) ? 'traveling' : arrived(state) ? 'completed' : idle(state) ? 'idle' : 'unknown'};
  if (report.state === 'unknown') throw new Failure('TRAVEL_STATE_CHANGED');
  if (!execute) return {...report, result:'checked'};
  if (moving(state)) return {...report, result:'waiting'};
  if (arrived(state)) {
    let claim, pendingError;
    try { claim = await call(transport, P.travelClaim, 'POST'); }
    catch (e) { pendingError = e; }
    current = await status(); state = stateOf(current);
    if (arrived(state) || (!idle(state) && !moving(state))) throw pendingError || new Failure('TRAVEL_CLAIM_NOT_CONFIRMED');
    report.claim = {result:pendingError ? 'confirmed_after_error':'success', gained:number(claim?.reward_credit ?? claim?.credit)};
  }
  // Use the post-claim state; a successful claim never overrides the daily cap.
  if (moving(state)) return {...report, result:'waiting'};
  if (current.daily_limit_reached === true) return {...report, result:'daily_limit'};
  if (!idle(state)) throw new Failure('TRAVEL_STATE_CHANGED');
  const config = await call(transport, P.travelConfig, 'GET', {}, true);
  const locations = Array.isArray(config) ? config : config.locations || config.list || config.items;
  if (!Array.isArray(locations)) throw new Failure('TRAVEL_CONFIG_CHANGED');
  const selected = locations.find(x => obj(x) && (x.location_id || x.id) && x.unlocked !== false && x.locked !== true);
  if (!selected) return {...report, result:'no_unlocked_location'};
  const locationId = selected.location_id || selected.id;
  if (!(typeof locationId === 'number' && Number.isFinite(locationId)) && !(typeof locationId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(locationId))) throw new Failure('INVALID_LOCATION');
  let pendingError;
  try { await call(transport, P.depart, 'POST', {location_id:locationId}); }
  catch (e) { pendingError = e; }
  const after = await status();
  if (!moving(stateOf(after))) throw pendingError || new Failure('DEPART_NOT_CONFIRMED');
  return {...report, result:pendingError ? 'depart_confirmed_after_error':'departed'};
}
async function completed(transport, execute, allowed) {
  if (!Array.isArray(allowed) || allowed.some(x => typeof x !== 'string' || (x !== '*' && !/^[A-Za-z0-9_-]{1,100}$/.test(x)))) throw new Failure('INVALID_TASK_ALLOWLIST');
  if (!allowed.length) return {result:'disabled', claimed:0};
  const list = async () => {
    const data = await call(transport, P.tasks, 'GET', {}, true);
    if (!Array.isArray(data.tasks)) throw new Failure('TASK_SCHEMA_CHANGED');
    return data.tasks;
  };
  const tasks = (await list()).filter(x => obj(x) && typeof x.task_code === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(x.task_code) &&
    (allowed.includes('*') || allowed.includes(x.task_code)) && x.accept_status === 'completed');
  if (!execute) return {result:'checked', pending:tasks.length};
  let claimed = 0, gained = 0, knownCredits = true;
  for (const task of tasks) {
    let reply, pendingError;
    try { reply = await call(transport, [`/activity/growth/tasks/${task.task_code}/claim`], 'POST'); }
    catch (e) { pendingError = e; }
    const after = (await list()).find(x => x.task_code === task.task_code);
    if (after?.accept_status !== 'claimed') throw pendingError || new Failure('TASK_CLAIM_NOT_CONFIRMED');
    claimed++;
    if (number(reply?.credit) === null) knownCredits = false; else gained += reply.credit;
  }
  return {result:'success', claimed, gained:knownCredits ? gained:null};
}
async function run(transport, options) {
  const report = {version:1, time:new Date().toISOString(), timezone:'Asia/Shanghai', mode:options.execute ? 'execute':'check', ok:true, actions:{}};
  const actions = {signin:() => sign(transport, options.execute), travel:() => travel(transport, options.execute), completed:() => completed(transport, options.execute, options.claimTaskCodes || [])};
  for (const [name, action] of Object.entries(actions)) {
    if (options[name] === false) { report.actions[name] = {result:'disabled'}; continue; }
    try { report.actions[name] = await action(); }
    catch (e) {
      report.ok = false;
      report.actions[name] = {result:'failed', reason:e instanceof Failure ? e.reason:'INTERNAL_ERROR', code:e instanceof Failure ? e.code:undefined};
      if (e.reason === 'AUTH_REJECTED') break;
    }
  }
  return report;
}
module.exports = {Failure, envelope, run, sign, travel, completed, call, number};
