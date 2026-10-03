'use strict';
const $=id=>document.getElementById(id),desktop=window.relayDesktop;
const tilePositions={};let dragging=null;
let localProfile=null,connected=false;
let profile=null,view=null,joining=true,busy=false,layoutDirty=false,peerSignature='',polling=false,rememberFailed=false;
let noticeTimer;
const note=text=>{clearTimeout(noticeTimer);$('notice').textContent=text;if(text==='Saved.'||text.startsWith('Copied.'))noticeTimer=setTimeout(()=>{$('notice').textContent='';},6000);};
function address(value){const u=new URL(value.includes('://')?value:'http://'+value);if(!value.includes('://')&&!u.port)u.port='25560';if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.search||u.hash||u.pathname!=='/')throw Error('Enter only a server IP:port or HTTPS address.');return u.origin;}
async function api(route,body){
 if(!profile)throw Error('Connect to a server first.');
 if(desktop)return desktop.request({address:profile.address,route,token:profile.token?profile.id+':'+profile.token:'',body});
 const response=await fetch(route,{method:body===undefined?'GET':'POST',headers:{...(profile.token?{Authorization:'Bearer '+profile.id+':'+profile.token}:{}),...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body),credentials:'omit',cache:'no-store',signal:AbortSignal.timeout(15000)});
 const data=await response.json();if(!response.ok)throw Error(data.error||'The server could not complete that request.');return data;
}
function mode(newProfile){joining=newProfile;$('newTab').classList.toggle('selected',joining);$('existingTab').classList.toggle('selected',!joining);$('passwordLabel').textContent=joining?'Server join password':'Personal login token';$('connect').textContent=joining?'Create server account & connect':'Connect';$('loginHint').textContent=joining?'Ask the server owner for the join password. Your personal login will be saved on this device.':'Use your personal token, not the shared server password. For an existing 0.2 account, use its controlToken.';$('password').value='';}
$('newTab').onclick=()=>mode(true);$('existingTab').onclick=()=>mode(false);
function hideSecrets(){for(const input of document.querySelectorAll('[data-secret],.secret input'))input.type='password';}
window.addEventListener('blur',hideSecrets);document.addEventListener('visibilitychange',()=>{if(document.hidden)hideSecrets();});
for(const input of document.querySelectorAll('input[type=password]'))input.dataset.secret='true';
async function copyValue(value){
 if(desktop)await desktop.copy(value);
 else if(navigator.clipboard&&window.isSecureContext)await navigator.clipboard.writeText(value);
 else{const input=document.createElement('textarea');input.value=value;input.setAttribute('aria-hidden','true');input.style.position='fixed';input.style.left='-10000px';document.body.append(input);input.select();const copied=document.execCommand('copy');input.remove();if(!copied)throw Error('Clipboard unavailable. Use Reveal and copy manually.');}
 note('Copied. The clipboard contains the real value.');
}
for(const b of document.querySelectorAll('[data-copy]'))b.onclick=()=>copyValue($(b.dataset.copy).value).catch(()=>note('Copy failed. Reveal the field and copy manually.'));
for(const b of document.querySelectorAll('[data-reveal]'))b.onclick=()=>{const input=$(b.dataset.reveal);input.type='text';setTimeout(()=>input.type='password',5000);};
async function enter(){
 view=await api('/api/v3/view');const secrets=await api('/api/v3/secrets');await saveProfile();
 for(const id of ['obsServer','obsKey','loginToken'])$(id).value=secrets[id];
 $('savedAddress').value=profile.address;$('destinationUrl').value=secrets.destinationBaseUrl;$('destinationKey').value=secrets.destinationStreamKey;
 connected=true;setControls(true);$('serverStatus').textContent='Connected · '+(selected()?.nickname||$('serverNickname').value);
 $('password').value='';$('welcome').hidden=true;peerSignature='';layoutDirty=false;render(view);
 rememberFailed=false;
}
$('loginForm').onsubmit=async event=>{event.preventDefault();if(busy||vaultFailed)return;busy=true;$('connect').disabled=true;
 try{if(!(await verifyIdle()))return;const server=desktop?address($('address').value.trim()):location.origin;profile={address:server,id:$('username').value.trim(),token:joining?'':$('password').value.trim()};
  if(joining){const result=await api('/api/v3/register',{username:profile.id,password:$('password').value});profile.id=result.id;profile.token=result.token;}
  // Persist a newly issued token before subsequent network calls, so a temporary outage cannot orphan it.
  if(joining){$('loginToken').value=profile.token;await saveProfile();}
  await enter();if(!rememberFailed)note('Connected. Your sensitive fields stay hidden.');
 }catch(e){note(e.message||'Could not connect. Check the address and server.');if(joining&&profile?.token){mode(false);$('password').value=profile.token;note('Profile created. Retry connecting with the personal token filled in.');}}
 finally{busy=false;$('connect').disabled=false;serverMenu();}};
