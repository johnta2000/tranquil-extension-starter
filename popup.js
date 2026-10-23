const FALLBACK_SITES = {
  threads:{name:"Threads"}, instagram:{name:"Instagram"}, facebook:{name:"Facebook"},
  x:{name:"X / Twitter"}, linkedin:{name:"LinkedIn"}, reddit:{name:"Reddit"},
  youtube:{name:"YouTube"}, tiktok:{name:"TikTok"}, bookface:{name:"YC Bookface"}
};
const ICONS = { threads:"@",instagram:"IG",facebook:"f",x:"X",linkedin:"in",reddit:"r/",youtube:"▶",tiktok:"♪",bookface:"YC" };
const extensionApi = globalThis.chrome?.runtime?.id ? chrome : null;
const $ = (selector) => document.querySelector(selector);

const idleState=$("#idle-state"), activeState=$("#active-state"), startButton=$("#start-session");
const timer=$("#timer"), progressBar=$("#progress-bar"), feedToggle=$("#feed-toggle"), feedToggleCopy=$("#feed-toggle-copy");
const feedUnblocksToday=$("#feed-unblocks-today");
const sitePause=$("#site-pause"), sitePauseTitle=$("#site-pause-title"), sitePauseCopy=$("#site-pause-copy");
const confirmSiteDisable=$("#confirm-site-disable"), cancelSiteDisable=$("#cancel-site-disable");
const siteList=$("#site-list"), settingsPanel=$(".settings"), durationInput=$("#duration-input"), focusLevelSelect=$("#focus-level");
const activeLabelText=$("#active-label-text");
const activeDescription=$("#active-description"), showEmergency=$("#show-emergency");
const emergencyForm=$("#emergency-form"), emergencyReason=$("#emergency-reason");
const emergencyConfirm=$("#emergency-confirm"), emergencyWait=$("#emergency-wait");
const emergencyChallenge=$("#emergency-challenge");
const emergencyPhrase=$("#emergency-phrase"), emergencyPhraseInput=$("#emergency-phrase-input");
const confirmEmergency=$("#confirm-emergency"), errorBox=$("#error");
const versionLabel=$("#version-label");
let state=null, limits={minSessionMinutes:5,maxSessionMinutes:240};
let previewState=null;

versionLabel.textContent=extensionApi?`v${extensionApi.runtime.getManifest().version}`:"Preview";

function showError(message) { errorBox.textContent=message; errorBox.hidden=!message; }
function formatTime(milliseconds) { const s=Math.max(0,Math.ceil(milliseconds/1000)); return `${String(Math.floor(s/60)).padStart(2,"0")}:${String(s%60).padStart(2,"0")}`; }
function selectedDuration() { return Number(durationInput.value); }
function selectedFocusLevel() { return focusLevelSelect.value==="deep"?"deep":"standard"; }
function updateStartLabel() { const value=selectedDuration(); startButton.firstChild.textContent=`Start ${Number.isFinite(value)?value:"—"} min ${selectedFocusLevel()==="deep"?"Deep":"Standard"} session `; }

function renderFeedDisablePause() {
  const request=state?.feedDisableRequest;
  const feedsAlreadyOpen=state?.feedBlockingEnabled===false;
  feedToggle.className="feed-toggle";
  feedToggleCopy.textContent="";
  feedToggle.setAttribute("aria-pressed",String(!feedsAlreadyOpen));
  if(feedsAlreadyOpen){feedToggle.classList.add("is-off");feedToggle.setAttribute("aria-label","Turn feed removal on");return;}
  if(!request){feedToggle.setAttribute("aria-label","Pause before allowing infinite feeds");return;}
  const seconds=Math.max(0,Math.ceil((request.availableAt-Date.now())/1000));
  const ready=seconds===0;
  const attempt=request.attemptNumber||1;
  feedToggle.classList.add(ready?"ready":"waiting");
  feedToggleCopy.textContent=ready?`Allow #${attempt}`:`#${attempt} · ${seconds}s`;
  feedToggle.setAttribute("aria-label",ready?"Confirm allowing infinite feeds":`Cancel feed access pause; ${seconds} seconds remain`);
}

