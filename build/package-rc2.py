from pathlib import Path
import shutil,json,os,zipfile,tarfile,hashlib
r=Path(__file__).resolve().parents[1];parent=r.parent;v="1.0.0-rc.8";b=parent/'uc-rc3-ui-release';notes=(r/f'START-HERE-{v}.md').read_text();runtime=Path(os.environ.get('RUNTIME_ROOT',parent/'release-runtime'))
reference=json.loads((r/'build/runtime-rc3-reference.json').read_text())
def copy_fresh(src,dst):
 # Avoid stale timestamps on extracted/copy-on-write runtime files.
 with open(src,'rb') as a,open(dst,'wb') as b:
  shutil.copyfileobj(a,b,1024*1024);b.flush();os.fsync(b.fileno())
 os.chmod(dst,os.stat(src).st_mode);os.utime(dst,None)
 return dst
def verify_runtime(root,platform=None):
 for name,expected in reference.items():
  if platform and not name.startswith(platform+'/'):continue
  file=root/name
  if not file.is_file() or file.stat().st_size!=expected['size'] or hashlib.sha256(file.read_bytes()).hexdigest()!=expected['sha256']:raise RuntimeError('Damaged or incomplete runtime: '+str(file))
verify_runtime(runtime)
for name in ['windows-app','UniversalCollab-Linux']:
 dest=b/name
 if dest.exists():shutil.rmtree(dest)
 shutil.copytree(runtime/name,dest,dirs_exist_ok=True,copy_function=copy_fresh,ignore=shutil.ignore_patterns('$PLUGINSDIR','Uninstall.exe','.stream-relay.*','.StreamRelay.exe.*','.dxcompiler.dll.*'))
 app=dest/'resources/app'
 if app.exists():shutil.rmtree(app)
 shutil.copytree(r/'DesktopSource',app,copy_function=copy_fresh,ignore=shutil.ignore_patterns('windows-installer.nsi'))
 verify_runtime(b,name)
 if name=='UniversalCollab-Linux':shutil.copyfile(r/'DesktopSource/linux-install.sh',dest/'install.sh')
 (dest/'README.txt').write_text(notes)
 shutil.copy2(r/'API-Public-Release-Checklist.md',dest/'API-Public-Release-Checklist.md')
shutil.copy2(r/'DesktopSource/windows-installer.nsi',b/'installer.nsi')
with zipfile.ZipFile(parent/f'UniversalCollab-ServerUpdate-{v}.zip','w',zipfile.ZIP_DEFLATED) as z:
 for p in (b/'relay').rglob('*'):
  if p.is_file() and p.relative_to(b/'relay').parts[0] not in ['config.json','fallback.png','vendor','data']:z.write(p,str(p.relative_to(b/'relay')))
 z.writestr(f'UPDATE-{v}.md',notes)
with zipfile.ZipFile(parent/f'UniversalCollab-Owner-Source-PRIVATE-{v}.zip','w',zipfile.ZIP_DEFLATED) as z:
 for p in r.rglob('*'):
  if p.is_file() and p.relative_to(r).parts[0] not in ['vendor','data','OWNER-PRIVATE-RELEASE-KEYS'] and p.name != 'OWNER-ONLY.txt' and '__pycache__' not in p.parts and not any(x.startswith('.') for x in p.relative_to(r).parts) and p.suffix not in ['.zip','.gz'] and p.stat().st_size<10000000:z.write(p,str(p.relative_to(r)))
 for p in (b/'private-build-keys').glob('*.pem'):z.write(p,'OWNER-PRIVATE-RELEASE-KEYS/'+p.name)
 z.writestr('OWNER-ONLY.txt','Private development source and release signing key. Do not distribute to relay hosts or publish. No registry service is required.\n')
def linux_permissions(info):
 if info.name.endswith(('/stream-relay','/chrome_crashpad_handler','/chrome-sandbox','/install.sh')):info.mode=0o755
 return info
with tarfile.open(parent/f'UniversalCollab-Linux-{v}.tar.gz','w:gz',compresslevel=6) as t:t.add(b/'UniversalCollab-Linux',arcname='UniversalCollab-Linux',filter=linux_permissions)
shutil.copy2(r/f'START-HERE-{v}.md',parent/f'UniversalCollab-{v}-Setup-Guide.md')
print('PASS complete runtime files verified against rc.3 before and after copying.')
print('Packaged relay, private source and Linux app. Run makensis on uc-rc3-ui-release/installer.nsi, then copy its installer to the output folder.')
