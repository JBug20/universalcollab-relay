import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {execFileSync} from 'node:child_process';
import {PortalStore}from'../src/portal-store.mjs';import {createPortalServer}from'../src/portal-server.mjs';import{acceptChatFrames,boxPixels,scaleFrame}from'../src/stream-layout.mjs';import{Session}from'../src/session.mjs';import{geometry}from'../src/pip.mjs';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'canvas063-'));let api,session;let features={registration:true,chatOverlays:true,pictureInPicture:true,collaboratorFallback:true};
try{
 const store=new PortalStore({directory:dir,features:()=>features});const owner=store.register('owner',store.joinPassword);
 for(let i=1;i<=5;i++){const p=store.register('peer'+i,store.joinPassword);const req=store.request('owner',p.id,'video');store.respond(p.id,req.id,'approve');}
 const main={x:.5,y:.5,width:.5,height:.5},overlays=store.db.users.slice(1).map((u,i)=>({publisher:u.id,corner:'top-right',x:i/5,y:.5,width:.12,height:.25,z:i}));
 const chatOverlays=[{source:'combined',x:0,y:0,width:.2,height:.6,z:9}];
 store.settings('owner',{main,overlays,chatOverlays,fallback:[]});assert.equal(store.overlays('owner').length,5);
 const key=owner.inputKey;const restarted=new PortalStore({directory:dir});assert.equal(restarted.get('owner').inputKey,key);assert.equal(restarted.get('owner').settings.overlays.length,5);assert.deepEqual(restarted.get('owner').settings.main,{...main,visible:true,z:-1});
 assert.throws(()=>store.settings('owner',{main:{...main,width:NaN},overlays,chatOverlays,fallback:[]}));
 assert.throws(()=>store.settings('owner',{main,overlays,chatOverlays:[...chatOverlays,...chatOverlays],fallback:[]}));
 const frame={source:'combined',width:4,height:4,data:Buffer.alloc(24,180).toString('base64')};acceptChatFrames(store,'owner',{frames:[frame]});assert.equal(store.chatFrames.get('owner').get('combined').frame.length,24);
 assert.throws(()=>acceptChatFrames(store,'peer1',{frames:[frame]}));assert.throws(()=>acceptChatFrames(store,'owner',{frames:[{...frame,data:'x'}]}));
 features.chatOverlays=false;assert.throws(()=>acceptChatFrames(store,'owner',{frames:[frame]}));features.chatOverlays=true;
 const W=320,H=180,b=boxPixels(W,H,main);assert.deepEqual(b,{width:160,height:90,x:80,y:44});
 const geo=geometry(W,H,{widthPercent:25,marginPercent:2},'top-right',{x:0,y:0,width:.5,height:.5});assert.deepEqual(geo,{width:160,height:90,x:0,y:0});
 assert.equal(scaleFrame(Buffer.alloc(24,180),4,4,80,60).length,7200);
 // Actual FFmpeg filter used by a resized main feed: output stays original size.
 const raw=execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','color=red:s=320x180:r=30','-vf',`scale=${b.width}:${b.height}:force_original_aspect_ratio=decrease,pad=${b.width}:${b.height}:(ow-iw)/2:(oh-ih)/2,pad=${W}:${H}:${b.x}:${b.y},format=yuv420p`,'-frames:v','1','-threads','1','-f','rawvideo','pipe:1']);assert.equal(raw.length,W*H*3/2);assert.equal(raw[0],16);assert(raw[(b.y+10)*W+b.x+10]>16);
 const failures=[];session=new Session({config:{width:W,height:H,fps:30,mode:'test',videoBitrateKbps:500,fallbackAfterSeconds:2},fallback:raw,inputUrl:'unused',destination:'',log:()=>{},failed:m=>failures.push(m)});
 session.setMainBox(main);session.setChatFrames(chatOverlays,store.chatFrames.get('owner'));assert.equal(session.chatItems.length,1);
 const composite=session.picture(raw,performance.now());assert.equal(composite[0],180);assert.equal(raw[0],16);
 for(const f of store.chatFrames.get('owner').values())f.at-=16000;for(const item of session.chatItems)item.at-=16000;assert.equal(session.picture(raw,performance.now())[0],16);session.setChatFrames(chatOverlays,store.chatFrames.get('owner'));assert.equal(session.chatItems.length,0);
 await new Promise(r=>setTimeout(r,1600));assert(session.ticks>=35);assert.deepEqual(failures,[]);await session.close();session=null;
 api=await createPortalServer({config:{port:0,bind:'127.0.0.1'},store,status:id=>({id,broadcast:true,state:'live'}),action:async()=>{},changed:()=>{},busy:()=>true,validateDestination:async()=>{},rtmpPort:1935});
 const origin='http://127.0.0.1:'+api.server.address().port;const req=(route,body,user=owner)=>fetch(origin+route,{method:body?'POST':'GET',headers:{Origin:origin,Authorization:'Bearer '+user.id+':'+user.controlToken,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
 assert.equal((await req('/api/v3/view')).status,200);assert.equal((await(await req('/api/v3/view')).json()).capabilities.streamCanvas,1);
 assert.equal((await req('/api/v3/chat-frame',{frames:[frame]})).status,200);assert.equal((await req('/api/v3/chat-frame',{frames:[frame]},store.get('peer1'))).status,400);
 assert.equal((await fetch(origin+'/stream-canvas.js')).status,200);
 store.respond('peer1',store.db.requests.find(r=>r.peer==='peer1').id,'revoke');assert.equal(store.overlays('owner').length,4);
 console.log('PASS five approved PiPs, migration/static keys, geometry, real FFmpeg resized main and output pump, chat composition/expiry, host switch, scoped frame API and revocation.');
}finally{await session?.close();await api?.close();fs.rmSync(dir,{recursive:true,force:true});}