function renderSiteDisablePause() {
  const request=state?.siteDisableRequest;
  sitePause.hidden=!request;
  if(!request)return;
  const siteName=availableSiteNames[request.siteKey]||request.siteKey;
  const seconds=Math.max(0,Math.ceil((request.availableAt-Date.now())/1000));
  const ready=seconds===0;
  const attempt=request.attemptNumber||1;
  sitePauseTitle.textContent=`Pause before opening ${siteName}.`;
  sitePauseCopy.textContent=ready
    ? `Opening #${attempt} today. Allow ${siteName} only if you still mean to.`
    : `Opening #${attempt} today. Wait ${seconds} second${seconds===1?"":"s"}; repeated openings take longer.`;
  confirmSiteDisable.textContent=`Allow ${siteName}`;
  confirmSiteDisable.disabled=!ready;
}

const availableSiteNames=Object.fromEntries(Object.entries(FALLBACK_SITES).map(([key,site])=>[key,site.name]));

function renderSites(sites,enabledSites) {
  siteList.replaceChildren();
  for (const [key,site] of Object.entries(sites)) {
    const label=document.createElement("label"); label.className="site-item"; label.title=site.name;
    label.innerHTML=`<input type="checkbox" data-site="${key}"><span class="site-icon">${ICONS[key]}</span><span class="site-name">${site.name}</span>`;
    const input=label.querySelector("input"); input.checked=enabledSites[key]!==false; input.addEventListener("change",handleSiteChange); siteList.appendChild(label);
  }
}

async function handleSiteChange(event) {
  const input=event.currentTarget;
  const siteKey=input.dataset.site;
  if(input.checked) {
    const enabledSites={...(state?.enabledSites||{}),[siteKey]:true};
    if(extensionApi) {
      await extensionApi.storage.local.set({enabledSites});
      if(state?.siteDisableRequest?.siteKey===siteKey) await extensionApi.runtime.sendMessage({type:"CANCEL_SITE_DISABLE"});
    }
    state={...state,enabledSites,siteDisableRequest:state?.siteDisableRequest?.siteKey===siteKey?null:state?.siteDisableRequest};
    renderSiteDisablePause();
    return;
  }
  input.checked=true;
  const response=extensionApi
    ? await extensionApi.runtime.sendMessage({type:"REQUEST_SITE_DISABLE",siteKey})
    : {ok:true,siteDisableRequest:{siteKey,requestedAt:Date.now(),availableAt:Date.now()+5000+Math.floor(Math.random()*11)*1000}};
  if(!response?.ok){showError(response?.error||"Could not begin the pause.");return;}
  state={...state,feedDisableRequest:null,siteDisableRequest:response.siteDisableRequest};
  renderFeedDisablePause();
  renderSiteDisablePause();
}

function renderState(nextState) {
  state=nextState;
  const active=state.sessionEnd>Date.now();
  idleState.hidden=active; activeState.hidden=!active; settingsPanel.classList.toggle("locked",active);
  if (!active) {
    const remembered=String(state.lastSessionMinutes||30);
    durationInput.value=remembered;
    focusLevelSelect.value=state.lastFocusLevel==="deep"?"deep":"standard";
    updateStartLabel(); return;
  }

  activeLabelText.textContent=state.serverManagedSession ? "Focus across connected devices" : "Focus session active";
  activeDescription.textContent=state.sessionFocusLevel==="deep"
    ? "Gmail and your selected distractions are out of reach. Stay with the work in front of you."
    : "Your selected distractions are out of reach. Stay with the work in front of you.";
  showEmergency.hidden=Boolean(state.emergencyRequest);
  emergencyForm.hidden=true;
  emergencyConfirm.hidden=!state.emergencyRequest;
  if (state.emergencyRequest) {
    emergencyPhrase.textContent="";
    emergencyChallenge.hidden=true;
    emergencyPhraseInput.value="";
  }
  showEmergency.disabled=false; showEmergency.textContent="Need emergency access?";
  tick();
}

