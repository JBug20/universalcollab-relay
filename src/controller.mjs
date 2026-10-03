import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import readline from 'node:readline';
import {spawn,spawnSync} from 'node:child_process';
import {createHash,timingSafeEqual} from 'node:crypto';
import {Session} from './session.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const log=message=>console.log(new Date().toISOString()+' '+message);
const same=(a,b)=>typeof a==='string' && Buffer.byteLength(a)===Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a),Buffer.from(b));
const loopback=ip=>['127.0.0.1','::1','::ffff:127.0.0.1'].includes(ip);
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const freePort=()=>new Promise((resolve,reject)=>{
  const s=net.createServer();s.on('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});
});

export async function run() {
  const c=JSON.parse(fs.readFileSync('config.json','utf8'));
  c.port=Number(process.env.SERVER_PORT || c.port);
  c.mode=process.env.RELAY_MODE || c.mode;
  c.publishPassword=process.env.PUBLISH_PASSWORD || c.publishPassword;
  if(process.env.STOP_AFTER_MINUTES!==undefined)c.stopAfterMinutes=Number(process.env.STOP_AFTER_MINUTES);
  c.autoRearmAfterSeconds ??= 30;
  const fail=message=>{const e=new Error(message);e.safe=true;throw e;};
  if(!Number.isInteger(c.port)||c.port<1024||c.port>65535)fail('port must be 1024-65535.');
  if(!['test','live'].includes(c.mode))fail('mode must be test or live.');
  if(!/^[A-Za-z0-9_-]{24,64}$/.test(c.publishPassword)||c.publishPassword.startsWith('CHANGE_'))fail('Set publishPassword to your own 24-64 letters/numbers, hyphens or underscores.');
  if(typeof c.stopAfterMinutes!=='number'||!Number.isFinite(c.stopAfterMinutes)||c.stopAfterMinutes<0||c.stopAfterMinutes>525600)fail('stopAfterMinutes must be 0-525600 (0 = manual).');
  if(!Number.isInteger(c.autoRearmAfterSeconds)||c.autoRearmAfterSeconds<0||c.autoRearmAfterSeconds>86400)fail('autoRearmAfterSeconds must be 0-86400 (0 = manual rearm).');
  if(![25,30,50,60].includes(c.fps))fail('fps must be 25, 30, 50 or 60.');
  if(!Number.isSafeInteger(c.width)||!Number.isSafeInteger(c.height)||c.width<160||c.height<90||c.width%2||c.height%2)fail('Use even integer dimensions of at least 160x90.');
  if(!Number.isInteger(c.videoBitrateKbps)||c.videoBitrateKbps<250||c.videoBitrateKbps>15000)fail('videoBitrateKbps must be 250-15000.');
  if(typeof c.fallbackAfterSeconds!=='number'||!Number.isFinite(c.fallbackAfterSeconds)||c.fallbackAfterSeconds<0.5||c.fallbackAfterSeconds>30)fail('fallbackAfterSeconds must be 0.5-30.');
  const base=new URL(c.destinationBaseUrl);
  if(!['rtmp:','rtmps:'].includes(base.protocol)||base.username||base.password||base.search||base.hash)fail('destinationBaseUrl must be an RTMP(S) server URL without a stream key, query, or credentials.');
  c.destinationBaseUrl=c.destinationBaseUrl.replace(/\/+$/,'');
  const binary=path.resolve('vendor/mediamtx');
  if(!fs.existsSync(binary))fail('MediaMTX is missing. Run node install.mjs, then start again.');
  const check=spawnSync(binary,['--version'],{encoding:'utf8',timeout:5000});
  if(check.status!==0 || !check.stdout.includes('v1.21.0'))fail('This build requires MediaMTX v1.21.0. Run node install.mjs.');
  const picture=spawnSync('ffmpeg',['-v','error','-i','fallback.png','-vf',`scale=${c.width}:${c.height}:force_original_aspect_ratio=decrease,pad=${c.width}:${c.height}:(ow-iw)/2:(oh-ih)/2,format=yuv420p`,'-frames:v','1','-threads','1','-f','rawvideo','pipe:1'],{maxBuffer:c.width*c.height*3,timeout:15000});
  if(picture.status!==0||picture.stdout.length!==c.width*c.height*3/2)fail('FFmpeg could not load fallback.png.');
  fs.mkdirSync('data',{recursive:true,mode:0o700});
  let state={blocked:[],active:null};
  if(fs.existsSync('data/state.json'))state=JSON.parse(fs.readFileSync('data/state.json','utf8'));
  if(!Array.isArray(state.blocked)||state.blocked.some(h=>!/^\w{64}$/.test(h)))fail('Invalid data/state.json; restore a valid state file before starting.');
  if(state.active && (typeof state.active.keyHash!=='string'||!Number.isFinite(state.active.deadline)))fail('Invalid active state.');
  const save=()=>{
    fs.writeFileSync('data/state.tmp',JSON.stringify(state),{mode:0o600});
    fs.renameSync('data/state.tmp','data/state.json');
  };
  // Restart begins a fresh quiet window for old blocks, including legacy state.
  // Attempts are deliberately tracked in memory: restarting cannot shorten the window.
  const lastAttempt=new Map(state.blocked.map(h=>[h,Date.now()]));
  const block=h=>{if(!state.blocked.includes(h))state.blocked.push(h);lastAttempt.set(h,Date.now());state.active=null;save();};
  const stillBlocked=h=>{
    if(!state.blocked.includes(h))return false;
    const now=Date.now(),quiet=now-(lastAttempt.get(h)??now);
    if(c.autoRearmAfterSeconds>0 && quiet>=c.autoRearmAfterSeconds*1000 && !active && !ending){
      const previous=state.blocked;
      state.blocked=state.blocked.filter(value=>value!==h);
      try{save();}catch(error){state.blocked=previous;throw error;}
      lastAttempt.delete(h);
      log('Ended event key automatically rearmed after quiet period.');
      return false;
    }
    lastAttempt.set(h,now);
    return true;
  };
  if(state.active?.deadline && Date.now()>=state.active.deadline)block(state.active.keyHash);
  let active=null,ending=false,shutting=false,pending=null,pollTimer=null,pollBusy=false,apiErrors=0;
  let mtx=null, endingPromise=null;
  function parse(name) {
    if(typeof name!=='string')return null;
    const parts=name.split('/');
    if(parts.length!==3||parts[0]!=='live'||!same(parts[1],c.publishPassword)||! /^[A-Za-z0-9_-]{8,256}$/.test(parts[2]))return null;
    return {name,key:parts[2],keyHash:hash(parts[2])};
  }
  const auth=http.createServer((req,res)=>{
    if(req.method!=='POST'||req.url!=='/auth'){res.writeHead(404).end();return;}
    let body='',done=false;
    req.on('data',chunk=>{body+=chunk;if(body.length>8192){done=true;res.writeHead(413).end();req.destroy();}});
    req.on('end',()=>{
      if(done)return;
      try {
        const a=JSON.parse(body),p=parse(a.path);
        if(shutting){res.writeHead(403).end();return;}
        if(a.action==='api' && loopback(a.ip)){res.writeHead(204).end();return;}
        if(a.action==='read' && loopback(a.ip) && p && active?.name===p.name){res.writeHead(204).end();return;}
        if(a.action!=='publish'||a.protocol!=='rtmp'||!p||stillBlocked(p.keyHash)||ending){res.writeHead(403).end();return;}
        if(active && active.name!==p.name){res.writeHead(403).end();return;}
        if(!active){
          if(pending && Date.now()<pending.until && pending.name!==p.name){res.writeHead(403).end();return;}
          pending={name:p.name,until:Date.now()+15000};
        }
        res.writeHead(204).end();
      }catch {res.writeHead(403).end();}
    });
  });
  auth.requestTimeout=5000;
  await new Promise((resolve,reject)=>{auth.once('error',reject);auth.listen(0,'127.0.0.1',resolve);});
  const apiPort=await freePort();
  const tls=c.tls?.enabled===true;
  const internalRtmp=tls?await freePort():c.port;
  const mtxConfig={
    logLevel:'error',logDestinations:['stdout'],readTimeout:'10s',writeTimeout:'10s',writeQueueSize:128,
    authMethod:'http',authHTTPAddress:`http://127.0.0.1:${auth.address().port}/auth`,authHTTPExclude:[],
    api:true,apiAddress:`127.0.0.1:${apiPort}`,apiAllowOrigins:[],
    rtsp:false,rtmp:true,rtmpEncryption:tls?'optional':'no',
    rtmpAddress:tls?`127.0.0.1:${internalRtmp}`:`:${c.port}`,
    hls:false,webrtc:false,srt:false,moq:false,metrics:false,pprof:false,playback:false,
    pathDefaults:{source:'publisher',overridePublisher:false,maxReaders:1},
    paths:{'~^live/[A-Za-z0-9_-]+/[A-Za-z0-9_-]+$':{}}
  };
  if(tls){
    if(!fs.existsSync(c.tls.certFile)||!fs.existsSync(c.tls.keyFile))fail('TLS certificate or key file missing.');
    mtxConfig.rtmpsAddress=`:${c.port}`;mtxConfig.rtmpServerCert=c.tls.certFile;mtxConfig.rtmpServerKey=c.tls.keyFile;
  }
  fs.writeFileSync('data/mediamtx.json',JSON.stringify(mtxConfig),{mode:0o600});
  mtx=spawn(binary,['data/mediamtx.json'],{stdio:['ignore','pipe','pipe']});
  // Media server logs can include publish paths. Consume them without echoing secrets.
  mtx.stdout.resume();mtx.stderr.resume();
  mtx.on('error',()=>shutdown(1));
  mtx.on('close',()=>{if(!shutting){log('MediaMTX stopped. Check port availability and configuration.');shutdown(1);}});
  const api=async(route,method='GET')=>{
    const r=await fetch(`http://127.0.0.1:${apiPort}${route}`,{method,signal:AbortSignal.timeout(2000)});
    if(!r.ok)throw Error('Local media API unavailable');
    return r.status===204?null:r.json();
  };
  const kick=async source=>{
    if(!source?.id)return;
    const type=source.type==='rtmpsConn'?'rtmps':'rtmp';
    await api(`/v3/${type}/conns/kick/${encodeURIComponent(source.id)}`,'POST').catch(()=>{});
  };
  function end(reason) {
    if(ending)return endingPromise;
    if(!active)return Promise.resolve();
    ending=true;const old=active;
    endingPromise=(async()=>{
      let saveFailed=false;
      try{block(old.keyHash);}catch{saveFailed=true;}
      log(`BROADCAST ENDED: ${reason}`);
      await Promise.all([old.engine.close(),kick(old.source)]);
      active=null;pending=null;ending=false;
      if(saveFailed){log('Cannot save ended-key state; stopping the service.');await shutdown(1);return;}
      if(!shutting)log(c.autoRearmAfterSeconds>0 ? `WAITING FOR OBS — same key available after ${c.autoRearmAfterSeconds}s without publish attempts; new keys can start immediately.` : 'WAITING FOR OBS — use a new event key or rearm.');
    })();
    return endingPromise;
  }
  async function poll() {
    if(pollBusy||shutting)return;pollBusy=true;
    try {
      if(active?.deadline && Date.now()>=active.deadline){await end('timer expired');return;}
      const data=await api('/v3/paths/list?itemsPerPage=100');apiErrors=0;
      const ready=(data.items||[]).filter(p=>p.online===true||p.ready===true);
      if(active){
        const p=ready.find(p=>p.name===active.name);
        if(p)active.source=p.source;
        active.engine.setAvailable(Boolean(p));
      } else if(!ending){
        for(const p of ready){
          const parsed=parse(p.name);if(!parsed)continue;
          if(state.blocked.includes(parsed.keyHash)){await kick(p.source);continue;}
          const previous=state.active?.keyHash===parsed.keyHash?state.active:null;
          const deadline=previous?previous.deadline:(c.stopAfterMinutes?Date.now()+c.stopAfterMinutes*60000:0);
          if(deadline && deadline<=Date.now()){block(parsed.keyHash);await kick(p.source);continue;}
          state.active={keyHash:parsed.keyHash,deadline};save();
          active={...parsed,deadline,source:p.source,engine:null};pending=null;
          active.engine=new Session({config:c,fallback:picture.stdout,
            inputUrl:`rtmp://127.0.0.1:${internalRtmp}/${parsed.name}`,
            destination:`${c.destinationBaseUrl}/${parsed.key}`,log,
            failed:reason=>{end(reason).catch(()=>shutdown(1));}});
          active.engine.setAvailable(true);
          log(`BROADCAST STARTED — ${c.mode==='test'?'TEST MODE, nothing sent externally':'LIVE MODE'}; ${deadline?'timer enabled':'manual end'}.`);
          break;
        }
      }
    }catch {
      apiErrors++;
      if(apiErrors===5)log('Local media API is unavailable; checking again.');
      if(apiErrors>=20)await shutdown(1);
    }finally{pollBusy=false;}
  }
  async function shutdown(code=0) {
    if(shutting)return;shutting=true;clearInterval(pollTimer);
    try{await end('server stopped');}catch{}
    auth.close();auth.closeAllConnections();
    if(mtx && mtx.exitCode===null && mtx.signalCode===null){
      mtx.kill('SIGTERM');await Promise.race([new Promise(r=>mtx.once('close',r)),wait(2000)]);
      if(mtx.exitCode===null && mtx.signalCode===null)mtx.kill('SIGKILL');
    }
    process.exit(code);
  }
  process.on('SIGTERM',()=>shutdown());process.on('SIGINT',()=>shutdown());
  readline.createInterface({input:process.stdin}).on('line',line=>{
    const command=line.trim().toLowerCase();
    if(command==='stop')shutdown();
    else if(command==='end')end('manual command').catch(()=>shutdown(1));
    else if(command==='status')log(active?`STATUS ${ending?'ending':active.engine.live?'live':'fallback'}; timer ${active.deadline?Math.max(0,Math.ceil((active.deadline-Date.now())/1000))+' seconds':'off'}`:'STATUS waiting');
    else if(command==='rearm'){
      if(active||ending)log('End the current broadcast before rearming.');
      else{state.blocked=[];lastAttempt.clear();state.active=null;save();log('Ended event keys rearmed. OBS auto-reconnect can now start a broadcast.');}
    }else if(command)log('Commands: status, end, rearm, stop');
  });
  let apiReady=false;
  for(let i=0;i<40&&!shutting;i++){
    try{await api('/v3/paths/list');apiReady=true;break;}catch{await wait(100);}
  }
  if(shutting)return;
  if(!apiReady){log('MediaMTX did not become ready.');await shutdown(1);return;}
  log(`RELAY READY — ${tls?'RTMPS':'RTMP'} port ${c.port}; ${c.mode.toUpperCase()} mode.`);
  log('WAITING FOR OBS — no outgoing stream until a publisher connects.');
  pollTimer=setInterval(poll,500);
  await poll();
}
