const exceptions=document.querySelector("#exceptions");
const status=document.querySelector("#save-status");
const history=document.querySelector("#history");
const guardToggle=document.querySelector("#guard-toggle");
const sitePolicyList=document.querySelector("#site-policy-list");
const workPassForm=document.querySelector("#work-pass-form");
const workPassActive=document.querySelector("#work-pass-active");
const workPassPurpose=document.querySelector("#work-pass-purpose");
const workPassTime=document.querySelector("#work-pass-time");
const workPassStatus=document.querySelector("#work-pass-status");
let currentWorkPass=null;
const siteNames={threads:"Threads",instagram:"Instagram",facebook:"Facebook",x:"X / Twitter",linkedin:"LinkedIn",reddit:"Reddit",youtube:"YouTube",tiktok:"TikTok",bookface:"YC Bookface"};
const accountCard=document.querySelector("#account");
const accountTitle=document.querySelector("#account-title");
const accountDescription=document.querySelector("#account-description");
const accountButton=document.querySelector("#connect-account");
const accountStatus=document.querySelector("#account-status");
const extensionApi=globalThis.chrome?.runtime?.id?chrome:null;

function renderAccountState(state={}) {
  if(state.connected) {
    accountCard.classList.add("connected"); accountTitle.textContent="Tranquil account connected";
    accountDescription.textContent="Your focus history now follows your Clerk account across extension updates and browsers.";
    accountButton.textContent="Connected"; accountButton.disabled=true; accountStatus.textContent="";
  } else {
    accountCard.classList.remove("connected"); accountTitle.textContent="Connect your Tranquil account";
    accountDescription.textContent="Sign in with Clerk once to keep your history when you update the extension or use another browser.";
    accountButton.textContent=state.pending?"Waiting for sign-in…":"Connect account"; accountButton.disabled=Boolean(state.pending);
  }
}

async function checkAccountConnection() {
  if(!extensionApi)return;
  const response=await extensionApi.runtime.sendMessage({type:"CHECK_ACCOUNT_LINK"});
  if(!response?.ok)throw new Error(response?.error||"Could not check account connection.");
  renderAccountState(response);
  if(response.connected)await load();
  else if(response.pending)setTimeout(()=>checkAccountConnection().catch((error)=>{accountStatus.textContent=error.message;}),1500);
}

