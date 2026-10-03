import fs from 'node:fs';import path from 'node:path';import{randomUUID}from'node:crypto';import{PortalError}from'./portal-store.mjs';
export class Recordings{
 constructor({directory='data/recordings',enabled=false,maxStorageMB=1024,minFreeMB=256}={}){
  if(!Number.isFinite(maxStorageMB)||maxStorageMB<16||!Number.isFinite(minFreeMB)||minFreeMB<0)throw Error('Invalid recording storage settings.');
  Object.assign(this,{directory,enabled,maxBytes:maxStorageMB*1048576,minFreeBytes:minFreeMB*1048576});fs.mkdirSync(directory,{recursive:true,mode:0o700});this.file=path.join(directory,'index.json');this.entries=fs.existsSync(this.file)?JSON.parse(fs.readFileSync(this.file,'utf8')):[];this.active=new Map();
  for(const e of this.entries){if(e.state==='live'){e.state='interrupted';e.endedAt=new Date().toISOString();}e.bytes=this.size(e.id);}this.save();
 }
 location(id){if(!/^[a-f0-9-]{36}$/.test(id))throw new PortalError('Recording not found.',404);return path.join(this.directory,id+'.ts');}
 size(id){try{return fs.statSync(this.location(id)).size;}catch{return 0;}}
 save(){fs.writeFileSync(this.file+'.tmp',JSON.stringify(this.entries),{mode:0o600});fs.renameSync(this.file+'.tmp',this.file);}
 usage(owner){return this.entries.filter(e=>owner===undefined||e.owner===owner).reduce((n,e)=>n+e.bytes||0,0);}
 list(owner){return this.entries.filter(e=>e.owner===owner).slice(-100).reverse().map(({owner,...e})=>({...e,bytes:this.size(e.id),downloadable:e.state!=='live'&&this.size(e.id)>0}));}
 get(owner,id){const e=this.entries.find(e=>e.owner===owner&&e.id===id);if(!e||e.state==='live'||!this.size(id))throw new PortalError('Recording is not available.',404);return {entry:e,file:this.location(id)};}
 delete(owner,id){this.get(owner,id);fs.rmSync(this.location(id),{force:true});this.entries=this.entries.filter(e=>!(e.owner===owner&&e.id===id));this.save();}
 start(owner,title,destinations,want){
  const e={id:randomUUID(),owner,title:title||'Untitled stream',destinations,startedAt:new Date().toISOString(),endedAt:null,state:'live',bytes:0,recording:!!want&&this.enabled,note:want&&!this.enabled?'Recording disabled by host':''};this.entries.push(e);this.save();let stream=null,closed=false,failed=false,lastCheck=0;
  const fail=message=>{if(failed)return;failed=true;e.note=message;e.recording=false;stream?.end();try{this.save();}catch{}};
  const room=(extra=0)=>{if(!this.spaceAt||Date.now()-this.spaceAt>1000){const s=fs.statfsSync(this.directory);this.spaceAvailable=s.bavail*s.bsize;this.spaceAt=Date.now();}return this.usage()+extra<=this.maxBytes&&this.usage(owner)+extra<=(this.quota?.(owner)??this.maxBytes)&&this.spaceAvailable-extra>this.minFreeBytes;};
  if(e.recording){try{if(!room(1))fail('Recording storage limit reached');else{stream=fs.createWriteStream(this.location(e.id),{flags:'wx',mode:0o600});stream.on('error',()=>fail('Recording stopped: disk write failed'));}}catch{fail('Recording could not start');}}
  const result={id:e.id,write:chunk=>{if(!stream||failed||closed)return;try{if(!room(chunk.length)){fail('Recording stopped: storage limit reached');return;}if(stream.writableLength>4194304){fail('Recording stopped: storage too slow');return;}stream.write(chunk);e.bytes+=chunk.length;this.spaceAvailable-=chunk.length;}catch{fail('Recording stopped: disk unavailable');}},close:async()=>{if(closed)return;closed=true;if(stream&&!stream.destroyed)await new Promise(resolve=>{stream.once('error',resolve);stream.end(resolve);});e.state='ended';e.endedAt=new Date().toISOString();e.bytes=this.size(e.id);this.active.delete(e.id);try{this.save();}catch{}},status:()=>({id:e.id,recording:!!stream&&!failed,note:e.note})};this.active.set(e.id,result);return result;
 }
}
