import assert from "node:assert/strict";
import { CONFIG } from "../config.js";
// All cloud responses in this suite are mocked; no network calls are made.
CONFIG.convexUrl = "https://test.convex.cloud";
CONFIG.accountConnectUrl = "https://example.test/tranquil-connect/";
let fakeNow=1_800_000_000_000;
Date.now=()=>fakeNow;
const stored={};
const synced={};
let dynamicRules=[];
let tabs=[{id:1,url:"https://www.threads.com/"},{id:2,url:"https://example.com/work"}];
const updatedTabs=[];
const alarmTimes=new Map();
const listeners={};
const convexEvents=[];
const usageEvents=[];
const usageBatches=[];
let usageUploadHook=null;
const feedAccessEvents=[];
let remoteSync=null;
let sharedOffline=false;
const userIds=[];
const registeredUsers=new Map();

globalThis.fetch=async(_url,options)=>{
  const request=JSON.parse(options.body);
  if(sharedOffline && /^(sessions|access):/.test(request.path))throw new Error("offline");
  const reply=value=>({ok:true,async json(){return {status:"success",value};}});
  if(request.path==="access:status")return reply({enabled:true,serverNow:fakeNow,policies:["facebook","linkedin","reddit","youtube"].map(siteKey=>({siteKey,blocked:false,used:0,limit:3,maxMinutes:10})),grants:[]});
  if(request.path==="sessions:get")return reply({serverNow:fakeNow,session:remoteSync});
  if(request.path==="sessions:start"){
    if(!remoteSync?.active || remoteSync.sessionEnd<=fakeNow)remoteSync={sessionId:request.args.requestId,sessionStart:fakeNow,sessionEnd:fakeNow+request.args.minutes*60000,durationMinutes:request.args.minutes,focusLevel:request.args.focusLevel,siteKeys:request.args.siteKeys,serverManaged:true,active:true};
    return reply({serverNow:fakeNow,session:remoteSync});
  }
  if(request.path==="sessions:beginEmergency"){
    remoteSync.emergencyReadyAt??=fakeNow+30000;return reply({serverNow:fakeNow,readyAt:remoteSync.emergencyReadyAt});
  }
  if(request.path==="sessions:stop"){
    assert.equal(request.args.sessionId,remoteSync.sessionId);assert.ok(fakeNow>=remoteSync.emergencyReadyAt);
    remoteSync={...remoteSync,active:false,endReason:"emergency"};return reply({serverNow:fakeNow,session:remoteSync});
  }
  if(request.path==="focus:registerClient") {
    userIds.push(request.args.userId);
    registeredUsers.set(request.args.userId,request.args.accessToken);
    return {ok:true,async json(){return {status:"success",value:{userId:request.args.userId}};}};
  }
  if(request.path==="focus:getSession") {
    userIds.push(request.args.userId);
    assert.equal(registeredUsers.get(request.args.userId),request.args.accessToken);
    return {ok:true,async json(){return {status:"success",value:remoteSync};}};
  }
  if(request.path==="focus:publishSession") {
    userIds.push(request.args.userId);
    if(!remoteSync||remoteSync.updatedAt<=request.args.updatedAt) remoteSync={...request.args};
    return {ok:true,async json(){return {status:"success",value:"sync-id"};}};
  }
  if(request.path==="focus:recordEvent") {
    userIds.push(request.args.userId);
    if(!convexEvents.some((event)=>event.eventId===request.args.eventId)) convexEvents.push(request.args);
    return {ok:true,async json(){return {status:"success",value:"event-id"};}};
  }
  if(request.path==="focus:recordUsageBatch") {
    usageBatches.push(structuredClone(request.args.events));
    if (usageUploadHook) await usageUploadHook(request.args.events);
    for(const event of request.args.events) {
      if(!usageEvents.some(saved=>saved.eventId===event.eventId)) usageEvents.push({...event,userId:request.args.userId});
    }
    return reply({accepted:request.args.events.length});
  }
  if(request.path==="focus:recordFeedAccess") {
    if(!feedAccessEvents.some((event)=>event.eventId===request.args.eventId)) feedAccessEvents.push(request.args);
    return {ok:true,async json(){return {status:"success",value:{count:feedAccessEvents.filter((event)=>event.userId===request.args.userId&&event.localDay===request.args.localDay).length}};}};
  }
  if(request.path==="focus:summary") {
    userIds.push(request.args.userId);
    const mine=convexEvents.filter((event)=>event.userId===request.args.userId);
    return {ok:true,async json(){return {status:"success",value:{
      sessionsStarted:mine.filter((event)=>event.eventType==="session_started").length,
      completedSessions:mine.filter((event)=>event.endReason==="completed").length,
      emergencyStops:mine.filter((event)=>event.endReason==="emergency").length,
      distractionsBlocked:mine.filter((event)=>event.eventType==="distraction_blocked").length,
      plannedMinutes:mine.filter((event)=>event.eventType==="session_started").reduce((sum,event)=>sum+(event.plannedMinutes||0),0),
      completedMinutes:mine.filter((event)=>event.endReason==="completed").reduce((sum,event)=>sum+(event.plannedMinutes||0),0),
      feedUnblocksToday:feedAccessEvents.filter((event)=>event.userId===request.args.userId&&event.localDay===request.args.localDay).length,
      feedUnblocksRecent:feedAccessEvents.filter((event)=>event.userId===request.args.userId).length,
      feedUnblocksDay:request.args.localDay,
      topSites:[],browsers:[],recentSessions:[],siteUsage:[],recentSiteVisits:[],usageDays:[]
    }};}};
  }
  throw new Error(`Unexpected Convex path ${request.path}`);
};

