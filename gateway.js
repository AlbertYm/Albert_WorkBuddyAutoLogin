'use strict';
const https = require('node:https');
const {Failure,envelope} = require('./engine');
const validToken=x=>typeof x==='string' && x.length>0 && x.length<=32768 && /^[A-Za-z0-9._~+\/-]+=*$/.test(x);
function jwtExpiry(token) {
  try {const value=JSON.parse(Buffer.from(token.split('.')[1],'base64url')).exp;return Number.isFinite(value) ? value:null;}
  catch {return null;}
}
function validate(auth) {
  if(!auth || !validToken(auth.accessToken) || !validToken(auth.refreshToken)) throw new Failure('AUTH_FORMAT_INVALID');
  return {accessToken:auth.accessToken,refreshToken:auth.refreshToken};
}
function request(method,pathname,body={},headers={}) {
  if(!pathname.startsWith('/') || pathname.startsWith('//') || /[\r\n?#]/.test(pathname)) return Promise.reject(new Failure('PATH_NOT_ALLOWED'));
  return new Promise((resolve,reject)=> {
    const content=Buffer.from(JSON.stringify(body));
    const req=https.request({hostname:'copilot.tencent.com',port:443,path:pathname,method,rejectUnauthorized:true,
      headers:{Accept:'application/json','Content-Type':'application/json',...headers,...(method==='POST' ? {'Content-Length':content.length}:{})}},res=> {
      let size=0;const chunks=[];
      res.on('data',chunk=>{size+=chunk.length;if(size>1048576){res.destroy();reject(new Failure('RESPONSE_TOO_LARGE'));}else chunks.push(chunk);});
      res.on('error',()=>reject(new Failure('NETWORK_ERROR')));
      res.on('end',()=>{let json;try{json=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{}resolve({status:res.statusCode,json});});
    });
    req.setTimeout(25000,()=>req.destroy());req.on('error',()=>reject(new Failure('NETWORK_ERROR')));
    if(method==='POST')req.write(content);req.end();
  });
}
async function refresh(auth,http=request,now=Date.now()/1000) {
  const data=envelope(await http('POST','/v2/plugin/auth/token/refresh',{}, {
    'X-Refresh-Token':auth.refreshToken,'X-Auth-Refresh-Source':'plugin','X-Domain':'www.workbuddy.cn',
  }));
  const next=validate(data);
  for(const token of [next.accessToken,next.refreshToken]) {
    const exp=jwtExpiry(token);if(exp!==null && exp<=now) throw new Failure('REFRESH_RETURNED_EXPIRED_TOKEN');
  }
  return next;
}
function transport(auth,http=request) {
  return {request:(method,pathname,body)=>http(method,pathname,body,{Authorization:`Bearer ${auth.accessToken}`}),close:()=>{}};
}
module.exports={validToken,jwtExpiry,validate,request,refresh,transport};
