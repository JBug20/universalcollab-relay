import fs from 'node:fs';
// Preferences are optional UI settings, not accounts or publishing credentials.
export function normalizePreferences(value,users){
 const entries=Array.isArray(value)?value:value&&typeof value==='object'?Object.entries(value).map(([id,p])=>p&&typeof p==='object'?{...p,id}:null):[];
 const result=new Map();
 for(const p of entries){
  if(!p||typeof p!=='object'||typeof p.id!=='string'||!users.has(p.id))continue;
  const item=result.get(p.id)||{id:p.id};
  for(const key of ['pip','collab']){
   if(typeof p[key]==='boolean')item[key]=p[key];
   else if(p[key]==='true'||p[key]==='false')item[key]=p[key]==='true';
  }
  if('pip' in item||'collab' in item)result.set(p.id,item);
 }
 return [...result.values()];
}
export function migratePreferences(state,users,file='data/multi-state.json'){
 const normalized=normalizePreferences(state.preferences,users);
 if(JSON.stringify(state.preferences??[])===JSON.stringify(normalized)){state.preferences=normalized;return false;}
 if(fs.existsSync(file)){
  try{fs.writeFileSync(file+'.before-0.3.1',fs.readFileSync(file),{flag:'wx',mode:0o600});}
  catch(error){if(error.code!=='EEXIST')throw error;}
 }
 state.preferences=normalized;
 fs.writeFileSync(file+'.preferences.tmp',JSON.stringify(state),{mode:0o600});
 fs.renameSync(file+'.preferences.tmp',file);
 return true;
}
