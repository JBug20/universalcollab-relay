import {PortalError} from './portal-store.mjs';
export function validateBox(p,required=true){
 const result={};for(const k of ['x','y','width','height']){
  if(!required&&p[k]===undefined)continue;
  const n=p[k];if(!Number.isFinite(n)||n<((k==='width'||k==='height')?.04:0)||n>1)throw new PortalError('Keep each item inside the canvas, with size 4–100%.');result[k]=n;
 }return result;
}
export function boxPixels(width,height,p={x:0,y:0,width:1,height:1}){
 const even=n=>Math.floor(n/2)*2,w=Math.max(2,even(width*p.width)),h=Math.max(2,even(height*p.height));
 return {width:w,height:h,x:even((width-w)*p.x),y:even((height-h)*p.y)};
}
// Scale a completed YUV frame once when a static chat/fallback image changes.
export function scaleFrame(frame,sw,sh,dw,dh){
 if(sw===dw&&sh===dh)return frame;
 const out=Buffer.alloc(dw*dh*3/2);
 for(let plane=0;plane<3;plane++){
  const div=plane?2:1,w=sw/div,h=sh/div,W=dw/div,H=dh/div;
  const src=plane?sw*sh+(plane-1)*sw*sh/4:0,dst=plane?dw*dh+(plane-1)*dw*dh/4:0;
  for(let y=0;y<H;y++){const sy=Math.floor(y*h/H)*w;for(let x=0;x<W;x++)out[dst+y*W+x]=frame[src+sy+Math.floor(x*w/W)];}
 }return out;
}
export function acceptChatFrames(store,id,body){
 if(store.features().chatOverlays===false)throw new PortalError('Chat overlays disabled.',403);
 if(!Array.isArray(body.frames)||body.frames.length>3)throw new PortalError('Invalid chat frames.');
 const allowed=new Set((store.get(id).settings.chatOverlays||[]).map(x=>x.source));
 const next=new Map();
 for(const f of body.frames){
  if(!allowed.has(f.source)||next.has(f.source))throw new PortalError('Save this chat tile first.');
  if(!Number.isInteger(f.width)||!Number.isInteger(f.height)||f.width<2||f.height<2||f.width>512||f.height>768||f.width%2||f.height%2||typeof f.data!=='string')throw new PortalError('Invalid chat frame size.');
  const frame=Buffer.from(f.data,'base64');if(frame.length!==f.width*f.height*3/2)throw new PortalError('Incomplete chat frame.');
  next.set(f.source,{frame,width:f.width,height:f.height,at:Date.now()});
 }
 store.chatFrames.set(id,next);
 return {ok:true};
}
