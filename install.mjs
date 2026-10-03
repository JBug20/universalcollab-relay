import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

export const version='v1.21.0';
const builds={
  x64:{arch:'amd64',sha256:'e02e34c3337a35f20ac9e5aa31524566108964e6e37dbc46cf8292169f6c792b'},
  arm64:{arch:'arm64',sha256:'a8113b5928ba1a934b81557b61b8a07954b76921a4b567d54c7f086f8b39d9a2'}
};
export async function install(){
  const build=builds[process.arch];
  if(process.platform!=='linux'||!build)throw Error('Linux x64 or arm64 is required.');
  const name=`mediamtx_${version}_linux_${build.arch}.tar.gz`;
  let bytes;
  if(process.env.MEDIAMTX_ARCHIVE)bytes=fs.readFileSync(process.env.MEDIAMTX_ARCHIVE);
  else{
    const response=await fetch(`https://github.com/bluenviron/mediamtx/releases/download/${version}/${name}`,{signal:AbortSignal.timeout(120000)});
    if(!response.ok)throw Error('Dependency download failed.');
    const chunks=[];let size=0;
    for await(const chunk of response.body){size+=chunk.length;if(size>100*1024*1024)throw Error('Dependency archive too large.');chunks.push(chunk);}
    bytes=Buffer.concat(chunks);
  }
  if(createHash('sha256').update(bytes).digest('hex')!==build.sha256)throw Error('Dependency SHA-256 mismatch.');
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'relay-install-'));
  try{
    const archive=path.join(tmp,'dependency.tar.gz');fs.writeFileSync(archive,bytes);
    const r=spawnSync('tar',['-xzf',archive,'-C',tmp,'mediamtx','LICENSE'],{stdio:'ignore'});
    if(r.status!==0)throw Error('Cannot extract dependency; tar is required.');
    fs.mkdirSync('vendor',{recursive:true});
    fs.copyFileSync(path.join(tmp,'mediamtx'),'vendor/mediamtx.new');fs.chmodSync('vendor/mediamtx.new',0o755);
    fs.renameSync('vendor/mediamtx.new','vendor/mediamtx');
    fs.copyFileSync(path.join(tmp,'LICENSE'),'vendor/LICENSE');
    console.log('MediaMTX v1.21.0 installed; SHA-256 verified.');
  }finally{fs.rmSync(tmp,{recursive:true,force:true});}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  install().catch(()=>{console.error('Dependency installation failed: check Linux architecture, network, tar, disk space and archive checksum.');process.exitCode=1;});
}
