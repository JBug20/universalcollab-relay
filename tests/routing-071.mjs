import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {PortalStore}from'../src/portal-store.mjs';import{parsePublisherPath}from'../src/multi-routing.mjs';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'routing071-'));
try{let s=new PortalStore({directory:dir}),u=s.register('test',s.joinPassword);assert.equal(u.destinationBaseUrl,'');assert.equal(u.destinationStreamKey,'');s=new PortalStore({directory:dir});u=s.get('test');assert.equal(u.destinationBaseUrl,'');const users=new Map([[u.id,u]]);assert.equal(parsePublisherPath('live/test/'+u.inputKey,'',users),null);
s.setProduction('test',{id:'draft',title:'Test',destinations:[{id:'twitch',name:'Twitch',url:'rtmp://example.com/live',key:'TW'},{id:'youtube',name:'YouTube',url:'rtmp://example.net/live',key:'YT'}]});
assert.equal(parsePublisherPath('live/test/'+u.inputKey,'',users).destinations.length,2);assert.equal(parsePublisherPath('live/test/'+u.password+'/oldRestreamKey','',users),null);assert.equal(s.publicView('test',()=>({})).me.production.id,'draft');assert.equal(s.publicView('test',()=>({})).capabilities.verifiedProduction,2);
console.log('PASS blank destination survives restart, no implicit Restream, permanent OBS key routes complete plan, legacy override rejected.');
}finally{fs.rmSync(dir,{recursive:true,force:true});}
