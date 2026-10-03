import{spawn}from'node:child_process';
// One encoded MPEG-TS feed, independent stream-copy workers. Slow destinations
// restart independently, without blocking the encoder or other destinations.
export class OutputHub{
 constructor(destinations,recording){this.closed=false;this.recording=recording;this.targets=destinations.map(d=>({...d,process:null,state:'connecting',timer:null}));for(const t of this.targets)this.start(t);}
 start(t){if(this.closed)return;t.state='connecting';const p=spawn('ffmpeg',['-hide_banner','-nostdin','-loglevel','error','-probesize','1000000','-analyzeduration','1000000','-f','mpegts','-i','pipe:0','-map','0:v:0','-map','0:a:0','-c','copy','-bsf:a','aac_adtstoasc',...(t.url.startsWith('rtmps:')?['-tls_verify','1']:[]),'-rw_timeout','15000000','-flvflags','no_duration_filesize','-f','flv','-progress','pipe:3',t.url],{stdio:['pipe','ignore','pipe','pipe']});t.process=p;p.stderr.resume();p.stdin.on('error',()=>{});p.on('error',()=>{});p.stdio[3].on('data',()=>{t.state='sending';});p.on('close',()=>{if(t.process!==p)return;t.process=null;if(!this.closed){t.state='reconnecting';t.timer=setTimeout(()=>this.start(t),3000);}});}
 write(chunk){if(this.closed)return;this.recording?.write(chunk);for(const t of this.targets){const p=t.process;if(!p||p.exitCode!==null||p.signalCode!==null||p.stdin.destroyed)continue;if(p.stdin.writableLength>4194304){p.kill('SIGKILL');t.state='reconnecting';}else p.stdin.write(chunk);}}
 status(){return this.targets.map(t=>({id:t.id,name:t.name,state:t.state}));}
 async close(){this.closed=true;await Promise.all(this.targets.map(async t=>{clearTimeout(t.timer);const p=t.process;if(!p||p.exitCode!==null||p.signalCode!==null)return;await new Promise(resolve=>{const timer=setTimeout(()=>p.kill('SIGKILL'),3000);p.once('close',()=>{clearTimeout(timer);resolve();});p.stdin.end();});}));await this.recording?.close();}
}
