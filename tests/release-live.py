"""Real local media + HTTP control tests. Uses only loopback destinations."""
import json,os,subprocess,tempfile,shutil,time,urllib.request,urllib.error
from pathlib import Path
from multi import freeport,wait_for
ROOT=Path(os.environ.get('UC_RELAY_ROOT',Path(__file__).resolve().parents[1]))
children=[]
with tempfile.TemporaryDirectory(prefix='relay-controls-') as tmp:
 w=Path(tmp)
 for n in ['index.js','install.mjs','fallback.png']:shutil.copy(ROOT/n,w/n)
 for n in ['src','vendor']:shutil.copytree(ROOT/n,w/n)
 port,target,api,control=freeport(),freeport(),freeport(),freeport()
 origin=f'http://127.0.0.1:{control}'
 c=json.loads((ROOT/'config.json').read_text());c.update(port=port,mode='live',fps=30,autoRearmAfterSeconds=1)
 c['controls'].update(enabled=True,port=control,bind='127.0.0.1',publicOrigin=origin)
 c['hostFeatures']['recording']=True;c['recordings']={'maxStorageMB':16,'minFreeMB':0};c['multi']['allowPrivateDestinations']=True;c['multi']['pictureInPicture']['enabled']=True
 for i,p in enumerate(c['multi']['publishers'],1):
  p['destinationBaseUrl']=f'rtmp://127.0.0.1:{target}/live';p['destinationStreamKey']=f'event_{i}'
 (w/'config.json').write_text(json.dumps(c))
 cfg=dict(logLevel='error',rtsp=False,rtmp=True,rtmpAddress=f'127.0.0.1:{target}',hls=False,webrtc=False,srt=False,moq=False,api=True,apiAddress=f'127.0.0.1:{api}',authInternalUsers=[dict(user='any',ips=['127.0.0.1'],permissions=[dict(action=a) for a in ['publish','read','api']])],paths={'all_others':{}})
 (w/'receiver.json').write_text(json.dumps(cfg))
 children.append(subprocess.Popen([str(w/'vendor/mediamtx'),'receiver.json'],cwd=w,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL))
 log=(w/'log').open('w');app=None;actual=None
 def logs():return (w/'log').read_text()
 def start():
  env={k:v for k,v in os.environ.items() if k not in ['SERVER_PORT','RELAY_MODE','STOP_AFTER_MINUTES']}
  p=subprocess.Popen(['node','index.js'],cwd=w,env=env,stdin=subprocess.PIPE,stdout=log,stderr=subprocess.STDOUT);children.append(p);return p
 def cmd(v):app.stdin.write((v+'\n').encode());app.stdin.flush()
 def request(i,route='/api/status',method='GET',token=None,extra=None,body=None):
  p=actual['multi']['publishers'][i-1]
  headers={'Authorization':f'Bearer {p["id"]}:{token or p["controlToken"]}','Origin':origin}
  headers.update(extra or {})
  req=urllib.request.Request(origin+route,data=body,method=method,headers=headers)
  try:
   with urllib.request.urlopen(req,timeout=12) as response:return response.status,json.load(response)
  except urllib.error.HTTPError as e:return e.code,json.load(e)
 def status(i):
  code,data=request(i);assert code==200,(code,data);return data
 def action(i,a):
  code,data=request(i,'/api/'+a,'POST');assert code==200,(code,data);return data
 def pub(i,key=None,audio_only=False):
  p=actual['multi']['publishers'][i-1]
  args=['ffmpeg','-v','error','-re']
  if not audio_only:args+=['-f','lavfi','-i',f'color={"red" if i==1 else "blue"}:s=320x180:r=30']
  args+=['-f','lavfi','-i','sine=frequency=440:sample_rate=48000']
  if not audio_only:args+=['-c:v','libx264','-preset','ultrafast','-tune','zerolatency','-threads','1','-g','30']
  route=f'{p["id"]}/{p["inputKey"]}' if key is None else f'{p["id"]}/{p["password"]}/{key}'
  args+=['-c:a','aac','-f','flv',f'rtmp://127.0.0.1:{port}/live/{route}']
  child=subprocess.Popen(args,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL);children.append(child);return child
 def pixel(i,x,y):
  data=subprocess.run(['ffmpeg','-v','error','-threads','1','-rw_timeout','5000000','-i',f'rtmp://127.0.0.1:{target}/live/event_{i}','-frames:v','1','-threads','1','-pix_fmt','rgb24','-f','rawvideo','pipe:1'],capture_output=True,timeout=12,check=True).stdout
  return tuple(data[(y*320+x)*3:(y*320+x)*3+3])
 def red(v):return len(v)==3 and v[0]>150 and v[2]<80
 def blue(v):return len(v)==3 and v[2]>150 and v[0]<80
 def paths():
  try:
   with urllib.request.urlopen(f'http://127.0.0.1:{api}/v3/paths/list',timeout=2) as r:return {p['name']:p['source']['id'] for p in json.load(r)['items'] if p.get('online',p.get('ready'))}
  except Exception:return {}
 def post3(i,route,body):return request(i,'/api/v3/'+route,'POST',extra={'Content-Type':'application/json'},body=json.dumps(body).encode())
 try:
  app=start();wait_for(lambda:'CONTROLS READY' in logs())
  join=json.loads((w/'data/server-access.json').read_text())['joinPassword']
  actual={'multi':{'publishers':[]}}
  for i,name in enumerate(['alice','bob'],1):
   req=urllib.request.Request(origin+'/api/v3/register',data=json.dumps({'username':name,'password':join}).encode(),headers={'Origin':origin,'Content-Type':'application/json'})
   with urllib.request.urlopen(req,timeout=10) as r:login=json.load(r)
   actual['multi']['publishers'].append({'id':name,'controlToken':login['token']})
   assert post3(i,'destination',{'url':f'rtmp://127.0.0.1:{target}/live','key':f'event_{i}'})[0]==200
   code,secrets=request(i,'/api/v3/secrets');assert code==200
   actual['multi']['publishers'][i-1]['inputKey']=secrets['obsKey']
  assert post3(1,'production',{'title':'Recorded test stream','record':True,'destinations':[{'id':'one','name':'First','url':f'rtmp://127.0.0.1:{target}/live','key':'event_1'},{'id':'two','name':'Second','url':f'rtmp://127.0.0.1:{target}/live','key':'event_extra'},{'id':'bad','name':'Unavailable','url':f'rtmp://127.0.0.1:{freeport()}/live','key':'unused'}]})[0]==200
  a,b=pub(1),pub(2);wait_for(lambda:len(paths())==3,65)
  wait_for(lambda:red(pixel('extra',150,90)),25)
  assert len(status(1)['outputs'])==3
  print('PASS two simultaneous destinations plus one failing target; healthy streams remain live.',flush=True)
  before=paths();wait_for(lambda:red(pixel(1,275,20)),20)
  assert post3(1,'settings',{'overlays':[{'publisher':'bob','corner':'top-right'}],'fallback':['bob']})[0]==400
  assert post3(1,'request',{'peer':'bob','kind':'video'})[0]==200
  assert post3(1,'request',{'peer':'bob','kind':'fallback'})[0]==200
  code,data=request(2,'/api/v3/view');assert code==200
  for r in data['requests']:assert post3(2,'respond',{'id':r['id'],'decision':'approve'})[0]==200
  assert post3(1,'settings',{'overlays':[{'publisher':'bob','corner':'top-right'}],'fallback':['bob']})[0]==200
  wait_for(lambda:blue(pixel(1,275,20)),25);assert paths()==before
  print('PASS app registration and destination setup without restart; approval gates actual PiP pixels.',flush=True)
  # Resize live PiP and main, then verify a public chat frame in the encoded output.
  import base64
  canvas={'overlays':[{'publisher':'bob','corner':'top-right','x':1,'y':0,'width':.5,'height':.5,'z':0}], 'main':{'x':0,'y':1,'width':.5,'height':.5},'chatOverlays':[{'source':'combined','x':0,'y':0,'width':.2,'height':.2,'z':1}],'fallback':['bob']}
  assert post3(1,'settings',canvas)[0]==200
  wait_for(lambda:blue(pixel(1,240,20)),25)
  wait_for(lambda:red(pixel(1,80,140)),25)
  frame={'source':'combined','width':4,'height':4,'data':base64.b64encode(bytes([220]*16+[128]*8)).decode()}
  assert post3(1,'chat-frame',{'frames':[frame]})[0]==200
  wait_for(lambda:all(v>190 for v in pixel(1,10,10)),12)
  assert post3(1,'chat-frame',{'frames':[]})[0]==200
  wait_for(lambda:all(v<30 for v in pixel(1,10,10)),12)
  assert paths()==before
  assert post3(1,'settings',{'main':{'x':0,'y':0,'width':1,'height':1},'overlays':[{'publisher':'bob','corner':'top-right'}],'chatOverlays':[],'fallback':['bob']})[0]==200
  wait_for(lambda:red(pixel(1,150,90)),25)
  print('PASS resized main/PiP and chat-frame pixels in real outgoing stream; same outgoing RTMP connection.',flush=True)
  action(1,'force-fallback');wait_for(lambda:status(1)['forcedFallback'],10)
  wait_for(lambda:blue(pixel(1,150,90)),20);assert a.poll() is None and paths()==before
  assert status(1)['fallbackRemainingSeconds'] is None
  action(1,'restore-primary');wait_for(lambda:red(pixel(1,150,90)),20)
  print('PASS manual fallback and restore keep primary and outgoing connections alive.',flush=True)
  a.terminate();a.wait(timeout=8);wait_for(lambda:status(1)['state']=='collab',20)
  wait_for(lambda:blue(pixel(1,150,90)),20)
  fallback=next(r for r in data['requests'] if r['kind']=='fallback')
  assert post3(2,'respond',{'id':fallback['id'],'decision':'revoke'})[0]==200
  wait_for(lambda:status(1)['state']=='fallback',15)
  assert paths()==before and b.poll() is None
  print('PASS approved raw feed becomes fallback; revocation returns to reconnect image with peer uninterrupted.',flush=True)
  a=pub(1);wait_for(lambda:status(1)['state']=='live',25)
  video=next(r for r in data['requests'] if r['kind']=='video')
  assert post3(2,'respond',{'id':video['id'],'decision':'revoke'})[0]==200
  wait_for(lambda:red(pixel(1,275,20)),20)
  assert paths()==before
  print('PASS video revocation removes inset live; primary returns; outgoing connections stay continuous.',flush=True)
  assert post3(2,'respond',{'id':fallback['id'],'decision':'approve-session'})[0]==200
  assert post3(1,'settings',{'main':{'x':0,'y':0,'width':1,'height':1},'overlays':[],'chatOverlays':[],'fallback':['bob'],'fallbackTimeoutMinutes':.05})[0]==200
  a.terminate();a.wait(timeout=8);wait_for(lambda:not status(1)['broadcast'],20)
  assert b.poll() is None and status(2)['broadcast']
  assert next(r for r in request(2,'/api/v3/view')[1]['requests'] if r['id']==fallback['id'])['status']=='revoked'
  print('PASS fallback timeout ends only owner broadcast and revokes session approval.',flush=True)
  code,history=request(1,'/api/v3/recordings');assert code==200
  recording=history['items'][0];assert recording['title']=='Recorded test stream' and recording['downloadable'] and recording['bytes']>0,recording
  headers={'Authorization':'Bearer alice:'+actual['multi']['publishers'][0]['controlToken'],'Origin':origin}
  download=origin+'/api/v3/recordings/'+recording['id']+'/download'
  with urllib.request.urlopen(urllib.request.Request(download,headers=headers),timeout=15)as response: raw=response.read()
  assert len(raw)==recording['bytes'];(w/'download.ts').write_bytes(raw)
  info=json.loads(subprocess.check_output(['ffprobe','-v','error','-show_entries','stream=codec_type','-of','json',str(w/'download.ts')]))
  assert {'video','audio'}<={s['codec_type'] for s in info['streams']}
  try:
   headers['Authorization']='Bearer bob:'+actual['multi']['publishers'][1]['controlToken']
   urllib.request.urlopen(urllib.request.Request(download,headers=headers),timeout=10)
   raise AssertionError('Cross-account download succeeded')
  except urllib.error.HTTPError as error:assert error.code==404
  assert request(2,'/api/v3/recordings')[1]['items'][0]['title']!='Recorded test stream'
  print('PASS finalized recording download, actual video/audio tracks and cross-account denial.',flush=True)
  assert post3(2,'recording-delete',{'id':recording['id']})[0]==404
  assert post3(1,'recording-delete',{'id':recording['id']})[0]==200
  assert not any(r['id']==recording['id'] for r in request(1,'/api/v3/recordings')[1]['items'])
  print('PASS recording deletion is owner-only.',flush=True)
  cmd('stop');assert app.wait(timeout=12)==0
 except Exception:
  print(logs());raise
 finally:
  for p in reversed(children):
   if p.poll() is None:p.terminate()
  for p in reversed(children):
   try:p.wait(timeout=5)
   except subprocess.TimeoutExpired:p.kill();p.wait()
  log.close()
