"""Local-only multi-stream integration. No destination outside this machine.
Tests real decoded colors/audio, not just controller messages.
Run: python3 tests/multi.py
"""
import base64, json, os, shutil, socket, subprocess, tempfile, time, urllib.request, array
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]

def freeport():
    with socket.socket() as s:s.bind(('127.0.0.1',0));return s.getsockname()[1]
def wait_for(fn,seconds=20):
    deadline=time.monotonic()+seconds
    while time.monotonic()<deadline:
        if fn():return
        time.sleep(.15)
    raise AssertionError('Timeout')

def main():
    children=[]
    with tempfile.TemporaryDirectory(prefix='relay-multi-test-') as temp:
        w=Path(temp)
        for name in ['index.js','install.mjs','fallback.png']:shutil.copy(ROOT/name,w/name)
        for name in ['src','vendor']:shutil.copytree(ROOT/name,w/name)
        port,target,api=freeport(),freeport(),freeport()
        c=json.loads((ROOT/'config.multi.example.json').read_text());c.update(mode='live',port=port,fps=30,stopAfterMinutes=0)
        c['multi'].update(allowedDestinationHosts=['127.0.0.1'],allowPrivateDestinations=True,maxSessions=2)
        c['multi']['collab'].update(enabled=True,recoverAfterSeconds=1)
        people=[dict(id='alice',password='AlicePrivateTestPassword123456789',collabGroup='duo'),dict(id='bob',password='BobPrivateTestPassword12345678901',collabGroup='duo'),dict(id='charlie',password='CharliePrivateTestPassword1234567',collabGroup='other')]
        for person in people:person['destinationBaseUrl']=f'rtmp://127.0.0.1:{target}/live'
        c['multi']['publishers']=people
        (w/'config.json').write_text(json.dumps(c))
        cfg=dict(logLevel='error',rtsp=False,rtmp=True,rtmpAddress=f'127.0.0.1:{target}',hls=False,webrtc=False,srt=False,moq=False,api=True,apiAddress=f'127.0.0.1:{api}',authInternalUsers=[dict(user='any',ips=['127.0.0.1'],permissions=[dict(action=a) for a in ['publish','read','api']])],paths={'all_others':{}})
        (w/'receiver.json').write_text(json.dumps(cfg))
        receiver=subprocess.Popen([str(w/'vendor/mediamtx'),'receiver.json'],cwd=w,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL);children.append(receiver)
        log=(w/'log').open('w');app=None
        def logs():return (w/'log').read_text()
        def cmd(value):app.stdin.write((value+'\n').encode());app.stdin.flush()
        def start():
            env={k:v for k,v in os.environ.items() if k not in ['SERVER_PORT','RELAY_MODE','STOP_AFTER_MINUTES','PUBLISH_PASSWORD']}
            p=subprocess.Popen(['node','index.js'],cwd=w,env=env,stdin=subprocess.PIPE,stdout=log,stderr=subprocess.STDOUT);children.append(p);return p
        def destination(id):return f'rtmp://127.0.0.1:{target}/live/event_{id}_private'
        def encoded(value):return value if 'unapproved.example' in value else value.rsplit('/',1)[-1]
        def publisher(id,color='red',size='320x180',dest=None,password=None):
            who=next(p for p in people if p['id']==id)
            url=f'rtmp://127.0.0.1:{port}/live/{id}/{password or who["password"]}/{encoded(dest or destination(id))}'
            p=subprocess.Popen(['ffmpeg','-v','error','-re','-f','lavfi','-i',f'color={color}:s={size}:r=30','-f','lavfi','-i',f'sine=frequency={880 if id=="bob" else 440}:sample_rate=48000','-c:v','libx264','-preset','ultrafast','-tune','zerolatency','-threads','1','-g','30','-c:a','aac','-f','flv',url],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL);children.append(p);return p
        def paths():
            try:
                with urllib.request.urlopen(f'http://127.0.0.1:{api}/v3/paths/list',timeout=2) as r:return {p['name']:p for p in json.load(r)['items'] if p.get('online',p.get('ready'))}
            except Exception:return {}
        def snapshot(id):
            p=subprocess.run(['ffmpeg','-v','error','-rw_timeout','5000000','-i',destination(id),'-frames:v','1','-vf','scale=1:1','-pix_fmt','rgb24','-f','rawvideo','pipe:1'],capture_output=True,timeout=12,check=True)
            return tuple(p.stdout[:3])
        def frequency(id):
            p=subprocess.run(['ffmpeg','-v','error','-rw_timeout','5000000','-i',destination(id),'-t','1','-vn','-ac','1','-ar','8000','-f','s16le','pipe:1'],capture_output=True,timeout=12,check=True)
            samples=array.array('h');samples.frombytes(p.stdout)
            # Tone begins after decoder priming; analyze final half-second.
            samples=samples[-4000:]
            assert max(abs(v) for v in samples)>300
            return sum(a<=0<b for a,b in zip(samples,samples[1:]))*8000/len(samples)
        def red(v):return v[0]>150 and v[2]<80
        def blue(v):return v[2]>150 and v[0]<80
        try:
            app=start();wait_for(lambda:'RELAY READY' in logs());assert not paths()
            wrong=publisher('alice',password='WrongPrivatePassword123456789');assert wrong.wait(timeout=8)!=0
            bad=publisher('alice',dest='rtmp://unapproved.example/live/key');assert bad.wait(timeout=8)!=0
            a=publisher('alice')
            wait_for(lambda:'[alice] OBS ACTIVE' in logs(),35)
            duplicate=publisher('charlie',dest=destination('alice'));assert duplicate.wait(timeout=8)!=0
            b=publisher('bob',color='blue',size='640x360')
            wait_for(lambda:'[alice] OBS ACTIVE' in logs() and '[bob] OBS ACTIVE' in logs(),35)
            wait_for(lambda:len(paths())==2)
            assert '[alice] BROADCAST STARTED — LIVE; 320x180' in logs(),logs()
            assert '[bob] BROADCAST STARTED — LIVE; 640x360' in logs(),logs()
            assert red(snapshot('alice')) and blue(snapshot('bob'))
            source_a=paths()['live/event_alice_private']['source']['id']
            source_b=paths()['live/event_bob_private']['source']['id']
            print('PASS concurrent destinations, independent auto-detected sizes, actual red/blue output, bad credentials/raw URL key rejected',flush=True)
            third=publisher('charlie');assert third.wait(timeout=8)!=0
            dup=publisher('alice',dest=destination('bob'));assert dup.wait(timeout=8)!=0
            # Neither rejection can replace an existing source/destination.
            assert paths()['live/event_alice_private']['source']['id']==source_a
            print('PASS session limit and destination replacement rejected',flush=True)
            a.terminate();a.wait(timeout=5)
            wait_for(lambda:'[alice] SOURCE collab bob' in logs())
            wait_for(lambda:blue(snapshot('alice')),15)
            assert 850<frequency('alice')<910
            assert paths()['live/event_alice_private']['source']['id']==source_a
            assert blue(snapshot('bob'))
            print('PASS primary disconnect switches actual video and audio to collab peer without restarting either destination',flush=True)
            # Reconnect at a different size; original outgoing canvas stays fixed.
            a=publisher('alice',size='480x270')
            wait_for(lambda:'[alice] SOURCE primary' in logs())
            wait_for(lambda:red(snapshot('alice')),15)
            assert 410<frequency('alice')<470
            probe=subprocess.run(['ffprobe','-v','error','-rw_timeout','5000000','-show_entries','stream=codec_type,width,height','-of','json',destination('alice')],capture_output=True,text=True,timeout=12,check=True)
            tracks=json.loads(probe.stdout)['streams'];video=next(t for t in tracks if t['codec_type']=='video')
            assert (video['width'],video['height'])==(320,180)
            assert any(t['codec_type']=='audio' for t in tracks)
            print('PASS primary recovery and fixed output size across resolution change',flush=True)
            cmd('collab off');wait_for(lambda:'COLLAB off' in logs())
            a.terminate();a.wait(timeout=5);wait_for(lambda:'[alice] SOURCE fallback screen' in logs())
            time.sleep(2);assert not blue(snapshot('alice'))
            assert paths()['live/event_bob_private']['source']['id']==source_b
            cmd('collab on');before=logs().count('[alice] SOURCE collab bob')
            wait_for(lambda:logs().count('[alice] SOURCE collab bob')>before)
            wait_for(lambda:blue(snapshot('alice')),15)
            print('PASS collab disabled gives fallback screen; enabled restores peer',flush=True)
            cmd('end alice');wait_for(lambda:'live/event_alice_private' not in paths())
            assert 'live/event_bob_private' in paths() and b.poll() is None
            cmd('end bob');b.wait(timeout=10);wait_for(lambda:not paths())
            assert app.poll() is None
            print('PASS ending one output leaves other publisher/output running',flush=True)
            cmd('stop');assert app.wait(timeout=10)==0
            # Independent timers and persistence after controller restart.
            c['stopAfterMinutes']=.2;c['autoRearmAfterSeconds']=0
            (w/'config.json').write_text(json.dumps(c));before=logs().count('RELAY READY');app=start();wait_for(lambda:logs().count('RELAY READY')>before)
            blocked=publisher('alice');assert blocked.wait(timeout=8)!=0
            aa=publisher('alice',dest=destination('alice')+'_new')
            wait_for(lambda:logs().count('[alice] BROADCAST STARTED')==2)
            time.sleep(3)
            bb=publisher('bob',color='blue',dest=destination('bob')+'_new')
            wait_for(lambda:logs().count('[bob] BROADCAST STARTED')==2)
            wait_for(lambda:'[alice] BROADCAST ENDED: timer expired' in logs(),20)
            aa.wait(timeout=10)
            assert 'live/event_bob_private_new' in paths()
            wait_for(lambda:'[bob] BROADCAST ENDED: timer expired' in logs(),20);bb.wait(timeout=10)
            wait_for(lambda:not paths());cmd('stop');assert app.wait(timeout=10)==0
            print('PASS separate timers, saved ended-key blocks and new event restart',flush=True)
            for secret in [p['password'] for p in people]+[destination(p['id']) for p in people]:assert secret not in logs()
            print('ALL MULTI-STREAM CHECKS PASSED',flush=True)
        except Exception:
            print(logs());raise
        finally:
            for p in reversed(children):
                if p.poll() is None:p.terminate()
            for p in reversed(children):
                try:p.wait(timeout=5)
                except subprocess.TimeoutExpired:p.kill();p.wait()
            log.close()
if __name__=='__main__':main()