function event(name) { return {addListener(fn){listeners[name]=fn;}}; }
globalThis.chrome={
  storage:{
    local:{async get(defaults){return {...defaults,...stored};},async set(values){Object.assign(stored,values);}},
    sync:{async get(defaults){return {...defaults,...synced};},async set(values){Object.assign(synced,values);}}
  },
  declarativeNetRequest:{
    async getDynamicRules(){return dynamicRules;},
    async updateDynamicRules({removeRuleIds=[],addRules=[]}){dynamicRules=dynamicRules.filter((rule)=>!removeRuleIds.includes(rule.id));dynamicRules.push(...addRules);}
  },
  alarms:{async get(name){return alarmTimes.has(name)?{name}:undefined;},async create(name,{when,periodInMinutes}){alarmTimes.set(name,when??`every:${periodInMinutes}`);},async clear(name){alarmTimes.delete(name);},onAlarm:event("alarm")},
  tabs:{
    async query(){return tabs;},
    async get(id){return tabs.find(tab=>tab.id===id);},
    async update(id,change){updatedTabs.push({id,...change});const tab=tabs.find((item)=>item.id===id);if(tab)Object.assign(tab,change);},
    onUpdated:event("tabUpdated"),
    onRemoved:event("tabRemoved")
  },
  webNavigation:{onBeforeNavigate:event("beforeNavigate"),onCommitted:event("committed"),onHistoryStateUpdated:event("historyUpdated")},
  runtime:{getURL(path){return `chrome-extension://test/${path}`;},onInstalled:event("installed"),onStartup:event("startup"),onMessage:event("message")}
};

await import("../background.js");

function send(message,sender={}) {
  return new Promise((resolve,reject)=>{const keepOpen=listeners.message(message,sender,resolve);if(!keepOpen)reject(new Error(`No async response for ${message.type}`));});
}
const flush=()=>new Promise((resolve)=>setTimeout(resolve,0));

// Notification conversion does not rely on any content script being loaded.
const notificationUrl="https://www.linkedin.com/feed/?highlightedUpdateUrn=urn%3Ali%3Aactivity%3A7508649276630265856&highlightedUpdateType=RESHARED_YOUR_UPDATE&origin=inapp&showCommentBox=true";
const postUrl="https://www.linkedin.com/feed/update/urn:li:activity:7508649276630265856/?showCommentBox=true";
tabs.push({id:99,url:notificationUrl});
for (const name of ["committed","historyUpdated"]) {
  tabs.find(tab=>tab.id===99).url=notificationUrl;
  const before=JSON.stringify(dynamicRules);
  await listeners[name]({tabId:99,frameId:0,url:notificationUrl});
  assert.equal(tabs.find(tab=>tab.id===99).url,postUrl);
  assert.equal(JSON.stringify(dynamicRules),before,"notification navigation must not add allow rules or weaken blocking");
}
const updatesBefore=updatedTabs.length;
await listeners.committed({tabId:99,frameId:0,url:notificationUrl});
assert.equal(updatedTabs.length,updatesBefore,"a stale event must not replace a newer URL");
tabs.find(tab=>tab.id===99).url=notificationUrl;
await listeners.committed({tabId:99,frameId:1,url:notificationUrl});
assert.equal(updatedTabs.length,updatesBefore,"ignore subframes");
tabs.find(tab=>tab.id===99).pendingUrl="https://www.linkedin.com/messaging/";
await listeners.committed({tabId:99,frameId:0,url:notificationUrl});
assert.equal(updatedTabs.length,updatesBefore,"do not interrupt a newer pending navigation");
tabs=tabs.filter(tab=>tab.id!==99);
updatedTabs.length=0;

