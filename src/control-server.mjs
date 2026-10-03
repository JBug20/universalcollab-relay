import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import {createHash,timingSafeEqual} from 'node:crypto';
const digest=value=>createHash('sha256').update(value).digest();
const local=host=>['127.0.0.1','localhost','[::1]','::1'].includes(host);
export function validateControl(c,mediaPort){
  if(!c||c.enabled===false)return null;
  if(c.enabled!==true)throw Error('controls.enabled must be true or false.');
  if(!Number.isInteger(c.port)||c.port<1024||c.port>65535||c.port===mediaPort)throw Error('controls.port must be a separate allocated port between 1024 and 65535.');
  if(!['0.0.0.0','127.0.0.1','::1','::'].includes(c.bind))throw Error('controls.bind must be 0.0.0.0, 127.0.0.1, :: or ::1.');
  let origin;try{origin=new URL(c.publicOrigin);}catch{throw Error('Set controls.publicOrigin to your HTTPS control address.');}
  if(origin.username||origin.password||origin.search||origin.hash||origin.pathname!=='/'||!['https:','http:'].includes(origin.protocol))throw Error('controls.publicOrigin must be an origin only, without a path, query or credentials.');
  if(origin.protocol!=='https:'&&c.allowRemoteHttp!==true&&!(local(origin.hostname)&&local(c.bind)))throw Error('Public controls require HTTPS. Use a trusted HTTPS reverse proxy or controls.tls.');
  if(c.tls?.enabled&&origin.protocol!=='https:')throw Error('TLS controls require an HTTPS publicOrigin.');
  return {...c,publicOrigin:origin.origin};
}
export async function createControlServer({config,users,status,action}){
  // No cookies, credentials in URLs, wildcard CORS or user-selectable action targets.
  const assets=new Map([
    ['/', ['text/html; charset=utf-8',fs.readFileSync(new URL('./dock.html',import.meta.url))]],
    ['/dock.js',['text/javascript; charset=utf-8',fs.readFileSync(new URL('./dock.js',import.meta.url))]],
    ['/dock.css',['text/css; charset=utf-8',fs.readFileSync(new URL('./dock.css',import.meta.url))]]
  ]);
  const failures=new Map(),pending=new Map();
  function serialized(id,fn){
    const job=(pending.get(id)||Promise.resolve()).catch(()=>{}).then(fn);
    pending.set(id,job);job.finally(()=>{if(pending.get(id)===job)pending.delete(id);}).catch(()=>{});return job;
  }
  function limited(ip){
    const now=Date.now();for(const [k,v] of failures)if(v.until<now)failures.delete(k);
    return (failures.get(ip)?.count||0)>=30||failures.size>=1000;
  }
  const handler=async(req,res)=>{
    const reply=(code,body)=>{if(!res.writableEnded)res.writeHead(code,{'Content-Type':'application/json; charset=utf-8'}).end(JSON.stringify(body));};
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    res.setHeader('X-Frame-Options','DENY');
    try{
      // A proxy must preserve Host. Rebinding/foreign hosts cannot serve the dock.
      if(req.headers.host!==new URL(config.publicOrigin).host){reply(403,{error:'Open the configured control address.'});return;}
      const asset=assets.get(req.url);
      if(req.method==='GET'&&asset){res.writeHead(200,{'Content-Type':asset[0]}).end(asset[1]);return;}
      if(req.method==='GET'&&req.url==='/dock-config'){reply(200,{origin:config.publicOrigin,allowRemoteHttp:config.allowRemoteHttp===true});return;}
      if(!['/api/status','/api/end','/api/allow','/api/pip-on','/api/pip-off','/api/collab-on','/api/collab-off'].includes(req.url)){reply(404,{error:'Not found.'});return;}
      if((req.url==='/api/status'&&req.method!=='GET')||(req.url!=='/api/status'&&req.method!=='POST')){reply(405,{error:'Method not allowed.'});return;}
      // Reject browser cross-origin requests; native test clients may omit Origin on GET.
      if((req.method==='POST'&&req.headers.origin!==config.publicOrigin)||(req.headers.origin&&req.headers.origin!==config.publicOrigin)){reply(403,{error:'Origin rejected.'});return;}
      if(req.headers['transfer-encoding']||Number(req.headers['content-length']||0)>0){reply(400,{error:'No request body is accepted.'});req.resume();return;}
      const ip=req.socket.remoteAddress;
      if(limited(ip)){reply(429,{error:'Too many failed logins. Wait one minute.'});return;}
      const match=/^Bearer ([A-Za-z0-9_-]{1,32}):([A-Za-z0-9_-]{24,64})$/.exec(req.headers.authorization||'');
      const person=match&&users.get(match[1]);
      const good=timingSafeEqual(digest(match?.[2]||''),digest(person?.controlToken||'unconfigured'));
      if(!person||!good){const f=failures.get(ip)||{count:0,until:Date.now()+60000};f.count++;failures.set(ip,f);reply(401,{error:'Check your streamer ID and control token.'});return;}
      if(req.url==='/api/status'){reply(200,status(person.id));return;}
      await serialized(person.id,()=>action(person.id,req.url.slice('/api/'.length)));
      reply(200,status(person.id));
    }catch{reply(503,{error:'Control action could not be confirmed. Refresh status or contact the server owner.'});}
  };
  const server=config.tls?.enabled?https.createServer({cert:fs.readFileSync(config.tls.certFile),key:fs.readFileSync(config.tls.keyFile)},handler):http.createServer(handler);
  server.requestTimeout=10000;server.headersTimeout=10000;server.keepAliveTimeout=5000;server.maxConnections=100;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(config.port,config.bind,resolve);});
  // Do not crash the relay on a later individual control-listener error.
  server.on('error',()=>{});
  return {close:()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();})};
}
