import {acceptChatFrames} from './stream-layout.mjs';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import {PortalError,destination} from './portal-store.mjs';
export async function createPortalServer({config,store,status,action,changed,busy,validateDestination,rtmpPort,rtmpTls=false,recordings=null}){
 const assets=new Map([['/workspace-ui.js',['workspace-ui.js','text/javascript']],['/obs-ui.js',['obs-ui.js','text/javascript']],['/startup-guard.js',['startup-guard.js','text/javascript']],['/',['portal.html','text/html']],['/portal.js',['portal.js','text/javascript']],['/stream-canvas.js',['stream-canvas.js','text/javascript']],['/platforms-ui.js',['platforms-ui.js','text/javascript']],['/studio-ui.js',['studio-ui.js','text/javascript']],['/release-ui.js',['release-ui.js','text/javascript']],['/host-ui.js',['host-ui.js','text/javascript']],['/studio-ui-v2.js',['studio-ui-v2.js','text/javascript']],['/studio-ui-v2.css',['studio-ui-v2.css','text/css']],['/portal.css',['portal.css','text/css']]].map(([url,[file,type]])=>[url,{body:fs.readFileSync(new URL(file,import.meta.url)),type}]));
 const failures=new Map();let mutations=Promise.resolve();
 const serialize=fn=>{const job=mutations.then(fn);mutations=job.catch(()=>{});return job;};
 const server=(config.tls?.enabled?https:http).createServer(config.tls?.enabled?{cert:fs.readFileSync(config.tls.certFile),key:fs.readFileSync(config.tls.keyFile)}:{},async(req,res)=>{
  const send=(code,value,type='application/json')=>{if(!res.writableEnded)res.writeHead(code,{'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-src https: http:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"}).end(type==='application/json'?JSON.stringify(value):value);};
  try{
   const origin=config.publicOrigin||`${config.tls?.enabled?'https':'http'}://${req.headers.host}`;
   let originURL;try{originURL=new URL(origin);}catch{throw new PortalError('Invalid server address.');}
   if(req.headers.host!==originURL.host)throw new PortalError('Use the configured server address.',403);
   if(req.headers.origin&&req.headers.origin!==origin)throw new PortalError('Origin rejected.',403);
   if(assets.has(req.url)&&req.method==='GET'){const a=assets.get(req.url);send(200,a.body,a.type);return;}
   if(req.url==='/api/v3/info'&&req.method==='GET'){send(200,{version:'1.0.0-rc.5',name:'UniversalCollab',rtmpPort,capabilities:{...store.features(),hostAdmin:store.hostAdmin?1:0},hostClaimed:!!store.hostAdmin?.db.ownerId});return;}
   const download=/^\/api\/v3\/recordings\/([a-f0-9-]{36})\/download$/.exec(req.url||'');
   if(download){if(req.method!=='GET')throw new PortalError('Method not allowed.',405);const user=store.authenticate(req.headers.authorization);if(!user)throw new PortalError('Unauthorized.',401);if(!recordings)throw new PortalError('Recordings unavailable.',404);const f=recordings.get(user.id,download[1]);res.writeHead(200,{'Content-Type':'video/mp2t','Content-Length':fs.statSync(f.file).size,'Cache-Control':'no-store','Content-Disposition':'attachment; filename="'+f.entry.id+'.ts"'});const stream=fs.createReadStream(f.file);stream.on('error',()=>res.destroy());res.on('close',()=>stream.destroy());stream.pipe(res);return;}
   if(!/^\/api\/(v3\/(register|view|secrets|destination|settings|request|respond|collab-warning|collab-request|collab-respond|display-name|chat-frame|production|production-clear|recordings|recording-delete|invites|invite|invite-revoke|host-claim|host-view|host-settings|host-member|host-action|host-rotate)|status|end|allow|pip-on|pip-off|collab-on|collab-off|force-fallback|restore-primary)$/.test(req.url||''))throw new PortalError('Not found.',404);
   const isRead=['/api/v3/view','/api/v3/secrets','/api/status','/api/v3/recordings','/api/v3/invites','/api/v3/host-view'].includes(req.url);
   if(req.method!==(isRead?'GET':'POST'))throw new PortalError('Method not allowed.',405);
   if(!isRead&&req.headers.origin!==origin)throw new PortalError('Origin rejected.',403);
   let body={};if(!isRead){let bytes=0,parts=[];for await(const part of req){bytes+=part.length;if(bytes>(req.url==='/api/v3/chat-frame'?2500000:65536))throw new PortalError('Request too large.',413);parts.push(part);}if(bytes){if(!String(req.headers['content-type']).startsWith('application/json'))throw new PortalError('JSON required.',415);try{body=JSON.parse(Buffer.concat(parts).toString());}catch{throw new PortalError('Invalid request.');}}}
   const ip=req.socket.remoteAddress,now=Date.now();for(const [k,v] of failures)if(now-v.time>60000)failures.delete(k);
   if((failures.get(ip)?.count||0)>=20||failures.size>2000)throw new PortalError('Too many login attempts. Try again in a minute.',429);
   const fail=()=>{const f=failures.get(ip)||{count:0,time:now};f.count++;failures.set(ip,f);};
   if(req.url?.startsWith('/api/v3/host-')&&originURL.protocol!=='https:'&&!['127.0.0.1','[::1]','localhost'].includes(originURL.hostname))throw new PortalError('Host administration requires HTTPS. Configure TLS or a trusted HTTPS reverse proxy.',403);
   if(req.url==='/api/v3/host-claim'){
    if(!store.hostAdmin)throw new PortalError('Host administration unavailable.',404);
    try{const value=await serialize(()=>{const result=store.hostAdmin.claim(body,store.authenticate(req.headers.authorization));changed();return result;});send(200,value);}catch(e){fail();throw e;}return;
   }
   if(req.url==='/api/v3/register'){
    try{const user=await serialize(()=>{const u=store.register(body.username,body.password);changed();return u;});send(200,{id:user.id,token:user.controlToken});}catch(e){fail();throw e;}return;
   }
   const user=store.authenticate(req.headers.authorization);if(!user){fail();throw new PortalError('Check your username and personal login token.',401);}
   const id=user.id;
   if(req.url.startsWith('/api/v3/host-')){
    const host=store.hostAdmin;if(!host)throw new PortalError('Host administration unavailable.',404);host.require(user);
    if(req.url==='/api/v3/host-rotate'){const token=await serialize(()=>{host.require(store.authenticate(req.headers.authorization));return host.rotate(user);});send(200,{token});return;}
    if(req.url==='/api/v3/host-view'){send(200,host.view(user));return;}
    await serialize(async()=>{host.require(store.authenticate(req.headers.authorization));
     if(req.url==='/api/v3/host-settings')host.settings(user,body);
     else if(req.url==='/api/v3/host-member'){const target=host.member(user,body);changed();if(target.disabled)await action(target.id,'end');}
     else if(req.url==='/api/v3/host-action'){if(!store.get(body.id)||!['end','allow'].includes(body.action))throw new PortalError('Invalid host action.');await action(body.id,body.action);host.log(id,'broadcast-'+body.action,body.id);}
     changed();});send(200,host.view(user));return;
   }

   if(req.url==='/api/v3/chat-frame'){send(200,acceptChatFrames(store,id,body));return;}
   if(req.url==='/api/v3/invites'){send(200,{items:store.invites(id)});return;}
   if(req.url==='/api/v3/invite'){const value=await serialize(()=>store.invite(id,body.minutes));send(200,value);return;}
   if(req.url==='/api/v3/recordings'){send(200,{items:recordings?.list(id)||[]});return;}
   if(req.url==='/api/status'){send(200,status(id));return;}
   if(req.url==='/api/v3/view'){send(200,store.publicView(id,status));return;}
   if(req.url==='/api/v3/secrets'){
    const host=originURL.hostname;
    send(200,{obsServer:`${rtmpTls?'rtmps':'rtmp'}://${host}:${rtmpPort}/live/${id}`,obsKey:user.inputKey,loginToken:user.controlToken,destinationBaseUrl:user.destinationBaseUrl,destinationStreamKey:user.destinationStreamKey});return;
   }
   await serialize(async()=>{
    try{
    if(!store.authenticate(req.headers.authorization))throw new PortalError('Account access revoked.',401);
    if(req.url==='/api/v3/invite-revoke'){const peer=store.revokeInvite(store.hostAdmin?.isOwner(user)?store.db.invites.find(i=>i.id===body.id)?.owner:id,body.id);if(peer)await action(peer,'end');}
    else if(req.url==='/api/v3/recording-delete'){if(store.features().recordingManagement===false)throw new PortalError('Recording management disabled by host.',403);recordings.delete(id,body.id);}
    else if(req.url==='/api/v3/production-clear'){if(busy(id))throw new PortalError('Stop OBS and end the stream first.',409);store.clearProduction(id);changed();}
    else if(req.url==='/api/v3/production'){
     if(busy(id))throw new PortalError('Stop OBS and end the stream first.',409);
     if(!Array.isArray(body.destinations)||body.destinations.length>8)throw new PortalError('Invalid destinations.');
     for(const d of body.destinations){const value=destination(d.url,d.key||'');await validateDestination(value.combined);}
     if(busy(id))throw new PortalError('Stop OBS first.',409);store.setProduction(id,body);changed();
    }else if(req.url==='/api/v3/destination'){
     if(busy(id))throw new PortalError('End your stream and stop OBS before changing its destination.',409);
     const d=destination(body.url,body.key||'');await validateDestination(d.combined);
     if(busy(id))throw new PortalError('Stop OBS before saving a destination.',409);
     store.setDestination(id,d.destinationBaseUrl,d.destinationStreamKey);changed();
    }else if(req.url==='/api/v3/settings'){if(body.resolution!==undefined&&JSON.stringify(body.resolution)!==JSON.stringify(store.get(id).settings.resolution||null)&&busy(id))throw new PortalError('Stop OBS and end the relay broadcast before changing resolution.',409);store.settings(id,body);changed();}
    else if(req.url==='/api/v3/collab-warning')store.acceptCollabWarning(id);
    else if(req.url==='/api/v3/collab-request')store.collabRequest(id,body.peer,body.permanent===true);
    else if(req.url==='/api/v3/collab-respond'){store.collabRespond(id,body.id,body.decision);changed();}
    else if(req.url==='/api/v3/display-name')store.displayName(id,body.name);
    else if(req.url==='/api/v3/request')store.request(id,body.peer,body.kind);
    else if(req.url==='/api/v3/respond'){store.respond(id,body.id,body.decision);changed();}
    else {
     const command=req.url.slice(5),features=store.features();
     if((command==='pip-on'&&!features.pictureInPicture)||(command==='collab-on'&&!features.collaboratorFallback))throw new PortalError('This feature is disabled by the server host.',403);
     await action(id,command);
    }
    }finally{changed();}
   });
   send(200,store.publicView(id,status));
  }catch(e){send(e instanceof PortalError?e.code:503,{reason:({'Host administration requires HTTPS. Configure TLS or a trusted HTTPS reverse proxy.':'HOST_HTTPS','Host administration requires the owner account.':'HOST_ONLY','Member slots are full.':'MEMBER_LIMIT','Guest slots are reserved or full.':'GUEST_LIMIT'})[e.message]||'',error:e instanceof PortalError?e.message:'Action could not be completed. Check server availability and destination, then try again.'});}
 });
 server.requestTimeout=12000;server.headersTimeout=12000;server.maxConnections=100;
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(config.port,config.bind,resolve);});server.on('error',()=>{});
 return {server,close:()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();})};
}