const initial=await send({type:"GET_STATE"});
assert.equal(initial.ok,true);
assert.deepEqual(initial.sites.threads.domains,["threads.com"]);
assert.deepEqual(initial.sites.bookface.domains,["bookface.ycombinator.com"]);
assert.equal(initial.limits.minSessionMinutes,5);

const feedPause=await send({type:"REQUEST_FEED_DISABLE"});
const globalFeedDelay=feedPause.feedDisableRequest.availableAt-fakeNow;
assert.ok(globalFeedDelay>=5*1000&&globalFeedDelay<=15*1000,"global feed pause must be randomized between 5 and 15 seconds");
assert.equal(feedPause.feedDisableRequest.attemptNumber,1);
assert.equal(globalFeedDelay%1000,0,"the randomized wait should use whole seconds");
assert.equal((await send({type:"CONFIRM_FEED_DISABLE"})).ok,false,"feed removal cannot be disabled before the pause finishes");
fakeNow+=globalFeedDelay;
assert.equal((await send({type:"CONFIRM_FEED_DISABLE"})).feedBlockingEnabled,false);
assert.equal(stored.feedDisableRequest,null);

stored.enabledSites={...stored.enabledSites,youtube:true};
const sitePause=await send({type:"REQUEST_SITE_DISABLE",siteKey:"youtube"});
const siteFeedDelay=sitePause.siteDisableRequest.availableAt-fakeNow;
assert.ok(siteFeedDelay>=20*1000&&siteFeedDelay<=30*1000,"the second feed opening today must add 15 seconds of friction");
assert.equal(sitePause.siteDisableRequest.attemptNumber,2);
assert.equal(siteFeedDelay%1000,0);
assert.equal((await send({type:"CONFIRM_SITE_DISABLE",siteKey:"youtube"})).ok,false,"one feed cannot be opened before its pause finishes");
fakeNow+=siteFeedDelay;
const siteAllowed=await send({type:"CONFIRM_SITE_DISABLE",siteKey:"youtube"});
assert.equal(siteAllowed.enabledSites.youtube,false);
assert.equal(stored.siteDisableRequest,null);
stored.enabledSites={...stored.enabledSites,youtube:true};

await send({type:"RECORD_SITE_USAGE",eventId:"usage:visit-1:open",visitId:"visit-1",siteKey:"facebook",eventType:"site_opened",occurredAt:fakeNow});
await send({type:"RECORD_SITE_USAGE",eventId:"usage:visit-1:time-1",visitId:"visit-1",siteKey:"facebook",eventType:"visible_time",occurredAt:fakeNow+10000,durationSeconds:10});
assert.equal(usageEvents.length,0,"usage must wait for the batch alarm");
assert.equal(stored.usageQueue.length,2);
await listeners.alarm({name:"tranquil-usage-upload"});
assert.equal(usageBatches.length,1,"two events share one upload");
assert.equal(stored.usageQueue.length,0);
assert.equal(usageEvents.filter((event)=>event.eventType==="site_opened").length,1,"site opens must be delivered to Convex");
assert.equal(usageEvents.filter((event)=>event.eventType==="visible_time").reduce((sum,event)=>sum+event.durationSeconds,0),10,"visible site time must be delivered to Convex");
assert.equal(usageEvents.some((event)=>"url" in event||"title" in event),false,"usage analytics must not contain URLs or page titles");

