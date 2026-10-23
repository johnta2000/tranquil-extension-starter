const SITE_NAMES={threads:"Threads",instagram:"Instagram",facebook:"Facebook",x:"X / Twitter",linkedin:"LinkedIn",reddit:"Reddit",youtube:"YouTube",tiktok:"TikTok",bookface:"YC Bookface",gmail:"Gmail"};
const SITE_URLS={threads:"https://threads.com/",instagram:"https://instagram.com/",facebook:"https://facebook.com/",x:"https://x.com/",linkedin:"https://linkedin.com/",reddit:"https://reddit.com/",youtube:"https://youtube.com/",tiktok:"https://tiktok.com/",bookface:"https://bookface.ycombinator.com/",gmail:"https://mail.google.com/"};
const SESSION_DURATION_MS=30*60*1000;
const extensionApi=globalThis.chrome?.runtime?.id?chrome:null;
const timer=document.querySelector("#timer"),progressBar=document.querySelector("#progress-bar");
const siteName=document.querySelector("#site-name"),endsAt=document.querySelector("#ends-at");
const statusLabel=document.querySelector("#status-label"),heading=document.querySelector("#heading");
const copy=document.querySelector("#copy"),accessLink=document.querySelector("#access-link");
const siteKey=new URLSearchParams(location.search).get("site");
const readableName=SITE_NAMES[siteKey]||"This site";
siteName.textContent=readableName;
accessLink.href=SITE_URLS[siteKey]||"about:blank";
accessLink.textContent=`Return to ${readableName}`;
let state={sessionEnd:null,sessionDurationMinutes:30};

function formatTime(milliseconds) { const total=Math.max(0,Math.ceil(milliseconds/1000)); return `${String(Math.floor(total/60)).padStart(2,"0")}:${String(total%60).padStart(2,"0")}`; }

function render() {
  const now=Date.now();
  const focusActive=state.sessionEnd>now;
  const target=state.sessionEnd;
  const remaining=Math.max(0,(target||0)-now);
  const shared=state.sharedAccess?.enabled&&state.sharedAccess.policies.find(p=>p.siteKey===siteKey);
  if(shared&&!focusActive) {
    statusLabel.textContent="Work access only";heading.textContent="One task. No feed.";
    copy.textContent=shared.blocked?"This service is blocked across your connected devices.":`${Math.max(0,shared.limit-shared.used)} of ${shared.limit} shared work allowances remain today.`;
    timer.textContent="";progressBar.style.width="0%";endsAt.textContent="Feeds and Reels never unlock.";
    accessLink.hidden=false;accessLink.textContent="Request work access";accessLink.href=chrome.runtime.getURL("options.html#work-access");return;
  }
  timer.textContent=formatTime(remaining);
  const total=(state.sessionDurationMinutes||30)*60000||SESSION_DURATION_MS;
  progressBar.style.width=`${Math.min(100,(remaining/total)*100)}%`;

  if (focusActive) {
    statusLabel.textContent="Focus session active";
    heading.textContent="Stay with the one thing.";
    copy.textContent=`${readableName} can wait. You chose this time before the impulse arrived.`;
    endsAt.textContent=`Access returns at ${new Date(state.sessionEnd).toLocaleTimeString([],{hour:"numeric",minute:"2-digit"})}`;
    accessLink.hidden=true;
  } else {
    statusLabel.textContent="Session complete";
    heading.textContent="The space is yours again.";
    copy.textContent="Your focus session has ended.";
    endsAt.textContent="Choose deliberately what comes next.";
    accessLink.hidden=false;
  }
}

const statePromise=extensionApi
  ? extensionApi.storage.local.get({sessionEnd:null,sessionDurationMinutes:30,sharedAccess:null})
  : Promise.resolve({sessionEnd:Date.now()+SESSION_DURATION_MS,sessionDurationMinutes:30});
statePromise.then((saved)=>{state={...state,...saved};render();setInterval(render,1000);});
if(extensionApi&&SITE_NAMES[siteKey]) {
  extensionApi.runtime.sendMessage({type:"GET_RETURN_URL",siteKey}).then((response)=>{
    if(response?.ok&&response.returnUrl) accessLink.href=response.returnUrl;
  });
  accessLink.addEventListener("click",()=>{ extensionApi.runtime.sendMessage({type:"CLEAR_RETURN_URL"}); });
}
extensionApi?.storage.onChanged.addListener((changes)=>{
  for (const key of ["sessionEnd","sessionDurationMinutes","sharedAccess"]) if (changes[key]) state[key]=changes[key].newValue;
  render();
});

const source=new URLSearchParams(location.search).get("source");
if(extensionApi&&!source&&SITE_NAMES[siteKey]) extensionApi.runtime.sendMessage({type:"RECORD_DISTRACTION",siteKey});
