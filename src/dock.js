'use strict';
const $=id=>document.getElementById(id);
let credential='',pollTimer,busy=false,inFlight=false,generation=0,current=null;
function message(text){$('notice').textContent=text;}
function buttons(disabled){for(const id of ['end','allow','pip','collab'])$(id).disabled=disabled;}
async function api(route,method='GET'){
  const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),12000);
  try{
    const response=await fetch(route,{method,headers:{Authorization:'Bearer '+credential},credentials:'omit',cache:'no-store',signal:abort.signal});
    const data=await response.json();if(!response.ok)throw Error(data.error||'Control request failed.');return data;
  }finally{clearTimeout(timer);}
}
function render(data){
  current=data;
  $('pip').textContent='Picture-in-picture: '+(data.pictureInPicture?'ON — click to disable':'OFF — click to enable');
  $('collab').textContent='Collab fallback: '+(data.collabFallback?'ON — click to disable':'OFF — click to enable');
  $('pip').disabled=busy;$('collab').disabled=busy;
  $('who').textContent=data.id;
  const names={held:'Broadcast ended',ending:'Ending broadcast…',starting:'Starting broadcast…',live:'You are live',collab:'Showing a collaborator',fallback:'Reconnect screen is live',ready:'Ready for OBS',waiting:'Waiting to reconnect'};
  $('state').textContent=names[data.state]||'Checking broadcast';
  $('badge').textContent=data.mode==='test'?'Test mode':data.held?'Stopped':data.broadcast?'Broadcasting':'Standby';
  $('badge').className='badge '+(data.held?'stopped':data.broadcast?'live':'');
  $('detail').textContent=data.held?'Stop Streaming in OBS. After 30 seconds without reconnect attempts, your next stream is allowed automatically.':data.state==='starting'?'Checking your incoming video and audio.':data.broadcast?(data.source==='primary'?'Your own feed':data.source==='collab'?'Collaborator feed': 'Fallback screen')+' · '+data.width+' × '+data.height+' · '+data.fps+' FPS': 'Start Streaming in OBS when you are ready.';
  if(data.mode==='test')$('detail').textContent+=' Test mode sends nothing to your platform.';
  $('timer').textContent=data.remainingSeconds===null?'Manual end':Math.ceil(data.remainingSeconds/60)+' min remaining';
  $('end').disabled=busy||data.state==='ending'||data.held;
  $('allow').disabled=busy||data.broadcast||data.state==='starting'||data.state==='ending';
}
async function refresh(){
  if(!credential||inFlight||busy)return;
  const g=generation;inFlight=true;
  try{const data=await api('/api/status');if(g!==generation)return;render(data);message('');}
  catch(error){if(g===generation){buttons(true);message('Status unavailable. '+error.message+' No stop has been confirmed.');}}
  finally{inFlight=false;}
}
$('login').addEventListener('submit',async event=>{
  event.preventDefault();credential=$('identity').value.trim()+':'+$('token').value.trim();$('signin').disabled=true;
  try{const data=await api('/api/status');$('token').value='';$('login').hidden=true;$('panel').hidden=false;render(data);message('');clearInterval(pollTimer);pollTimer=setInterval(refresh,3000);}
  catch(error){credential='';message(error.message);}
  finally{$('signin').disabled=false;}
});
async function act(name){
  if(busy||!credential)return;
  busy=true;generation++;buttons(true);message(name==='end'?'Ending your broadcast…':name==='allow'?'Allowing your next broadcast…':'Saving your setting…');
  try{const data=await api('/api/'+name,'POST');busy=false;render(data);message(name==='end'?'Broadcast ended. Click Stop Streaming in OBS; your next stream will unlock automatically.':name==='allow'?'Your next broadcast is allowed. Start Streaming in OBS.':'Setting saved for your broadcast.');}
  catch(error){busy=false;buttons(true);message('Action not confirmed. '+error.message+' Check status before assuming it succeeded.');}
}
$('pip').addEventListener('click',()=>current&&act(current.pictureInPicture?'pip-off':'pip-on'));
$('collab').addEventListener('click',()=>current&&act(current.collabFallback?'collab-off':'collab-on'));
$('refresh').addEventListener('click',refresh);
$('end').addEventListener('click',()=>act('end'));
$('allow').addEventListener('click',()=>act('allow'));
$('logout').addEventListener('click',()=>{generation++;credential='';clearInterval(pollTimer);$('panel').hidden=true;$('login').hidden=false;message('Signed out. Signing out does not end a broadcast.');});
(async()=>{
  try{const response=await fetch('/dock-config',{cache:'no-store'});const config=await response.json();
    if(location.origin!==config.origin)throw Error('Open the configured control address.');
    if(location.protocol!=='https:'&&config.allowRemoteHttp!==true&&!['127.0.0.1','localhost','[::1]'].includes(location.hostname))throw Error('Use HTTPS for remote controls.');
    $('login').hidden=false;message('Sign in to control only your own broadcast.');
  }catch(error){message('Controls unavailable. '+error.message);}
})();
