'use strict';
// UI-only controller. Existing rc.3 forms and stream handlers retain their nodes.
(async () => {
  await window.portalReady;
  if(!window.streamCanvas||!window.streamStudio||!window.releaseFeatures)throw Error('A required app module did not start.');
  const make = (tag, text) => { const n = document.createElement(tag); if (text) n.textContent = text; return n; };
  const read = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } };
  const write = (key, value) => { localStorage.setItem(key, JSON.stringify(value)); };
  const uid = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), n => n.toString(16).padStart(2, '0')).join('');
  const report = e => { const message = e?.message || String(e); note(message); $('setupError').textContent = message; $('collabFeedback').textContent = message; };
  const act = fn => async () => { try { await fn(); } catch (e) { report(e); } };
  const open = id => { hideSecrets(); const dialog = $(id); dialog.style.zIndex=String(Math.max(80,...[...document.querySelectorAll("dialog")].map(d=>Number(d.style.zIndex)||80))+1); if (!dialog.open) dialog.show(); };
  for (const b of document.querySelectorAll('[data-close]')) b.onclick = () => $(b.dataset.close).close();
  const feedback = make('p'); feedback.id = 'collabFeedback'; feedback.setAttribute('role', 'status'); $('collabMenu').append(feedback);
  let settingsCategory='general';
  let page = 'studio', onboarding = !read('uc-ui5-setup', false), step = 0;
  const sections = ['nameSetup', 'connectionsPanel', 'obsSetupChoice', 'relaySetup'];
  function setPage(next) {
    if (next === 'admin' && !connected) { report('Connect to your relay first.'); return; }
    page = next;
    $('studioPage').hidden=onboarding;
    if(next==='studio'){for(const id of ['settings','admin'])$(id+'PageWindow').close();}else open(next+'PageWindow');
    for (const b of document.querySelectorAll('[data-page]')) b.setAttribute('aria-pressed', String(b.dataset.page === next));
    if (next === 'settings') setupPaint();
    if (next === 'admin' && view?.me?.isHost) $('hostLoad').click();
    hideSecrets();
  }
  for (const b of document.querySelectorAll('[data-page]')) b.onclick = () => setPage(b.dataset.page);
  $('openAdminAccess').onclick = () => setPage('admin');
  const adminBack = button('Back to Studio', () => setPage('studio')); $('adminPage').prepend(adminBack);
  const setupTitles = ['Choose your name','Connect your platforms','Automatic or manual OBS setup','Join or host a relay'];
  const setupHelp = ['This display name is yours throughout the app. Existing account usernames stay unchanged.','Connect Twitch, YouTube or a custom destination. You can do this later.','Pair OBS now, or copy the relay URL and key after joining.','Join an existing server, or see the hosting option. You may finish setup and connect later.'];
  function setupPaint() {
    document.body.classList.toggle('onboarding',onboarding);$('studioPage').hidden=onboarding;window.onboardingActive=onboarding;window.dispatchEvent(new Event('setup-step'));
    $('setupGuide').hidden = $('setupFooter').hidden = !onboarding;
    $('settingsCategories').hidden=onboarding;
    const groups={output:['fallbackPanel','resolutionSettings'],general:['generalSettings'],connections:['connectionsPanel'],relay:['relaySetup','manualOBS','openAdminAccess'],obs:['obsSetupChoice','obsImportantSettings'],preview:['previewSettings'],appearance:['appearanceSettings'],advanced:['advancedSettings','workspaceTools']};
    for(const id of new Set([...sections,...Object.values(groups).flat()]))$(id).hidden=onboarding?!sections.includes(id)||sections.indexOf(id)!==step:!groups[settingsCategory].includes(id);
    for(const b of document.querySelectorAll('[data-setting]'))b.setAttribute('aria-pressed',String(b.dataset.setting===settingsCategory));
    $('settingsName').value=localProfile.displayName;
    if (!onboarding) return;
    $('setupTitle').textContent = setupTitles[step]; $('setupHelp').textContent = setupHelp[step];
    $('setupProgress').textContent = `Step ${step+1} of 4`; $('setupBack').disabled = step === 0;
    $('setupSkip').hidden = step === 0; $('setupNext').textContent = step === 3 ? 'Finish setup' : 'Continue';
    if (step === 0) $('setupName').value = localProfile.displayName === 'My workspace' ? '' : localProfile.displayName;
    if (step === 3 && !connected) { if (!$('username').value) $('username').value = localProfile.displayName.replace(/[^A-Za-z0-9_-]/g,'').slice(0,32); }
  }
  async function advance() {
    $('setupError').textContent = '';
    if (step === 0) { if (!$('setupName').value.trim()) throw Error('Enter a name to continue.'); await persistLocal($('setupName').value); }
    if (step < 3) { step++; setupPaint(); return; }
    write('uc-ui5-setup',true); onboarding = false; setupPaint(); setPage('studio');
    if(connected)note($('obsMode').value==='auto'?'Automatic OBS setup is enabled. Prepare your stream, then click Start Stream.':'Copy your relay URL and key from Settings → Relay into OBS.');
  }
  $('setupNext').onclick = act(advance); $('setupSkip').onclick = act(advance);
  $('setupBack').onclick = () => { if (step) step--; setupPaint(); };
  $('joinRelay').onclick = act(async () => {
    $('serverSelect').value = '__add__'; await $('serverSelect').onchange();$('username').value=localProfile.displayName.replace(/[^A-Za-z0-9_-]/g,'').slice(0,32)||'Streamer';mode(true);$('welcome').hidden=false;open('joinRelayWindow');
  });
  $('hostRelay').onclick = () => { $('installerPending').hidden = false;open('hostRelayWindow'); };
  function eye(id) {
    const input = $(id), wrap = make('div'); wrap.className = 'eye-field'; input.before(wrap); wrap.append(input);
    const b = button('', () => { const show = input.type === 'password'; input.type = show ? 'text' : 'password'; b.setAttribute('aria-pressed',String(show)); b.setAttribute('aria-label',(show?'Hide ':'Show ')+(id==='address'?'server address':'password')); });
    b.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>';
    b.setAttribute('aria-label','Show '+(id==='address'?'server address':'password')); b.setAttribute('aria-pressed','false'); b.className='eye'; wrap.append(b); input.dataset.secret='true';
  }
  for (const id of ['address','password','obsPassword']) eye(id);
  window.addEventListener('blur',()=>document.querySelectorAll('.eye').forEach(b=>b.setAttribute('aria-pressed','false')));
  $('obsMode').value = read('uc-ui5-obs-mode','manual');
  $('obsMode').onchange = () => { write('uc-ui5-obs-mode',$('obsMode').value); $('automaticOBS').hidden = $('obsMode').value !== 'auto'; };
  $('obsMode').onchange();
  for(const b of document.querySelectorAll('[data-setting]'))b.onclick=()=>{settingsCategory=b.dataset.setting;setupPaint();window.dispatchEvent(new Event('settings-category'));};
  $('saveSettingsName').onclick=act(()=>persistLocal($('settingsName').value));
  $('runSetup').onclick=()=>{onboarding=true;step=0;setPage('settings');};
  $('settingsCustomize').onclick=()=>open('workspaceDialog');
  $('resetPreferences').onclick=()=>{if(!confirm('Reset panel positions, visibility, sizes and OBS preview preferences? Saved accounts, names, scenes, Collab permissions and completed setup are kept.'))return;for(const key of ['uc-ui8-dock-sizes','uc-ui8-panel-weights','uc-ui5-workspace','uc-ui8-workspace','uc-ui7-dock-sizes','uc-ui6-preview'])localStorage.removeItem(key);location.reload();};
  $('uninstallApp').onclick=act(async()=>{if(!desktop?.maintenance)throw Error('Uninstall is available in the installed desktop app.');await desktop.maintenance('uninstall');});
  // Scenes save in their own schema; rc.4 workspace data is intentionally ignored.
  let sceneScope='', scenes=[], selectedScene='', restoring=false, switching=false;
  let library=read('uc-ui5-scenes',{}); if(!library||typeof library!=='object'||Array.isArray(library))library={};
  function saveScene() {
    if(restoring||!sceneScope||!selectedScene)return;
    const scene=scenes.find(s=>s.id===selectedScene);if(scene)scene.layout=window.streamCanvas.snapshot();
    library[sceneScope]={selected:selectedScene,scenes};write('uc-ui5-scenes',library);
  }
  function drawScenes() {
    $('sceneList').replaceChildren();
    for(const scene of scenes){const b=button(scene.name,act(()=>switchScene(scene.id)));b.setAttribute('aria-pressed',String(scene.id===selectedScene));b.disabled=switching;$('sceneList').append(b);}
  }
  function sceneSync() {
    const scope=connected?profile.address+'|'+profile.id:'offline';if(scope===sceneScope)return;
    sceneScope=scope;const saved=library[scope];
    scenes=Array.isArray(saved?.scenes)?saved.scenes.filter(s=>s&&typeof s.id==='string'&&typeof s.name==='string'&&Array.isArray(s.layout?.items)).slice(0,100):[];
    if(!scenes.length)scenes=[{id:uid(),name:'Main scene',layout:window.streamCanvas.snapshot()}];
    selectedScene=scenes.some(s=>s.id===saved?.selected)?saved.selected:scenes[0].id;
    restoring=true;try{if(saved)window.streamCanvas.restore(scenes.find(s=>s.id===selectedScene).layout);}finally{restoring=false;}
    saveScene();drawScenes();
  }
  async function switchScene(id) {
    if(switching||busy||id===selectedScene)return;
    saveScene();const before=window.streamCanvas.snapshot(),scene=scenes.find(s=>s.id===id);if(!scene)return;
    switching=true;restoring=true;drawScenes();
    try { window.streamCanvas.restore(scene.layout);if(connected&&!await window.streamCanvas.save()){window.streamCanvas.restore(before);return;}selectedScene=id; }
    finally{restoring=false;switching=false;saveScene();drawScenes();}
  }
  const sceneName=()=>{const n=$('sceneName').value.trim();if(!n)throw Error('Enter a scene name.');return n;};
  $('sceneNew').onclick=act(()=>{if(scenes.length>=100)throw Error('Maximum 100 scenes.');saveScene();scenes.push({id:uid(),name:sceneName(),layout:{items:[{id:'main',kind:'main',x:0,y:0,width:1,height:1,z:-1}],locked:[],fallback:[]}});saveScene();drawScenes();});
  $('sceneDuplicate').onclick=act(()=>{if(scenes.length>=100)throw Error('Maximum 100 scenes.');scenes.push({id:uid(),name:sceneName(),layout:window.streamCanvas.snapshot()});saveScene();drawScenes();});
  $('sceneRename').onclick=act(()=>{scenes.find(s=>s.id===selectedScene).name=sceneName();saveScene();drawScenes();});
  $('sceneDelete').onclick=act(async()=>{if(scenes.length<=1)throw Error('Keep at least one scene.');if(!confirm('Delete this saved scene?'))return;const previous=selectedScene;await switchScene(scenes.find(s=>s.id!==previous).id);if(selectedScene!==previous){scenes=scenes.filter(s=>s.id!==previous);saveScene();drawScenes();}});
  window.addEventListener('scene-change',()=>{try{saveScene();}catch(e){report(e);}});
  $('layoutForm').addEventListener('change',()=>saveScene());
  $('canvasSave').textContent='Apply scene to relay';
  $('addItem').onclick=()=>{window.streamCanvas.availability();$('itemChoices').replaceChildren();for(const option of $('canvasSource').options){if(!option.value)continue;const b=button(option.textContent,()=>{$('canvasSource').value=option.value;$('canvasAdd').click();$('itemPicker').close();});$('itemChoices').append(b);}if(!$('itemChoices').children.length)$('itemChoices').textContent=connected?'No more approved sources available. Open Collab to request a friend’s feed.':'Connect to a relay to add chat and approved friend POVs.';open('itemPicker');};
  $('lockItem').onclick=()=>window.streamCanvas.toggleLock();
  const context=make('div');context.id='itemContext';context.hidden=true;document.body.append(context);
  window.addEventListener('item-context',e=>{context.replaceChildren(button(window.streamCanvas.selected().locked?'Unlock item':'Lock item',()=>{window.streamCanvas.toggleLock();context.hidden=true;}));context.style.left=Math.max(0,Math.min(innerWidth-160,e.detail.x))+'px';context.style.top=Math.max(0,Math.min(innerHeight-60,e.detail.y))+'px';context.hidden=false;});
  document.addEventListener('pointerdown',e=>{if(!context.contains(e.target))context.hidden=true;});document.addEventListener('keydown',e=>{if(e.key==='Escape')context.hidden=true;});
  // One combined warning, once. The server still independently checks acceptance.
  let collabBusy=false,collabSignature='',warningAccount='';
  const peerName=id=>view?.peers?.find(p=>p.id===id)?.displayName||id;
  async function registerWarning() {
    if(!connected||view?.capabilities?.mutualCollab!==1)return;
    const identity=profile.address+'|'+profile.id;if(view.me.collabWarning===1||warningAccount===identity)return;
    const data=await api('/api/v3/collab-warning',{});warningAccount=identity;render(data);
  }
  $('collabButton').onclick=act(async()=>{
    $('collabFeedback').textContent='';const accepted=read('uc-ui5-collab-explained',false)||view?.me?.collabWarning===1;
    $('collabExplanation').hidden=!!accepted;$('collabMembers').hidden=!accepted;open('collabMenu');
    if(accepted){write('uc-ui5-collab-explained',true);await registerWarning();drawCollab(true);}
  });
  $('acceptExplanation').onclick=act(async()=>{await registerWarning();write('uc-ui5-collab-explained',true);$('collabExplanation').hidden=true;$('collabMembers').hidden=false;drawCollab(true);});
  async function collabAction(route,input) {
    if(collabBusy||!connected||uncertain)return;collabBusy=true;
    try{await registerWarning();render(await api('/api/v3/'+route,input));drawCollab(true);}finally{collabBusy=false;}
  }
  function drawCollab(force=false) {
    const rows=view?.collaborations||[],mine=view?.me?.id;
    const incoming=rows.filter(p=>(p.status==='pending'&&p.peer===mine)||(p.status==='approved'&&p.upgradeBy&&p.upgradeBy!==mine));
    $('collabCount').hidden=!incoming.length;$('collabCount').textContent='+'+incoming.length;$('collabButton').classList.toggle('incoming',incoming.length>0);
    const signature=JSON.stringify([connected,uncertain,mine,rows,view?.peers]);if(!force&&signature===collabSignature)return;collabSignature=signature;
    const root=$('mutualPeople');root.replaceChildren();$('legacyPermissions').hidden=!(view?.requests||[]).some(r=>!r.partnershipId);
    if(!connected){root.textContent='Connect to a relay to see its members.';return;}
    if(view.capabilities?.mutualCollab!==1){root.textContent='This is an rc.3 relay. Update the relay to use mutual Collab and Super Collab. Existing individual permissions remain available below.';$('legacyPermissions').hidden=false;return;}
    if(uncertain){root.textContent='Reconnect to the relay before changing collaboration permissions.';return;}
    for(const p of incoming){const row=make('article');const upgrade=!!p.upgradeBy;row.append(make('h3',peerName(p.owner===mine?p.peer:p.owner)),make('p',upgrade?'Super Collab request — ongoing mutual access':'Collab request — mutual access for this session'));for(const decision of ['accept','decline'])row.append(button(decision==='accept'?'Accept':'Decline',act(()=>collabAction('collab-respond',{id:p.id,decision:decision+(upgrade?'-super':'')}))));root.append(row);}
    for(const peer of view.peers){const p=rows.find(p=>[p.owner,p.peer].includes(peer.id));const row=make('article');row.append(make('h3',peer.displayName||peer.id),make('p',peer.state));
      if(p?.status==='approved'){row.append(make('p',p.scope==='persistent'?'Super Collab active':'Collab active'));if(p.scope!=='persistent'&&!p.upgradeBy)row.append(button('Request Super Collab',act(()=>collabAction('collab-request',{peer:peer.id,permanent:true}))));if(p.upgradeBy===mine)row.append(make('p','Super Collab request sent'),button('Cancel upgrade',act(()=>collabAction('collab-respond',{id:p.id,decision:'cancel-super'}))));row.append(button('End Collab',act(()=>collabAction('collab-respond',{id:p.id,decision:'end'}))));}
      else if(p?.status==='pending'){row.append(make('p',p.owner===mine?'Request sent':'Respond to the incoming request above'));if(p.owner===mine)row.append(button('Cancel request',act(()=>collabAction('collab-respond',{id:p.id,decision:'end'}))));}
      else row.append(button('Collab',act(()=>collabAction('collab-request',{peer:peer.id}))));root.append(row);
    }
    if(!view.peers.length)root.append(make('p','No other people on this relay yet.'));
  }
  // Panels have one stable DOM owner; customization changes column placement only.
  const defaults={order:{dockLeft:['chat'],dockCenter:['layout'],dockRight:['stream','obsSources'],dockBottom:['obsScenes','scenes','sources','obsMixer']},hidden:['obsSources'],width:'balanced',unlocked:true,heights:{},colors:{}};
  let workspace=read('uc-ui8-workspace',structuredClone(defaults));if(!workspace||typeof workspace!=='object')workspace=structuredClone(defaults);
  const panels=new Map([...document.querySelectorAll('[data-dock]')].map(p=>[p.dataset.dock,p]));
  const titles={sources:'Sources · relay layout',obsScenes:'OBS scenes',obsSources:'OBS sources',obsMixer:'OBS audio mixer',scenes:'Relay scenes',layout:'Stream layout',stream:'Stream controls',fallback:'Fallback & output',chat:'Chat'};
  const validURL=value=>{try{const u=new URL(value);return ['http:','https:'].includes(u.protocol)&&!u.username&&!u.password;}catch{return false;}};
  let customTools=read('universalcollab-tools-v1',[]);customTools=Array.isArray(customTools)?customTools.filter(t=>t&&typeof t.id==='string'&&t.id.startsWith('tool-')&&typeof t.name==='string'&&validURL(t.url)).slice(0,30):[];
  function toolCard(t){const p=make('section');p.className='card';p.dataset.dock=t.id;titles[t.id]=t.name;p.append(make('h2',t.name),make('p','A local workspace tool. This is not a broadcast overlay.'));const frame=make('iframe');frame.src=t.url;frame.title=t.name;frame.loading='lazy';frame.referrerPolicy='no-referrer';frame.setAttribute('sandbox','allow-scripts allow-forms allow-same-origin');frame.style.cssText='width:100%;height:320px;border:0';p.append(button('Open in browser',act(()=>desktop?.studio?desktop.studio('open-tool',{url:t.url}):window.open(t.url,'_blank','noopener,noreferrer'))),button('Delete tool',()=>{if(!confirm('Delete this workspace tool?'))return;customTools=customTools.filter(x=>x.id!==t.id);write('universalcollab-tools-v1',customTools);panels.delete(t.id);p.remove();saveWorkspace();}),frame);panels.set(t.id,p);$('dockRight').append(p);return p;}
  for(const t of customTools)toolCard(t);
  function decorate(id,panel){const heading=make('div',titles[id]);heading.className='dock-handle';heading.tabIndex=0;heading.setAttribute('aria-label','Move '+titles[id]+' panel');panel.prepend(heading);heading.ondragstart=e=>{if(!workspace.unlocked){e.preventDefault();return;}e.dataTransfer.setData('text/plain',id);};}
  for(const [id,panel]of panels)decorate(id,panel);
  function workspacePaint(){
    const seen=new Set();for(const column of ['dockLeft','dockCenter','dockRight','dockBottom'])for(const id of (Array.isArray(workspace.order?.[column])?workspace.order[column]:[])){if(panels.has(id)&&!seen.has(id)){$(column).append(panels.get(id));seen.add(id);}}
    for(const [id,p]of panels){if(!seen.has(id))$(id==='scenes'?'dockLeft':id==='layout'?'dockCenter':'dockRight').append(p);p.hidden=(Array.isArray(workspace.hidden)&&workspace.hidden.includes(id))||(p.classList.contains('obs-panel')&&!window.obsConnected);p.classList.toggle('resizable',!!workspace.unlocked);p.firstElementChild.draggable=!!workspace.unlocked;p.style.setProperty('--panel-color',workspace.colors?.[id]||({scenes:'#674ea7',sources:'#315d83',layout:'#614285',stream:'#316453',chat:'#795135',obsScenes:'#465774',obsSources:'#745561',obsMixer:'#466437'}[id]||'#514366'));const h=workspace.heights?.[id];p.style.height=Number.isFinite(h)&&h>=180?Math.min(h,1500)+'px':'';}
    $('studioDocks').classList.toggle('wide',workspace.width==='wide');$('workspaceWidth').value=workspace.width==='wide'?'wide':'balanced';$('workspaceUnlocked').checked=!!workspace.unlocked;workspaceSettings();window.dispatchEvent(new Event('panels-changed'));
  }
  function saveWorkspace(){workspace.order=Object.fromEntries(['dockLeft','dockCenter','dockRight','dockBottom'].map(id=>[id,[...$(id).children].map(p=>p.dataset.dock).filter(Boolean)]));write('uc-ui8-workspace',workspace);workspacePaint();}
  function workspaceSettings(){const root=$('panelSettings');root.replaceChildren();for(const[id,p]of panels){const row=make('label',titles[id]+' '),visible=make('input');visible.type='checkbox';visible.checked=!workspace.hidden?.includes(id);visible.setAttribute('aria-label','Show '+titles[id]);visible.onchange=()=>{workspace.hidden=[...panels].filter(([key])=>key===id?!visible.checked:workspace.hidden?.includes(key)).map(([key])=>key);saveWorkspace();};const select=make('select');select.setAttribute('aria-label',titles[id]+' column');for(const[col,label]of[['dockLeft','Left'],['dockCenter','Center'],['dockRight','Right'],['dockBottom','Bottom']])select.append(new Option(label,col));select.value=p.parentElement.id;select.onchange=()=>{$(select.value).append(p);saveWorkspace();};const color=make('input');color.type='color';color.value=workspace.colors?.[id]||'#614285';color.setAttribute('aria-label',titles[id]+' title color');color.oninput=()=>{workspace.colors??={};workspace.colors[id]=color.value;write('uc-ui8-workspace',workspace);p.style.setProperty('--panel-color',color.value);};row.append(visible,select,color);root.append(row);}}
  for(const column of ['dockLeft','dockCenter','dockRight','dockBottom']){$(column).ondragover=e=>{if(workspace.unlocked&&e.dataTransfer.types.includes('text/plain')){e.preventDefault();$(column).classList.add('drop-target');}};$(column).ondrop=e=>{if(!workspace.unlocked)return;e.preventDefault();document.querySelectorAll('.drop-target').forEach(n=>n.classList.remove('drop-target'));const p=panels.get(e.dataTransfer.getData('text/plain'));if(p){const target=e.target.closest('[data-dock]');if(target&&target!==p&&target.parentElement===$(column))$(column).insertBefore(p,target);else $(column).append(p);saveWorkspace();}};}
  document.addEventListener('pointerup',()=>{if(!workspace.unlocked)return;workspace.heights={};for(const[id,p]of panels)if(p.style.height)workspace.heights[id]=p.offsetHeight;write('uc-ui8-workspace',workspace);});
  $('workspaceUnlocked').onchange=()=>{workspace.unlocked=$('workspaceUnlocked').checked;saveWorkspace();};$('workspaceWidth').onchange=()=>{workspace.width=$('workspaceWidth').value;saveWorkspace();};$('workspaceReset').onclick=()=>{workspace=structuredClone(defaults);workspacePaint();saveWorkspace();};$('customizeStudio').onclick=()=>open('workspaceDialog');workspacePaint();
  const toolEditor=make('section');toolEditor.append(make('h3','Custom workspace tool'));const toolName=make('input');toolName.placeholder='Tool name';toolName.maxLength=48;toolName.setAttribute('aria-label','Tool name');const toolURL=make('input');toolURL.type='password';toolURL.placeholder='https://…';toolURL.setAttribute('aria-label','Tool URL');toolEditor.append(toolName,toolURL,button('Add custom tool',act(()=>{if(!toolName.value.trim()||!validURL(toolURL.value))throw Error('Enter a name and valid HTTP(S) URL.');if(customTools.length>=30)throw Error('Maximum 30 custom tools.');const t={id:'tool-'+uid(),name:toolName.value.trim(),url:toolURL.value};customTools.push(t);write('universalcollab-tools-v1',customTools);decorate(t.id,toolCard(t));toolName.value=toolURL.value='';saveWorkspace();})));$('workspaceDialog').append(toolEditor);
  const presetsSection=make('section');presetsSection.append(make('h3','Workspace presets'));let presets=read('uc-ui5-workspace-presets',[]);if(!Array.isArray(presets))presets=[];const presetName=make('input');presetName.maxLength=48;presetName.placeholder='Preset name';presetName.setAttribute('aria-label','Workspace preset name');const presetChoice=make('select');presetChoice.setAttribute('aria-label','Workspace preset');const paintPresets=()=>{presetChoice.replaceChildren(new Option('Choose a preset',''),...presets.map(p=>new Option(p.name,p.name)));};paintPresets();presetsSection.append(presetChoice,presetName,button('Save workspace preset',act(()=>{const name=presetName.value.trim();if(!name)throw Error('Enter a preset name.');if(presets.length>=20&&!presets.some(p=>p.name===name))throw Error('Maximum 20 presets.');presets=presets.filter(p=>p.name!==name);presets.push({name,workspace:structuredClone(workspace)});write('uc-ui5-workspace-presets',presets);paintPresets();presetChoice.value=name;})),button('Load workspace preset',()=>{const p=presets.find(p=>p.name===presetChoice.value);if(p?.workspace){workspace=structuredClone(p.workspace);workspacePaint();saveWorkspace();}}),button('Delete workspace preset',()=>{presets=presets.filter(p=>p.name!==presetChoice.value);write('uc-ui5-workspace-presets',presets);paintPresets();}));$('workspaceDialog').append(presetsSection);
  let draggingButton=null,suppressCollabClick=false;const collabButton=$('collabButton');
  function positionCollab(){const pos=workspace.collabPosition;if(!pos){collabButton.style.left='18px';collabButton.style.top='';collabButton.style.bottom='18px';return;}collabButton.style.left=Math.max(8,Math.min(innerWidth-150,pos.x))+'px';collabButton.style.top=Math.max(8,Math.min(innerHeight-65,pos.y))+'px';collabButton.style.bottom='auto';}
  collabButton.addEventListener('pointerdown',e=>{if(!workspace.unlocked||e.button!==0)return;draggingButton={x:e.clientX,y:e.clientY,left:collabButton.offsetLeft,top:collabButton.offsetTop};collabButton.setPointerCapture(e.pointerId);});collabButton.addEventListener('pointermove',e=>{if(!draggingButton)return;const dx=e.clientX-draggingButton.x,dy=e.clientY-draggingButton.y;if(Math.abs(dx)+Math.abs(dy)>6){suppressCollabClick=true;workspace.collabPosition={x:draggingButton.left+dx,y:draggingButton.top+dy};positionCollab();}});collabButton.addEventListener('pointerup',()=>{if(draggingButton){draggingButton=null;write('uc-ui8-workspace',workspace);setTimeout(()=>suppressCollabClick=false,50);}});collabButton.addEventListener('click',e=>{if(suppressCollabClick){e.preventDefault();e.stopImmediatePropagation();}},true);window.addEventListener('resize',positionCollab);positionCollab();
  let nameSynced='';
  function sync(){
    $('studioName').textContent=localProfile?.displayName||'UniversalCollab';$('workspaceName').textContent=$('studioName').textContent;$('adminTab').hidden=!connected||!view?.me?.isHost;
    if(page==='admin'&&!connected)setPage('studio');
    if(!connected||!view?.me?.isHost)$('hostContent').replaceChildren();

    sceneSync();drawCollab();
    if(connected&&view.capabilities?.mutualCollab===1&&localProfile?.displayName){const identity=profile.address+'|'+profile.id+'|'+localProfile.displayName;if(identity!==nameSynced){nameSynced=identity;api('/api/v3/display-name',{name:localProfile.displayName}).catch(()=>{nameSynced='';});}}
  }
  window.addEventListener('relay-state',()=>{try{sync();}catch(e){report(e);}});window.addEventListener('local-name',sync);
  window.addEventListener('obs-connection',workspacePaint);
  sync();if(onboarding)setPage('settings');
  window.workspaceUI={getWorkspace:()=>workspace,setPanelVisible:(id,show)=>{workspace.hidden=(workspace.hidden||[]).filter(n=>n!==id);if(!show)workspace.hidden.push(id);saveWorkspace();},setPage,openSettings:category=>{settingsCategory=category;onboarding=false;setPage('settings');},panels,titles,saveWorkspace,workspacePaint};
  document.body.dataset.ready='true';window.dispatchEvent(new Event('studio-ready'));$('bootStatus').hidden=!(window.appStartupErrors?.length);
})().catch(e=>{document.getElementById('bootMessage').textContent='Studio startup failed: '+e.message;document.getElementById('bootStatus').hidden=false;});
