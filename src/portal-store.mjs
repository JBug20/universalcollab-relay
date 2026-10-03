import fs from 'node:fs';
import {randomBytes,createHash,timingSafeEqual} from 'node:crypto';
import {joinDestination} from './multi-routing.mjs';
const token=()=>randomBytes(32).toString('base64url');
const digest=x=>createHash('sha256').update(String(x||'')).digest();
const equal=(a,b)=>timingSafeEqual(digest(a),digest(b));
import {validateBox} from './stream-layout.mjs';
const corners=['top-left','top-right','bottom-left','bottom-right'];
export class PortalError extends Error{constructor(message,code=400){super(message);this.code=code;}}
export function destination(base,key){
 try{
  if(typeof base!=='string'||typeof key!=='string')throw Error();
  base=base.trim();key=key.trim();
  if(!key){const u=new URL(base);const at=u.pathname.lastIndexOf('/');key=u.pathname.slice(at+1);u.pathname=u.pathname.slice(0,at);base=u.href;}
  const combined=joinDestination(base,key);return {destinationBaseUrl:base.replace(/\/$/,''),destinationStreamKey:key,combined};
 }catch{throw new PortalError('Enter an RTMP or RTMPS server URL and stream key.');}
}
export class PortalStore{
 constructor({directory='data',publishers=[],maxAccounts=4096,features=()=>({registration:true,pictureInPicture:true,collaboratorFallback:true})}){
  this.features=features;this.chatFrames=new Map();this.directory=directory;this.maxAccounts=maxAccounts;fs.mkdirSync(directory,{recursive:true,mode:0o700});
  this.file=directory+'/accounts.json';
  this.db=fs.existsSync(this.file)?JSON.parse(fs.readFileSync(this.file,'utf8')):{version:1,users:[],requests:[]};
  if(this.db.version!==1||!Array.isArray(this.db.users)||!Array.isArray(this.db.requests))throw Error('Invalid account data');
  // Existing usernames are claimed using their personal control token, never the shared join password.
  for(const p of publishers)if(!this.db.users.some(u=>u.id===p.id))this.db.users.push({...p,settings:{overlays:[],fallback:[]}});
  for(const u of this.db.users){u.settings??={overlays:[],fallback:[]};u.overlays=[];u.controlToken||=token();u.inputKey||=token();u.password||=token();u.destinationBaseUrl??='';u.destinationStreamKey??='';}
  this.db.partnerships??=[];for(const p of this.db.partnerships)if(p.scope==='session'){p.status='revoked';p.upgradeBy='';}
  this.db.invites??=[];for(const r of this.db.requests)if(r.scope==='session'&&r.status==='approved')r.status='revoked';
  this.save();
  const setup=directory+'/server-access.json';
  if(!fs.existsSync(setup))fs.writeFileSync(setup,JSON.stringify({joinPassword:token()},null,2)+'\n',{mode:0o600});
  this.joinPassword=JSON.parse(fs.readFileSync(setup,'utf8')).joinPassword;
  if(typeof this.joinPassword!=='string'||this.joinPassword.length<12)throw Error('Invalid server join password');
 }
 save(){fs.writeFileSync(this.file+'.tmp',JSON.stringify(this.db,null,2)+'\n',{mode:0o600});fs.renameSync(this.file+'.tmp',this.file);}
 transact(fn){const before=structuredClone(this.db);try{const result=fn();this.save();return result;}catch(e){this.db=before;throw e;}}
 get(id){return this.db.users.find(u=>u.id===id);}
 authenticate(credential){const [id,t,...extra]=String(credential||'').replace(/^Bearer /,'').split(':');const u=this.get(id);return !extra.length&&u&&!u.disabled&&(!u.guestExpiresAt||u.guestExpiresAt>Date.now())&&equal(t,u.controlToken)?u:null;}
 register(username,password){
  const invite=this.db.invites?.find(i=>!i.usedBy&&!i.revoked&&i.expiresAt>Date.now()&&equal(i.digest,digest(password).toString('hex')));
  if(!this.features().registration&&!invite)throw new PortalError('New accounts are disabled by this server host.',403);
  if(invite&&this.features().guestInvites!==true)throw new PortalError('Guest invitations are disabled by this host.',403);
  if(!invite&&!equal(password,this.joinPassword))throw new PortalError('Server join password is incorrect.',401);
  if(typeof username!=='string'||! /^[A-Za-z0-9_-]{1,32}$/.test(username))throw new PortalError('Use 1–32 letters, numbers, underscores or hyphens for your username.');
  if(this.db.users.some(u=>u.id.toLowerCase()===username.toLowerCase()))throw new PortalError('That username is already registered. Use its personal login token.',409);
  this.hostAdmin?.assertJoin(!!invite);
  if(this.db.users.length>=this.maxAccounts)throw new PortalError('This server has reached its account limit.',409);
  return this.transact(()=>{const u={id:username,password:token(),inputKey:token(),controlToken:token(),destinationBaseUrl:'',destinationStreamKey:'',settings:{overlays:[],fallback:[]}};if(invite){u.guestExpiresAt=invite.expiresAt;u.invitedBy=invite.owner;invite.usedBy=u.id;}this.db.users.push(u);return u;});
 }
 allowed(owner,peer,kind){return !this.get(owner)?.disabled&&!this.get(peer)?.disabled&&owner!==peer&&this.db.requests.some(r=>r.owner===owner&&r.peer===peer&&r.kind===kind&&r.status==='approved'&&(!r.partnershipId||this.partnershipActive(this.db.partnerships.find(p=>p.id===r.partnershipId)))&&(!r.expiresAt||r.expiresAt>Date.now())&&(!this.get(peer)?.guestExpiresAt||this.get(peer).guestExpiresAt>Date.now())&&(!this.get(owner)?.guestExpiresAt||this.get(owner).guestExpiresAt>Date.now()));}
 feature(kind){return kind==='video'?this.features().pictureInPicture:this.features().collaboratorFallback;}
 request(owner,peer,kind){
  if(!this.feature(kind))throw new PortalError('This collaboration feature is disabled by the server host.',403);
  if(!this.get(peer)||owner===peer||!['video','fallback'].includes(kind))throw new PortalError('Choose another streamer and a valid permission.');
  return this.transact(()=>{let r=this.db.requests.find(r=>r.owner===owner&&r.peer===peer&&r.kind===kind);if(!r){r={id:randomBytes(12).toString('hex'),owner,peer,kind,status:'pending'};this.db.requests.push(r);}else if(r.status!=='approved')r.status='pending';return r;});
 }
 respond(id,requestId,decision){
  const session=decision==='approve-session';if(session){if(this.features().sessionPermissions===false)throw new PortalError('Session permissions disabled by host.',403);decision='approve';}
  const r=this.db.requests.find(r=>r.id===requestId);
  if(r?.partnershipId)throw new PortalError('Use the Collab menu for mutual permissions.');
  if(!r||!['approve','decline','revoke','cancel'].includes(decision))throw new PortalError('Request not found.');
  if((decision==='cancel'&&r.owner!==id)||(decision!=='cancel'&&r.peer!==id))throw new PortalError('Only the stream owner can grant or revoke this permission.',403);
  if(decision==='approve'&&!this.feature(r.kind))throw new PortalError('This collaboration feature is disabled by the server host.',403);
  return this.transact(()=>{if(decision==='approve'){r.scope=session?'session':'persistent';r.expiresAt=session?Date.now()+86400000:0;}r.status=decision==='approve'?'approved':decision==='decline'?'declined':'revoked';return r;});
 }
 endSession(id){return this.transact(()=>{for(const p of this.db.partnerships)if(p.scope==='session'&&(p.owner===id||p.peer===id)){p.status='revoked';p.upgradeBy='';}for(const r of this.db.requests)if(r.scope==='session'&&r.status==='approved'&&(r.owner===id||r.peer===id))r.status='revoked';});}
 partnershipActive(p){return !!p&&p.status==='approved'&&(!p.expiresAt||p.expiresAt>Date.now())&&[p.owner,p.peer].every(id=>{const u=this.get(id);return u&&!u.disabled&&(!u.guestExpiresAt||u.guestExpiresAt>Date.now());});}
 acceptCollabWarning(id){return this.transact(()=>{this.get(id).collabWarning=1;});}
 collabRequest(id,peer,permanent=false){
  if(this.get(id)?.collabWarning!==1)throw new PortalError('Read the Collab explanation first.',403);
  if(!this.features().pictureInPicture||!this.features().collaboratorFallback)throw new PortalError('Collaboration disabled by host.',403);
  if(this.features().sessionPermissions===false)throw new PortalError('Session collaboration disabled by host.',403);
  if(id===peer||!this.get(peer)||this.get(peer).disabled||this.get(peer).guestExpiresAt&&this.get(peer).guestExpiresAt<=Date.now())throw new PortalError('Choose an available member.');
  return this.transact(()=>{
   let p=this.db.partnerships.find(p=>[p.owner,p.peer].includes(id)&&[p.owner,p.peer].includes(peer));
   if(permanent){if(!this.partnershipActive(p)||p.scope!=='session')throw new PortalError('Approve regular Collab first.');if(p.upgradeBy&&p.upgradeBy!==id)throw new PortalError('Respond to the existing Super Collab request first.');p.upgradeBy=id;return p;}
   if(p?.status==='pending'||this.partnershipActive(p))return p;
   if(!p){p={id:randomBytes(12).toString('hex')};this.db.partnerships.push(p);}
   Object.assign(p,{owner:id,peer,status:'pending',scope:'session',expiresAt:0,upgradeBy:''});return p;
  });
 }
 collabRespond(id,requestId,decision){
  const p=this.db.partnerships.find(p=>p.id===requestId);
  if(!p||![p.owner,p.peer].includes(id))throw new PortalError('Request not found.',403);
  if(!['accept','decline','end','accept-super','decline-super','cancel-super'].includes(decision))throw new PortalError('Invalid collaboration action.');
  if(['accept','accept-super'].includes(decision)){
   if(this.get(id).collabWarning!==1)throw new PortalError('Read the Collab explanation first.',403);
   if(!this.features().pictureInPicture||!this.features().collaboratorFallback||this.features().sessionPermissions===false)throw new PortalError('Collaboration disabled by host.',403);
   if([p.owner,p.peer].some(who=>!this.get(who)||this.get(who).disabled||this.get(who).guestExpiresAt&&this.get(who).guestExpiresAt<=Date.now()))throw new PortalError('Member is unavailable.',403);
  }
  if(['accept','decline'].includes(decision)&&(p.peer!==id||p.status!=='pending'))throw new PortalError('Only the recipient can respond.',403);
  if(['accept-super','decline-super'].includes(decision)&&(!this.partnershipActive(p)||!p.upgradeBy||p.upgradeBy===id))throw new PortalError('No incoming Super Collab request.',403);
  if(decision==='cancel-super'&&p.upgradeBy!==id)throw new PortalError('Only the requester can cancel.',403);
  return this.transact(()=>{
   if(decision==='accept'){p.status='approved';p.scope='session';p.expiresAt=Date.now()+86400000;}
   if(decision==='accept-super'){p.scope='persistent';p.expiresAt=0;p.upgradeBy='';}
   if(decision==='decline-super'||decision==='cancel-super')p.upgradeBy='';
   if(decision==='end'||decision==='decline'){p.status='revoked';p.upgradeBy='';}
   for(const owner of [p.owner,p.peer])for(const kind of ['video','fallback']){
    const peer=owner===p.owner?p.peer:p.owner;let row=this.db.requests.find(r=>r.owner===owner&&r.peer===peer&&r.kind===kind);
    if(!row){row={id:randomBytes(12).toString('hex'),owner,peer,kind};this.db.requests.push(row);}
    Object.assign(row,{partnershipId:p.id,scope:p.scope,expiresAt:p.expiresAt,status:p.status==='approved'?'approved':'revoked'});
   }return p;
  });
 }
 displayName(id,value){if(typeof value!=='string'||!value.trim()||value.trim().length>48)throw new PortalError('Choose a name of 1–48 characters.');return this.transact(()=>{this.get(id).displayName=value.trim();});}
 invite(owner,minutes){
  this.hostAdmin?.assertInvite(owner,minutes);
  if(this.features().guestInvites!==true||this.get(owner)?.guestExpiresAt)throw new PortalError('Guest invitations are unavailable.',403);
  if(!Number.isInteger(minutes)||minutes<5||minutes>1440)throw new PortalError('Choose 5–1440 minutes.');
  const active=this.db.invites.filter(i=>!i.revoked&&i.expiresAt>Date.now());if(active.filter(i=>i.owner===owner).length>=10)throw new PortalError('Revoke an unused invitation first.');
  const secret=token(),value={id:randomBytes(12).toString('hex'),owner,digest:digest(secret).toString('hex'),expiresAt:Date.now()+minutes*60000,usedBy:'',revoked:false};
  this.transact(()=>{this.db.invites=active;this.db.invites.push(value);});return {id:value.id,secret,expiresAt:value.expiresAt};
 }
 invites(id){return this.db.invites.filter(i=>i.owner===id).map(({digest,...i})=>i);}
 revokeInvite(owner,id){return this.transact(()=>{const i=this.db.invites.find(i=>i.owner===owner&&i.id===id);if(!i)throw new PortalError('Invitation not found.',404);i.revoked=true;if(i.usedBy){const u=this.get(i.usedBy);if(u)u.guestExpiresAt=Date.now()-1;}return i.usedBy;});}
 settings(id,settings){
  if(!settings||!Array.isArray(settings.overlays)||!Array.isArray(settings.fallback)||settings.overlays.length>this.db.users.length-1||settings.fallback.length>10)throw new PortalError('Choose registered streamers and up to ten fallback choices.');
  const current=this.get(id).settings;
  const fallbackTimeoutMinutes=settings.fallbackTimeoutMinutes??current.fallbackTimeoutMinutes??0;
  if(!Number.isFinite(fallbackTimeoutMinutes)||fallbackTimeoutMinutes<0||fallbackTimeoutMinutes>1440)throw new PortalError('Fallback timeout must be 0–1440 minutes.');
  if(this.features().fallbackTimeout===false&&fallbackTimeoutMinutes!==0&&fallbackTimeoutMinutes!==current.fallbackTimeoutMinutes)throw new PortalError('Fallback timeout is disabled by this host.',403);
  const povLabels=settings.povLabels??current.povLabels??true;if(typeof povLabels!=='boolean')throw new PortalError('Invalid POV label setting.');
  if(!this.features().pictureInPicture&&settings.overlays.length&&JSON.stringify(settings.overlays)!==JSON.stringify(current.overlays))throw new PortalError('Corner feeds are disabled by the server host.',403);
  if(!this.features().collaboratorFallback&&settings.fallback.length&&JSON.stringify(settings.fallback)!==JSON.stringify(current.fallback))throw new PortalError('Collaborator fallback is disabled by the server host.',403);
  const overlays=settings.overlays.map(p=>{
   if(!p||!corners.includes(p.corner)||!this.allowed(id,p.publisher,'video'))throw new PortalError('Corner video needs approval from that streamer.');const tile={visible:p.visible!==false,publisher:p.publisher,corner:p.corner,...validateBox(p,false),z:Number.isSafeInteger(p.z)?Math.max(0,Math.min(10000,p.z)):0};
   if(p.x!==undefined||p.y!==undefined){if(!Number.isFinite(p.x)||!Number.isFinite(p.y)||p.x<0||p.x>1||p.y<0||p.y>1)throw new PortalError('Tile positions must stay inside the preview.');tile.x=p.x;tile.y=p.y;}
   return tile;
  });
  if(new Set(overlays.map(p=>p.publisher)).size!==overlays.length)throw new PortalError('Use a different streamer for each tile.');
  if(new Set(settings.fallback).size!==settings.fallback.length||settings.fallback.some(p=>!this.allowed(id,p,'fallback')))throw new PortalError('Fallback needs approval from every selected streamer.');
  const chatOverlays=settings.chatOverlays??current.chatOverlays??[];
  if(!Array.isArray(chatOverlays)||chatOverlays.length>3||new Set(chatOverlays.map(p=>p.source)).size!==chatOverlays.length)throw new PortalError('Use one tile per chat source.');
  if(this.features().chatOverlays===false&&chatOverlays.length&&JSON.stringify(chatOverlays)!==JSON.stringify(current.chatOverlays??[]))throw new PortalError('Chat overlays are disabled by this host.',403);
  const chats=chatOverlays.map(p=>{if(!['twitch','youtube','combined'].includes(p.source))throw new PortalError('Invalid chat source.');return {visible:p.visible!==false,source:p.source,...validateBox(p),z:Number.isSafeInteger(p.z)?Math.max(0,Math.min(10000,p.z)):100};});
  const mediaOverlays=settings.mediaOverlays??current.mediaOverlays??[];
  if(!Array.isArray(mediaOverlays)||mediaOverlays.length>24||new Set(mediaOverlays.map(p=>p.id)).size!==mediaOverlays.length)throw new PortalError('Use up to 24 different text, picture, or browser sources.');
  const media=mediaOverlays.map(p=>{if(!p||!/^((text|image|browser):[A-Za-z0-9-]{8,64})$/.test(p.id)||!['text','image','browser'].includes(p.kind)||typeof p.name!=='string'||p.name.length>80||typeof p.text!=='string'||p.text.length>1000||typeof p.url!=='string'||p.url.length>2048||p.image!==undefined)throw new PortalError('Invalid broadcast overlay source.');if(p.kind==='browser'&&!/^https?:\/\//.test(p.url))throw new PortalError('Browser sources need an HTTP(S) address.');return {id:p.id,kind:p.kind,name:p.name,text:p.text,url:p.url,visible:p.visible!==false,...validateBox(p),z:Number.isSafeInteger(p.z)?Math.max(0,Math.min(10000,p.z)):100};});
  const main=settings.main??current.main??{x:0,y:0,width:1,height:1};validateBox(main);
  const resolution=settings.resolution===undefined?current.resolution:settings.resolution;
  if(resolution!==undefined&&resolution!==null&&(!Number.isInteger(resolution.width)||!Number.isInteger(resolution.height)||resolution.width<320||resolution.height<240||resolution.width>3840||resolution.height>3840||resolution.width%2||resolution.height%2||resolution.width*resolution.height>8294400))throw new PortalError('Use even dimensions from 320×240, up to 3840 per side and 8.3 megapixels.');
  return this.transact(()=>{this.get(id).settings={resolution:resolution||null,fallbackTimeoutMinutes,povLabels,overlays,chatOverlays:chats,mediaOverlays:media,main:{...validateBox(main),visible:main.visible!==false,z:Number.isSafeInteger(main.z)?Math.max(-1,Math.min(10000,main.z)):-1},fallback:[...settings.fallback]};return this.get(id).settings;});
 }
 clearProduction(id){return this.transact(()=>Object.assign(this.get(id),{production:null,destinationBaseUrl:'',destinationStreamKey:''}));}
 setDestination(id,base,key){const d=destination(base,key);return this.transact(()=>Object.assign(this.get(id),{production:null,destinationBaseUrl:d.destinationBaseUrl,destinationStreamKey:d.destinationStreamKey}));}
 overlays(id){if(!this.features().pictureInPicture)return [];return (this.get(id)?.settings.overlays||[]).filter(p=>p.visible!==false&&this.allowed(id,p.publisher,'video'));}
 fallback(id){if(!this.features().collaboratorFallback)return [];return (this.get(id)?.settings.fallback||[]).filter(p=>this.allowed(id,p,'fallback'));}
 setProduction(id,input){
  if(typeof input.title!=='string'||!input.title.trim()||input.title.length>140||!Array.isArray(input.destinations)||!input.destinations.length||input.destinations.length>8)throw new PortalError('Choose a title and 1–8 destinations.');
  if(this.features().multipleDestinations===false&&input.destinations.length>1)throw new PortalError('Multiple destinations disabled by host.',403);
  if(input.record&&this.features().recording!==true)throw new PortalError('Recording disabled by host.',403);
  const destinations=input.destinations.map(d=>{if(!d||! /^[A-Za-z0-9_-]{1,64}$/.test(d.id)||typeof d.name!=='string'||d.name.length>80)throw new PortalError('Invalid destination.');const v=destination(d.url,d.key||'');return {id:d.id,name:d.name,url:v.combined,base:v.destinationBaseUrl,key:v.destinationStreamKey};});
  if(new Set(destinations.map(d=>d.url)).size!==destinations.length||new Set(destinations.map(d=>d.id)).size!==destinations.length)throw new PortalError('Duplicate destinations.');
  return this.transact(()=>{const u=this.get(id);u.production={id:typeof input.id==='string'?input.id:'',title:input.title.trim(),record:!!input.record,destinations};u.destinationBaseUrl=destinations[0].base;u.destinationStreamKey=destinations[0].key;return true;});
 }
 publicView(id,status){const u=this.get(id);return {capabilities:{...this.features(),mutualCollab:1,hostAdmin:this.hostAdmin?1:0,streamCanvas:1,production:1,verifiedProduction:2},me:{id,displayName:u.displayName||id,collabWarning:u.collabWarning===1,isHost:this.hostAdmin?.isOwner(u)||false,disabled:!!u.disabled,canStart:this.hostAdmin?.canStart(id)??true,production:u.production?{id:u.production.id||'',title:u.production.title,record:u.production.record,destinations:u.production.destinations.map(({id,name})=>({id,name}))}:null,guestExpiresAt:u.guestExpiresAt||null,settings:u.settings,destinationConfigured:!!u.destinationStreamKey},status:status(id),peers:this.db.users.filter(p=>p.id!==id&&!p.disabled&&(!p.guestExpiresAt||p.guestExpiresAt>Date.now())).map(p=>({id:p.id,displayName:p.displayName||p.id,state:status(p.id).state})),collaborations:this.db.partnerships.filter(p=>p.owner===id||p.peer===id).map(p=>({...p,status:p.status==='approved'&&!this.partnershipActive(p)?'revoked':p.status})),requests:this.db.requests.filter(r=>r.owner===id||r.peer===id).map(r=>({...r,status:r.status==='approved'&&!this.allowed(r.owner,r.peer,r.kind)?'revoked':r.status}))};}
}
