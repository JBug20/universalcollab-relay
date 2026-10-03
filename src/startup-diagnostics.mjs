// Never return raw child-process messages, stderr, commands or URLs.
export function startupFailure(error){
  const known=new Set(['Video and audio with valid dimensions were not detected within 30 seconds','Invalid detected tracks','Expected video and audio','Resolution outside budget','Fallback picture','Publisher disconnected during detection','Expired saved deadline']);
  if(known.has(error?.message))return error.message;
  if(error?.code==='ENOENT')return 'Required executable or file was not found.';
  if(error?.code==='EACCES')return 'Permission denied.';
  if(error?.code==='ENOSPC')return 'No space left on disk.';
  if(error?.code==='ERR_CHILD_PROCESS_STDIO_MAXBUFFER')return 'Process output exceeded its buffer limit.';
  if(error?.signal==='SIGKILL')return 'Child process was killed (SIGKILL); check host resource limits.';
  if(error?.killed)return 'Child process timed out or was terminated.';
  const diagnostic=String(error?.stderr||'').toLowerCase();
  if(diagnostic.includes('connection refused'))return 'Local media connection was refused.';
  if(diagnostic.includes('401')||diagnostic.includes('unauthorized'))return 'Local media reader authorization was rejected.';
  if(diagnostic.includes('cannot allocate memory'))return 'Child process could not allocate memory.';
  if(diagnostic.includes('resource temporarily unavailable'))return 'Child process reported unavailable resources.';
  if(diagnostic.includes('invalid data found'))return 'Child process could not parse the media input.';
  if(Number.isInteger(error?.code))return `Child process exited with code ${error.code}.`;
  return 'Unexpected initialization error; raw details withheld to protect stream credentials.';
}
