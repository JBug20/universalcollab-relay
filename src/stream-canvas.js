'use strict';
(()=>{
 let resolution=null,locked=new Set();let items=[],selection='main',messages=[],chatStatus={},moving=null,uploading=false,lastSent='',lastAt=0;
 const root=$('layoutPreview'),clamp=(v,a,b)=>Math.max(a,Math.min(b,v)),defaultMain=()=>({id:'main',kind:'main',x:0,y:0,width:1,height:1,z:-1});
 const supported=()=>connected&&view?.capabilities?.streamCanvas===1;
 const editable=item=>!locked.has(item.id)&&supported()&&(item.kind==='main'||capability(item.kind==='video'?'pictureInPicture':'chatOverlays'));
 const chosen=()=>items.find(i=>i.id===selection)||items[0];
 const title=i=>i.kind==='main'?'Your main feed':i.kind==='video'?(view?.peers?.find(p=>p.id===i.publisher)?.displayName||i.publisher)+' POV':({twitch:'Twitch chat',youtube:'YouTube chat',combined:'Combined chat'}[i.source]);
 function changed(){layoutDirty=true;window.dispatchEvent(new Event('scene-change'));$('canvasHint').textContent='Unsaved changes — Save stream layout & fallback to apply.';}
 function load(settings){
  resolution=settings.resolution||null;items=[{...defaultMain(),...(settings.main||{})}];
  for(const [n,p]of (settings.overlays||[]).entries())items.push({id:'video:'+p.publisher,kind:'video',visible:p.visible!==false,publisher:p.publisher,corner:p.corner||'top-right',x:p.x??(p.corner?.endsWith('left')?.027:.973),y:p.y??(p.corner?.startsWith('bottom')?.973:.027),width:p.width??(view?.status.overlayWidthPercent||25)/100,height:p.height??(view?.status.overlayWidthPercent||25)/100,z:p.z??n});
  for(const [n,p]of (settings.chatOverlays||[]).entries())items.push({id:'chat:'+p.source,kind:'chat',...p,z:p.z??(100+n)});
  selection=items.some(i=>i.id===selection)?selection:'main';lastSent='';paint();availability();
 }
 function availability(){
  const old=$('canvasSource').value,select=$('canvasSource');select.replaceChildren(new Option('Choose an item',''));
  if(supported()){
   if(capability('pictureInPicture'))for(const peer of view.peers)if(view.requests.some(r=>r.owner===view.me.id&&r.peer===peer.id&&r.kind==='video'&&r.status==='approved')&&!items.some(i=>i.publisher===peer.id))select.add(new Option((peer.displayName||peer.id)+' POV','video:'+peer.id));
   if(desktop?.platform&&capability('chatOverlays'))for(const source of ['twitch','youtube','combined'])if(!items.some(i=>i.source===source))select.add(new Option(title({kind:'chat',source}),'chat:'+source));
  }
  if([...select.options].some(o=>o.value===old))select.value=old;
  select.disabled=!supported();$('canvasAdd').disabled=!supported()||select.options.length===1;$('canvasSave').disabled=!supported();
  $('canvasHint').textContent=!connected?'Connect to edit a stream layout.':!supported()?'Update the relay server to 0.6.3 to use the stream canvas.':layoutDirty?'Unsaved changes — Save stream layout & fallback to apply.':'Select an item; drag to move, use its corner handle to resize. Arrow keys move; Shift + arrows resize.';
  inspect();presetPaint();
 }
 function styleBox(el,item){el.style.left=item.x*(1-item.width)*100+'%';el.style.top=item.y*(1-item.height)*100+'%';el.style.width=item.width*100+'%';el.style.height=item.height*100+'%';el.style.zIndex=String((item.z??-1)+1);el.hidden=item.visible===false;}
 let obsImage='';
 function previewImage(tile){if(!obsImage)return;const img=document.createElement('img');img.className='obs-preview-image';img.alt='OBS program output preview';img.src=obsImage;tile.prepend(img);}
 function paint(){
  const status=resolution||view?.status;root.style.aspectRatio=status?.width&&status?.height?status.width+'/'+status.height:'16/9';
  root.replaceChildren();$('canvasLayers').replaceChildren();
  for(const item of [...items].sort((a,b)=>(b.z??-1)-(a.z??-1))){
   const tile=document.createElement('div');tile.className='canvas-item '+item.kind+(item.id===selection?' selected':'');tile.dataset.item=item.id;tile.classList.toggle('locked',locked.has(item.id));tile.oncontextmenu=e=>{e.preventDefault();selection=item.id;selectPaint();inspect();window.dispatchEvent(new CustomEvent('item-context',{detail:{x:e.clientX,y:e.clientY}}));};tile.tabIndex=0;tile.setAttribute('role','group');tile.setAttribute('aria-label',title(item));styleBox(tile,item);
   const label=document.createElement('span');label.className='canvas-label';label.textContent=title(item);tile.append(label);if(item.kind==='main')previewImage(tile);
   if(item.kind==='chat'){const text=document.createElement('div');text.className='canvas-chat-preview';const filtered=messages.filter(m=>item.source==='combined'||m.platform===item.source).slice(-4);text.textContent=filtered.length?filtered.map(m=>m.author+': '+m.text).join('\n'):'Chat messages appear here';tile.append(text);}
   const handle=document.createElement('button');handle.type='button';handle.className='canvas-resize';handle.textContent='↘';handle.setAttribute('aria-label','Resize '+title(item));tile.append(handle);
   tile.onpointerdown=e=>{
    if(e.button!==0)return;selection=item.id;selectPaint();inspect();if(!editable(item))return;
    e.preventDefault();tile.focus();moving={id:item.id,pointer:e.pointerId,startX:e.clientX,startY:e.clientY,before:{...item},resize:e.target===handle};dragging=true;tile.setPointerCapture(e.pointerId);
   };
   tile.onpointermove=e=>{if(!moving||moving.id!==item.id||moving.pointer!==e.pointerId)return;const r=root.getBoundingClientRect(),b=moving.before,dx=(e.clientX-moving.startX)/r.width,dy=(e.clientY-moving.startY)/r.height;
    if(moving.resize){const left=b.x*(1-b.width),top=b.y*(1-b.height);item.width=clamp(b.width+dx,.04,1-left);item.height=clamp(b.height+dy,.04,1-top);item.x=left/Math.max(.000001,1-item.width);item.y=top/Math.max(.000001,1-item.height);}
    else{item.x=clamp(b.x+dx/Math.max(.000001,1-b.width),0,1);item.y=clamp(b.y+dy/Math.max(.000001,1-b.height),0,1);}
    item.x=clamp(item.x,0,1);item.y=clamp(item.y,0,1);styleBox(tile,item);inspect();changed();
   };
   tile.onpointerup=()=>{moving=null;dragging=null;};tile.onpointercancel=()=>{if(moving){Object.assign(item,moving.before);moving=null;dragging=null;paint();}};
   tile.onkeydown=e=>{const delta={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]}[e.key];if(!delta||!editable(item))return;e.preventDefault();selection=item.id;if(e.shiftKey){item.width=clamp(item.width+delta[0]*.01,.04,1);item.height=clamp(item.height+delta[1]*.01,.04,1);}else{item.x=clamp(item.x+delta[0]*.01,0,1);item.y=clamp(item.y+delta[1]*.01,0,1);}changed();styleBox(tile,item);inspect();};
   root.append(tile);
   const row=document.createElement('div');row.className='relay-source-row';row.dataset.layer=item.id;row.draggable=!locked.has(item.id);row.setAttribute('aria-selected',String(item.id===selection));
   const layer=button(title(item),()=>{selection=item.id;selectPaint();inspect();});layer.className='source-name';layer.setAttribute('aria-pressed',String(item.id===selection));row.append(layer);
   const visible=button(item.visible===false?'○':'◉',()=>{if(!supported())return;item.visible=item.visible===false;changed();paint();});visible.title=visible.ariaLabel=(item.visible===false?'Show ':'Hide ')+title(item);visible.disabled=!supported();row.append(visible);
   const lock=button(locked.has(item.id)?'🔒':'🔓',()=>{selection=item.id;toggleLock();});lock.ariaLabel='Lock / unlock '+title(item);row.append(lock);
   row.ondragstart=e=>{if(!editable(item)){e.preventDefault();return;}e.dataTransfer.setData('application/x-relay-source',item.id);};row.ondragover=e=>{if(e.dataTransfer.types.includes('application/x-relay-source'))e.preventDefault();};row.ondrop=e=>{e.preventDefault();e.stopPropagation();const id=e.dataTransfer.getData('application/x-relay-source'),from=items.find(i=>i.id===id);if(!from||!editable(from)||!editable(item)||from===item)return;const ordered=[...items].sort((a,b)=>b.z-a.z).filter(i=>i!==from);ordered.splice(ordered.indexOf(item),0,from);ordered.reverse().forEach((i,n)=>i.z=n);selection=id;changed();paint();};$('canvasLayers').append(row);
  }
  inspect();
 }
 function selectPaint(){for(const node of root.children)node.classList.toggle('selected',node.dataset.item===selection);for(const node of $('canvasLayers').children){node.setAttribute('aria-selected',String(node.dataset.layer===selection));node.querySelector('.source-name').setAttribute('aria-pressed',String(node.dataset.layer===selection));}}
 function inspect(){const i=chosen();if(!i)return;for(const [key,id]of [['width','canvasWidth'],['height','canvasHeight'],['x','canvasX'],['y','canvasY']]){const el=$(id);el.disabled=!editable(i);if(document.activeElement!==el)el.value=Math.round(100*(key==='x'?i.x*(1-i.width):key==='y'?i.y*(1-i.height):i[key])*10)/10;}
  for(const id of ['canvasRemove','canvasBack','canvasFront'])$(id).disabled=(id==='canvasRemove'&&i.kind==='main')||!editable(i);$('canvasMainReset').disabled=!supported()||locked.has('main');}
 for(const [key,id]of [['width','canvasWidth'],['height','canvasHeight'],['x','canvasX'],['y','canvasY']])$(id).onchange=()=>{const i=chosen(),v=Number($(id).value)/100;if(!i||!editable(i)||!Number.isFinite(v))return;i[key]=key==='x'?clamp(v/Math.max(.000001,1-i.width),0,1):key==='y'?clamp(v/Math.max(.000001,1-i.height),0,1):clamp(v,.04,1);changed();paint();};
 $('canvasAdd').onclick=()=>{const value=$('canvasSource').value;if(!supported()||!value||items.some(i=>i.id===value))return;const [kind,source]=value.split(':');const z=Math.max(0,...items.map(i=>i.z))+1;const i={id:value,kind,x:.5,y:.5,width:kind==='chat'?.3:.25,height:kind==='chat'?.6:.25,z};if(kind==='video'){i.publisher=source;i.corner='top-right';}else i.source=source;items.push(i);selection=i.id;changed();paint();availability();};
 $('canvasRemove').onclick=()=>{if(chosen()?.kind==='main'||!editable(chosen()))return;items=items.filter(i=>i.id!==selection);selection='main';changed();paint();availability();};
 function reorder(step){const item=chosen();if(!item||!editable(item))return;const layers=items.slice().sort((a,b)=>a.z-b.z),at=layers.indexOf(item),next=at+step;if(next<0||next>=layers.length)return;[layers[at],layers[next]]=[layers[next],layers[at]];layers.forEach((i,n)=>i.z=n);changed();paint();}
 $('canvasBack').onclick=()=>reorder(-1);$('canvasFront').onclick=()=>reorder(1);$('canvasMainReset').onclick=()=>{if(locked.has('main'))return;Object.assign(items[0],defaultMain());selection='main';changed();paint();};
 const box=i=>({x:i.x,y:i.y,width:i.width,height:i.height});
 async function save(){if(!supported()||busy)return false;const main={...box(items[0]),visible:items[0].visible!==false,z:items[0].z},overlays=items.filter(i=>i.kind==='video').map(i=>({publisher:i.publisher,corner:i.corner,...box(i),z:i.z,visible:i.visible!==false})),chatOverlays=items.filter(i=>i.kind==='chat').map(i=>({source:i.source,...box(i),z:i.z,visible:i.visible!==false}));
  const settings={...window.releaseFeatures?.settings(),resolution,main,overlays:capability('pictureInPicture')?overlays:view.me.settings.overlays,chatOverlays:capability('chatOverlays')?chatOverlays:(view.me.settings.chatOverlays||[]),fallback:capability('collaboratorFallback')?[1,2].map(i=>$('fallback'+i).value).filter(Boolean):view.me.settings.fallback};
  const savedItems=structuredClone(items);if(await change('/api/v3/settings',settings)){layoutDirty=false;load(view.me.settings);for(const i of savedItems)if(i.visible===false&&!items.some(x=>x.id===i.id))items.push(i);paint();note('Stream layout saved.');return true;}return false;
 }
 // Render public chat locally; OAuth tokens never go to the relay. YUV tiles are
 // bounded and sent at most once every three seconds, only while broadcasting.
 function makeFrame(tile){
  const status=view.status,aspect=(status.width||1920)*tile.width/((status.height||1080)*tile.height);
  const w=Math.max(2,Math.floor(Math.min(512,768*aspect)/2)*2),h=Math.max(2,Math.floor(Math.min(768,w/aspect)/2)*2);
  const canvas=document.createElement('canvas');canvas.width=w;canvas.height=h;const c=canvas.getContext('2d',{willReadFrequently:true});c.fillStyle='#11111c';c.fillRect(0,0,w,h);const font=Math.max(12,Math.round(w/23)),line=font*1.4;
  c.font='bold '+font+'px sans-serif';c.fillStyle='#c7a6ff';c.fillText(title({kind:'chat',source:tile.source}),12,line,Math.max(1,w-24));c.font=font+'px sans-serif';
  const rows=[];for(const m of messages.filter(m=>tile.source==='combined'||m.platform===tile.source).slice(-30)){
   const words=((tile.source==='combined'?(m.platform==='twitch'?'[T] ':'[Y] '):'')+m.author+': '+m.text).split(/\s+/);let row='';
   for(const word of words){if(c.measureText(row+' '+word).width>w-24&&row){rows.push(row);row='';}if(c.measureText(word).width>w-24){for(const char of word){if(c.measureText(row+char).width>w-24&&row){rows.push(row);row='';}row+=char;}}else row+=(row?' ':'')+word;}if(row)rows.push(row);
  }
  const visible=rows.slice(-Math.max(0,Math.floor((h-line*2)/line)));c.fillStyle='#f4f1ff';visible.forEach((t,n)=>c.fillText(t,12,line*(n+2),Math.max(1,w-24)));
  const rgba=c.getImageData(0,0,w,h).data,n=w*h,yuv=new Uint8Array(n*3/2);let u=n,v=n+n/4;
  for(let y=0;y<h;y+=2)for(let x=0;x<w;x+=2){let rr=0,gg=0,bb=0;for(let yy=0;yy<2;yy++)for(let xx=0;xx<2;xx++){const p=(y+yy)*w+x+xx,q=p*4,r=rgba[q],g=rgba[q+1],b=rgba[q+2];yuv[p]=clamp(Math.round(16+.257*r+.504*g+.098*b),16,235);rr+=r;gg+=g;bb+=b;}const at=(y/2)*(w/2)+x/2;yuv[u+at]=clamp(Math.round(128-.148*rr/4-.291*gg/4+.439*bb/4),16,240);yuv[v+at]=clamp(Math.round(128+.439*rr/4-.368*gg/4-.071*bb/4),16,240);}
  let binary='';for(let i=0;i<yuv.length;i+=16384)binary+=String.fromCharCode(...yuv.subarray(i,i+16384));return {source:tile.source,width:w,height:h,data:btoa(binary)};
 }
 async function upload(){if(uploading||!supported()||!capability('chatOverlays')||!view.status.broadcast)return;
  const tiles=view.me.settings.chatOverlays||[];if(!tiles.length)return;
  const available=tiles.filter(t=>t.source==='combined'?chatStatus.twitch?.running||chatStatus.youtube?.running:chatStatus[t.source]?.running);
  const signature=JSON.stringify([available,messages,view.status.width,view.status.height]);if(signature===lastSent&&Date.now()-lastAt<6000)return;
  uploading=true;try{const frames=available.map(makeFrame);await api('/api/v3/chat-frame',{frames});lastSent=signature;lastAt=Date.now();}catch{$('canvasHint').textContent='Chat overlay update failed. Check the relay connection; stale overlays hide automatically.';}finally{uploading=false;}
 }
 // Stream presets are scoped to the saved server/account and still require approvals on load/save.
 const presetPanel=document.createElement('details');presetPanel.id='streamPresetPanel';const summary=document.createElement('summary');summary.textContent='Stream layout presets';presetPanel.append(summary);
 const row=document.createElement('div');row.className='row';const presetSelect=document.createElement('select');presetSelect.id='streamPresetSelect';presetSelect.setAttribute('aria-label','Saved stream layout');
 const presetName=document.createElement('input');presetName.id='streamPresetName';presetName.maxLength=48;presetName.placeholder='Preset name';presetName.setAttribute('aria-label','Stream layout preset name');
 const presetsKey='universalcollab-stream-presets-v1';let presetRows=[];try{const parsed=JSON.parse(localStorage.getItem(presetsKey)||'[]');if(Array.isArray(parsed))presetRows=parsed.slice(0,100).filter(p=>p&&typeof p.name==='string'&&Array.isArray(p.items)&&p.items.length<=68);}catch{}
 const scope=()=>selected()?.key||'';
 function presetPaint(){const old=presetSelect.value;presetSelect.replaceChildren(new Option('Choose saved stream layout',''),...presetRows.filter(p=>p.scope===scope()).map(p=>new Option(p.name,p.name)));presetSelect.value=old;for(const b of row.querySelectorAll('button,input,select'))b.disabled=!supported();}
 function presetPersist(){try{localStorage.setItem(presetsKey,JSON.stringify(presetRows));presetPaint();return true;}catch{note('Could not save stream presets on this device.');return false;}}
 const storePreset=button('Save preset',()=>{if(!supported())return;const name=presetName.value.trim();if(!name){note('Enter a preset name.');return;}const existing=presetRows.find(p=>p.scope===scope()&&p.name===name);if(existing&&!confirm('Replace stream preset “'+name+'”?'))return;if(!existing&&presetRows.length>=100){note('Delete an unused preset first (100 maximum across servers).');return;}presetRows=presetRows.filter(p=>!(p.scope===scope()&&p.name===name));presetRows.push({name,scope:scope(),items:structuredClone(items),fallback:[1,2].map(i=>$('fallback'+i).value).filter(Boolean)});if(presetPersist()){presetSelect.value=name;note('Stream preset saved locally. It does not change the broadcast until you save the stream layout.');}});storePreset.id='saveStreamPreset';
 const loadPreset=button('Load preset',()=>{if(!supported())return;const p=presetRows.find(p=>p.scope===scope()&&p.name===presetSelect.value);if(!p)return;let skipped=0;
 const allowed=(peer,kind)=>view.requests.some(r=>r.owner===view.me.id&&r.peer===peer&&r.kind===kind&&r.status==='approved')&&view.peers.some(p=>p.id===peer);
 const clean=[];for(const item of p.items){const box=['x','y','width','height'].every(k=>Number.isFinite(item[k])&&item[k]>=0&&item[k]<=1)&&item.width>=.04&&item.height>=.04;if(!box){skipped++;continue;}if(item.kind==='main'||item.kind==='video'&&capability('pictureInPicture')&&allowed(item.publisher,'video')||item.kind==='chat'&&capability('chatOverlays')&&['twitch','youtube','combined'].includes(item.source))clean.push({...item});else skipped++;}
 items=clean.filter(i=>i.kind!=='main');items.unshift(clean.find(i=>i.kind==='main')||defaultMain());selection='main';
 const fallbacks=(p.fallback||[]).filter(peer=>capability('collaboratorFallback')&&allowed(peer,'fallback'));skipped+=(p.fallback||[]).length-fallbacks.length;for(const i of [1,2])$('fallback'+i).value=fallbacks[i-1]||'';
 changed();paint();availability();note('Preset loaded for preview. Save stream layout & fallback to apply.'+(skipped?' '+skipped+' unavailable or unapproved item(s) omitted.':''));});loadPreset.id='loadStreamPreset';
 const deletePreset=button('Delete preset',()=>{const name=presetSelect.value;if(!supported()||!name||!confirm('Delete stream preset “'+name+'”?'))return;presetRows=presetRows.filter(p=>!(p.scope===scope()&&p.name===name));presetPersist();});deletePreset.id='deleteStreamPreset';
 row.append(presetSelect,loadPreset,presetName,storePreset,deletePreset);presetPanel.append(row);$('canvasSave').after(presetPanel);

 function snapshot(){return {resolution,items:structuredClone(items),locked:[...locked],fallback:[1,2].map(n=>$('fallback'+n).value).filter(Boolean),options:window.releaseFeatures?.settings()||{}};}
 function restore(value){
  resolution=value?.resolution||null;
  const valid=i=>i&&['main','video','chat'].includes(i.kind)&&['x','y','width','height'].every(k=>Number.isFinite(i[k])&&i[k]>=0&&i[k]<=1)&&i.width>=.04&&i.height>=.04;
  const list=Array.isArray(value?.items)?value.items.filter(valid):[];
  items=[{...defaultMain(),...list.find(i=>i.kind==='main')}];const used=new Set(['main']);
  for(const i of list){if(i.kind==='main'||used.has(i.id))continue;if(i.kind==='video'&&(!connected||!view.requests.some(r=>r.owner===view.me.id&&r.peer===i.publisher&&r.kind==='video'&&r.status==='approved')))continue;if(i.kind==='chat'&&!['twitch','youtube','combined'].includes(i.source))continue;items.push({...i});used.add(i.id);}
  locked=new Set(Array.isArray(value?.locked)?value.locked.filter(id=>used.has(id)):[]);selection='main';
  for(const n of [1,2])$('fallback'+n).value=value?.fallback?.[n-1]||'';
  if($('fallbackTimeout'))$('fallbackTimeout').value=value?.options?.fallbackTimeoutMinutes||0;
  if($('povLabels'))$('povLabels').checked=value?.options?.povLabels!==false;
  changed();paint();availability();
 }
 function toggleLock(){const i=chosen();if(!i)return;locked.has(i.id)?locked.delete(i.id):locked.add(i.id);changed();paint();}
 window.streamCanvas={resolution:value=>{resolution=value;changed();paint();},preview:data=>{obsImage=data||'';const tile=root.querySelector('[data-item="main"]');if(tile){tile.querySelector('.obs-preview-image')?.remove();previewImage(tile);}},snapshot,restore,toggleLock,selected:()=>({id:selection,locked:locked.has(selection)}),load,save,availability,reset:()=>{layoutDirty=false;root.style.aspectRatio='16/9';load({});},chats:(m,s)=>{messages=m;chatStatus=s;if(!moving){for(const el of root.querySelectorAll('.canvas-chat-preview')){const item=items.find(i=>i.id===el.parentElement.dataset.item);el.textContent=messages.filter(m=>item.source==='combined'||item.source===m.platform).slice(-4).map(m=>m.author+': '+m.text).join('\n')||'Chat messages appear here';}}}};
 load({});setInterval(upload,3000);
})();
