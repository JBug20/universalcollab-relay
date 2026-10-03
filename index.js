// Stream Relay 0.3: accounts and collaboration are managed in the app.
let startupStep='loading configuration';
(async()=>{
 console.log('UNIVERSALCOLLAB 1.0.0-rc.5 - release candidate — studio, collaboration and recovery');
 const fs=await import('node:fs');
 const c=JSON.parse(fs.readFileSync('config.json','utf8'));
 c.controls??={};c.controls.enabled=true;c.controls.port=Number(process.env.CONTROL_PORT||c.controls.port||25560);c.controls.bind??='0.0.0.0';c.controls.allowRemoteHttp=true;c.controls.publicOrigin??='';c.controls.tls??={enabled:false};
 c.multi??={};c.multi.enabled=true;c.multi.publishers??=[];
 const {hostFeatures}=await import('./src/host-features.mjs');
 try{hostFeatures(c);}catch(e){e.safe=true;throw e;}
 c.hostFeatures={registration:true,pictureInPicture:true,collaboratorFallback:true,chatOverlays:true,multipleDestinations:true,recording:false,...c.hostFeatures};
 c.recordings={maxStorageMB:1024,minFreeMB:256,...c.recordings};
 fs.writeFileSync('config.json',JSON.stringify(c,null,2)+'\n',{mode:0o600});
 startupStep='checking MediaMTX installation';
 if(!fs.existsSync('vendor/mediamtx')){const {install}=await import('./install.mjs');await install();}
 startupStep='loading relay modules';
 const {run}=await import('./src/multi-controller.mjs');
 startupStep='initializing relay';await run();
})().catch(error=>{
 console.error('Startup failed during '+startupStep+'.');
 if(error?.safe===true)console.error(error.message);
 else{
  const codes={EACCES:'Permission denied while opening a file or port.',EPERM:'Host denied a required operation.',EADDRINUSE:'A required listening port is already in use.',ENOENT:'A required file or executable is missing.',ENOSPC:'The server disk is full.',ERR_MODULE_NOT_FOUND:'A required source module is missing. Replace the entire src folder.'};
  console.error(codes[error?.code]||(error?.name==='SyntaxError'?'A JSON or JavaScript file has invalid syntax.':'Unexpected initialization error.'));
  // Only allow a source filename and line numbers through, never a raw stack or value.
  const frame=String(error?.stack||'').match(/src\/([a-zA-Z0-9_-]+\.mjs:\d+:\d+)/);
  if(frame)console.error('Source: src/'+frame[1]);
 }
 process.exit(1);
});
