import {HostAdmin} from './host-admin.mjs';
import {integrityStatus} from './integrity.mjs';
import {hostFeatures} from './host-features.mjs';
import {migratePreferences} from './preferences-migration.mjs';
import {validateControl} from './control-server.mjs';
import {PortalStore} from './portal-store.mjs';
import {Recordings} from './recordings.mjs';
import {createPortalServer} from './portal-server.mjs';
import {detectTracks} from './detect-tracks.mjs';
import {startupFailure} from './startup-diagnostics.mjs';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import readline from 'node:readline';
import {spawn,spawnSync,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomBytes} from 'node:crypto';
import {Session} from './session.mjs';
import {validatePip,ThumbnailPool} from './pip.mjs';
import {hash,same,loopback,joinDestination,validateDestination,selectSource,parsePublisherPath} from './multi-routing.mjs';

const execute=promisify(execFile);
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const log=message=>console.log(new Date().toISOString()+' '+message);
const freePort=()=>new Promise((resolve,reject)=>{const s=net.createServer();s.on('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
const safe=message=>{const e=new Error(message);e.safe=true;throw e;};

export async function run(){
  const c=JSON.parse(fs.readFileSync('config.json','utf8'));
  c.port=Number(process.env.SERVER_PORT||c.port);c.mode=process.env.RELAY_MODE||c.mode;
  if(process.env.STOP_AFTER_MINUTES!==undefined)c.stopAfterMinutes=Number(process.env.STOP_AFTER_MINUTES);
  c.autoRearmAfterSeconds??=30;c.fps??=60;
  c.controlsAutoAllowAfterSeconds??=30;
  if(!Number.isInteger(c.controlsAutoAllowAfterSeconds)||c.controlsAutoAllowAfterSeconds<5||c.controlsAutoAllowAfterSeconds>86400)safe("controlsAutoAllowAfterSeconds must be 5-86400.");
  const m=c.multi;
  hostFeatures(c); // Validate host policy before account creation or media startup.
  const portal=new PortalStore({publishers:m.publishers||[],features:()=>hostFeatures(c)});
  m.publishers=portal.db.users;
  const recordings=new Recordings({...c.recordings,enabled:hostFeatures(c).recording});
  const host=new HostAdmin({store:portal,config:c,recordings});
  console.log('Host setup: read data/host-setup-code.txt once, then claim the relay in the app.');
  console.log('Account setup: read data/server-access.json for the server join password.');
  m.maxSessions??=3;m.maxInputPixels??=33177600;
  m.allowedDestinationHosts=[];m.allowPrivateDestinations??=false;
  m.collab??={};m.collab.enabled??=true;m.collab.recoverAfterSeconds??=3;
  if(!Number.isInteger(c.port)||c.port<1024||c.port>65535)safe('port must be 1024-65535.');
  if(!['test','live'].includes(c.mode))safe('mode must be test or live.');
  if(![25,30,50,60].includes(c.fps))safe('fps must be 25, 30, 50 or 60.');
  if(!Number.isInteger(c.videoBitrateKbps)||c.videoBitrateKbps<250||c.videoBitrateKbps>15000)safe('videoBitrateKbps must be 250-15000.');
  if(!Number.isFinite(c.stopAfterMinutes)||c.stopAfterMinutes<0||c.stopAfterMinutes>525600)safe('stopAfterMinutes must be 0-525600.');
  if(!Number.isInteger(c.autoRearmAfterSeconds)||c.autoRearmAfterSeconds<0||c.autoRearmAfterSeconds>86400)safe('autoRearmAfterSeconds must be 0-86400.');
  if(!Number.isFinite(c.fallbackAfterSeconds)||c.fallbackAfterSeconds<.5||c.fallbackAfterSeconds>30)safe('fallbackAfterSeconds must be 0.5-30.');
  if(!Number.isInteger(m.maxSessions)||m.maxSessions<1||m.maxSessions>16)safe('multi.maxSessions must be 1-16.');
  if(!Number.isSafeInteger(m.maxInputPixels)||m.maxInputPixels<14400)safe('multi.maxInputPixels must be at least 14400.');
  if(![true,false].includes(m.collab.enabled)||![true,false].includes(m.allowPrivateDestinations))safe('Use true or false for multi mode switches.');
  if(!Number.isFinite(m.collab.recoverAfterSeconds)||m.collab.recoverAfterSeconds<0||m.collab.recoverAfterSeconds>60)safe('collab.recoverAfterSeconds must be 0-60.');
  if(!Array.isArray(m.publishers)||m.publishers.length>4096)safe('Account history exceeds the supported 4096 identities.');
  const users=new Map();
  for(const p of m.publishers){
    if(!p||! /^[a-zA-Z0-9_-]{1,32}$/.test(p.id)||users.has(p.id)||! /^[A-Za-z0-9_-]{24,64}$/.test(p.password)||p.password.startsWith('CHANGE_'))safe('Each publisher needs a unique simple id and private 24-64 character password.');
    if(typeof p.inputKey!=='string'||! /^[A-Za-z0-9_-]{24,64}$/.test(p.inputKey))safe('Each publisher needs a persistent 24-64 character inputKey.');
    if(p.destinationStreamKey){try{joinDestination(p.destinationBaseUrl,p.destinationStreamKey);}catch{safe('destinationStreamKey must be a platform key, not a combined URL.');}}
    if(p.collabGroup && !/^[A-Za-z0-9_-]{1,32}$/.test(p.collabGroup))safe('Use simple collab group names.');
    try{if(p.destinationBaseUrl)m.allowedDestinationHosts.push(new URL(joinDestination(p.destinationBaseUrl,'validation_key')).hostname.toLowerCase());for(const d of p.production?.destinations||[])m.allowedDestinationHosts.push(new URL(d.url).hostname.toLowerCase());}catch{safe('Each publisher needs a valid RTMP(S) destinationBaseUrl without a stream key, query or credentials.');}
    users.set(p.id,p);
  }
  if(new Set(m.publishers.map(p=>p.password)).size!==m.publishers.length)safe('Give each publisher a different password.');
  let controlConfig;try{controlConfig=validateControl({...c.controls,publicOrigin:c.controls.publicOrigin||`http://127.0.0.1:${c.controls.port}`},c.port);if(controlConfig&&!c.controls.publicOrigin)controlConfig.publicOrigin='';}catch(error){safe(error.message);}
  if(controlConfig){
    const tokens=m.publishers.map(p=>p.controlToken);
    if(tokens.some(t=>typeof t!=='string'||! /^[A-Za-z0-9_-]{24,64}$/.test(t))||new Set(tokens).size!==tokens.length||tokens.some(t=>m.publishers.some(p=>p.password===t)))safe('Each publisher needs a distinct controlToken, separate from publishing passwords.');
  }
  let pip;try{pip=validatePip(m);}catch(error){safe(error.message);}
  // The pool itself is idle; decoders are acquired only for enabled outputs.
  const overlayPool=new ThumbnailPool();
  const dimensions=(w,h)=>Number.isSafeInteger(w)&&Number.isSafeInteger(h)&&w>=160&&h>=90&&w%2===0&&h%2===0&&w*h<=m.maxInputPixels;
  const binary=path.resolve('vendor/mediamtx');
  const check=spawnSync(binary,['--version'],{encoding:'utf8',timeout:5000});
  if(check.status!==0||!check.stdout.includes('v1.21.0'))safe('This build requires MediaMTX v1.21.0.');
  if(!fs.existsSync('fallback.png'))safe('fallback.png is missing.');
  fs.mkdirSync('data',{recursive:true,mode:0o700});
  let state={blocked:[],active:{}};
  if(fs.existsSync('data/multi-state.json'))state=JSON.parse(fs.readFileSync('data/multi-state.json','utf8'));
  if(!Array.isArray(state.blocked)||state.blocked.some(h=>! /^[a-f0-9]{64}$/.test(h))||!state.active||typeof state.active!=='object'||Array.isArray(state.active))safe('Invalid data/multi-state.json.');
  for(const [id,v] of Object.entries(state.active))if(!users.has(id)||!v||! /^[a-f0-9]{64}$/.test(v.keyHash)||!Number.isFinite(v.deadline)||v.deadline<0)delete state.active[id];
  state.held??=[];state.blockedOwners??={};
  if(!Array.isArray(state.held)||state.held.some(id=>typeof id!=='string')||!state.blockedOwners||Array.isArray(state.blockedOwners)||typeof state.blockedOwners!=='object')safe('Invalid saved control state.');
  if(migratePreferences(state,users))log('Saved preferences upgraded; valid settings preserved. Original state backed up.');
  const preferences=id=>state.preferences.find(p=>p.id===id)||{};
  const effectivePip=id=>hostFeatures(c).pictureInPicture&&(preferences(id).pip??true);
  const effectiveCollab=id=>hostFeatures(c).collaboratorFallback&&(preferences(id).collab??true);
  const controlEpoch=new Map();
  const isHeld=id=>state.held.includes(id);
  const heldActivity=new Map(state.held.map(id=>[id,Date.now()]));
  const save=()=>{fs.writeFileSync('data/multi-state.tmp',JSON.stringify(state),{mode:0o600});fs.renameSync('data/multi-state.tmp','data/multi-state.json');};
  const lastAttempt=new Map(state.blocked.map(h=>[h,Date.now()]));
  const block=(id,keyHash)=>{if(!state.blocked.includes(keyHash))state.blocked.push(keyHash);lastAttempt.set(keyHash,Date.now());state.blockedOwners[keyHash]=id;delete state.active[id];save();};
  for(const [id,v] of Object.entries(state.active))if(v.deadline&&v.deadline<=Date.now())block(id,v.keyHash);
  const sessions=new Map(),reservations=new Map(),grants=new Map(),inputs=new Map();
  const starting=new Map(),ending=new Map();
  let shutting=false,pollTimer,media,controls,pollBusy=false,apiErrors=0;
  const readerToken=randomBytes(24).toString('hex');
  const parse=(name,query)=>parsePublisherPath(name,query,users);
  function blocked(p){
    if(!state.blocked.includes(p.keyHash))return false;
    const now=Date.now();
    if(c.autoRearmAfterSeconds>0 && now-(lastAttempt.get(p.keyHash)??now)>=c.autoRearmAfterSeconds*1000&&!ending.has(p.id)){
      const previous=state.blocked;
      state.blocked=previous.filter(h=>h!==p.keyHash);
      try{save();}catch(error){state.blocked=previous;throw error;}
      lastAttempt.delete(p.keyHash);log(`[${p.id}] Key automatically rearmed.`);return false;
    }
    lastAttempt.set(p.keyHash,now);return true;
  }
  function reserved(id){return sessions.has(id)||starting.has(id)||reservations.has(id)||ending.has(id);}
  function prune(){
    for(const [id,r] of reservations)if(r.until<Date.now()&&!sessions.has(id)&&!starting.has(id))reservations.delete(id);
    for(const [name,g] of grants)if(!reserved(g.id))grants.delete(name);
  }
  const auth=http.createServer((req,res)=>{
    if(req.method!=='POST'||req.url!=='/auth'){res.writeHead(404).end();return;}
    let body='',done=false;req.on('data',chunk=>{body+=chunk;if(body.length>32768){done=true;res.writeHead(413).end();req.destroy();}});
    req.on('end',async()=>{
      if(done)return;let held=null;
      try{
        const a=JSON.parse(body);
        if(shutting){res.writeHead(403).end();return;}
        if(a.action==='api'&&loopback(a.ip)){res.writeHead(204).end();return;}
        if(a.action==='read'&&loopback(a.ip)&&same(new URLSearchParams(a.query).get('relay_reader'),readerToken)&&grants.has(a.path)){res.writeHead(204).end();return;}
        const p=parse(a.path,a.query);
        if(a.action==='publish'&&!p){const parts=String(a.path||'').split('/'),u=users.get(parts[1]);if(u&&same(parts[2],u.inputKey)&&parts.length===3&&!u.destinationStreamKey&&!u.production?.destinations?.length)log('['+u.id+'] NOT READY — prepare a stream in the app first.');}
        if(a.action==='publish'&&a.protocol==='rtmp'&&p&&isHeld(p.id))heldActivity.set(p.id,Date.now());
        if(p&&!host.available(portal.get(p.id))){res.writeHead(403).end();return;}
        if(p&&users.get(p.id)?.guestExpiresAt&&users.get(p.id).guestExpiresAt<=Date.now()){res.writeHead(403).end();return;}
        if(a.action!=='publish'||a.protocol!=='rtmp'||!p||isHeld(p.id)||blocked(p)||ending.has(p.id)){res.writeHead(403).end();return;}
        prune();
        const existing=sessions.get(p.id)||starting.get(p.id)||reservations.get(p.id);
        if(!existing&&!host.canStart(p.id)){log('['+p.id+'] NOT READY — ask the host to check access and the member slot in the app.');res.writeHead(403).end();return;}
        if(existing&&existing.name!==p.name){res.writeHead(403).end();return;}
        const all=[...sessions.values(),...starting.values(),...reservations.values()];
        if(all.some(x=>x.id!==p.id&&(x.destinationHashes||[x.destinationHash]).some(h=>p.destinationHashes.includes(h)))){res.writeHead(403).end();return;}
        if(!existing&&new Set(all.map(x=>x.id)).size>=m.maxSessions){res.writeHead(403).end();return;}
        // Reserve before DNS lookup so simultaneous requests cannot bypass limits.
        if(!existing){held={...p,until:Date.now()+30000};reservations.set(p.id,held);}
        const epoch=controlEpoch.get(p.id)||0;
        const destination=await Promise.race([Promise.all(p.destinations.map(d=>validateDestination(d.url,m))),wait(4000).then(()=>{throw Error('Lookup timeout');})]);
        if(shutting||isHeld(p.id)||(controlEpoch.get(p.id)||0)!==epoch||ending.has(p.id)){res.writeHead(403).end();return;}
        grants.set(p.name,{...p,destination:destination[0]});res.writeHead(204).end();held=null;
      }catch{if(!res.headersSent)res.writeHead(403).end();}
      finally{if(held&&reservations.get(held.id)===held)reservations.delete(held.id);}
    });
  });
  auth.requestTimeout=5000;
  await new Promise((r,j)=>{auth.once('error',j);auth.listen(0,'127.0.0.1',r);});
  const apiPort=await freePort(),tls=c.tls?.enabled===true,internalPort=tls?await freePort():c.port;
  const cfg={logLevel:'error',logDestinations:['stdout'],readTimeout:'10s',writeTimeout:'10s',writeQueueSize:128,
    authMethod:'http',authHTTPAddress:`http://127.0.0.1:${auth.address().port}/auth`,authHTTPExclude:[],
    api:true,apiAddress:`127.0.0.1:${apiPort}`,apiAllowOrigins:[],rtsp:false,rtmp:true,rtmpEncryption:tls?'optional':'no',
    rtmpAddress:tls?`127.0.0.1:${internalPort}`:`:${c.port}`,hls:false,webrtc:false,srt:false,moq:false,metrics:false,pprof:false,playback:false,
    pathDefaults:{source:'publisher',overridePublisher:false,maxReaders:m.maxSessions+2},paths:{'~^live/[A-Za-z0-9_-]+/[A-Za-z0-9_-]+(/[A-Za-z0-9_.-]+)?$':{}}};
  if(tls){if(!fs.existsSync(c.tls.certFile)||!fs.existsSync(c.tls.keyFile))safe('TLS files missing.');cfg.rtmpsAddress=`:${c.port}`;cfg.rtmpServerCert=c.tls.certFile;cfg.rtmpServerKey=c.tls.keyFile;}
  fs.writeFileSync('data/multi-mediamtx.json',JSON.stringify(cfg),{mode:0o600});
  media=spawn(binary,['data/multi-mediamtx.json'],{stdio:['ignore','pipe','pipe']});media.stdout.resume();media.stderr.resume();
  media.on('error',()=>shutdown(1));media.on('close',()=>{if(!shutting){log('Media server stopped.');shutdown(1);}});
  const api=async(route,method='GET')=>{const r=await fetch(`http://127.0.0.1:${apiPort}${route}`,{method,signal:AbortSignal.timeout(2000)});if(!r.ok)throw Error('Media API');return r.status===204?null:r.json();};
  const kick=async source=>{if(source?.id)await api(`/v3/${source.type==='rtmpsConn'?'rtmps':'rtmp'}/conns/kick/${encodeURIComponent(source.id)}`,'POST').catch(()=>{});};
  const inputUrl=name=>`rtmp://127.0.0.1:${internalPort}/${name}?relay_reader=${readerToken}`;
  function end(id,reason){
    if(ending.has(id))return ending.get(id);
    const s=sessions.get(id)||starting.get(id)||reservations.get(id);if(!s)return Promise.resolve();
    s.cancelled=true;s.abort?.abort();
    const task=(async()=>{
      let bad=false;try{block(id,s.keyHash);}catch{bad=true;}
      log(`[${id}] BROADCAST ENDED: ${reason}`);
      await Promise.all([s.engine?.close(),kick(inputs.get(id)?.source||s.source)]);
      // Any in-flight probe/creation checks cancelled before starting output.
      await s.recording?.close();
      portal.endSession(id);sessions.delete(id);starting.delete(id);reservations.delete(id);inputs.delete(id);grants.delete(s.name);
      if(bad){log('Cannot save ended-key state.');setImmediate(()=>shutdown(1));}
    })();
    ending.set(id,task);task.finally(()=>ending.delete(id));return task;
  }
  async function start(p,source){
    if(shutting||isHeld(p.id)||reserved(p.id)&&!reservations.has(p.id))return;
    const pending={...p,source,cancelled:false,abort:new AbortController()};starting.set(p.id,pending);reservations.delete(p.id);
    let stage='detect input tracks';
    try{
      log(`[${p.id}] STARTUP: detecting incoming video and audio.`);
      const {video}=await detectTracks({signal:pending.abort.signal,
        probe:async timeout=>{
          const result=await execute('ffprobe',['-v','error','-rw_timeout','5000000','-analyzeduration','15000000','-probesize','20000000','-show_entries','stream=codec_type,width,height','-of','json',inputUrl(p.name)],{timeout,maxBuffer:65536,signal:pending.abort.signal});
          return JSON.parse(result.stdout).streams||[];
        },
        onAttempt:result=>{
          if(result.probeFailed)log(`[${p.id}] DETECTION attempt ${result.attempt}: probe failed; retrying within startup budget.`);
          else log(`[${p.id}] DETECTED attempt ${result.attempt}: video=${result.video}; audio=${result.audio}; width=${result.width}; height=${result.height}; ${result.complete?'ready':'waiting for complete tracks'}.`);
        }});
      stage='validate detected tracks';
      // Round odd input sizes up to even YUV420p dimensions. Keep one fixed
      // canvas throughout this broadcast, including collab switches/reconnects.
      const resolution=portal.get(p.id)?.settings.resolution;const width=resolution?.width||Math.ceil(video.width/2)*2,height=resolution?.height||Math.ceil(video.height/2)*2;
      if(!dimensions(width,height)||video.width*video.height>m.maxInputPixels)throw Error('Resolution outside budget');
      stage='prepare fallback picture';
      const picture=await execute('ffmpeg',['-v','error','-i','fallback.png','-vf',`scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,format=yuv420p`,'-frames:v','1','-threads','1','-f','rawvideo','pipe:1'],{encoding:'buffer',maxBuffer:width*height*3,timeout:15000,signal:pending.abort.signal});
      if(picture.stdout.length!==width*height*3/2)throw Error('Fallback picture');
      if(shutting||isHeld(p.id)||pending.cancelled||starting.get(p.id)!==pending)return;
      // Authorization expiry or input disappearance must not start an unseen output.
      stage='confirm publisher still connected';
      if(!inputs.get(p.id)?.ready)throw Error('Publisher disconnected during detection');
      stage='restore broadcast timer';
      const previous=state.active[p.id]?.keyHash===p.keyHash?state.active[p.id]:null;
      const deadline=previous?previous.deadline:(c.stopAfterMinutes?Date.now()+c.stopAfterMinutes*60000:0);
      if(deadline&&deadline<=Date.now())throw Error('Expired saved deadline');
      stage='save broadcast state';
      state.active[p.id]={keyHash:p.keyHash,deadline};save();
      const s={...pending,startedAt:Date.now(),deadline,width,height,selected:p.id,switchedAt:Date.now(),selectedFailedUntil:new Map()};
      stage='create output session';
      const owner=portal.get(p.id);s.recording=recordings.start(p.id,owner.production?.title||'Untitled stream',p.destinations.map(d=>d.name),c.mode==='live'&&!!owner.production?.record);pending.recording=s.recording;
      s.engine=new Session({destinations:p.destinations,recording:s.recording,overlayPool,overlayOptions:pip,config:{...c,width,height},fallback:picture.stdout,inputUrl:inputUrl(p.name),destination:p.destination,
        log:message=>log(`[${p.id}] ${message}`),failed:reason=>end(p.id,reason)});
      sessions.set(p.id,s);starting.delete(p.id);s.engine.setAvailable(true);
      log(`[${p.id}] BROADCAST STARTED — ${c.mode.toUpperCase()}; ${width}x${height} at ${c.fps} fps; ${deadline?'timer enabled':'manual end'}.`);
    }catch(error){
      if(!pending.cancelled&&!shutting){log(`[${p.id}] STARTUP FAILED at ${stage}: ${startupFailure(error)}`);await end(p.id,'initialization failed');}
    }finally{if(starting.get(p.id)===pending)starting.delete(p.id);}
  }
  async function poll(){
    if(shutting||pollBusy)return;pollBusy=true;
    try{
      prune();const data=await api('/v3/paths/list?itemsPerPage=100');apiErrors=0;const now=Date.now(),seen=new Set();
      for(const path of data.items||[]){
        if(!path.online&&!path.ready)continue;
        // A just-authorized publisher can appear after its grant was revoked.
        // Continue recognizing held paths so an in-flight connection is kicked.
        const g=grants.get(path.name)||parse(path.name,'');if(!g)continue;
        if(isHeld(g.id))heldActivity.set(g.id,Date.now());
        if(!host.available(portal.get(g.id))||isHeld(g.id)||ending.has(g.id)||state.blocked.includes(g.keyHash)){await kick(path.source);continue;}
        if(!grants.has(path.name))continue;
        seen.add(g.id);
        let i=inputs.get(g.id);
        if(!i||i.name!==path.name){i={...g,bytes:-1,lastData:now,healthySince:now,healthy:false};inputs.set(g.id,i);}
        const bytes=Number(path.bytesReceived||0);
        if(bytes!==i.bytes){i.bytes=bytes;i.lastData=now;}
        const healthy=bytes>0&&now-i.lastData<c.fallbackAfterSeconds*1000;
        if(healthy&&!i.healthy)i.healthySince=now;
        Object.assign(i,{ready:true,healthy,source:path.source});
        if(!sessions.has(g.id)&&!starting.has(g.id)&&!ending.has(g.id))start(g,path.source);
      }
      for(const id of [...state.held]){
        if(!users.has(id)||reserved(id))continue;
        if(Date.now()-(heldActivity.get(id)??Date.now())>=c.controlsAutoAllowAfterSeconds*1000){
          await controlAction(id,'allow');
          log(`[${id}] AUTO ALLOW — OBS quiet; ready for your next stream.`);
        }
      }
      for(const [id,i] of inputs)if(!seen.has(id)){i.ready=false;i.healthy=false;}
      for(const [id,s] of sessions){
        if(ending.has(id))continue;
        if(portal.get(id)?.guestExpiresAt&&now>=portal.get(id).guestExpiresAt){await end(id,'guest session expired');continue;}
        if(s.deadline&&now>=s.deadline){await end(id,'timer expired');continue;}
        const candidates=new Map([...inputs].map(([key,value])=>[key,{...value,healthy:value.healthy&&(s.selectedFailedUntil.get(key)||0)<=now}]));
        // A connected but undecodable feed must not hold a collab output forever.
        if(s.selected && !s.engine.live && now-s.switchedAt>10000 && candidates.get(s.selected)?.healthy){
          s.selectedFailedUntil.set(s.selected,now+15000);candidates.get(s.selected).healthy=false;
        }
        const primary=candidates.get(id);
        const backups=effectiveCollab(id)?portal.fallback(id):[];
        const chosen=s.forcedFallback?(backups.find(peer=>candidates.get(peer)?.healthy)||null):primary?.healthy&&(!backups.length||now-primary.healthySince>=m.collab.recoverAfterSeconds*1000)?id:backups.find(peer=>candidates.get(peer)?.healthy)||(primary?.healthy?id:null);
        const missingPrimary=!primary?.healthy;
        s.primaryMissingSince=missingPrimary?(s.primaryMissingSince||now):0;
        const timeout=hostFeatures(c).fallbackTimeout?(portal.get(id)?.settings.fallbackTimeoutMinutes||0):0;
        if(timeout&&s.primaryMissingSince&&now-s.primaryMissingSince>=timeout*60000){await controlAction(id,'end');log(`[${id}] Fallback timeout ended the broadcast.`);continue;}
        s.engine.labelsEnabled=hostFeatures(c).povLabels&&portal.get(id)?.settings.povLabels!==false;
        s.engine.povName=chosen&&chosen!==id?chosen:'';
        if(chosen!==s.selected){
          s.selected=chosen;s.switchedAt=now;
          if(chosen)s.engine.setSource(inputUrl(inputs.get(chosen).name));
          log(`[${id}] SOURCE ${chosen===id?'primary':chosen?'collab '+chosen:'fallback screen'}`);
        }
        for(const [owner,frames] of portal.chatFrames){for(const [source,frame]of frames)if(Date.now()-frame.at>15000)frames.delete(source);if(!frames.size)portal.chatFrames.delete(owner);}
        s.engine.setMainBox(portal.get(id)?.settings.main);
        s.engine.setChatFrames(hostFeatures(c).chatOverlays?(portal.get(id)?.settings.chatOverlays||[]):[],portal.chatFrames.get(id));
        s.engine.setAvailable(Boolean(chosen));
        if(effectivePip(id)){
          const owner=users.get(id);
          const overlays=portal.overlays(id).filter(tile=>tile.publisher!==chosen&&inputs.get(tile.publisher)?.healthy)
            .map(tile=>({id:tile.publisher,...tile,inputUrl:inputUrl(inputs.get(tile.publisher).name)}));
          s.engine.setOverlays(overlays);
        }else s.engine.setOverlays([]);
      }
    }catch{if(++apiErrors===5)log('Local media API unavailable.');if(apiErrors>=20)await shutdown(1);}
    finally{pollBusy=false;}
  }
  function controlStatus(id){
    const s=sessions.get(id),begin=starting.has(id)||reservations.has(id),held=isHeld(id);
    const stateName=ending.has(id)?'ending':held?'held':begin?'starting':s?(s.engine.live?(s.selected===id?'live':'collab'):'fallback'):'ready';
    return {id,forcedFallback:!!s?.forcedFallback,fallbackRemainingSeconds:s?.primaryMissingSince&&hostFeatures(c).fallbackTimeout&&portal.get(id)?.settings.fallbackTimeoutMinutes?Math.max(0,Math.ceil(portal.get(id).settings.fallbackTimeoutMinutes*60-(Date.now()-s.primaryMissingSince)/1000)):null,health:hostFeatures(c).streamHealth?{outputFps:s?.engine.outputFps||0,inputHealthy:!!inputs.get(id)?.healthy,uptimeSeconds:s?Math.max(0,Math.floor((Date.now()-(s.startedAt||Date.now()))/1000)):0,sourceName:s?.selected||null}:null,outputs:s?.engine.hub?.status()||[],recording:s?.recording?.status()||null,overlayWidthPercent:pip.widthPercent,overlayMarginPercent:pip.marginPercent,pictureInPicture:effectivePip(id),collabFallback:effectiveCollab(id),mode:c.mode,state:stateName,held,broadcast:Boolean(s),source:s?.engine.live?(s.selected===id?'primary':'collab'):'fallback',width:s?.width||0,height:s?.height||0,fps:c.fps,remainingSeconds:s?.deadline?Math.max(0,Math.ceil((s.deadline-Date.now())/1000)):null};
  }
  async function controlAction(id,action){
    if(shutting||!users.has(id))throw Error('Unavailable');
    if(['force-fallback','restore-primary'].includes(action)){if(!hostFeatures(c).manualFallback)throw Error('Manual fallback disabled by host');const session=sessions.get(id);if(!session)throw Error('Start a broadcast first');session.forcedFallback=action==='force-fallback';return;}
    if(['pip-on','pip-off','collab-on','collab-off'].includes(action)){
      if((action==='pip-on'&&!hostFeatures(c).pictureInPicture)||(action==='collab-on'&&!hostFeatures(c).collaboratorFallback))throw Error('Feature disabled by host');
      const [feature,value]=action.split('-'),previous=state.preferences;
      state.preferences=[...previous.filter(p=>p.id!==id),{...preferences(id),id,[feature]:value==='on'}];
      try{save();}catch(error){state.preferences=previous;throw error;}
      if(feature==='pip'&&value==='off')sessions.get(id)?.engine.setOverlays([]);
      log(`[${id}] ${feature.toUpperCase()} ${value} — saved for this output.`);return;
    }
    controlEpoch.set(id,(controlEpoch.get(id)||0)+1);
    if(action==='end'){
      if(!isHeld(id))state.held.push(id);
      heldActivity.set(id,Date.now());
      // Persist the hold BEFORE disconnecting, including when no OBS is attached.
      try{save();}catch(error){await end(id,'control stop; state persistence failed');throw error;}
      await end(id,'ended by streamer controls');
      for(const [name,g] of grants)if(g.id===id)grants.delete(name);
      reservations.delete(id);inputs.delete(id);
      log(`[${id}] CONTROL STOP — waiting for OBS to stop reconnecting; automatic allow follows.`);
    }else if(action==='allow'){
      if(ending.has(id))await ending.get(id);
      if(sessions.has(id)||starting.has(id)||reservations.has(id))throw Error('Broadcast is active');
      const heldBefore=state.held,blockedBefore=state.blocked;
      state.held=state.held.filter(x=>x!==id);
      const removed=state.blocked.filter(key=>state.blockedOwners[key]===id);
      state.blocked=state.blocked.filter(key=>state.blockedOwners[key]!==id);
      try{save();}catch(error){state.held=heldBefore;state.blocked=blockedBefore;throw error;}
      heldActivity.delete(id);
      for(const key of removed)lastAttempt.delete(key);
      log(`[${id}] CONTROL ALLOW — OBS may start this publisher again.`);
    }else throw Error('Unknown action');
  }
  async function shutdown(code=0){
    if(shutting)return;shutting=true;clearInterval(pollTimer);
    await Promise.all([...new Set([...sessions.keys(),...starting.keys()])].map(id=>end(id,'server stopped')));
    await overlayPool?.close();
    await controls?.close();
    auth.close();auth.closeAllConnections();
    if(media&&media.exitCode===null&&media.signalCode===null){media.kill('SIGTERM');await Promise.race([new Promise(r=>media.once('close',r)),wait(2000)]);if(media.exitCode===null&&media.signalCode===null)media.kill('SIGKILL');}
    process.exit(code);
  }
  process.on('SIGINT',()=>shutdown());process.on('SIGTERM',()=>shutdown());
  readline.createInterface({input:process.stdin}).on('line',line=>{
    const [command,id]=line.trim().split(/\s+/);
    if(command==='stop')shutdown();
    else if(command==='status'){
      log(`STATUS ${sessions.size} broadcasts; ${starting.size} starting; collab ${hostFeatures(c).collaboratorFallback?'on':'off'}; inset decoders ${overlayPool?.entries.size||0}`);
      for(const [who,s] of sessions)log(`[${who}] ${s.width}x${s.height}; source ${s.selected||'fallback screen'}; timer ${s.deadline?Math.max(0,Math.ceil((s.deadline-Date.now())/1000))+' seconds':'off'}`);
    }else if(command==='end'){
      if(id==='all')Promise.all([...new Set([...sessions.keys(),...starting.keys()])].map(who=>end(who,'manual command')));
      else if(users.has(id))end(id,'manual command');else log('Use end <publisher-id> or end all.');
    }else if(command==='allow'&&users.has(id)){
      controlAction(id,'allow').catch(()=>log('Could not allow publisher; end its active broadcast first.'));
    }else if(command==='rearm'){
      if(sessions.size||starting.size||ending.size)log('End broadcasts before rearming.');
      else{state.blocked=[];state.active={};lastAttempt.clear();save();log('Ended event keys rearmed. Streamer control holds remain in effect; use allow <id> to release one.');}
    }else if(command==='collab'&&['on','off'].includes(id)){m.collab.enabled=id==='on';log(`COLLAB ${id}; same-group publishers only. Runtime override; config controls next restart.`);}
    else if(command)log('Commands: status, end <id>, end all, collab on, collab off, rearm, allow <id>, stop');
  });
  let ready=false;for(let n=0;n<40&&!shutting;n++){try{await api('/v3/paths/list');ready=true;break;}catch{await wait(100);}}
  if(!ready){log('Media server did not become ready.');await shutdown(1);return;}
  if(controlConfig){
    try{controls=await createPortalServer({config:controlConfig,store:portal,status:controlStatus,action:controlAction,rtmpPort:c.port,rtmpTls:tls,recordings,
      busy:id=>reserved(id)||inputs.get(id)?.ready,
      changed:()=>{m.publishers=portal.db.users;users.clear();m.allowedDestinationHosts=[];for(const p of m.publishers){users.set(p.id,p);if(p.destinationBaseUrl)m.allowedDestinationHosts.push(new URL(p.destinationBaseUrl).hostname.toLowerCase());for(const d of p.production?.destinations||[])m.allowedDestinationHosts.push(new URL(d.url).hostname.toLowerCase());}},
      validateDestination:async value=>validateDestination(value,{...m,allowedDestinationHosts:[new URL(value).hostname.toLowerCase()]})});log('CONTROLS READY — open the app or the control port in your browser.');}
    catch{log('Controls could not start. Check control port allocation, HTTPS configuration and files.');await shutdown(1);return;}
  }
  log(`RELAY READY — MULTI ${tls?'RTMPS':'RTMP'} port ${c.port}; ${c.mode.toUpperCase()}; max ${m.maxSessions} broadcasts; collab ${hostFeatures(c).collaboratorFallback?'on':'off'}.`);
  log(`PICTURE IN PICTURE ${hostFeatures(c).pictureInPicture?'ON':'OFF'} — main-feed audio only.`);
  log('WAITING FOR OBS — no outgoing stream until an authorized publisher connects.');
  pollTimer=setInterval(poll,500);await poll();
}
