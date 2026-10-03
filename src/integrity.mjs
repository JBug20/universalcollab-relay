import fs from 'node:fs';import path from 'node:path';import {fileURLToPath}from'node:url';import{createHash,verify}from'node:crypto';
// The build injects this public key; signing keys are never distributed.
export const RELEASE_PUBLIC_KEY='';
const root=fileURLToPath(new URL('../',import.meta.url));
let cached;
export function integrityStatus(){if(cached&&Date.now()-cached.at<60000)return cached.value;let value;try{if(!RELEASE_PUBLIC_KEY)value={status:'development'};else{const envelope=JSON.parse(fs.readFileSync(path.join(root,'release-manifest.json')));if(!verify(null,Buffer.from(envelope.payload),RELEASE_PUBLIC_KEY,Buffer.from(envelope.signature,'base64url')))throw Error();const manifest=JSON.parse(envelope.payload);for(const [name,digest]of Object.entries(manifest.files)){if(name.includes('..')||path.isAbsolute(name)||createHash('sha256').update(fs.readFileSync(path.join(root,name))).digest('hex')!==digest)throw Error();}value={status:'verified'};}}catch{value={status:'modified'};}cached={at:Date.now(),value};return value;}
