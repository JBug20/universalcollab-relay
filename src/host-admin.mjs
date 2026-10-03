import fs from 'node:fs';
import {randomBytes,createHash,timingSafeEqual} from 'node:crypto';
import {PortalError} from './portal-store.mjs';
const token=()=>randomBytes(32).toString('base64url'),hash=s=>createHash('sha256').update(String(s||'')).digest('hex');
const eq=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
export class HostAdmin{
 constructor({store,config,recordings=null,directory=store.directory}){
  Object.assign(this,{store,config,recordings,directory});this.file=directory+'/host.json';this.auditFile=directory+'/host-audit.json';
  this.db=fs.existsSync(this.file)?JSON.parse(fs.readFileSync(this.file,'utf8')):{version:1,ownerId:null,claimHash:'',policy:{guestLimit:2,guestMaxMinutes:120,defaultStorageMB:1024},features:{},maxSessions:null};
  this.audit=fs.existsSync(this.auditFile)?JSON.parse(fs.readFileSync(this.auditFile,'utf8')):[];
  if(!this.db.ownerId&&!this.db.claimHash){const code=token();this.db.claimHash=hash(code);this.persist();fs.writeFileSync(directory+'/host-setup-code.txt',code+'\n',{mode:0o600});}
  this.db.policy.maxStorageMB??=config.recordings?.maxStorageMB??1024;this.db.policy.minFreeMB??=config.recordings?.minFreeMB??256;
  this.db.policy.memberLimit??=Math.max(100,this.counts().members.length);
  this.apply();store.hostAdmin=this;
 }
 persist(){fs.writeFileSync(this.file+'.tmp',JSON.stringify(this.db),{mode:0o600});fs.renameSync(this.file+'.tmp',this.file);}
 apply(){Object.assign(this.config.hostFeatures??={},this.db.features);if(this.db.maxSessions!==null)this.config.multi.maxSessions=this.db.maxSessions;if(this.recordings){this.recordings.enabled=this.config.hostFeatures.recording===true;if(this.db.policy.maxStorageMB!==undefined)this.recordings.maxBytes=this.db.policy.maxStorageMB*1048576;if(this.db.policy.minFreeMB!==undefined)this.recordings.minFreeBytes=this.db.policy.minFreeMB*1048576;this.recordings.quota=owner=>(this.store.get(owner)?.storageLimitMB??this.db.policy.defaultStorageMB)*1048576;}}
 log(actor,event,target=''){this.audit.push({at:Date.now(),actor,event,target});this.audit=this.audit.slice(-500);fs.writeFileSync(this.auditFile+'.tmp',JSON.stringify(this.audit),{mode:0o600});fs.renameSync(this.auditFile+'.tmp',this.auditFile);}
 isOwner(u){return !!u&&!u.disabled&&this.db.ownerId===u.id;}
 require(u){if(!this.isOwner(u))throw new PortalError('Host administration requires the owner account.',403);}
 counts(){const members=this.store.db.users.filter(u=>!u.disabled&&!u.guestExpiresAt);members.sort((a,b)=>(a.id===this.db.ownerId?-1:b.id===this.db.ownerId?1:0));return {members,guests:this.store.db.users.filter(u=>!u.disabled&&u.guestExpiresAt>Date.now())};}
 available(u){if(!u||u.disabled)return false;if(u.guestExpiresAt)return u.guestExpiresAt>Date.now();return true;}
 canStart(id){const u=this.store.get(id);if(!this.available(u))return false;const c=this.counts();return u.guestExpiresAt?c.guests.slice(0,this.db.policy.guestLimit).some(p=>p.id===id):c.members.slice(0,this.db.policy.memberLimit).some(p=>p.id===id);}
 assertJoin(guest){const c=this.counts(),limit=this.db.policy.memberLimit;if(!guest&&!this.db.ownerId&&c.members.length>=limit-1)throw new PortalError('The host must claim the reserved owner slot first.',409);if(guest?c.guests.length>=this.db.policy.guestLimit:c.members.length>=limit)throw new PortalError(guest?'Guest slots are full.':'Member slots are full.',409);}
 assertInvite(id,minutes){this.require(this.store.get(id));if(minutes>this.db.policy.guestMaxMinutes)throw new PortalError('Invitation exceeds the host guest duration limit.');const pending=this.store.db.invites.filter(i=>!i.usedBy&&!i.revoked&&i.expiresAt>Date.now()).length;if(this.counts().guests.length+pending>=this.db.policy.guestLimit)throw new PortalError('Guest slots are reserved or full.',409);}
 claim(body,user){
  if(this.db.ownerId)throw new PortalError('This relay has already been claimed.',409);
  if(!eq(hash(body.code),this.db.claimHash))throw new PortalError('Incorrect host setup code.',401);
  let u=user;
  if(!u){if(this.store.get(body.username))throw new PortalError('Sign in to the existing account before claiming it.',409);if(!/^[A-Za-z0-9_-]{1,32}$/.test(body.username||''))throw new PortalError('Choose a valid host username.');if(this.counts().members.length>=this.db.policy.memberLimit)throw new PortalError('Sign in to an existing member account to claim this relay.',409);u=this.store.transact(()=>{const item={id:body.username,password:token(),inputKey:token(),controlToken:token(),destinationBaseUrl:'',destinationStreamKey:'',settings:{overlays:[],fallback:[]}};this.store.db.users.push(item);return item;});}
  if(u.guestExpiresAt||u.disabled)throw new PortalError('A guest cannot own the relay.',403);
  this.db.ownerId=u.id;this.db.claimHash='';this.persist();fs.rmSync(this.directory+'/host-setup-code.txt',{force:true});this.log(u.id,'claimed');return {id:u.id,token:u.controlToken};
 }
 view(user){this.require(user);const c=this.counts();return {ownerId:this.db.ownerId,policy:this.db.policy,features:this.store.features(),maxSessions:this.config.multi.maxSessions??3,counts:{members:c.members.length,guests:c.guests.length},members:this.store.db.users.filter(u=>this.available(u)).concat(this.store.db.users.filter(u=>!this.available(u)).slice(-200)).map(u=>({id:u.id,disabled:!!u.disabled,role:u.id===this.db.ownerId?'owner':u.guestExpiresAt?'guest':'member',guestExpiresAt:u.guestExpiresAt||null,storageLimitMB:u.storageLimitMB??this.db.policy.defaultStorageMB,usedMB:(this.recordings?.usage(u.id)||0)/1048576,canStart:this.canStart(u.id)})),invites:this.store.db.invites.map(({digest,...i})=>i),audit:this.audit.slice(-50)};}
 rotate(user){this.require(user);const fresh=token();this.store.transact(()=>{this.store.get(user.id).controlToken=fresh;});this.log(user.id,'owner-login-rotated');return fresh;}
 settings(user,body){this.require(user);const policy={...this.db.policy},features={...this.db.features};for(const [key,min,max]of[['memberLimit',1,100000],['guestLimit',0,100000],['guestMaxMinutes',5,1440],['defaultStorageMB',0,10000000],['maxStorageMB',16,100000000],['minFreeMB',0,10000000]])if(body[key]!==undefined){if(!Number.isSafeInteger(body[key])||body[key]<min||body[key]>max)throw new PortalError('Invalid host storage or guest limit.');policy[key]=body[key];}
  const allowed=['registration','guestInvites','recording','recordingManagement','pictureInPicture','collaboratorFallback','chatOverlays','multipleDestinations','manualFallback','fallbackTimeout','povLabels','streamHealth','sessionPermissions'];
  if(body.features){for(const [k,v]of Object.entries(body.features)){if(!allowed.includes(k)||typeof v!=='boolean')throw new PortalError('Invalid feature setting.');features[k]=v;}}
  const maxSessions=body.maxSessions??this.db.maxSessions;if(maxSessions!==null&&(!Number.isSafeInteger(maxSessions)||maxSessions<1||maxSessions>12))throw new PortalError('Choose 1–12 simultaneous broadcasts.');
  const previous=this.db;this.db={...previous,policy,features,maxSessions};try{this.persist();}catch(e){this.db=previous;throw e;}this.apply();this.log(user.id,'settings-updated');
 }
 member(user,body){this.require(user);const target=this.store.get(body.id);if(!target)throw new PortalError('Member not found.',404);if(body.id===this.db.ownerId&&(body.disabled!==undefined||body.role!==undefined))throw new PortalError('The owner cannot be disabled or made a guest.');
  if(body.disabled!==undefined&&typeof body.disabled!=='boolean')throw new PortalError('Invalid member status.');if(body.storageLimitMB!==undefined&&(!Number.isSafeInteger(body.storageLimitMB)||body.storageLimitMB<0||body.storageLimitMB>10000000))throw new PortalError('Invalid storage quota.');
  if(body.role!==undefined&&!['member','guest'].includes(body.role))throw new PortalError('Invalid role.');
  const desiredRole=body.role??(target.guestExpiresAt?'guest':'member'),enabling=body.disabled===false&&target.disabled,converting=body.role&&body.role!==(target.guestExpiresAt?'guest':'member');
  if((enabling||converting)&&body.disabled!==true)this.assertJoin(desiredRole==='guest');
  if(desiredRole==='guest'&&converting&&(!Number.isSafeInteger(body.minutes)||body.minutes<5||body.minutes>this.db.policy.guestMaxMinutes))throw new PortalError('Choose a valid guest duration.');
  this.store.transact(()=>{if(body.storageLimitMB!==undefined)target.storageLimitMB=body.storageLimitMB;if(body.disabled!==undefined)target.disabled=body.disabled;if(converting){if(desiredRole==='member'){delete target.guestExpiresAt;delete target.invitedBy;}else target.guestExpiresAt=Date.now()+body.minutes*60000;}if(target.disabled){for(const p of this.store.db.partnerships||[])if(p.owner===target.id||p.peer===target.id){p.status='revoked';p.upgradeBy='';}target.production=null;target.destinationBaseUrl='';target.destinationStreamKey='';for(const i of this.store.db.invites)if(i.owner===target.id)i.revoked=true;for(const q of this.store.db.requests)if(q.owner===target.id||q.peer===target.id)q.status='revoked';}});this.log(user.id,target.disabled?'member-disabled':'member-updated',target.id);return target;
 }
}
