import {randomBytes} from 'node:crypto';

// Existing credentials are never rotated merely by restarting the service.
export function prepareConfig(config,{trio=false}={}){
  if(trio){
    if((config.multi?.publishers?.length||0)>3)throw Error('Select three publishers before automatic trio migration.');
    config.trioSetupVersion=1;
    config.multi??={};config.multi.enabled=true;config.multi.maxSessions=3;
    config.multi.collab??={};config.multi.collab.enabled=true;
    config.fps=60;
  }
  config.fps??=60;
  if(config.multi?.enabled===true){
    const m=config.multi;
    config.controls??={enabled:false,port:8080,bind:'0.0.0.0',publicOrigin:'',tls:{enabled:false,certFile:'control.crt',keyFile:'control.key'}};
    m.maxSessions??=3;m.collab??={};m.collab.enabled??=true;m.collab.recoverAfterSeconds??=3;
    m.publishers??=[];
    if(!Array.isArray(m.publishers))throw Error('Invalid publishers');
    if(!m.publishers.length && /^[A-Za-z0-9_-]{24,64}$/.test(config.publishPassword||'') && !config.publishPassword.startsWith('CHANGE_')){
      m.publishers.push({id:'streamer1',password:config.publishPassword,collabGroup:'trio'});
    }
    // Preserve named users in existing configurations. Fill up to three slots.
    let next=1;
    while(m.publishers.length<3){
      while(m.publishers.some(p=>p.id===`streamer${next}`))next++;
      m.publishers.push({id:`streamer${next++}`,password:'',collabGroup:m.publishers[0]?.collabGroup||'trio'});
    }
    for(const p of m.publishers){
      if(p.inputKey===undefined||p.inputKey==='')p.inputKey=randomBytes(24).toString('base64url');
      p.destinationStreamKey??='';
      p.destinationBaseUrl??=config.destinationBaseUrl||'';
      if(p.password===undefined||p.password===''||p.password?.startsWith('CHANGE_'))p.password=randomBytes(24).toString('base64url');
      if(p.controlToken===undefined||p.controlToken===''||p.controlToken?.startsWith('CHANGE_'))p.controlToken=randomBytes(32).toString('base64url');
      if(trio)p.collabGroup='trio';
    }
    m.pictureInPicture??={enabled:false,widthPercent:25,marginPercent:2};
    for(let i=0;i<m.publishers.length;i++){
      const owner=m.publishers[i];
      const peers=[...m.publishers.slice(i+1),...m.publishers.slice(0,i)].filter(p=>owner.collabGroup&&p.collabGroup===owner.collabGroup).slice(0,2);
      owner.overlays??=peers.map((p,index)=>({publisher:p.id,corner:index===0?'top-right':'bottom-right'}));
    }
    delete m.allowedDestinationHosts;
    delete config.publishPassword;delete config.destinationBaseUrl;
    delete config.width;delete config.height;delete m.autoResolution;
  }else if(typeof config.publishPassword==='string'&&config.publishPassword.startsWith('CHANGE_'))config.publishPassword=randomBytes(24).toString('base64url');
  return config;
}
