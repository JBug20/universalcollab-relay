// Host policy is authoritative; streamer preferences cannot enable disabled features.
export function hostFeatures(config={}){
 const h=config.hostFeatures??{};
 if(!h||typeof h!=="object"||Array.isArray(h))throw Error('hostFeatures must be an object.');
 const defaults={povLabels:true,manualFallback:true,fallbackTimeout:true,streamHealth:true,guestInvites:false,sessionPermissions:true,recordingManagement:true,registration:true,pictureInPicture:true,collaboratorFallback:true,chatOverlays:true,multipleDestinations:true,recording:false};
 for(const key of Object.keys(h))if(!(key in defaults))throw Error('Unknown hostFeatures setting. Check the documented host feature names.');
 for(const key of Object.keys(defaults))if(h[key]!==undefined&&typeof h[key]!=="boolean")throw Error('hostFeatures.'+key+' must be true or false.');
 return {...Object.fromEntries(['povLabels','manualFallback','fallbackTimeout','streamHealth','sessionPermissions','recordingManagement'].map(k=>[k,h[k]??true])),guestInvites:h.guestInvites??false,multipleDestinations:h.multipleDestinations??true,recording:h.recording??false,chatOverlays:h.chatOverlays??true,registration:h.registration??true,pictureInPicture:(h.pictureInPicture??true)&&config.multi?.pictureInPicture?.enabled!==false,collaboratorFallback:(h.collaboratorFallback??true)&&config.multi?.collab?.enabled!==false};
}
