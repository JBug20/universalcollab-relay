import {povLabel} from './pov-label.mjs';
import {OutputHub} from './output-hub.mjs';
import {spawn} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import {boxPixels,scaleFrame} from './stream-layout.mjs';
import {geometry,composite} from './pip.mjs';

// One output encoder for the lifetime of a broadcast, independent of publishers.
export class Session {
  constructor({config, fallback, inputUrl, destination, log, failed, overlayPool=null, overlayOptions=null,destinations=null,recording=null}) {
    this.hub=config.mode==='live'?new OutputHub(destinations||[{id:'default',name:'Destination',url:destination}],recording):null;this.recording=recording;this.overlayPool=overlayPool;this.overlayOptions=overlayOptions;this.overlays=new Map();
    this.c=config; this.fallback=fallback; this.inputUrl=inputUrl;
    this.log=log; this.failed=failed; this.destination=destination;
    this.labelCache=new Map();this.povName='';this.labelsEnabled=true;this.outputFps=0;this.mainBox={x:0,y:0,width:1,height:1};this.chatItems=[];this.chatCache=new Map();
    this.vBytes=config.width*config.height*3/2;
    this.aBytes=48000*4/config.fps;
    this.silence=Buffer.alloc(this.aBytes);
    this.frame=fallback; this.audio=Buffer.alloc(0); this.lastFrame=0;
    this.closed=false; this.live=false; this.wantInput=false;
    this.decoder=null; this.nextDecode=0; this.ticks=0;
    this.startOutput();
  }
  child(args,stdio) {
    const p=spawn('ffmpeg',['-hide_banner','-nostdin','-loglevel','error',...args],{stdio});
    p.on('error',()=>this.log('FFmpeg process could not start.'));
    // Never expose raw FFmpeg errors: they may contain destination keys.
    p.stderr?.resume(); return p;
  }
  startOutput() {
    const c=this.c;
    // Raw PCM's format/rate/channels are already explicit. FFmpeg 7's stream-info
    // probe waits for a 16384-byte packet at 48 kHz stereo. At 60 fps our bounded
    // paired feeds can stop at 16000 audio bytes while video input is blocked
    // during initialization. Skip only this unnecessary raw-audio probe so
    // input threads can start draining; do not enlarge queues or insert samples.
    const target=c.mode==='test'?['-f','null','-']:['-f','mpegts','-mpegts_flags','+resend_headers','pipe:4'];
    this.encoder=this.child([
      '-probesize','32','-analyzeduration','0','-thread_queue_size','64',
      '-f','rawvideo','-pixel_format','yuv420p','-video_size',`${c.width}x${c.height}`,'-framerate',String(c.fps),'-i','pipe:0',
      '-probesize','32','-analyzeduration','0','-thread_queue_size','64',
      '-f','s16le','-ar','48000','-ac','2','-nofind_stream_info','-i','pipe:3',
      '-map','0:v:0','-map','1:a:0','-c:v','libx264','-preset','ultrafast','-tune','zerolatency','-threads','2',
      '-b:v',`${c.videoBitrateKbps}k`,'-maxrate',`${c.videoBitrateKbps}k`,'-bufsize',`${c.videoBitrateKbps*2}k`,
      '-g',String(c.fps*2),'-keyint_min',String(c.fps*2),'-sc_threshold','0',
      '-pix_fmt','yuv420p','-c:a','aac','-b:a','160k','-ar','48000',...target
    ],['pipe','ignore','pipe','pipe',...(this.hub?['pipe']:[])]);
    if(this.hub)this.encoder.stdio[4].on('data',chunk=>this.hub.write(chunk));
    this.encoder.stdin.on('error',()=>{}); this.encoder.stdio[3].on('error',()=>{});
    this.encoder.on('close',()=>{if(!this.closed)this.failed('Outgoing encoder stopped. Check destination/key or connectivity.');});
    this.epoch=performance.now();this.lastWrite=this.epoch;
    this.reportAt=this.epoch;this.reportTicks=0;
    this.pump();
  }
  setOverlays(items){
    if(this.closed||!this.overlayPool)return;
    const keep=new Set(items.map(item=>item.id));
    for(const [id,current] of this.overlays)if(!keep.has(id)){
      this.overlayPool.release(current.ref);this.overlays.delete(id);
    }
    for(const item of items){
      const current=this.overlays.get(item.id);
      const box=geometry(this.c.width,this.c.height,this.overlayOptions,item.corner,item);
      // Position-only edits reuse the decoder and its frame, avoiding a blink.
      if(current?.url===item.inputUrl&&current.box.width===box.width&&current.box.height===box.height){current.box=box;current.corner=item.corner;current.z=item.z||0;continue;}
      if(current)this.overlayPool.release(current.ref);
      const ref=this.overlayPool.acquire(item.inputUrl,box.width,box.height,this.c.fps);
      this.overlays.set(item.id,{id:item.id,ref,box,url:item.inputUrl,corner:item.corner,z:item.z||0});
    }
  }
  setMainBox(box={x:0,y:0,width:1,height:1}){
    if(JSON.stringify(box)===JSON.stringify(this.mainBox))return;
    this.mainBox=box;const b=boxPixels(this.c.width,this.c.height,box);
    const blank=Buffer.alloc(this.vBytes,128);blank.fill(16,0,this.c.width*this.c.height);
    this.layoutFallback=composite(blank,this.c.width,this.c.height,[{...b,frame:scaleFrame(this.fallback,this.c.width,this.c.height,b.width,b.height)}]);
    this.lastFrame=0;this.audio=Buffer.alloc(0);this.stopDecoder();
  }
  setChatFrames(items,frames){
    const keep=new Set();this.chatItems=[];
    for(const tile of items){
      if(tile.visible===false)continue;
      const f=frames?.get(tile.source);if(!f||Date.now()-f.at>15000)continue;
      const b=boxPixels(this.c.width,this.c.height,tile);keep.add(tile.source);
      let cached=this.chatCache.get(tile.source);
      if(!cached||cached.original!==f||cached.width!==b.width||cached.height!==b.height){cached={original:f,width:b.width,height:b.height,frame:scaleFrame(f.frame,f.width,f.height,b.width,b.height)};this.chatCache.set(tile.source,cached);}
      this.chatItems.push({...b,frame:cached.frame,z:tile.z||0,at:f.at});
    }
    for(const key of this.chatCache.keys())if(!keep.has(key))this.chatCache.delete(key);
  }
  picture(base,now){
    const overlays=[];
    const box=boxPixels(this.c.width,this.c.height,this.mainBox);
    // The decoder produces a padded full-size frame. Extract its main rectangle
    // only when stacking or hiding it; the default path stays allocation-free.
    if(this.mainBox.visible===false||this.mainBox.z>=0){
      if(this.mainBox.visible!==false){const frame=Buffer.alloc(box.width*box.height*3/2);for(let plane=0;plane<3;plane++){const d=plane?2:1,sw=this.c.width/d,sh=this.c.height/d,w=box.width/d,h=box.height/d,x=box.x/d,y=box.y/d;const src=plane?this.c.width*this.c.height+(plane-1)*this.c.width*this.c.height/4:0,dst=plane?box.width*box.height+(plane-1)*box.width*box.height/4:0;for(let row=0;row<h;row++)base.copy(frame,dst+row*w,src+(y+row)*sw+x,src+(y+row)*sw+x+w);}overlays.push({...box,frame,z:this.mainBox.z});}
      base=Buffer.alloc(this.vBytes,128);base.fill(16,0,this.c.width*this.c.height);
    }
    const label=(id,b)=>{const k=id+':'+b.width;let l=this.labelCache.get(k);if(!l){l=povLabel(id,b.width,Math.max(1,this.c.width/640));if(this.labelCache.size>64)this.labelCache.clear();this.labelCache.set(k,l);}return l;};
    if(this.mainBox.visible!==false&&this.labelsEnabled&&this.povName&&this.live){const b=boxPixels(this.c.width,this.c.height,this.mainBox),l=label(this.povName,b);if(l.height<=b.height)overlays.push({...l,x:b.x,y:b.y,z:this.mainBox.z??-1});}
    for(const item of this.overlays.values()){
      const preview=item.ref.entry;
      if(preview.frame&&now-preview.lastFrame<this.c.fallbackAfterSeconds*1000){let frame=preview.frame;if(this.labelsEnabled){const l=label(item.id,item.box);if(l.height<=item.box.height)frame=composite(frame,item.box.width,item.box.height,[{...l,x:0,y:0}]);}overlays.push({...item.box,frame,z:item.z||0});}
    }
    overlays.push(...this.chatItems.filter(x=>Date.now()-x.at<15000));overlays.sort((a,b)=>a.z-b.z);
    return composite(base,this.c.width,this.c.height,overlays);
  }
  stopDecoder() {
    const p=this.decoder;
    if(!p || p.exitCode!==null || p.signalCode!==null || p.relayStopTimer)return;
    p.kill('SIGTERM');
    p.relayStopTimer=setTimeout(()=>{if(p.exitCode===null&&p.signalCode===null)p.kill('SIGKILL');},750);
    p.once('close',()=>clearTimeout(p.relayStopTimer));
  }
  setSource(inputUrl) {
    if(this.closed || this.inputUrl===inputUrl)return;
    this.inputUrl=inputUrl;this.lastFrame=0;this.audio=Buffer.alloc(0);
    this.nextDecode=0;
    this.stopDecoder();
  }
  setAvailable(available) {
    this.wantInput=available;
    if(this.closed)return;
    if(!available) {
      this.lastFrame=0;this.audio=Buffer.alloc(0);
      this.stopDecoder();
    } else if(!this.decoder && performance.now()>=this.nextDecode)this.decode();
  }
  decode() {
    const c=this.c,b=boxPixels(c.width,c.height,this.mainBox);
    const p=this.child(['-threads','2','-filter_threads','2','-rw_timeout','5000000',
      '-probesize','1000000','-analyzeduration','1000000','-i',this.inputUrl,
      '-map','0:v:0','-vf',`scale=${b.width}:${b.height}:force_original_aspect_ratio=decrease,pad=${b.width}:${b.height}:(ow-iw)/2:(oh-ih)/2,pad=${c.width}:${c.height}:${b.x}:${b.y},fps=${c.fps},format=yuv420p`,
      '-threads','2','-f','rawvideo','pipe:1',
      '-map','0:a:0','-ac','2','-ar','48000','-c:a','pcm_s16le','-f','s16le','pipe:3'
    ],['ignore','pipe','pipe','pipe']);
    this.decoder=p;
    const sourceUrl=this.inputUrl;
    let frame=Buffer.allocUnsafe(this.vBytes),used=0;
    p.stdout.on('data',chunk=>{
      if(this.closed || !this.wantInput || this.inputUrl!==sourceUrl)return;
      let offset=0;
      while(offset<chunk.length){
        const n=Math.min(this.vBytes-used,chunk.length-offset);
        chunk.copy(frame,used,offset,offset+n);used+=n;offset+=n;
        if(used===this.vBytes){this.frame=frame;this.lastFrame=performance.now();frame=Buffer.allocUnsafe(this.vBytes);used=0;}
      }
    });
    p.stdio[3].on('data',chunk=>{
      if(this.closed || !this.wantInput || this.inputUrl!==sourceUrl)return;
      this.audio=Buffer.concat([this.audio,chunk]);
      if(this.audio.length>38400)this.audio=Buffer.from(this.audio.subarray(this.audio.length-38400));
    });
    p.on('close',()=>{
      if(this.decoder===p){this.decoder=null;this.lastFrame=0;this.audio=Buffer.alloc(0);this.nextDecode=sourceUrl===this.inputUrl?performance.now()+1000:0;}
    });
  }
  pump() {
    if(this.closed)return;
    const now=performance.now(),due=this.epoch+this.ticks*1000/this.c.fps;
    if(now<due){this.timer=setTimeout(()=>this.pump(),Math.max(1,due-now));return;}
    if(this.encoder.stdin.writableLength>this.vBytes*3 || this.encoder.stdio[3].writableLength>this.aBytes*12){
      if(now-this.lastWrite>15000){this.failed('Outgoing encoder stalled for 15 seconds.');return;}
      this.timer=setTimeout(()=>this.pump(),5);return;
    }
    const fresh=this.lastFrame>0 && now-this.lastFrame<this.c.fallbackAfterSeconds*1000;
    if(fresh!==this.live){this.live=fresh;this.log(fresh?'OBS ACTIVE':'FALLBACK ACTIVE');}
    let sound=this.silence;
    if(this.live && this.audio.length>=this.aBytes){sound=this.audio.subarray(0,this.aBytes);this.audio=this.audio.subarray(this.aBytes);}
    else if(!this.live)this.audio=Buffer.alloc(0);
    this.encoder.stdin.write(this.picture(this.live?this.frame:(this.layoutFallback||this.fallback),now));this.encoder.stdio[3].write(sound);
    this.ticks++;this.lastWrite=now;
    if(now-this.reportAt>=15000){
      this.outputFps=(this.ticks-this.reportTicks)*1000/(now-this.reportAt);this.log(`OUTPUT ${this.outputFps.toFixed(1)} fps; ${this.live?'OBS':'fallback'}`);
      this.reportAt=now;this.reportTicks=this.ticks;
    }
    if(now-due>1000){this.log('Encoder is behind real time; check host CPU allocation.');this.epoch=now-this.ticks*1000/this.c.fps;}
    this.timer=setTimeout(()=>this.pump(),Math.max(1,this.epoch+this.ticks*1000/this.c.fps-performance.now()));
  }
  async close() {
    if(this.closed)return;this.closed=true;clearTimeout(this.timer);
    const previews=[...this.overlays.values()].map(item=>this.overlayPool.release(item.ref));this.overlays.clear();
    const processes=[this.decoder,this.encoder].filter(Boolean);
    await Promise.all(processes.map(p=>new Promise(resolve=>{
      if(p.exitCode!==null || p.signalCode!==null){resolve();return;}
      const force=setTimeout(()=>p.kill('SIGKILL'),2000);
      p.once('close',()=>{clearTimeout(force);resolve();});
      p.kill('SIGTERM');
    })));
    await Promise.all(previews);await this.hub?.close();await this.recording?.close();
    this.decoder=null;this.encoder=null;this.audio=Buffer.alloc(0);this.frame=this.fallback;
  }
}