stored.feedBlockingEnabled=false;
let guardState;
for(let heartbeat=0;heartbeat<30;heartbeat+=1) {
  guardState=await send({type:"FEED_ACTIVITY",siteKey:"youtube"});
  if(heartbeat<29) assert.equal(guardState.warning,false);
  if(heartbeat<29) fakeNow+=10*1000;
}
assert.equal(guardState.warning,true,"five active minutes should start the warning");
assert.equal(guardState.warningEndsAt,fakeNow+60*1000);
assert.equal(alarmTimes.get("stillspace-feed-guard:youtube"),fakeNow+60*1000);
listeners.alarm({name:"stillspace-feed-guard:youtube"});
await flush();await flush();
assert.equal(stored.feedBlockingEnabled,true,"the warning alarm restores feed blocking");
assert.equal(stored.enabledSites.youtube,true);
assert.equal(stored.feedUsage.youtube,undefined);

stored.enabledSites={...stored.enabledSites,facebook:false};
stored.feedBlockingEnabled=true;
await send({type:"FEED_ACTIVITY",siteKey:"facebook"});
fakeNow+=10*1000;
await send({type:"FEED_ACTIVITY",siteKey:"facebook"});
fakeNow+=60*1000;
await send({type:"FEED_ACTIVITY",siteKey:"facebook"});
assert.ok(stored.feedUsage.facebook.activeMs>=35*1000,"ordinary reading pauses must not reset visible feed time");
const facebookWatchdog=alarmTimes.get("stillspace-feed-limit:facebook");
assert.ok(facebookWatchdog>fakeNow,"a background watchdog must back up content-script heartbeats");
fakeNow=facebookWatchdog;
listeners.alarm({name:"stillspace-feed-limit:facebook"});
await flush();await flush();
assert.equal(stored.feedUsage.facebook.warningEndsAt,fakeNow+60*1000,"the watchdog must start the warning at five minutes");
fakeNow=stored.feedUsage.facebook.warningEndsAt;
listeners.alarm({name:"stillspace-feed-guard:facebook"});
await flush();await flush();
assert.equal(stored.enabledSites.facebook,true,"the watchdog warning must ultimately restore feed blocking");
assert.equal(stored.guardBlockedSites.facebook,true,"attention guard must record that Facebook feed access was restored");
const guardOff=await send({type:"SET_ATTENTION_GUARD",enabled:false});
assert.equal(guardOff.attentionGuardEnabled,false);
assert.deepEqual(stored.feedUsage,{},"turning the guard off must clear accumulated usage");
assert.deepEqual(stored.guardBlockedSites,{},"turning the guard off must clear route-independent fallback blocks");
stored.enabledSites.facebook=false;
assert.equal((await send({type:"FEED_ACTIVITY",siteKey:"facebook"})).monitoring,false);
const guardOn=await send({type:"SET_ATTENTION_GUARD",enabled:true});
assert.equal(guardOn.attentionGuardEnabled,true);
await send({type:"FEED_ACTIVITY",siteKey:"facebook"});
assert.ok(stored.feedUsage.facebook,"a visible visit should create a counter");
const leftPage=await send({type:"FEED_INACTIVE",siteKey:"facebook"});
assert.equal(leftPage.paused,true);
assert.equal(stored.feedUsage.facebook,undefined,"leaving the page must reset its concentrated-usage counter");
assert.equal(alarmTimes.has("stillspace-feed-limit:facebook"),false,"leaving the page must cancel its watchdog");
assert.equal(alarmTimes.has("stillspace-feed-guard:facebook"),false,"leaving the page must cancel its warning");
stored.enabledSites.facebook=true;

const invalid=await send({type:"START_SESSION",durationMinutes:4});
assert.equal(invalid.ok,false);

tabs.push({id:3,url:"https://accounts.youtube.com/accounts/CheckConnection"});
const started=await send({type:"START_SESSION",durationMinutes:45,focusLevel:"standard"});
assert.equal(started.ok,true,JSON.stringify(started));
assert.equal(started.sessionEnd,fakeNow+45*60*1000);
assert.equal(dynamicRules.length,10);
assert.match(dynamicRules[0].condition.regexFilter,/threads\\\.com/);
assert.equal(dynamicRules.some((rule)=>rule.condition.regexFilter.includes("mail\\.google\\.com")),false);
const youtubeRule=dynamicRules.find((rule)=>rule.condition.regexFilter.includes("youtube\\.com"));
assert.deepEqual(youtubeRule.condition.excludedRequestDomains,["accounts.youtube.com"],"Google's YouTube authentication handoff must remain available during focus");
assert.equal(updatedTabs.some((update)=>update.id===3),false,"an open Google authentication handoff must never be redirected to the blocked page");
tabs=tabs.filter((tab)=>tab.id!==3);
assert.match(updatedTabs[0].url,/source=session_start/,"automatic redirects must not count as resisted distractions");
const threadsReturn=await send({type:"GET_RETURN_URL",siteKey:"threads"},{tab:{id:1}});
assert.equal(threadsReturn.returnUrl,"https://www.threads.com/","the original tab URL must be retained");
await flush();

