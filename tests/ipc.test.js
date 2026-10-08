'use strict';
const test=require('node:test'), assert=require('node:assert/strict');
const {EventEmitter}=require('events');
const net=require('net'), fs=require('fs'),crypto=require('crypto');
const ipc=require('../ipc');
test('local IPC challenge/proof, RPC and HTTP decode use no credential export',async()=> {
  const read=fs.readFileSync,create=net.createConnection;
  const endpoint=process.platform==='win32' ? '\\\\.\\pipe\\mock-workbuddy':'/tmp/mock-workbuddy';
  const frames=[];let closed=false;
  const socket=new EventEmitter();
  socket.destroy=()=>{if(!closed){closed=true;socket.emit('close');}};
  socket.write=text=> {
    const request=JSON.parse(text);frames.push(request);
    let response;
    if(request.type==='session_hello') {
      const proof=crypto.createHmac('sha256','mock-ticket').update(ipc.frame('server',1,endpoint,request.client_nonce,'mock-server-nonce')).digest('base64url');
      response={type:'session_challenge',protocol:1,server_nonce:'mock-server-nonce',server_proof:proof};
    } else if(request.type==='session_prove') {
      const hello=frames[0];
      assert.equal(request.client_proof,crypto.createHmac('sha256','mock-ticket').update(ipc.frame('client',1,endpoint,hello.client_nonce,'mock-server-nonce')).digest('base64url'));
      response={type:'session_hello_ack'};
    } else if(request.method==='broker/GetPipe') response={id:request.id,result:{channel:'mock-channel'}};
    else {
      assert.equal(request.method,'mock-channel/http.fetch');assert.equal(request.mode,'call');
      assert.deepEqual(JSON.parse(Buffer.from(request.params.body_b64,'base64').toString('utf8')),{});
      response={id:request.id,result:{status:200,body_b64:Buffer.from(JSON.stringify({code:0,data:{today_checked_in:true}})).toString('base64')}};
    }
    queueMicrotask(()=>socket.emit('data',Buffer.from(JSON.stringify(response)+'\n')));
  };
  fs.readFileSync=(file,...args)=> String(file).endsWith('endpoint.json') ? JSON.stringify({endpoint,ticket:'mock-ticket'}):read(file,...args);
  net.createConnection=()=>{queueMicrotask(()=>socket.emit('connect'));return socket;};
  try {
    const transport=await ipc.connect();
    const response=await transport.request('POST','/v2/billing/meter/checkin-activity-status',{});
    assert.equal(response.json.data.today_checked_in,true);transport.close();assert.equal(closed,true);
    assert.ok(!JSON.stringify(frames).includes('accessToken'));assert.ok(!JSON.stringify(frames).includes('mock-ticket'));
  } finally {fs.readFileSync=read;net.createConnection=create;}
});
test('IPC rejects invalid server proof without issuing account requests',async()=> {
  const read=fs.readFileSync,create=net.createConnection;
  const endpoint=process.platform==='win32' ? '\\\\.\\pipe\\mock-workbuddy':'/tmp/mock-workbuddy';
  const socket=new EventEmitter();let closed=false,count=0;
  socket.destroy=()=>{if(!closed){closed=true;socket.emit('close');}};
  socket.write=()=>{count++;queueMicrotask(()=>socket.emit('data',Buffer.from(JSON.stringify({type:'session_challenge',protocol:1,server_nonce:'nonce',server_proof:'wrong'})+'\n')));};
  fs.readFileSync=(file,...args)=> String(file).endsWith('endpoint.json') ? JSON.stringify({endpoint,ticket:'mock-ticket'}):read(file,...args);
  net.createConnection=()=>{queueMicrotask(()=>socket.emit('connect'));return socket;};
  try {await assert.rejects(ipc.connect(),/IPC_SERVER_PROOF_FAILED/);assert.equal(count,1);assert.equal(closed,true);}
  finally {fs.readFileSync=read;net.createConnection=create;}
});
