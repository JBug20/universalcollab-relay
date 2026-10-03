import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {PortalStore} from '../src/portal-store.mjs';import {createPortalServer} from '../src/portal-server.mjs';import {hostFeatures} from '../src/host-features.mjs';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'relay-guests-'));let server;const config={hostFeatures:{guestInvites:true}},actions=[];
try{
 const store=new PortalStore({directory:dir,features:()=>hostFeatures(config)});const owner=store.register('Owner',store.joinPassword),other=store.register('Other',store.joinPassword);
 server=await createPortalServer({config:{port:0,bind:'127.0.0.1'},store,status:()=>({state:'ready'}),action:async(id,a)=>actions.push([id,a]),changed:()=>{},busy:()=>false,validateDestination:async()=>{},rtmpPort:1935});
 const origin='http://127.0.0.1:'+server.server.address().port;
 const req=(route,body,user=owner)=>fetch(origin+'/api/v3/'+route,{method:body===undefined?'GET':'POST',headers:{Origin:origin,'Content-Type':'application/json',Authorization:'Bearer '+user.id+':'+user.controlToken},body:body===undefined?undefined:JSON.stringify(body)});
 const response=await req('invite',{minutes:30});assert.equal(response.status,200);const invite=await response.json();assert(!JSON.stringify(await (await req('invites')).json()).includes(invite.secret));
 config.hostFeatures.registration=false;const join=await req('register',{username:'Guest',password:invite.secret});assert.equal(join.status,200);const guest=await join.json();guest.controlToken=guest.token;
 assert.equal((await req('register',{username:'Another',password:invite.secret})).status,403);assert.equal((await req('invite',{minutes:30},guest)).status,403);
 assert.equal((await req('invite-revoke',{id:invite.id},other)).status,404);assert.equal((await req('invite-revoke',{id:invite.id})).status,200);assert.deepEqual(actions,[['Guest','end']]);assert.equal((await req('view',undefined,guest)).status,401);
 config.hostFeatures.guestInvites=false;assert.equal((await req('invite',{minutes:30})).status,403);
 console.log('PASS HTTP invite creation, one-use guest joining with registration off, masked listings, owner-only revocation ends guest, expired auth rejection and host disable.');
}finally{await server?.close();fs.rmSync(dir,{recursive:true,force:true});}
