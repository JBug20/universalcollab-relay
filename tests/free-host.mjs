import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
const {PortalStore,HostAdmin,createPortalServer}=process.env.UC_BUNDLE?await import(process.env.UC_BUNDLE):{...await import('../src/portal-store.mjs'),...await import('../src/host-admin.mjs'),...await import('../src/portal-server.mjs')};
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'uc-free-'));let server;
const oldFetch=globalThis.fetch;let networkCalls=0;globalThis.fetch=()=>{networkCalls++;throw Error('Offline');};
try{
 const config={multi:{maxSessions:3},hostFeatures:{guestInvites:true,registration:true}};
 let store=new PortalStore({directory:dir,features:()=>config.hostFeatures});
 // Migrate an existing unclaimed relay with more than the former free tier allowed.
 for(let i=0;i<8;i++)store.register('member'+i,store.joinPassword);
 const keys=store.db.users.map(u=>[u.id,u.controlToken,u.inputKey]);
 fs.writeFileSync(dir+'/license.json','expired or malformed legacy license');
 config.licensing={registryURL:'broken URL',publicKey:'obsolete'};
 let host=new HostAdmin({store,config});
 host.claim({code:fs.readFileSync(dir+'/host-setup-code.txt','utf8').trim()},store.get('member0'));
 const owner=store.get('member0');assert(host.canStart('member7'));
 host.settings(owner,{memberLimit:12,guestLimit:4});
 for(let i=8;i<12;i++)store.register('member'+i,store.joinPassword);
 assert.throws(()=>store.register('full',store.joinPassword),/slots/);
 assert.throws(()=>host.settings(store.get('member1'),{memberLimit:20}),/owner/);
 for(let i=0;i<4;i++){const invite=store.invite(owner.id,30);store.register('guest'+i,invite.secret);assert(host.canStart('guest'+i));}
 assert.throws(()=>store.invite(owner.id,30),/slots/);
 host.member(owner,{id:'member1',disabled:true});assert(!host.canStart('member1'));
 assert(!store.authenticate('member1:'+keys[1][1]));
 host.settings(owner,{memberLimit:20});
 store=new PortalStore({directory:dir,features:()=>config.hostFeatures});host=new HostAdmin({store,config});
 assert.equal(host.db.policy.memberLimit,20);assert(host.canStart('member11'));
 assert.deepEqual(store.db.users.slice(0,8).map(u=>[u.id,u.controlToken,u.inputKey]),keys);
 assert.equal(networkCalls,0);assert(!('license' in host.view(store.get(owner.id))));
 globalThis.fetch=oldFetch;
 server=await createPortalServer({config:{bind:'127.0.0.1',port:0},store,status:()=>({broadcast:false}),action:async()=>{},changed:()=>{},busy:()=>false,validateDestination:async()=>{},rtmpPort:1935});
 const origin='http://127.0.0.1:'+server.server.address().port;
 const headers={Origin:origin,Authorization:'Bearer '+owner.id+':'+owner.controlToken,'Content-Type':'application/json'};
 for(const route of ['host-license','host-refresh'])assert.equal((await fetch(origin+'/api/v3/'+route,{method:'POST',headers,body:'{}'})).status,404);
 const v=await(await fetch(origin+'/api/v3/host-view',{headers})).json();assert.equal(v.policy.memberLimit,20);assert(!v.license);
 console.log('PASS offline migration, obsolete license ignored, >10 members and >2 guests, host limits, permissions, restart persistence, key preservation, removed activation endpoints.');
}finally{globalThis.fetch=oldFetch;await server?.close();fs.rmSync(dir,{recursive:true,force:true});}
