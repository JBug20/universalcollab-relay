'use strict';
window.appStartupErrors=[];
window.addEventListener('error',e=>{window.appStartupErrors.push(e.message);const message=document.getElementById('bootMessage');if(message){message.textContent='App startup problem: '+e.message;document.getElementById('bootStatus').hidden=false;}});
document.getElementById('resetStudioUI').onclick=()=>{if(!confirm('Reset only the new studio layout? Saved servers, platform logins and scenes are kept.'))return;for(const key of ['uc-ui5-workspace'])localStorage.removeItem(key);location.reload();};