function tick() {
  renderFeedDisablePause();
  renderSiteDisablePause();
  if (!state?.sessionEnd) return;
  const now=Date.now();
  const target=state.sessionEnd;
  timer.textContent=formatTime(target-now);
  const total=(state.sessionDurationMinutes||30)*60000;
  progressBar.style.width=`${Math.min(100,Math.max(0,((target-now)/total)*100))}%`;
  if (state.emergencyRequest) {
    const wait=Math.max(0,state.emergencyRequest.availableAt-now);
    const ready=wait<=0;
    emergencyWait.textContent=ready?"The pause is complete. End the session only if this still cannot wait.":`Pause for ${Math.ceil(wait/1000)} seconds.`;
    emergencyChallenge.hidden=!ready;
    if(ready) emergencyPhrase.textContent=state.emergencyRequest.phrase;
    confirmEmergency.disabled=!ready||emergencyPhraseInput.value.trim()!==state.emergencyRequest.phrase;
  }
  if (target<=now) loadState();
}

durationInput.addEventListener("input",updateStartLabel);
focusLevelSelect.addEventListener("change",updateStartLabel);
feedToggle.addEventListener("click",async()=>{
  const feedsAlreadyOpen=state?.feedBlockingEnabled===false;
  if(feedsAlreadyOpen) {
    if(extensionApi) {
      await extensionApi.storage.local.set({feedBlockingEnabled:true});
      await extensionApi.runtime.sendMessage({type:"CANCEL_FEED_DISABLE"});
    }
    state={...state,feedBlockingEnabled:true,feedDisableRequest:null};
    renderFeedDisablePause();
    return;
  }
  if(state?.feedDisableRequest) {
    if(Date.now()<state.feedDisableRequest.availableAt) {
      if(extensionApi)await extensionApi.runtime.sendMessage({type:"CANCEL_FEED_DISABLE"});
      state={...state,feedDisableRequest:null};
      renderFeedDisablePause();
      return;
    }
    const response=extensionApi?await extensionApi.runtime.sendMessage({type:"CONFIRM_FEED_DISABLE"}):{ok:true,feedBlockingEnabled:false};
    if(!response?.ok){showError(response?.error||"The pause is not complete.");renderFeedDisablePause();return;}
    state={...state,feedBlockingEnabled:false,feedDisableRequest:null};
    renderFeedDisablePause();
    return;
  }
  const response=extensionApi
    ? await extensionApi.runtime.sendMessage({type:"REQUEST_FEED_DISABLE"})
    : {ok:true,feedDisableRequest:{requestedAt:Date.now(),availableAt:Date.now()+5000+Math.floor(Math.random()*11)*1000,priorOpenCount:0,attemptNumber:1}};
  if(!response?.ok){showError(response?.error||"Could not begin the pause.");return;}
  state={...state,feedDisableRequest:response.feedDisableRequest};
  renderFeedDisablePause();
});
confirmSiteDisable.addEventListener("click",async()=>{
  const siteKey=state?.siteDisableRequest?.siteKey;
  if(!siteKey)return;
  confirmSiteDisable.disabled=true;
  const response=extensionApi
    ? await extensionApi.runtime.sendMessage({type:"CONFIRM_SITE_DISABLE",siteKey})
    : {ok:true,siteKey,enabledSites:{...(state?.enabledSites||{}),[siteKey]:false}};
  if(!response?.ok){showError(response?.error||"The pause is not complete.");renderSiteDisablePause();return;}
  state={...state,enabledSites:response.enabledSites,siteDisableRequest:null};
  const input=document.querySelector(`[data-site="${siteKey}"]`);
  if(input)input.checked=false;
  renderSiteDisablePause();
});
cancelSiteDisable.addEventListener("click",async()=>{
  if(extensionApi)await extensionApi.runtime.sendMessage({type:"CANCEL_SITE_DISABLE"});
  state={...state,siteDisableRequest:null};
  renderSiteDisablePause();
});
$("#view-analytics").addEventListener("click",()=>extensionApi?.tabs.create({url:extensionApi.runtime.getURL("options.html#analytics")}));
$("#view-settings").addEventListener("click",()=>extensionApi?.tabs.create({url:extensionApi.runtime.getURL("options.html#settings")}));

