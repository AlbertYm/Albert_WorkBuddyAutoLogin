'use strict';
const https = require('https');
const {spawnSync} = require('child_process');
const {Failure, envelope} = require('./engine');
const HOSTS = new Set(['www.workbuddy.cn','www.codebuddy.cn']);
const validToken = x => typeof x === 'string' && x.length > 0 && x.length <= 32768 && /^[A-Za-z0-9._~+\/-]+=*$/.test(x);
function expiry(token) {
  try { const exp = JSON.parse(Buffer.from(token.split('.')[1], 'base64url')).exp; return Number.isFinite(exp) ? exp : null; }
  catch { return null; }
}
function validate(auth) {
  if (!auth || !validToken(auth.accessToken) || (auth.refreshToken && !validToken(auth.refreshToken)) ||
    typeof auth.uid !== 'string' || !/^[\x21-\x7e]{1,2048}$/.test(auth.uid) || !HOSTS.has(auth.domain)) throw new Failure('INVALID_AUTH');
  if (auth.enterpriseId && (typeof auth.enterpriseId !== 'string' || !/^[\x21-\x7e]{1,2048}$/.test(auth.enterpriseId))) throw new Failure('INVALID_AUTH');
  return {accessToken:auth.accessToken, refreshToken:auth.refreshToken || '', uid:auth.uid, domain:auth.domain, enterpriseId:auth.enterpriseId || ''};
}
function request(host, method, pathname, body, headers) {
  if (!HOSTS.has(host) && host !== 'copilot.tencent.com') return Promise.reject(new Failure('HOST_NOT_ALLOWED'));
  if (!pathname.startsWith('/') || pathname.startsWith('//') || /[\r\n?#]/.test(pathname)) return Promise.reject(new Failure('PATH_NOT_ALLOWED'));
  return new Promise((resolve, reject) => {
    const content = Buffer.from(JSON.stringify(body || {}));
    const req = https.request({hostname:host, port:443, path:pathname, method, headers:{Accept:'application/json','Content-Type':'application/json','User-Agent':'WorkBuddy',...headers,...(method === 'POST' ? {'Content-Length':content.length}:{})}, rejectUnauthorized:true}, res => {
      // https.request never follows redirects; credentials cannot cross hosts.
      let bytes = 0, chunks = [];
      res.on('data', chunk => { bytes += chunk.length; if (bytes > 1024*1024) { res.destroy(); reject(new Failure('RESPONSE_TOO_LARGE')); } else chunks.push(chunk); });
      res.on('error', () => reject(new Failure('NETWORK_ERROR')));
      res.on('end', () => { let json; try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {} resolve({status:res.statusCode,json}); });
    });
    req.setTimeout(25000, () => req.destroy());
    req.on('error', () => reject(new Failure('NETWORK_ERROR')));
    if (method === 'POST') req.write(content);
    req.end();
  });
}
function saveSecret(auth, env = process.env) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(env.GITHUB_REPOSITORY || '') || !env.WB_SECRET_WRITE_TOKEN) throw new Failure('SECRET_WRITER_REQUIRED');
  const result = spawnSync('gh', ['secret','set','WORKBUDDY_AUTH','--repo',env.GITHUB_REPOSITORY], {
    input:JSON.stringify(auth), encoding:'utf8', timeout:30000, windowsHide:true,
    env:{...env, GH_TOKEN:env.WB_SECRET_WRITE_TOKEN, GH_HOST:'github.com'}, maxBuffer:65536,
  });
  // No subprocess output is forwarded: error text may contain private context.
  if (result.error || result.status !== 0) throw new Failure('SECRET_PERSIST_FAILED');
}
async function prepare(auth, {execute = false, env = process.env, http = request, persist = saveSecret, now = Date.now()/1000} = {}) {
  auth = validate(auth);
  const exp = expiry(auth.accessToken);
  const remaining = exp === null ? null : Math.floor((exp-now)/86400);
  if (!execute) {
    if (exp !== null && exp <= now) throw new Failure('ACCESS_TOKEN_EXPIRED');
    return {auth, info:{source:'cloud', remainingDays:remaining, refresh:'not_run_in_check'}};
  }
  // Opaque tokens refresh when RT exists; JWT tokens refresh within one day of expiry.
  if (auth.refreshToken && (exp === null || exp-now < 86400)) {
    // Ensure the persistence path is configured BEFORE consuming a potentially single-use RT.
    if (!env.WB_SECRET_WRITE_TOKEN || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(env.GITHUB_REPOSITORY || '')) throw new Failure('SECRET_WRITER_REQUIRED');
    const data = envelope(await http('copilot.tencent.com', 'POST', '/v2/plugin/auth/token/refresh', {}, {
      'X-Refresh-Token':auth.refreshToken,'X-Auth-Refresh-Source':'plugin','X-Domain':'copilot.tencent.com',
    }));
    // Never assume a missing new RT remains valid after rotation.
    if (!validToken(data.accessToken) || !validToken(data.refreshToken)) throw new Failure('REFRESH_SCHEMA_CHANGED');
    auth = validate({...auth, accessToken:data.accessToken, refreshToken:data.refreshToken});
    const newExpiry = expiry(auth.accessToken);
    if (newExpiry !== null && newExpiry <= now) throw new Failure('REFRESH_RETURNED_EXPIRED_TOKEN');
    await persist(auth, env); // Persist both tokens as one Secret before any reward write.
    return {auth,info:{source:'cloud', remainingDays:newExpiry === null ? null:Math.floor((newExpiry-now)/86400), refresh:'saved'}};
  }
  if (exp !== null && exp <= now) throw new Failure('ACCESS_TOKEN_EXPIRED');
  return {auth,info:{source:'cloud',remainingDays:remaining,refresh:auth.refreshToken ? 'not_due':'manual_renewal_required'}};
}
function transport(auth) {
  const headers = {Authorization:`Bearer ${auth.accessToken}`, 'X-User-Id':auth.uid,'X-Domain':auth.domain};
  if (auth.enterpriseId) { headers['X-Enterprise-Id']=auth.enterpriseId; headers['X-Tenant-Id']=auth.enterpriseId; }
  return {request:(method, pathname, body) => request(auth.domain,method,pathname,body,headers),close:() => {}};
}
module.exports = {validate, expiry, prepare, transport, saveSecret, request};