const distraction=await send({type:"RECORD_DISTRACTION",siteKey:"threads"});
assert.equal(distraction.recorded,true);
const standardGmail=await send({type:"RECORD_DISTRACTION",siteKey:"gmail"});
assert.equal(standardGmail.recorded,false,"Standard focus must leave Gmail available");

const emergencyRequested=await send({type:"REQUEST_EMERGENCY",reason:"A family member needs an urgent response"});
assert.equal(emergencyRequested.ok,true);
assert.equal(emergencyRequested.emergencyRequest.availableAt,fakeNow+30*1000);
assert.equal(dynamicRules.length,10,"blocking remains active during the pause");

const tooEarly=await send({type:"CONFIRM_EMERGENCY",phrase:emergencyRequested.emergencyRequest.phrase});
assert.equal(tooEarly.ok,false);
fakeNow+=30*1000;
const emergency=await send({type:"CONFIRM_EMERGENCY",phrase:emergencyRequested.emergencyRequest.phrase});
assert.equal(emergency.ok,true);
assert.equal(emergency.sessionEnded,true);
assert.equal(stored.sessionEnd,null,"successful emergency access ends the session");
assert.equal(dynamicRules.length,1,"the always-on YouTube policy remains after an emergency stop");
assert.equal(stored.emergencyLog.length,1);
assert.equal(stored.emergencyLog[0].action,"session_stopped");

tabs.push({id:3,url:"https://mail.google.com/mail/u/0/#inbox"});
const secondStarted=await send({type:"START_SESSION",durationMinutes:15,focusLevel:"deep"});
assert.equal(secondStarted.ok,true);
assert.equal(stored.sessionFocusLevel,"deep");
assert.equal(dynamicRules.length,11);
assert.equal(dynamicRules.some((rule)=>rule.condition.regexFilter==="^https?://mail\\.google\\.com(/.*)?$"),true);
assert.match(tabs.find((tab)=>tab.id===3).url,/blocked\.html\?site=gmail&source=session_start/);
const primaryGmailReturn=await send({type:"GET_RETURN_URL",siteKey:"gmail"},{tab:{id:3}});
assert.equal(primaryGmailReturn.returnUrl,"https://mail.google.com/mail/u/0/#inbox");
listeners.beforeNavigate({tabId:4,frameId:0,url:"https://mail.google.com/mail/u/1/#inbox"});
await flush();await flush();
const secondaryGmailReturn=await send({type:"GET_RETURN_URL",siteKey:"gmail"},{tab:{id:4}});
assert.equal(secondaryGmailReturn.returnUrl,"https://mail.google.com/mail/u/1/#inbox","each Gmail account must retain its own exact route");
const gmailDistraction=await send({type:"RECORD_DISTRACTION",siteKey:"gmail"});
assert.equal(gmailDistraction.recorded,true);
fakeNow=secondStarted.sessionEnd;
listeners.alarm({name:"stillspace-session-end"});
await flush();await flush();
assert.equal(stored.sessionEnd,null);
assert.equal(dynamicRules.length,1,"the always-on YouTube policy remains after focus completes");

