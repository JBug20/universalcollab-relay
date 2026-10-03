import json,os,subprocess,tempfile,shutil,time,urllib.request,socket
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
def port():
 with socket.socket() as s:s.bind(('127.0.0.1',0));return s.getsockname()[1]
with tempfile.TemporaryDirectory(prefix='relay-pref-startup-') as tmp:
 w=Path(tmp)
 for n in ['index.js','install.mjs','fallback.png']:shutil.copy(ROOT/n,w/n)
 shutil.copytree(ROOT/'src',w/'src');(w/'vendor').mkdir();shutil.copy(ROOT.parent/'relay-025/vendor/mediamtx',w/'vendor/mediamtx');(w/'data').mkdir()
 c=json.loads((ROOT/'config.json').read_text());c.update(port=port(),mode='test');control=port();c['controls'].update(port=control,publicOrigin='',bind='127.0.0.1')
 c['multi']['publishers']=[dict(id='streamer1',password='a'*32,inputKey='b'*32,controlToken='c'*32,destinationBaseUrl='rtmp://live.restream.io/live',destinationStreamKey='')]
 (w/'config.json').write_text(json.dumps(c));old={'blocked':[],'active':{},'held':[],'blockedOwners':{},'preferences':[{'id':'streamer1','pip':False,'collab':False},{'id':'old_missing_user','pip':True}]};(w/'data/multi-state.json').write_text(json.dumps(old))
 for attempt in range(2):
  log=(w/f'log{attempt}').open('w');p=subprocess.Popen(['node','index.js'],cwd=w,stdin=subprocess.PIPE,stdout=log,stderr=subprocess.STDOUT,env={k:v for k,v in os.environ.items() if k not in ['SERVER_PORT','CONTROL_PORT','RELAY_MODE','STOP_AFTER_MINUTES']})
  try:
   for _ in range(100):
    if 'CONTROLS READY' in (w/f'log{attempt}').read_text():break
    assert p.poll() is None,(w/f'log{attempt}').read_text();time.sleep(.1)
   request=urllib.request.Request(f'http://127.0.0.1:{control}/api/status',headers={'Authorization':'Bearer streamer1:'+('c'*32)})
   with urllib.request.urlopen(request,timeout=3) as response:status=json.load(response)
   assert status['pictureInPicture'] is False and status['collabFallback'] is False
   assert json.loads((w/'data/multi-state.json.before-0.3.1').read_text())==old
   accounts=json.loads((w/'data/accounts.json').read_text());assert accounts['users'][0]['controlToken']=='c'*32
   p.stdin.write(b'stop\n');p.stdin.flush();assert p.wait(timeout=10)==0
  finally:
   if p.poll() is None:p.terminate();p.wait(timeout=10)
   log.close()
 print('PASS actual relay starts with stale preferences, preserves account token and valid toggles, and starts again successfully.')
