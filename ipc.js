'use strict';
// Protocol derived from the user's buddy_daily.js; no auth-file or token decoding.
const net = require('net'), crypto = require('crypto'), fs = require('fs'), path = require('path'), os = require('os');
const {Failure} = require('./engine');
function frame(role, protocol, endpoint, clientNonce, serverNonce) {
  const chunks=[];
  for (const part of [role === 'server' ? 'wbipc-s':'wbipc-c',String(protocol),endpoint,clientNonce,serverNonce]) {
    const bytes=Buffer.from(part,'utf8'), length=Buffer.alloc(4); length.writeUInt32BE(bytes.length); chunks.push(length,bytes);
  }
  return Buffer.concat(chunks);
}
async function connect() {
  let endpoint, ticket;
  try { ({endpoint,ticket}=JSON.parse(fs.readFileSync(path.join(process.env.WORKBUDDY_CONFIG_DIR || path.join(os.homedir(),'.workbuddy'),'wbipc','endpoint.json'),'utf8'))); }
  catch { throw new Failure('CLIENT_NOT_READY'); }
  if (typeof endpoint !== 'string' || typeof ticket !== 'string' || !ticket) throw new Failure('IPC_ENDPOINT_CHANGED');
  // Restrict the socket to local named pipes / Unix-domain sockets.
  if (process.platform === 'win32' ? !endpoint.startsWith('\\\\.\\pipe\\') : !path.isAbsolute(endpoint)) throw new Failure('IPC_ENDPOINT_CHANGED');
  const socket=net.createConnection(endpoint), pending=new Map();
  const clientNonce=crypto.randomBytes(16).toString('base64url');
  const proof=(role, protocol, serverNonce) => crypto.createHmac('sha256',Buffer.from(ticket,'utf8')).update(frame(role,protocol,endpoint,clientNonce,serverNonce)).digest('base64url');
  const send=value => socket.write(JSON.stringify(value)+'\n');
  let nextId=1, buffer=Buffer.alloc(0), phase='hello', channel;
  let handshakeResolve, handshakeReject;
  const handshake=new Promise((resolve,reject) => {handshakeResolve=resolve;handshakeReject=reject;});
  const fail=reason => {
    const error=new Failure(reason); handshakeReject(error);
    for (const p of pending.values()) {clearTimeout(p.timer);p.reject(error);} pending.clear(); socket.destroy();
  };
  const handshakeTimer=setTimeout(() => fail('IPC_HANDSHAKE_TIMEOUT'),15000);
  socket.on('connect',() => send({type:'session_hello',protocol_min:1,protocol_max:1,client_nonce:clientNonce,
    ticket_id:crypto.createHash('sha256').update(ticket,'utf8').digest('hex').slice(0,16),client:{kind:'cli',id:'buddy-unified',version:'1.0'}}));
  socket.on('error',() => fail('CLIENT_NOT_READY'));
  socket.on('close',() => {clearTimeout(handshakeTimer);if(phase!=='closed') fail('IPC_CLOSED');});
  socket.on('data',data => {
    buffer=Buffer.concat([buffer,data]);
    if (buffer.length>2*1024*1024) return fail('IPC_FRAME_TOO_LARGE');
    while (buffer.includes(10)) {
      const end=buffer.indexOf(10), line=buffer.subarray(0,end);buffer=buffer.subarray(end+1);
      if (!line.length) continue;
      let msg;try {msg=JSON.parse(line.toString('utf8'));} catch {return fail('IPC_INVALID_JSON');}
      if (msg.type==='session_challenge' && phase==='hello') {
        if (msg.protocol!==1 || typeof msg.server_nonce!=='string') return fail('IPC_PROTOCOL_CHANGED');
        if (msg.server_proof !== undefined) {
          const expected=Buffer.from(proof('server',msg.protocol,msg.server_nonce));
          const actual=Buffer.from(String(msg.server_proof));
          if(actual.length!==expected.length || !crypto.timingSafeEqual(actual,expected)) return fail('IPC_SERVER_PROOF_FAILED');
        }
        phase='prove';send({type:'session_prove',client_proof:proof('client',msg.protocol,msg.server_nonce)});continue;
      }
      if(msg.type==='session_hello_ack' && phase==='prove') {phase='ready';clearTimeout(handshakeTimer);handshakeResolve();continue;}
      const p=pending.get(msg.id);
      if(p) {pending.delete(msg.id);clearTimeout(p.timer);p.resolve(msg);}
    }
  });
  function rpc(method, params, mode) {
    const id=nextId++;
    return new Promise((resolve,reject) => {
      const timer=setTimeout(() => {pending.delete(id);reject(new Failure('NETWORK_ERROR'));},45000);
      pending.set(id,{resolve,reject,timer});send({jsonrpc:'2.0',id,method,params,...(mode ? {mode}:{})});
    });
  }
  try {
    await handshake;
    const response=await rpc('broker/GetPipe',{pipe:'wb.request'});
    if(response.error || typeof response.result?.channel!=='string') throw new Failure('IPC_PIPE_UNAVAILABLE');
    channel=response.result.channel;
  } catch(e) {clearTimeout(handshakeTimer);phase='closed';socket.destroy();throw e;}
  return {
    request:async(method,pathname,body) => {
      if (!pathname.startsWith('/') || pathname.startsWith('//') || /[\r\n?#]/.test(pathname)) throw new Failure('PATH_NOT_ALLOWED');
      const params={method,path:pathname};
      if(method==='POST') params.body_b64=Buffer.from(JSON.stringify(body || {})).toString('base64');
      const response=await rpc(channel+'/http.fetch',params,'call');
      if(response.error || !response.result) throw new Failure('IPC_HTTP_FAILED');
      let json;try {json=JSON.parse(Buffer.from(response.result.body_b64,'base64').toString('utf8'));} catch {}
      return {status:response.result.status,json};
    },
    close:() => {phase='closed';socket.destroy();clearTimeout(handshakeTimer);},
  };
}
module.exports={connect,frame};