const invalidWorkPass=await send({type:"START_WORK_PASS",url:"https://example.com",reason:"Research a launch",durationMinutes:15});
assert.equal(invalidWorkPass.ok,false,"work passes must not create arbitrary browsing exceptions");
const workPass=await send({type:"START_WORK_PASS",url:"https://www.youtube.com/watch?v=abc123XYZ_0&t=45",reason:"Review the launch interview",durationMinutes:15});
assert.equal(workPass.ok,true);
assert.equal(workPass.workPass.url,"https://www.youtube.com/watch?v=abc123XYZ_0");
assert.equal(dynamicRules.length,2,"a work pass adds one narrow high-priority allow rule");
assert.equal(dynamicRules.some((rule)=>rule.action.type==="allow"&&rule.priority===100),true);
assert.equal(alarmTimes.get("tranquil-work-pass-end"),workPass.workPass.expiresAt);
assert.equal((await send({type:"END_WORK_PASS"})).ended,true);
assert.equal(dynamicRules.length,1,"ending a work pass restores strict YouTube blocking");
const blockedPolicy=await send({type:"SET_SITE_POLICY",siteKey:"instagram",level:"blocked",maxMinutes:10});
assert.equal(blockedPolicy.sitePolicies.instagram.level,"blocked");
assert.equal(dynamicRules.length,2,"fully blocked sites receive persistent rules");
const rejectedBlockedPass=await send({type:"START_WORK_PASS",url:"https://www.instagram.com/p/abc123/",reason:"Review campaign creative",durationMinutes:10});
assert.equal(rejectedBlockedPass.ok,false,"fully blocked sites must reject work passes");
await send({type:"SET_SITE_POLICY",siteKey:"instagram",level:"feed_only",maxMinutes:10});
assert.equal(dynamicRules.length,1);

const stats=await send({type:"GET_STATS"});
assert.equal(stats.ok,true);
assert.equal(stats.stats.sessionsStarted,2);
assert.equal(stats.stats.distractionsBlocked,2);
assert.equal(stats.stats.emergencyStops,1);
assert.equal(stats.stats.completedSessions,1);
assert.equal(stats.stats.plannedMinutes,60);
assert.equal(stats.stats.feedUnblocksToday,2,"confirmed global and individual feed openings must count for the local day");
assert.equal(stats.stats.feedUnblocksRecent,2,"analytics must expose recent repeated feed openings");
assert.equal(feedAccessEvents.length,2,"feed-access events must be delivered idempotently to Convex");
assert.deepEqual(feedAccessEvents.map((event)=>event.scope),["all","site"]);
assert.equal(feedAccessEvents[1].siteKey,"youtube");
assert.equal(convexEvents.some((event)=>event.siteKey==="threads"),true);
assert.equal(convexEvents.some((event)=>event.siteKey==="gmail"),true);
assert.equal(convexEvents.some((event)=>event.focusLevel==="deep"),true);
assert.equal(convexEvents.some((event)=>"url" in event),false,"analytics must not store attempted URLs");
assert.ok(stored.userId&&stored.accessToken,"the extension must create an anonymous user identity");
assert.equal(synced.userId,stored.userId,"the user identity should follow the browser sync profile");
assert.equal(userIds.every((value)=>value===userIds[0]),true,"every backend operation must be scoped to one user");

remoteSync={
  userId:userIds[0],sessionId:"remote-session",sessionStart:fakeNow,sessionEnd:fakeNow+20*60*1000,
  durationMinutes:20,focusLevel:"deep",siteKeys:["threads","gmail"],active:true,updatedAt:fakeNow+1,updatedByInstallationId:"brave-install"
};
listeners.alarm({name:"stillspace-cross-browser-sync"});
await flush();await flush();
assert.equal(stored.clientSessionId,"remote-session","a session from another browser must be adopted");
assert.equal(stored.sessionFocusLevel,"deep");
assert.deepEqual(stored.sessionSiteKeys,["threads","gmail"]);
assert.equal(dynamicRules.length,3);

remoteSync={...remoteSync,active:false,endReason:"emergency",updatedAt:fakeNow+2};
listeners.alarm({name:"stillspace-cross-browser-sync"});
await flush();await flush();
assert.equal(stored.sessionEnd,null,"a stop from another browser must clear local blocking");
assert.equal(dynamicRules.length,1);

console.log("background behavior, cross-browser sync, and Convex stats checks passed");