function normalizeLine(line) {
  return line.trim().replace(/^https?:\/\//i,"").replace(/^www\./i,"").replace(/[?#].*$/,"").replace(/\/+$/,"");
}

function renderWorkPass(workPass) {
  currentWorkPass=workPass?.expiresAt>Date.now()?workPass:null;
  workPassActive.hidden=!currentWorkPass;
  workPassForm.hidden=Boolean(currentWorkPass);
  if(!currentWorkPass)return;
  workPassPurpose.textContent=currentWorkPass.purpose||currentWorkPass.reason;
  workPassTime.textContent=`${Math.max(0,Math.ceil((currentWorkPass.expiresAt-Date.now())/60000))} min left`;
}

function renderSitePolicies(sitePolicies={}) {
  sitePolicyList.replaceChildren();
  for(const [siteKey,name] of Object.entries(siteNames)) {
    const policy=sitePolicies[siteKey]||{level:siteKey==="youtube"?"work_pass":"feed_only",maxMinutes:15};
    const row=document.createElement("div"); row.className="policy-row";
    const label=document.createElement("strong"); label.textContent=name;
    const level=document.createElement("select"); level.className="policy-level"; level.dataset.site=siteKey;
    level.innerHTML='<option value="feed_only">Feed blocked</option><option value="work_pass">Work pass required</option><option value="blocked">Fully blocked</option>';
    level.value=policy.level;
    const max=document.createElement("select"); max.className="policy-max"; max.dataset.site=siteKey;
    max.innerHTML='<option value="10">10 min max</option><option value="15">15 min max</option><option value="20">20 min max</option><option value="30">30 min max</option>';
    max.value=String(policy.maxMinutes||15); max.hidden=policy.level!=="work_pass";
    const save=async()=>{
      const response=extensionApi?await extensionApi.runtime.sendMessage({type:"SET_SITE_POLICY",siteKey,level:level.value,maxMinutes:Number(max.value)}):{ok:true};
      if(!response?.ok){workPassStatus.textContent=response?.error||"Could not update site policy.";return;}
      max.hidden=level.value!=="work_pass"; workPassStatus.textContent="";
    };
    level.addEventListener("change",save); max.addEventListener("change",save);
    row.append(label,level,max); sitePolicyList.appendChild(row);
  }
}

async function load() {
  const data=extensionApi
    ? await extensionApi.storage.local.get({feedExceptions:[],emergencyLog:[],attentionGuardEnabled:true,sitePolicies:{},workPass:null})
    : {feedExceptions:["reddit.com/r/productivity"],emergencyLog:[],attentionGuardEnabled:true,sitePolicies:{youtube:{level:"work_pass",maxMinutes:30}},workPass:null};
  const statsResponse=extensionApi
    ? await extensionApi.runtime.sendMessage({type:"GET_STATS"})
    : {ok:true,stats:{sessionsStarted:12,completedSessions:10,distractionsBlocked:47,completedMinutes:390,emergencyStops:1,feedUnblocksToday:3,feedUnblocksRecent:11,focusStreak:4,browsers:[
      {browserLabel:"Chrome – Mac",sessionsStarted:7,distractionsBlocked:29},
      {browserLabel:"Brave – Mac",sessionsStarted:5,distractionsBlocked:18}
    ],topSites:[{siteKey:"youtube",count:21},{siteKey:"threads",count:14}],recentSessions:[
      {sessionId:"one",startedAt:Date.now()-3600000,durationMinutes:30,focusLevel:"deep",status:"completed"},
      {sessionId:"two",startedAt:Date.now()-86400000,durationMinutes:45,focusLevel:"standard",status:"completed"}
    ],siteUsage:[
      {siteKey:"youtube",opens:12,visibleSeconds:4260,lastOpenedAt:Date.now()-3600000},
      {siteKey:"facebook",opens:7,visibleSeconds:1880,lastOpenedAt:Date.now()-7200000}
    ],recentSiteVisits:[
      {visitId:"visit-one",siteKey:"youtube",startedAt:Date.now()-3600000,visibleSeconds:620},
      {visitId:"visit-two",siteKey:"facebook",startedAt:Date.now()-7200000,visibleSeconds:340}
    ]}};
  const stats=statsResponse?.stats||{};
  renderAccountState({connected:stats.accountConnected===true});
  guardToggle.checked=data.attentionGuardEnabled!==false;
  renderSitePolicies(data.sitePolicies);
  renderWorkPass(data.workPass);
  document.querySelector("#stat-sessions").textContent=stats.sessionsStarted??"—";
  document.querySelector("#stat-completed").textContent=stats.completedSessions??"—";
  document.querySelector("#stat-distractions").textContent=stats.distractionsBlocked??"—";
  document.querySelector("#stat-minutes").textContent=stats.completedMinutes??stats.plannedMinutes??"—";
  document.querySelector("#stat-emergencies").textContent=stats.emergencyStops??"—";
  document.querySelector("#stat-rate").textContent=stats.sessionsStarted
    ? `${Math.round(((stats.completedSessions||0)/stats.sessionsStarted)*100)}%`
    : "0%";
  document.querySelector("#stat-feed-unblocks").textContent=stats.feedUnblocksToday??"—";
  document.querySelector("#stat-feed-unblocks-recent").textContent=stats.feedUnblocksRecent??"—";
  document.querySelector("#stat-streak").textContent=stats.focusStreak??"—";

  const analyticsSiteNames={...siteNames,gmail:"Gmail"};
  const formatDuration=(seconds)=>{
    const total=Math.max(0,Math.round(seconds||0));
    if(total<60)return `${total}s`;
    const hours=Math.floor(total/3600),minutes=Math.floor((total%3600)/60);
    return hours?`${hours}h ${minutes}m`:`${minutes}m`;
  };

  const usageStats=document.querySelector("#usage-stats");
  usageStats.replaceChildren();
  const usage=stats.siteUsage||[];
  if(!usage.length) {
    const empty=document.createElement("p"); empty.className="empty"; empty.textContent="Site usage will appear after your first visit."; usageStats.appendChild(empty);
  } else {
    for(const site of usage) {
      const row=document.createElement("div"); row.className="usage-row";
      const label=document.createElement("strong"); label.textContent=analyticsSiteNames[site.siteKey]||site.siteKey;
      const opens=document.createElement("span"); opens.textContent=site.opens;
      const duration=document.createElement("span"); duration.textContent=formatDuration(site.visibleSeconds);
      const last=document.createElement("span"); last.textContent=site.lastOpenedAt?new Date(site.lastOpenedAt).toLocaleDateString([], {month:"short",day:"numeric"}):"—";
      row.append(label,opens,duration,last); usageStats.appendChild(row);
    }
  }

  const usageHistory=document.querySelector("#usage-history");
  usageHistory.replaceChildren();
  const visits=stats.recentSiteVisits||[];
  if(!visits.length) {
    const empty=document.createElement("p"); empty.className="empty"; empty.textContent="Recent site opens will appear here."; usageHistory.appendChild(empty);
  } else {
    for(const visit of visits) {
      const row=document.createElement("div"); row.className="usage-visit";
      const label=document.createElement("strong"); label.textContent=analyticsSiteNames[visit.siteKey]||visit.siteKey;
      const duration=document.createElement("span"); duration.textContent=formatDuration(visit.visibleSeconds);
      const time=document.createElement("time"); time.dateTime=new Date(visit.startedAt).toISOString(); time.textContent=new Date(visit.startedAt).toLocaleString([], {month:"short",day:"numeric",hour:"numeric",minute:"2-digit"});
      row.append(label,duration,time); usageHistory.appendChild(row);
    }
  }
  const siteStats=document.querySelector("#site-stats");
  siteStats.replaceChildren();
  const topSites=stats.topSites||[];
  if(!topSites.length) {
    const empty=document.createElement("p"); empty.className="empty"; empty.textContent="Blocked distractions will appear here."; siteStats.appendChild(empty);
  } else {
    const maximum=Math.max(...topSites.map((site)=>site.count));
    for(const site of topSites) {
      const row=document.createElement("div"); row.className="ranked-row";
      const label=document.createElement("strong"); label.textContent=analyticsSiteNames[site.siteKey]||site.siteKey;
      const value=document.createElement("span"); value.textContent=site.count;
      const bar=document.createElement("i"); bar.style.width=`${Math.max(8,(site.count/maximum)*100)}%`;
      row.append(label,value,bar); siteStats.appendChild(row);
    }
  }

  const sessionHistory=document.querySelector("#session-history");
  sessionHistory.replaceChildren();
  const recentSessions=stats.recentSessions||[];
  if(!recentSessions.length) {
    const empty=document.createElement("p"); empty.className="empty"; empty.textContent="Your first focus session will appear here."; sessionHistory.appendChild(empty);
  } else {
    for(const session of recentSessions.slice(0,6)) {
      const row=document.createElement("div"); row.className="session-row";
      const summary=document.createElement("div");
      const title=document.createElement("strong"); title.textContent=`${session.durationMinutes} min · ${session.focusLevel==="deep"?"Deep":"Standard"}`;
      const date=document.createElement("time"); date.dateTime=new Date(session.startedAt).toISOString(); date.textContent=new Date(session.startedAt).toLocaleString([], {month:"short",day:"numeric",hour:"numeric",minute:"2-digit"});
      const result=document.createElement("span"); result.className=`session-status ${session.status}`; result.textContent=session.status==="active"?"Active":session.status==="emergency"?"Stopped":"Completed";
      summary.append(title,date); row.append(summary,result); sessionHistory.appendChild(row);
    }
  }
  const browserStats=document.querySelector("#browser-stats");
  browserStats.replaceChildren();
  const browsers=stats.browsers||[];
  if(!browsers.length) {
    const empty=document.createElement("p"); empty.className="empty"; empty.textContent="Browser totals will appear after the first synced event."; browserStats.appendChild(empty);
  } else {
    for(const browser of browsers) {
      const row=document.createElement("div"); row.className="browser-row";
      const label=document.createElement("strong"); label.textContent=browser.browserLabel;
      const sessions=document.createElement("span"); sessions.textContent=browser.sessionsStarted;
      const blocked=document.createElement("span"); blocked.textContent=browser.distractionsBlocked;
      row.append(label,sessions,blocked); browserStats.appendChild(row);
    }
  }
  exceptions.value=(data.feedExceptions||[]).join("\n");
  history.replaceChildren();
  if (!data.emergencyLog?.length) { const empty=document.createElement("p"); empty.className="empty"; empty.textContent="No emergency access has been used."; history.appendChild(empty); return; }
  for (const entry of data.emergencyLog) {
    const row=document.createElement("div"); row.className="history-item";
    const time=document.createElement("time"); time.dateTime=new Date(entry.usedAt).toISOString(); time.textContent=new Date(entry.usedAt).toLocaleString();
    const reason=document.createElement("strong"); reason.textContent=entry.reason;
    const duration=document.createElement("span"); duration.textContent=entry.action==="session_stopped"?"Session stopped":"Emergency";
    row.append(time,reason,duration); history.appendChild(row);
  }
}

document.querySelector("#save").addEventListener("click",async()=>{
  const feedExceptions=[...new Set(exceptions.value.split("\n").map(normalizeLine).filter(Boolean))];
  if(extensionApi) await extensionApi.storage.local.set({feedExceptions});
  exceptions.value=feedExceptions.join("\n"); status.textContent="Saved";
  setTimeout(()=>{status.textContent="";},1800);
});

guardToggle.addEventListener("change",async()=>{
  if(extensionApi)await extensionApi.runtime.sendMessage({type:"SET_ATTENTION_GUARD",enabled:guardToggle.checked});
});

workPassForm.addEventListener("submit",async(event)=>{
  event.preventDefault();
  if(workPassForm.dataset.waiting)return;
  workPassForm.dataset.waiting="true";
  const submit=workPassForm.querySelector('button[type="submit"]');submit.disabled=true;
  const wait=5+Math.floor(Math.random()*11);
  for(let left=wait;left>0;left--){workPassStatus.textContent=`Pause before opening · ${left}s`;await new Promise(resolve=>setTimeout(resolve,1000));}
  workPassForm.dataset.waiting="";submit.disabled=false;workPassStatus.textContent="Starting focused access…";
  const url=document.querySelector("#work-pass-url").value;
  const reason=document.querySelector("#work-pass-reason").value;
  const durationMinutes=Number(document.querySelector("#work-pass-duration").value);
  const response=extensionApi
    ? await extensionApi.runtime.sendMessage({type:"START_WORK_PASS",url,reason,durationMinutes})
    : {ok:true,workPass:{url,reason,minutes:durationMinutes,expiresAt:Date.now()+durationMinutes*60000}};
  if(!response?.ok){workPassStatus.textContent=response?.error||"Could not start the work pass.";return;}
  workPassStatus.textContent=""; renderWorkPass(response.workPass);
  if(extensionApi)await extensionApi.tabs.create({url:response.workPass.url});
});

document.querySelector("#end-work-pass").addEventListener("click",async()=>{
  const response=extensionApi?await extensionApi.runtime.sendMessage({type:"END_WORK_PASS"}):{ok:true};
  if(!response?.ok){workPassStatus.textContent=response?.error||"Could not end the pass.";return;}
  renderWorkPass(null);
});

setInterval(()=>{if(currentWorkPass)renderWorkPass(currentWorkPass);},1000);

accountButton.addEventListener("click",async()=>{
  accountButton.disabled=true; accountStatus.textContent="Opening secure sign-in…";
  const response=await extensionApi.runtime.sendMessage({type:"START_ACCOUNT_LINK"});
  if(!response?.ok){accountButton.disabled=false;accountStatus.textContent=response?.error||"Could not start account connection.";return;}
  renderAccountState({pending:true}); accountStatus.textContent="Finish signing in in the new tab. This page will update automatically.";
  checkAccountConnection().catch((error)=>{accountStatus.textContent=error.message;accountButton.disabled=false;});
});

load().then(()=>checkAccountConnection().catch(()=>{}));
