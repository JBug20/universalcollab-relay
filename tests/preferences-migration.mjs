import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {normalizePreferences,migratePreferences} from '../src/preferences-migration.mjs';
const users=new Map([['streamer1',{}],['streamer2',{}]]);
assert.deepEqual(normalizePreferences([{id:'streamer1',pip:false,collab:true},{id:'deleted',pip:true},null,4,{id:'streamer2',pip:'false',collab:3}],users),[{id:'streamer1',pip:false,collab:true},{id:'streamer2',pip:false}]);
assert.deepEqual(normalizePreferences({streamer1:{pip:false},deleted:{collab:true}},users),[{id:'streamer1',pip:false}]);
assert.deepEqual(normalizePreferences([{id:'streamer1',pip:false},{id:'streamer1',collab:false}],users),[{id:'streamer1',pip:false,collab:false}]);
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'relay-pref-'));try{
 const file=dir+'/multi-state.json',state={blocked:['a'.repeat(64)],active:{},held:['streamer1'],blockedOwners:{['a'.repeat(64)]:'streamer1'},preferences:[{id:'old_user',pip:true},{id:'streamer1',pip:false}]};
 const original=JSON.stringify(state);fs.writeFileSync(file,original);
 assert(migratePreferences(state,users,file));assert.equal(fs.readFileSync(file+'.before-0.3.1','utf8'),original);
 assert.deepEqual(state.preferences,[{id:'streamer1',pip:false}]);assert.deepEqual(state.held,['streamer1']);assert.deepEqual(state.blocked,['a'.repeat(64)]);
 assert.equal(migratePreferences(state,users,file),false);
 console.log('PASS legacy/orphan/malformed preferences, valid toggle retention, exact backup, holds retained and idempotent restart.');
}finally{fs.rmSync(dir,{recursive:true,force:true});}