stored.accountConnected=true;remoteSync=null;
const shared=await send({type:"START_SESSION",durationMinutes:30,focusLevel:"deep"});
assert.equal(shared.ok,true);assert.equal(stored.serverManagedSession,true);
assert.equal(stored.clientSessionId,remoteSync.sessionId);
assert.equal(stored.sessionEnd,remoteSync.sessionEnd);
sharedOffline=true;
await send({type:"GET_STATE"});
assert.equal(stored.sessionEnd,shared.sessionEnd,"offline reconciliation preserves the cached deadline");
assert.ok(stored.focusSyncError);
const denied=await send({type:"REQUEST_EMERGENCY",reason:"An urgent work emergency"});
assert.equal(denied.ok,false,"offline cannot create a new shared emergency bypass");
assert.equal(stored.sessionEnd,shared.sessionEnd);
sharedOffline=false;
const pause=await send({type:"REQUEST_EMERGENCY",reason:"An urgent work emergency"});
assert.equal(pause.emergencyRequest.availableAt-fakeNow,30000);
assert.equal((await send({type:"CONFIRM_EMERGENCY",phrase:"end my focus"})).ok,false);
fakeNow+=30000;sharedOffline=true;
assert.equal((await send({type:"CONFIRM_EMERGENCY",phrase:"end my focus"})).ok,false);
assert.equal(stored.sessionEnd,shared.sessionEnd,"failed stop must not clear blocking");
sharedOffline=false;
assert.equal((await send({type:"CONFIRM_EMERGENCY",phrase:"end my focus"})).ok,true);
assert.equal(stored.sessionEnd,null);assert.equal(remoteSync.active,false);
remoteSync={sessionId:"phone-focus-session",sessionStart:fakeNow,sessionEnd:fakeNow+60000,durationMinutes:1,focusLevel:"standard",siteKeys:["threads"],serverManaged:true,active:true};
await send({type:"GET_STATE"});
assert.equal(stored.clientSessionId,"phone-focus-session");
assert.deepEqual(stored.sessionSiteKeys,["threads"],"desktop adopts the phone’s exact protected sites");
const before=convexEvents.length;
fakeNow+=60001;sharedOffline=true;
await send({type:"GET_STATE"});await flush();
assert.equal(stored.sessionEnd,null,"cached restrictions expire at the original deadline while offline");
assert.equal(convexEvents.length,before,"desktop never uploads duplicate completion for a server-owned session");
assert.equal((await send({type:"START_SESSION",durationMinutes:30,focusLevel:"standard"})).ok,false,"new shared sessions need server acknowledgement");
assert.equal(stored.sessionEnd,null);
console.log("connected desktop/phone session, offline retention, and shared emergency checks passed");

// An event appended while an upload is in flight must not be overwritten by its acknowledgment.
const usageMessage=id=>({type:"RECORD_SITE_USAGE",eventId:id,visitId:"queue-race",siteKey:"reddit",eventType:"visible_time",durationSeconds:10,occurredAt:fakeNow});
await send(usageMessage("race-a"));
usageUploadHook=async()=>{usageUploadHook=null;await send(usageMessage("race-b"));};
await listeners.alarm({name:"tranquil-usage-upload"});
assert.ok(usageEvents.some(e=>e.eventId==="race-a"));
assert.ok(usageEvents.some(e=>e.eventId==="race-b"));
assert.equal(stored.usageQueue.length,0);
// Offline and ambiguous acknowledgments keep the queue; retry uses identical IDs.
await send(usageMessage("retry-a"));
usageUploadHook=async()=>{throw new Error("offline");};
await listeners.alarm({name:"tranquil-usage-upload"});
assert.equal(stored.usageQueue.length,1);
assert.equal(stored.usageQueue[0].eventId,"retry-a");
usageUploadHook=null;
await listeners.alarm({name:"tranquil-usage-upload"});
assert.equal(stored.usageQueue.length,0);
assert.equal(usageEvents.filter(e=>e.eventId==="retry-a").length,1);
// Recover a backlog from storage in bounded batches; no event is discarded.
stored.usageQueue=Array.from({length:120},(_,i)=>({...usageMessage(`backlog-${i}`),installationId:stored.installationId}));
const batchStart=usageBatches.length;
await listeners.alarm({name:"tranquil-usage-upload"});
assert.deepEqual(usageBatches.slice(batchStart).map(b=>b.length),[50,50,20]);
assert.equal(stored.usageQueue.length,0);
const emptyStart=usageBatches.length;
await listeners.alarm({name:"tranquil-usage-upload"});
assert.equal(usageBatches.length,emptyStart,"idle alarms send no analytics requests");
console.log("Usage batching, concurrent appends, offline retries and backlog recovery passed.");