startButton.addEventListener("click",async()=>{
  showError(""); const duration=selectedDuration();
  if (!Number.isInteger(duration)||duration<limits.minSessionMinutes||duration>limits.maxSessionMinutes) { showError(`Choose ${limits.minSessionMinutes}–${limits.maxSessionMinutes} minutes.`); return; }
  startButton.disabled=true;
  const focusLevel=selectedFocusLevel();
  const response=extensionApi?await extensionApi.runtime.sendMessage({type:"START_SESSION",durationMinutes:duration,focusLevel}):{ok:true,sessionEnd:Date.now()+duration*60000};
  startButton.disabled=false;
  if (!response?.ok) { showError(response?.error||"Could not start the session."); return; }
  await loadState({sessionEnd:response.sessionEnd,sessionStart:Date.now(),sessionDurationMinutes:duration,lastSessionMinutes:duration,sessionFocusLevel:focusLevel,lastFocusLevel:focusLevel});
});

showEmergency.addEventListener("click",()=>{ showEmergency.hidden=true; emergencyForm.hidden=false; emergencyReason.focus(); });
emergencyForm.addEventListener("submit",async(event)=>{
  event.preventDefault(); showError("");
  const mockRequest={reason:emergencyReason.value,phrase:"I accept ending this focus session",availableAt:Date.now()+1000};
  if(!extensionApi) previewState={...state,emergencyRequest:mockRequest};
  const response=extensionApi
    ? await extensionApi.runtime.sendMessage({type:"REQUEST_EMERGENCY",reason:emergencyReason.value})
    : {ok:true,emergencyRequest:mockRequest};
  if (!response?.ok) { showError(response?.error||"Emergency access is unavailable."); return; }
  await loadState();
});
emergencyPhraseInput.addEventListener("input",tick);
confirmEmergency.addEventListener("click",async()=>{
  showError(""); confirmEmergency.disabled=true;
  if(!extensionApi) previewState={...state,sessionEnd:null,emergencyRequest:null};
  const response=extensionApi
    ? await extensionApi.runtime.sendMessage({type:"CONFIRM_EMERGENCY",phrase:emergencyPhraseInput.value})
    : {ok:true,sessionEnded:true};
  if (!response?.ok) { showError(response?.error||"Could not end the focus session."); tick(); return; }
  await loadState();
});

async function loadState(previewOverride=null) {
  const response=extensionApi?await extensionApi.runtime.sendMessage({type:"GET_STATE"}):{
    ok:true,settings:previewState||{feedBlockingEnabled:true,enabledSites:{},feedExceptions:[],lastSessionMinutes:30,sessionEnd:null},sites:FALLBACK_SITES,limits
  };
  if (!response?.ok) { showError(response?.error||"Tranquil could not load."); return; }
  limits=response.limits||limits; const settings={...response.settings,...previewOverride};
  if(!extensionApi) previewState=settings;
  if (!siteList.children.length) renderSites(response.sites||FALLBACK_SITES,settings.enabledSites||{});
  renderState(settings);
  if(settings.focusSyncError)showError(settings.focusSyncError);
  renderFeedDisablePause();
  renderSiteDisablePause();
}

async function loadFeedUnblocksToday() {
  const response=extensionApi
    ? await extensionApi.runtime.sendMessage({type:"GET_STATS"})
    : {ok:true,stats:{feedUnblocksToday:2}};
  const count=response?.ok?Number(response.stats?.feedUnblocksToday||0):null;
  feedUnblocksToday.textContent=count===null?"—":String(count);
  feedUnblocksToday.closest(".daily-counter")?.classList.toggle("is-repeated",count>=3);
}

loadState();
loadFeedUnblocksToday();
setInterval(tick,1000);
if(extensionApi) {
  extensionApi.storage.onChanged.addListener((changes,areaName)=>{
    if(areaName!=="local")return;
    if(changes.clientSessionId||changes.sessionEnd||changes.focusSyncError)loadState();
    if(changes.feedDisableRequest||changes.siteDisableRequest||changes.feedBlockingEnabled||changes.enabledSites) {
      extensionApi.storage.local.get({feedDisableRequest:null,siteDisableRequest:null,feedBlockingEnabled:true,enabledSites:{}}).then((saved)=>{
        state={...state,...saved};renderFeedDisablePause();
        for(const input of document.querySelectorAll("[data-site]"))input.checked=saved.enabledSites[input.dataset.site]!==false;
        renderSiteDisablePause();
      });
    }
    if(changes.localFeedAccessDaily||changes.feedAccessQueue)loadFeedUnblocksToday();
  });
}
