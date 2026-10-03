import {performance} from 'node:perf_hooks';
import {setTimeout as delay} from 'node:timers/promises';

// Keep one publisher reserved while waiting for complete track metadata.
// Each probe receives the remaining budget; cancellation never starts another.
export async function detectTracks({probe,signal,onAttempt=()=>{},budgetMs=30000,
  now=()=>performance.now(),pause=ms=>delay(ms,undefined,{signal})}){
  const deadline=now()+budgetMs;
  let attempt=0;
  while(now()<deadline){
    signal?.throwIfAborted();
    const timeoutMs=Math.max(1,Math.min(20000,Math.floor(deadline-now())));
    let tracks;
    try{tracks=await probe(timeoutMs);}
    catch(error){
      signal?.throwIfAborted();
      if(['ENOENT','EACCES','ERR_CHILD_PROCESS_STDIO_MAXBUFFER'].includes(error?.code))throw error;
      onAttempt({attempt:++attempt,probeFailed:true});
      if(now()>=deadline)throw error;
      await pause(Math.min(500,deadline-now()));continue;
    }
    signal?.throwIfAborted();
    if(!Array.isArray(tracks))throw Error('Invalid detected tracks');
    const video=tracks.find(t=>t.codec_type==='video');
    const audio=tracks.some(t=>t.codec_type==='audio');
    const complete=audio&&Number.isSafeInteger(video?.width)&&video.width>0&&Number.isSafeInteger(video?.height)&&video.height>0;
    onAttempt({attempt:++attempt,video:Boolean(video),audio,width:Number.isSafeInteger(video?.width)?video.width:0,height:Number.isSafeInteger(video?.height)?video.height:0,complete:Boolean(complete)});
    if(now()<=deadline&&complete)return {tracks,video};
    if(now()<deadline)await pause(Math.min(500,deadline-now()));
  }
  throw Error('Video and audio with valid dimensions were not detected within 30 seconds');
}