async function refresh(){if(!connected||!profile?.token||polling||busy||document.hidden)return;polling=true;const previous=profile;try{const result=await api('/api/v3/view');if(profile===previous)render(result);}catch{if(profile!==previous)return;uncertain=true;setControls(false);serverMenu();$('serverStatus').textContent='Connection lost — switching locked until verified.';note('Server unavailable. No change to your broadcast has been confirmed.');}finally{polling=false;}}
async function change(route,body={}){if(busy||!connected)return;busy=true;try{const result=await api(route,body);render(result);note('Saved.');return true;}catch(e){note(e.message||'Action could not be confirmed.');return false;}finally{busy=false;serverMenu();}}
$('refresh').onclick=refresh;$('end').onclick=async()=>{if(await change('/api/end'))note('Broadcast ended. Stop OBS; after the quiet period it will unlock automatically.');};$('allow').onclick=()=>change('/api/allow');
$('pip').onclick=()=>change('/api/'+(view.status.pictureInPicture?'pip-off':'pip-on'));$('collab').onclick=()=>change('/api/'+(view.status.collabFallback?'collab-off':'collab-on'));
$('destinationForm').onsubmit=async e=>{e.preventDefault();await change('/api/v3/destination',{url:$('destinationUrl').value,key:$('destinationKey').value});};
function button(text,fn){const b=document.createElement('button');b.type='button';b.textContent=text;b.onclick=fn;return b;}
const capability=key=>view?.capabilities?.[key]!==false;
function applyCapabilities(){
 const known=!!view?.capabilities;
 const disabled=[];
 if(!capability('pictureInPicture'))disabled.push('corner feeds');
 if(!capability('collaboratorFallback'))disabled.push('collaborator fallback');
 if(!capability('registration'))disabled.push('new accounts');
 $('hostCapabilities').textContent=!connected?'Connect to see this server’s available features.':!known?'Older server — host feature status is unavailable.':disabled.length?'Disabled by host: '+disabled.join(', ')+'.':'Host features available: corner feeds, collaborator fallback and new accounts.';
 for(const id of ['pip'])$(id).disabled=!connected||!capability('pictureInPicture');
 for(const id of ['fallback1','fallback2','collab'])$(id).disabled=!connected||!capability('collaboratorFallback');
 window.streamCanvas?.availability();window.streamStudio?.availability();window.releaseFeatures?.render();
}
function render(data){
 view=data;const s=data.status;active=isActive(s);uncertain=false;setControls(connected);serverMenu();if(active)$('serverStatus').textContent='Broadcast active · server switching locked';else $('serverStatus').textContent='Connected · '+(selected()?.nickname||$('serverNickname').value);
 const titles={ready:'Ready for OBS',held:'Ended · waiting for OBS to stop',ending:'Ending your broadcast',starting:'Starting your broadcast',live:'Your feed is live',collab:'Collaborator fallback is live',fallback:'Reconnect image is live'};
 $('state').textContent=titles[s.state]||'Standby';$('lamp').className='lamp'+(s.broadcast?' live':'');$('stats').textContent=(s.mode==='test'?'TEST · ':'')+(s.broadcast?s.width+' × '+s.height+' · '+s.fps+' FPS':'');
 $('end').disabled=s.held||s.state==='ending';$('allow').disabled=!s.held;$('saveDestination').disabled=s.broadcast||['starting','ending'].includes(s.state);
 $('destinationState').textContent=data.me.destinationConfigured?'Destination saved':'Add a destination before starting OBS';
 applyCapabilities();window.streamCanvas?.availability();window.streamStudio?.availability();window.releaseFeatures?.render();
 $('pip').textContent='Corner feeds: '+(s.pictureInPicture?'ON':'OFF');$('collab').textContent='Collab fallback: '+(s.collabFallback?'ON':'OFF');
 const signature=JSON.stringify([data.peers,data.requests,data.me.settings,data.capabilities]);
 if(peerSignature!==signature){peerSignature=signature;renderPeople();renderRequests();if(!layoutDirty&&!dragging)fillLayout();} window.dispatchEvent(new Event('relay-state'));
}
function renderPeople(){const root=$('people');root.replaceChildren();if(!view.peers.length){root.textContent='No other profiles yet. Invite a friend to this server.';return;}
 for(const p of view.peers){const row=document.createElement('div');row.className='person';const name=document.createElement('strong');name.textContent=p.id;const state=document.createElement('small');state.textContent=p.state;const actions=document.createElement('div');actions.className='buttons';
  for(const [kind,label] of [['video','Request video'],['fallback','Request fallback']]){const r=view.requests.find(r=>r.owner===view.me.id&&r.peer===p.id&&r.kind===kind);const b=button(r?.status==='approved'?kind+' approved':r?.status==='pending'?kind+' pending':label,()=>change('/api/v3/request',{peer:p.id,kind}));b.disabled=['approved','pending'].includes(r?.status)||!capability(kind==='video'?'pictureInPicture':'collaboratorFallback');actions.append(b);}
  row.append(name,state,actions);root.append(row);
 }}
