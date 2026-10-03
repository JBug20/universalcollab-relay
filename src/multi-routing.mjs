import {createHash,timingSafeEqual} from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';

export const hash=value=>createHash('sha256').update(value).digest('hex');
export const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
export const loopback=ip=>['127.0.0.1','::1','::ffff:127.0.0.1'].includes(ip);
export function joinDestination(base,key){
  if(typeof key!=='string'||! /^[A-Za-z0-9_.-]{1,512}$/.test(key)||['.','..'].includes(key))throw Error('Invalid platform stream key');
  if(typeof base!=='string'||/[\s\x00-\x1f\x7f\\]/.test(base))throw Error('Invalid destination server');
  const u=new URL(base);
  if(u.search||u.hash||u.username||u.password)throw Error('Destination server must not contain credentials or a query');
  u.pathname=u.pathname.replace(/\/+$/,'')+'/'+key;
  return destinationURL(u.href,[u.hostname.toLowerCase()]).href;
}
export function destinationURL(value,allowedHosts){
  if(typeof value!=='string'||value.length>4096||/[\s\x00-\x1f\x7f\\]/.test(value))throw Error('Invalid URL');
  const u=new URL(value);
  if(!['rtmp:','rtmps:'].includes(u.protocol)||u.username||u.password||u.hash||!u.hostname||!u.pathname.split('/').filter(Boolean).length)throw Error('Invalid destination');
  u.hostname=u.hostname.toLowerCase();
  if((u.protocol==='rtmp:'&&u.port==='1935')||(u.protocol==='rtmps:'&&u.port==='443'))u.port='';
  if(!allowedHosts.includes(u.hostname.toLowerCase()))throw Error('Destination host not approved');
  if(u.port && (!Number.isInteger(Number(u.port))||Number(u.port)<1||Number(u.port)>65535))throw Error('Invalid port');
  return u;
}
// Conservative public-address check. Private destinations require an explicit
// admin setting; approved DNS names are resolved before every new broadcast.
export function publicAddress(address){
  if(net.isIP(address)===4){
    const [a,b]=address.split('.').map(Number);
    return !(a===0||a===10||a===127||a>=224||(a===100&&b>=64&&b<=127)||(a===169&&b===254)||(a===172&&b>=16&&b<=31)||(a===192&&[0,168].includes(b))||(a===198&&[18,19,51].includes(b))||(a===203&&b===0));
  }
  // Accept global IPv6 unicast only, excluding documentation and transition ranges.
  if(net.isIP(address)===6)return /^[23]/i.test(address)&&!/^2001:(?:db8|0):/i.test(address)&&!/^2002:/i.test(address);
  return false;
}
export async function validateDestination(value,options,lookup=dns.lookup){
  const u=destinationURL(value,options.allowedDestinationHosts);
  if(!options.allowPrivateDestinations){
    const answers=await lookup(u.hostname.replace(/^\[|\]$/g,''),{all:true});
    if(!answers.length||answers.some(a=>!publicAddress(a.address)))throw Error('Nonpublic destination');
  }
  return u.href;
}
export function selectSource(owner,inputs,publishers,collab,now=Date.now()){
  const primary=inputs.get(owner);
  if(primary?.healthy && (!collab.enabled||now-primary.healthySince>=collab.recoverAfterSeconds*1000))return owner;
  if(collab.enabled){
    const group=publishers.find(p=>p.id===owner)?.collabGroup;
    if(group){
      const position=publishers.findIndex(p=>p.id===owner);
      // Start immediately after this owner and wrap around, skipping offline peers.
      const order=[...publishers.slice(position+1),...publishers.slice(0,position)];
      for(const p of order){
        if(p.id!==owner&&p.collabGroup===group&&inputs.get(p.id)?.healthy)return p.id;
      }
    }
  }
  // No backup: use a connected primary immediately while it settles.
  return primary?.healthy?owner:null;
}

// Only the permanent account key may publish; all destinations come from saved configuration.
export function parsePublisherPath(name,query,users){
 if(typeof name!=='string'||name.length>8400||query)return null;
 const parts=name.split('/');if(parts.length!==3||parts[0]!=='live')return null;
 const user=users.get(parts[1]);if(!user||!same(parts[2],user.inputKey))return null;
 try{
  const destinations=user.production?.destinations?.length?user.production.destinations:
   user.destinationStreamKey&&user.destinationBaseUrl?[{id:'default',name:'Saved destination',url:joinDestination(user.destinationBaseUrl,user.destinationStreamKey)}]:[];
  if(!destinations.length)return null;const destination=destinations[0].url;
  return {id:user.id,name,destination,destinations,keyHash:hash(user.id+'\0'+destinations.map(d=>d.url).join('\0')),destinationHash:hash(destination),destinationHashes:destinations.map(d=>hash(d.url))};
 }catch{return null;}
}
