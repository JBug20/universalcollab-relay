import {spawn} from 'node:child_process';
import {performance} from 'node:perf_hooks';

export const corners=['top-left','top-right','bottom-left','bottom-right'];
export function validatePip(m){
  const o=m.pictureInPicture??{enabled:false,widthPercent:25,marginPercent:2};
  o.enabled??=false;o.widthPercent??=25;o.marginPercent??=2;
  if(typeof o.enabled!=='boolean'||!Number.isFinite(o.widthPercent)||o.widthPercent<10||o.widthPercent>40||!Number.isFinite(o.marginPercent)||o.marginPercent<0||o.marginPercent>10)throw Error('pictureInPicture requires enabled true/false, widthPercent 10-40 and marginPercent 0-10.');
  const users=new Map(m.publishers.map(p=>[p.id,p]));
  for(const p of m.publishers){
    if(!Array.isArray(p.overlays??[]))throw Error('Overlays must be an array.');
    const ids=new Set(),positions=new Set();
    for(const overlay of p.overlays||[]){
      const peer=users.get(overlay?.publisher);
      if(!peer||peer.id===p.id||!corners.includes(overlay.corner)||ids.has(peer.id))throw Error('Overlay publishers must be distinct other publisher IDs, with different valid corners.');
      if(o.enabled&&(!p.collabGroup||peer.collabGroup!==p.collabGroup))throw Error('Overlay publishers must share the same nonempty collabGroup.');
      ids.add(peer.id);positions.add(overlay.corner);
    }
  }
  return o;
}
export function geometry(width,height,options,corner,position){
  if(!corners.includes(corner))throw Error('Invalid overlay corner');
  const even=n=>Math.floor(n/2)*2;
  const w=Math.max(2,even(width*(position?.width??options.widthPercent/100))),h=Math.max(2,even(height*(position?.height??options.widthPercent/100)));
  const margin=even(Math.min(width,height)*options.marginPercent/100);
  if(position?.x!==undefined||position?.y!==undefined){
    if(!Number.isFinite(position.x)||!Number.isFinite(position.y)||position.x<0||position.x>1||position.y<0||position.y>1)throw Error('Invalid overlay position');
    return {width:w,height:h,x:even((width-w)*position.x),y:even((height-h)*position.y)};
  }
  return {width:w,height:h,x:corner.endsWith('right')?width-margin-w:margin,y:corner.startsWith('bottom')?height-margin-h:margin};
}
// Copy planar YUV420p without converting or changing the full-size primary.
// Input buffers are immutable completed frames; never modify a shared frame.
export function composite(base,width,height,overlays){
  if(!overlays.length)return base;
  const output=Buffer.from(base);
  for(const item of overlays){
    const {frame,x,y,width:w,height:h}=item;
    if(!frame||frame.length!==w*h*3/2||x<0||y<0||x+w>width||y+h>height||[x,y,w,h].some(v=>!Number.isInteger(v)||v%2))throw Error('Invalid YUV overlay geometry');
    for(let plane=0;plane<3;plane++){
      const divisor=plane===0?1:2,srcW=w/divisor,srcH=h/divisor,dstW=width/divisor;
      const srcOffset=plane===0?0:w*h+(plane-1)*w*h/4;
      const dstOffset=plane===0?0:width*height+(plane-1)*width*height/4;
      for(let row=0;row<srcH;row++)frame.copy(output,dstOffset+(y/divisor+row)*dstW+x/divisor,srcOffset+row*srcW,srcOffset+(row+1)*srcW);
    }
  }
  return output;
}
class Thumbnail {
  constructor(url,width,height,fps){
    Object.assign(this,{url,width,height,fps,refs:0,frame:null,lastFrame:0,closed:false,process:null,retry:null});
    this.start();
  }
  start(){
    if(this.closed)return;
    const p=spawn('ffmpeg',['-hide_banner','-nostdin','-loglevel','error','-threads','1','-filter_threads','1','-rw_timeout','5000000',
      '-probesize','5000000','-analyzeduration','5000000','-i',this.url,'-map','0:v:0','-an',
      '-vf',`scale=${this.width}:${this.height}:force_original_aspect_ratio=decrease,pad=${this.width}:${this.height}:(ow-iw)/2:(oh-ih)/2,fps=${this.fps},format=yuv420p`,
      '-threads','1','-f','rawvideo','pipe:1'],{stdio:['ignore','pipe','pipe']});
    this.process=p;p.stderr.resume();p.on('error',()=>{});
    const bytes=this.width*this.height*3/2;let frame=Buffer.allocUnsafe(bytes),used=0;
    p.stdout.on('data',chunk=>{
      if(this.closed)return;
      let offset=0;
      while(offset<chunk.length){
        const n=Math.min(bytes-used,chunk.length-offset);chunk.copy(frame,used,offset,offset+n);used+=n;offset+=n;
        if(used===bytes){this.frame=frame;this.lastFrame=performance.now();frame=Buffer.allocUnsafe(bytes);used=0;}
      }
    });
    p.on('close',()=>{
      if(this.process===p){this.process=null;this.frame=null;this.lastFrame=0;}
      if(!this.closed)this.retry=setTimeout(()=>this.start(),1500);
    });
  }
  async close(){
    if(this.closed)return;this.closed=true;clearTimeout(this.retry);this.frame=null;this.lastFrame=0;
    const p=this.process;
    if(p&&p.exitCode===null&&p.signalCode===null)await new Promise(resolve=>{
      const force=setTimeout(()=>p.kill('SIGKILL'),750);
      p.once('close',()=>{clearTimeout(force);resolve();});p.kill('SIGTERM');
    });
  }
}
// Identical source/size/fps previews share one decoder across outputs.
export class ThumbnailPool {
  constructor(){this.entries=new Map();this.closing=new Set();}
  acquire(url,width,height,fps){
    const key=JSON.stringify([url,width,height,fps]);
    let entry=this.entries.get(key);
    if(!entry){entry=new Thumbnail(url,width,height,fps);this.entries.set(key,entry);}
    entry.refs++;return {key,entry};
  }
  release(ref){
    const entry=this.entries.get(ref.key);
    if(!entry||entry!==ref.entry)return Promise.resolve();
    if(--entry.refs>0)return Promise.resolve();
    this.entries.delete(ref.key);
    const closing=entry.close();this.closing.add(closing);closing.finally(()=>this.closing.delete(closing));return closing;
  }
  async close(){
    const pending=[...this.closing,...[...this.entries.values()].map(e=>e.close())];this.entries.clear();await Promise.all(pending);
  }
}