function renderRequests(){const root=$('requests');root.replaceChildren();if(!view.requests.length){root.textContent='No requests yet.';return;}
 for(const r of view.requests){const row=document.createElement('div');row.className='request';const label=document.createElement('strong');label.textContent=r.owner+' → '+r.peer;const kind=document.createElement('small');kind.textContent=(r.kind==='video'?'Corner video':'Fallback')+' · '+r.status;const actions=document.createElement('div');actions.className='buttons';
  const act=decision=>change('/api/v3/respond',{id:r.id,decision});
  if(r.peer===view.me.id){if(r.status==='pending'){const approve=button('Approve',()=>act('approve'));approve.disabled=!capability(r.kind==='video'?'pictureInPicture':'collaboratorFallback');if(view?.capabilities?.sessionPermissions===true)actions.append(button('Approve for session',()=>act('approve-session')));approve.textContent='Always allow';actions.append(approve,button('Decline',()=>act('decline')));}if(r.status==='approved')actions.append(button('Revoke',()=>act('revoke')));}
  else if(['pending','approved'].includes(r.status))actions.append(button('Cancel',()=>act('cancel')));
  row.append(label,kind,actions);root.append(row);
 }}
function fillSelect(id,kind,empty){const select=$(id);select.replaceChildren(new Option(empty,''));for(const p of view.peers)if(view.requests.some(r=>r.owner===view.me.id&&r.peer===p.id&&r.kind===kind&&r.status==='approved'))select.add(new Option(p.id,p.id));}
function fillLayout(){
 for(let i=1;i<=2;i++){fillSelect('fallback'+i,'fallback',i===1?'Reconnect image':'Then reconnect image');$('fallback'+i).value=view.me.settings.fallback[i-1]||'';}
 window.streamCanvas?.load(view.me.settings);
}
for(const id of ['fallback1','fallback2'])$(id).onchange=()=>{layoutDirty=true;};
$('layoutForm').onsubmit=async e=>{e.preventDefault();await window.streamCanvas?.save();};
const serverStorage='universalcollab-servers-v1',localKey='universalcollab-local-profile-v1';
let vault={schemaVersion:1,servers:[],selectedKey:''},vaultFailed=false,active=false,uncertain=false;
const selected=()=>vault.servers.find(s=>s.key===vault.selectedKey);
const isActive=s=>!!s?.broadcast||['starting','ending','live','collab','fallback'].includes(s?.state);
const offlineFields=['obsServer','obsKey','loginToken','savedAddress','destinationUrl','destinationKey'];
// Disabled fieldsets keep server controls visible, while panel handles remain usable.
for(const card of document.querySelectorAll('#manualOBS,#canvasPanel,#fallbackPanel,#legacyPermissions > .card')){
 const field=document.createElement('fieldset');field.className='server-controls';field.disabled=true;
 if(['connectionsPanel','streamsPanel'].includes(card.id))continue;
 for(const node of [...card.childNodes])if(!(node.nodeType===1&&(node.matches('h2,h3,.sectionhead,.panel-tools'))))field.append(node);
 card.append(field);
}
function setControls(on){
 for(const f of document.querySelectorAll('.server-controls'))f.disabled=!on;
 for(const id of ['refresh','end','allow'])$(id).disabled=!on;
}
function serverMenu(){
 const menu=$('serverSelect');menu.replaceChildren(new Option('No server selected',''));
 for(const s of vault.servers)menu.add(new Option(s.nickname,s.key));menu.add(new Option('＋ Add server…','__add__'));menu.value=vault.selectedKey;
 menu.disabled=busy||active||uncertain||vaultFailed;
 $('serverConnect').disabled=busy||!selected()||vaultFailed;
 $('serverConnect').textContent=connected?'Disconnect':uncertain?'Retry connection':'Connect';
 $('renameServer').disabled=busy||!selected()||vaultFailed;
 $('removeServer').disabled=busy||active||uncertain||!selected()||vaultFailed;
}
function offline(){
 connected=false;profile=null;view=null;active=false;uncertain=false;
 $('welcome').hidden=true;
 for(const id of offlineFields)$(id).value='';
 $('people').textContent='Connect to see people on this server.';$('requests').textContent='Connect to manage collaboration permissions.';
 $('state').textContent='Offline';$('stats').textContent='';$('lamp').className='lamp';
 window.streamCanvas?.reset();
 $('destinationState').textContent='Connect to configure your destination';
 for(const id of ['fallback1','fallback2'])$(id).replaceChildren(new Option('Connect to a server',''));
 $('serverStatus').textContent=selected()?'Offline · '+selected().nickname+' selected. Your panel layout stays local.':'Offline — add a server when you are ready. You can arrange panels now.';
 setControls(false);applyCapabilities();hideSecrets();serverMenu();window.dispatchEvent(new Event('relay-state'));
}
async function persistServers(next=vault){
 if(vaultFailed)throw Error('Unlock saved servers and restart before making changes.');
 if(desktop)await desktop.saveServers(next);else localStorage.setItem(serverStorage,JSON.stringify(next));
 vault=next;
}
async function requestServer(server,route,body){
 if(desktop)return desktop.request({address:server.address,route,token:server.id+':'+server.token,body});
 if(server.address!==location.origin)throw Error('Use the desktop app to connect to other servers.');
 const response=await fetch(route,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+server.id+':'+server.token,...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body),credentials:'omit',cache:'no-store',signal:AbortSignal.timeout(15000)});
 const data=await response.json();if(!response.ok)throw Error('Server request failed. Check your connection and account.');return data;
}
async function verifyIdle(){
 const current=selected();if(!current)return true;
 try{
  const result=await requestServer(current,'/api/v3/view');
  if(!result?.status||typeof result.status.broadcast!=='boolean')throw Error();
  active=isActive(result.status);uncertain=false;
  if(active){$('serverStatus').textContent='End your current broadcast before switching servers.';note('Your broadcast is active, including any fallback. End it before switching servers.');serverMenu();return false;}
  return true;
 }catch{uncertain=true;$('serverStatus').textContent='Cannot confirm broadcast state. Reconnect to this server before switching.';note('Server unavailable. Switching is locked until its broadcast state can be checked.');serverMenu();return false;}
}
$('serverSelect').onchange=async()=>{
 const target=$('serverSelect').value;$('serverSelect').value=vault.selectedKey;if(busy||active||uncertain||vaultFailed)return;
 busy=true;serverMenu();
 try{
  if(!(await verifyIdle()))return;
  if(target==='__add__'){
   document.querySelector('[data-workspace-tab="relay"]')?.click();
   offline();$('welcome').hidden=false;$('serverNickname').value='';$('username').value=localProfile.displayName.replace(/[^A-Za-z0-9_-]/g,'').slice(0,32);
   $('address').value='';mode(true);$('serverNickname').focus();
  }else{await persistServers({...vault,selectedKey:target});offline();}
 }catch{note('Server selection could not be saved. Nothing was switched.');}
 finally{busy=false;serverMenu();}
};
$('serverConnect').onclick=async()=>{
 if(busy||!selected())return;busy=true;serverMenu();
 try{
  if(connected){if(!(await verifyIdle()))return;offline();note('Disconnected. Saved servers and panel layout kept.');}
  else{profile={...selected()};await enter();uncertain=false;note('Connected.');}
 }catch{connected=false;uncertain=true;setControls(false);$('serverStatus').textContent='Server unavailable. Retry connection to confirm broadcast status.';note('Could not connect. Your saved servers and layout are unchanged.');}
 finally{busy=false;serverMenu();}
};
$('removeServer').onclick=async()=>{
 if(busy||active||uncertain||!selected())return;busy=true;serverMenu();
 try{if(!(await verifyIdle()))return;const next={...vault,servers:vault.servers.filter(s=>s.key!==vault.selectedKey),selectedKey:''};await persistServers(next);offline();note('Server removed from this device. Its account was not deleted.');}
 catch{note('Could not remove saved server.');}finally{busy=false;serverMenu();}
};
$('renameServer').onclick=()=>{$('renameValue').value=selected().nickname;$('renameForm').hidden=false;};
$('cancelRename').onclick=()=>{$('renameForm').hidden=true;};
$('renameForm').onsubmit=async e=>{e.preventDefault();if(busy)return;const name=$('renameValue').value.trim();if(!name)return;try{await persistServers({...vault,servers:vault.servers.map(s=>s.key===vault.selectedKey?{...s,nickname:name}:s)});$('renameForm').hidden=true;serverMenu();note('Server nickname saved.');}catch{note('Could not save nickname.');}};
$('backLocal').onclick=()=>{if(!busy){$('welcome').hidden=true;$('password').value='';}};
function paintLocal(){$('localIdentity').textContent=localProfile.displayName+' · Local profile';}
async function persistLocal(name){
 const displayName=name.trim();if(!displayName||displayName.length>48)throw Error();
 const value={schemaVersion:1,displayName,createdAt:localProfile?.createdAt||new Date().toISOString()};
 if(desktop)await desktop.saveLocalProfile(value);else localStorage.setItem(localKey,JSON.stringify(value));localProfile=value;paintLocal();window.dispatchEvent(new Event('local-name'));
}
$('editLocal').onclick=()=>{$('localEditName').value=localProfile.displayName;$('localEditForm').hidden=false;};
$('cancelLocalEdit').onclick=()=>{$('localEditForm').hidden=true;};
$('localEditForm').onsubmit=async e=>{e.preventDefault();try{await persistLocal($('localEditName').value);$('localEditForm').hidden=true;note('Local display name saved. Server usernames stay unchanged.');}catch{note('Could not save local profile.');}};
async function saveProfile(){
 // Upsert by server+account so reconnecting never duplicates a saved server.
 const match=vault.servers.find(s=>s.address===profile.address&&s.id===profile.id);
 const item={...profile,key:match?.key||profile.key||(crypto.randomUUID?.()||'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,c=>{const n=crypto.getRandomValues(new Uint8Array(1))[0]%16;return(c==='x'?n:(n&3|8)).toString(16)})),nickname:match?.nickname||$('serverNickname').value.trim()||'My server'};
 const next={schemaVersion:1,servers:[...vault.servers.filter(s=>s.key!==item.key),item],selectedKey:item.key};
 await persistServers(next);profile={...item};serverMenu();
}
window.portalReady=(async()=>{
 if(!desktop){$('addressLabel').hidden=true;$('address').required=false;}
 try{
  if(desktop)vault=await desktop.loadServers();
  else{
   const saved=JSON.parse(localStorage.getItem(serverStorage)||'null');
   if(saved)vault=saved;
   else{const old=JSON.parse(localStorage.getItem('stream-relay-profile-v3')||'null');if(old?.token){const key=(crypto.randomUUID?.()||'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,c=>{const n=crypto.getRandomValues(new Uint8Array(1))[0]%16;return(c==='x'?n:(n&3|8)).toString(16)}));vault={schemaVersion:1,servers:[{...old,address:location.origin,key,nickname:'My server'}],selectedKey:key};await persistServers();}}
  }
 }catch{vaultFailed=true;note('Saved servers could not be unlocked. Unlock your desktop keyring and restart. Your files have been kept.');}
 try{localProfile=desktop?await desktop.loadLocalProfile():JSON.parse(localStorage.getItem(localKey)||'null');}catch{}
 if(!localProfile){localProfile={schemaVersion:1,displayName:selected()?.id||'My workspace',createdAt:new Date().toISOString()};try{await persistLocal(localProfile.displayName);}catch{note('Local profile is available for this session, but could not be saved.');}}
 paintLocal();offline();setInterval(refresh,3000);
})();

