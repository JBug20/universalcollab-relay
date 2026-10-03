'use strict';
(()=>{
 const $=id=>document.getElementById(id),bridge=window.relayDesktop;
 let state=null,broadcasts=[],tab='combined',pendingModeration=null,chatSignature='',inFlight=false;let previousAccounts={};
 const notify=message=>{$('platformNotice').textContent=message;window.dispatchEvent(new CustomEvent('platform-notice',{detail:message}));};
 const call=async(op,input={})=>{if(!bridge?.platform)throw Error('Platform integration requires the desktop app.');return bridge.platform(op,input);};
 const error=e=>notify(e.message||'Platform action failed.');
 async function act(fn){if(inFlight)return;inFlight=true;try{await fn();}catch(e){error(e);}finally{inFlight=false;}}
 const names={twitch:'Twitch',youtube:'YouTube'};
 for(const button of document.querySelectorAll('[data-workspace-tab]'))button.onclick=()=>{
  tab=button.dataset.workspaceTab;
  for(const b of document.querySelectorAll('[data-workspace-tab]'))b.setAttribute('aria-selected',String(b===button));
  $('relayWorkspace').hidden=tab!=='relay';$('socialWorkspace').hidden=tab!=='social';$('platformWorkspace').hidden=['relay','social'].includes(tab);$('workspaceTools').hidden=!['relay','social'].includes(tab);window.dispatchEvent(new CustomEvent('workspace-tab',{detail:tab}));
  $('tab-combined').hidden=tab!=='combined';
  renderChat();window.dispatchEvent(new CustomEvent('platform-state',{detail:s}));
 };
 for(const p of ['twitch','youtube']){
  $(p+'Setup').onsubmit=e=>{e.preventDefault();act(async()=>{state=await call('configure',{platform:p,clientId:$(p+'Client').value.trim(),clientSecret:p==='youtube'?$('youtubeSecret').value.trim():''});$(p+'Client').value='';if(p==='youtube')$('youtubeSecret').value='';paint(state);notify(names[p]+' application settings saved on this device.');});};
  $(p+'Connect').onclick=()=>act(async()=>{paint(await call('connect',{platform:p}));notify('Finish signing in through your browser.');});
  $(p+'Cancel').onclick=()=>act(async()=>paint(await call('cancel',{platform:p})));
  $(p+'Disconnect').onclick=()=>act(async()=>{paint(await call('disconnect',{platform:p}));notify(names[p]+' disconnected. Your relay broadcast is unchanged.');});
  $(p+'ChatStart').onclick=()=>act(async()=>{paint(await call('chat-start',{platform:p,...(p==='youtube'?{id:$('youtubeBroadcast').value}:{})}));});
  $(p+'ChatStop').onclick=()=>act(async()=>paint(await call('chat-stop',{platform:p})));
 }
 $('twitchReload').onclick=()=>act(loadTwitch);
 async function loadTwitch(){const v=await call('twitch-info');$('twitchTitle').value=v.title;$('twitchLanguage').value=v.language||'en';$('twitchCategory').replaceChildren(new Option(v.gameName||'No category',v.gameId||''));$('twitchSave').disabled=false;notify('Twitch stream information loaded.');}
 $('categorySearch').onsubmit=e=>{e.preventDefault();act(async()=>{const result=await call('categories',{query:$('categoryQuery').value});const current=new Option($('twitchCategory').selectedOptions[0]?.textContent||'Keep category',$('twitchCategory').value);$('twitchCategory').replaceChildren(current,...result.filter(x=>x.id!==current.value).map(x=>new Option(x.name,x.id)));notify(result.length?'Choose a category, then save.':'No matching categories.');});};
 $('twitchInfoForm').onsubmit=e=>{e.preventDefault();act(async()=>{await call('twitch-save',{title:$('twitchTitle').value,gameId:$('twitchCategory').value,language:$('twitchLanguage').value});notify('Twitch stream information saved.');});};
 window.selectCreatedBroadcast=id=>act(async()=>{broadcasts=await call('broadcasts');$('youtubeBroadcast').replaceChildren(new Option('Choose a broadcast',''),...broadcasts.map(x=>new Option(x.title+' · '+x.state,x.id)));$('youtubeBroadcast').value=id;await fillYoutube();notify('New YouTube broadcast selected. Start its chat once it is live.');});
 $('youtubeReload').onclick=()=>act(async()=>{broadcasts=await call('broadcasts');$('youtubeBroadcast').replaceChildren(new Option('Choose a broadcast',''),...broadcasts.map(x=>new Option(x.title+' · '+x.state,x.id)));fillYoutube();notify(broadcasts.length?'Choose the broadcast to edit.':'No broadcasts found. Create one in YouTube Studio, then refresh.');});
 async function fillYoutube(){const id=$('youtubeBroadcast').value,b=broadcasts.find(x=>x.id===id);$('youtubeTitle').value=b?.title||'';$('youtubeDescription').value=b?.description||'';$('youtubeSave').disabled=true;if(!b)return;try{const v=await call('youtube-video-info',{id});if($('youtubeBroadcast').value!==id)return;$('youtubeCategoryId').value=v.categoryId;$('youtubeSave').disabled=false;}catch(e){error(e);}}
 $('youtubeBroadcast').onchange=()=>{fillYoutube();notify('Broadcast selected. Click Start chat to switch the YouTube chat source.');};
 $('youtubeInfoForm').onsubmit=e=>{e.preventDefault();act(async()=>{const result=await call('youtube-save',{id:$('youtubeBroadcast').value,title:$('youtubeTitle').value,description:$('youtubeDescription').value,categoryId:$('youtubeCategoryId').value});Object.assign(broadcasts.find(b=>b.id===result.id)||{},result);notify('YouTube title and description saved.');});};
 function paint(s){state=s;window.streamStudio?.accounts(s);window.streamCanvas?.chats(s.messages||[],s.chats);
  for(const p of ['twitch','youtube']){
   const a=s.accounts[p],j=s.auth[p],c=s.chats[p];if(previousAccounts[p]!==a?.id){if(p==='twitch'){$('twitchSave').disabled=true;$('twitchTitle').value='';}else{broadcasts=[];$('youtubeBroadcast').replaceChildren(new Option('Choose a broadcast',''));fillYoutube();}previousAccounts[p]=a?.id;}$(p+'Account').textContent=a?'Connected as '+a.name:j?.status==='waiting'?'Waiting for browser sign-in…':j?.error||'Not connected';
   $(p+'Configured').textContent=s.configured[p]?'OAuth application configured.':'One-time OAuth application setup required.';
   $(p+'SetupFields').disabled=!!a||j?.status==='waiting';$(p+'Connect').disabled=!!a||j?.status==='waiting';$(p+'Cancel').hidden=j?.status!=='waiting';$(p+'Disconnect').disabled=!a;
   $(p+'Tools').disabled=!a;$(p+'ChatStop').disabled=!c.running;$(p+'ChatStatus').textContent=c.status+(c.error?' · '+c.error:'');
  }
  renderChat();window.dispatchEvent(new CustomEvent('platform-state',{detail:s}));
 }
 let prefs={twitch:true,youtube:true,timestamps:true,font:'normal',filter:'',paused:false};
 try{const p=JSON.parse(localStorage.getItem('universalcollab-chat-ui-v1')||'null');if(p)for(const k of Object.keys(prefs))if(typeof p[k]===typeof prefs[k])prefs[k]=p[k];}catch{}
 const controls={chatTwitch:'twitch',chatYoutube:'youtube',chatTimes:'timestamps',chatFont:'font',chatFilter:'filter',chatPaused:'paused'};
 for(const [id,key] of Object.entries(controls)){const el=$(id);if(el.type==='checkbox')el.checked=prefs[key];else el.value=prefs[key];el.oninput=()=>{prefs[key]=el.type==='checkbox'?el.checked:el.value;try{localStorage.setItem('universalcollab-chat-ui-v1',JSON.stringify(prefs));}catch{}chatSignature='';renderChat();};}
 function renderChat(){if(!state)return;const messages=(state.messages||[]).filter(m=>(tab==='combined'?prefs[m.platform]:m.platform===tab)&&(!prefs.filter||(m.author+' '+m.text).toLowerCase().includes(prefs.filter.toLowerCase())));
  const root=$('chatMessages'),signature=JSON.stringify([messages,prefs.timestamps,prefs.font,tab]);if(signature===chatSignature)return;chatSignature=signature;
  const oldScroll=root.scrollTop;root.className='chat-messages font-'+(['small','normal','large'].includes(prefs.font)?prefs.font:'normal');root.replaceChildren();
  for(const m of messages){const row=document.createElement('article');row.className='chat-message';const meta=document.createElement('div');meta.className='chat-meta';const badge=document.createElement('strong');badge.textContent=names[m.platform]+' · '+m.author;meta.append(badge);if(prefs.timestamps){const time=document.createElement('time');time.textContent=new Date(m.time).toLocaleTimeString();meta.append(time);}const text=document.createElement('p');text.textContent=m.text;row.append(meta,text);
   if(m.authorId){const actions=document.createElement('div');actions.className='chat-actions';for(const action of ['delete','timeout','ban']){const b=document.createElement('button');b.textContent=action==='timeout'?'Timeout 10m':action==='delete'?'Delete':'Ban';b.onclick=()=>{pendingModeration={key:m.key,action};$('moderationText').textContent=(action==='delete'?'Delete this message':action==='timeout'?'Timeout '+m.author+' for 10 minutes':'Ban '+m.author)+' on '+names[m.platform]+'?';$('moderationConfirm').showModal();};actions.append(b);}row.append(actions);}root.append(row);
  }
  if(!messages.length){const p=document.createElement('p');p.className='hint';p.textContent='No messages yet. Start chat in the Twitch or YouTube tab.';root.append(p);}
  root.scrollTop=prefs.paused?oldScroll:root.scrollHeight;
 }
 $('moderationCancel').onclick=()=>{$('moderationConfirm').close();pendingModeration=null;};
 $('moderationDo').onclick=()=>act(async()=>{const target=pendingModeration;if(!target)return;await call('moderate',target);$('moderationConfirm').close();pendingModeration=null;notify('Moderation action completed on the original platform.');});
 $('chatSendForm').onsubmit=e=>{e.preventDefault();act(async()=>{const platform=$('chatTarget').value;await call('send',{platform,text:$('chatText').value});$('chatText').value='';notify('Sent to '+names[platform]+'.');});};
 $('chatClear').onclick=()=>act(async()=>{paint(await call('clear-local'));notify('Local chat view cleared. Platform messages were not deleted.');});
 // One shared chat surface follows the selected platform tab without duplicate polling.
 for(const b of document.querySelectorAll('[data-workspace-tab]'))b.addEventListener('click',()=>{if(['twitch','youtube','combined'].includes(tab)){$('tab-'+tab).append($('chatSurface'));if(tab!=='combined')$('chatTarget').value=tab;$('chatFilters').hidden=tab!=='combined';}});
 if(!bridge?.platform){$('desktopOnly').hidden=false;for(const el of document.querySelectorAll('#platformWorkspace input,#platformWorkspace button,#platformWorkspace select'))el.disabled=true;return;}
 bridge.onPlatforms(paint);call('state').then(paint).catch(error);
})();
