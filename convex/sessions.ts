import {ConvexError, v} from "convex/values";
import {makeFunctionReference} from "convex/server";
import {mutation, query, internalMutation} from "./_generated/server";
import type {MutationCtx, QueryCtx} from "./_generated/server";
import type {Doc} from "./_generated/dataModel";
import {accountDay} from "./accessRules";

const credentials={userId:v.string(),accessToken:v.string()};
const sessionArgs={...credentials,sessionId:v.string()};
const sites=new Set(["facebook","instagram","threads","linkedin","youtube","reddit","x","tiktok","bookface","gmail"]);
async function authorize(ctx:QueryCtx|MutationCtx,a:{userId:string,accessToken:string}) {
  const c=await ctx.db.query("accountCredentials").withIndex("by_access_token",q=>q.eq("accessToken",a.accessToken)).unique();
  if(!c || c.userId!==a.userId) throw new ConvexError("Sign in to share focus across devices.");
}
async function state(ctx:QueryCtx|MutationCtx,userId:string) {
  return ctx.db.query("focusSyncStates").withIndex("by_user",q=>q.eq("userId",userId)).unique();
}
// This ledger is written only by a server transition. Client retries cannot increment it again.
async function count(ctx:MutationCtx,s:Doc<"focusSyncStates">,reason:"started"|"completed"|"emergency",at:number) {
  const existing=await ctx.db.query("focusEvents").withIndex("by_event_id",q=>q.eq("eventId",`session:${s.sessionId}:${reason==="started"?"started":"ended"}`)).unique();
  if(existing) return;
  const install=await ctx.db.query("installations").withIndex("by_installation",q=>q.eq("installationId",s.updatedByInstallationId)).unique();
  await ctx.db.insert("focusEvents",{userId:s.userId,eventId:`session:${s.sessionId}:${reason==="started"?"started":"ended"}`,installationId:s.updatedByInstallationId,browserId:install?.browserId??"shared",browserLabel:install?.browserLabel??"Shared focus",sessionId:s.sessionId,eventType:reason==="started"?"session_started":"session_ended",occurredAt:at,...(reason==="started"?{plannedMinutes:s.durationMinutes,focusLevel:s.focusLevel}:{endReason:reason})});
  const stats=await ctx.db.query("userStats").withIndex("by_user",q=>q.eq("userId",s.userId)).unique();
  const zero={sessionsStarted:0,completedSessions:0,emergencyStops:0,distractionsBlocked:0,plannedMinutes:0,completedMinutes:0};
  const delta={sessionsStarted:Number(reason==="started"),completedSessions:Number(reason==="completed"),emergencyStops:Number(reason==="emergency"),distractionsBlocked:0,plannedMinutes:reason==="started"?s.durationMinutes:0,completedMinutes:reason==="completed"?s.durationMinutes:0};
  const value={...zero};
  for(const k of Object.keys(zero) as (keyof typeof zero)[]) value[k]=(stats?.[k]??0)+delta[k];
  if(stats) await ctx.db.patch(stats._id,{...value,updatedAt:at});
  else await ctx.db.insert("userStats",{userId:s.userId,...value,updatedAt:at});
  const config=await ctx.db.query("accessAccounts").withIndex("by_user",q=>q.eq("userId",s.userId)).unique();
  const day=accountDay(at,config?.timeZone??"UTC");
  const d=await ctx.db.query("dailyStats").withIndex("by_user_day",q=>q.eq("userId",s.userId).eq("day",day)).unique();
  const daily={sessionsStarted:(d?.sessionsStarted??0)+delta.sessionsStarted,completedSessions:(d?.completedSessions??0)+delta.completedSessions,distractionsBlocked:d?.distractionsBlocked??0,plannedMinutes:(d?.plannedMinutes??0)+delta.plannedMinutes,completedMinutes:(d?.completedMinutes??0)+delta.completedMinutes};
  if(d) await ctx.db.patch(d._id,{...daily,updatedAt:at}); else await ctx.db.insert("dailyStats",{userId:s.userId,day,...daily,updatedAt:at});
  if(reason==="started" && install) await ctx.db.patch(install._id,{sessionsStarted:install.sessionsStarted+1,lastSeenAt:at});
}
async function finish(ctx:MutationCtx,s:Doc<"focusSyncStates">,reason:"completed"|"emergency") {
  if(!s.active) return;
  const at=reason==="completed"?s.sessionEnd:Date.now();
  await ctx.db.patch(s._id,{active:false,endReason:reason,updatedAt:Date.now(),emergencyReadyAt:undefined});
  const row=await ctx.db.query("focusSessions").withIndex("by_session_id",q=>q.eq("sessionId",s.sessionId)).unique();
  if(row) await ctx.db.patch(row._id,{status:reason,endedAt:at,updatedAt:at});
  await count(ctx,s,reason,at);
}
export const get=query({args:credentials,handler:async(ctx,a)=>{
  await authorize(ctx,a);return {serverNow:Date.now(),session:await state(ctx,a.userId)};
}});
export const start=mutation({args:{...credentials,installationId:v.string(),requestId:v.string(),minutes:v.number(),focusLevel:v.union(v.literal("standard"),v.literal("deep")),siteKeys:v.array(v.string())},handler:async(ctx,a)=>{
  await authorize(ctx,a);
  const install=await ctx.db.query("installations").withIndex("by_installation",q=>q.eq("installationId",a.installationId)).unique();
  if(install?.userId!==a.userId) throw new ConvexError("Register this device before starting focus.");
  if(!Number.isInteger(a.minutes)||a.minutes<1||a.minutes>240||a.requestId.length<16||a.requestId.length>100||!a.siteKeys.length||a.siteKeys.some(s=>!sites.has(s))) throw new ConvexError("Choose sites and a focus duration of 1–240 minutes.");
  const now=Date.now();let current=await state(ctx,a.userId);
  if(current?.active && current.sessionEnd>now) return {serverNow:now,session:current};
  if(current?.active && current.serverManaged) await finish(ctx,current,"completed");
  const used=await ctx.db.query("focusSessions").withIndex("by_session_id",q=>q.eq("sessionId",a.requestId)).unique();
  if(used || current?.sessionId===a.requestId) throw new ConvexError("This session already ended. Start a new session.");
  const data={userId:a.userId,sessionId:a.requestId,sessionStart:now,sessionEnd:now+a.minutes*60000,durationMinutes:a.minutes,focusLevel:a.focusLevel,siteKeys:[...new Set(a.focusLevel==="deep"?[...a.siteKeys,"gmail"]:a.siteKeys.filter(s=>s!=="gmail"))],active:true,updatedAt:now,updatedByInstallationId:a.installationId,serverManaged:true};
  if(!data.siteKeys.length) throw new ConvexError("Select a distracting site for Standard focus.");
  const id=current?current._id:await ctx.db.insert("focusSyncStates",data);
  if(current) await ctx.db.replace(id,data);
  const next=(await ctx.db.get(id))!;
  await ctx.db.insert("focusSessions",{userId:a.userId,sessionId:a.requestId,startedAt:now,scheduledEndAt:data.sessionEnd,durationMinutes:a.minutes,focusLevel:a.focusLevel,siteKeys:data.siteKeys,status:"active",startedByInstallationId:a.installationId,updatedAt:now,serverManaged:true});
  await count(ctx,next,"started",now);
  const grants=await ctx.db.query("accessGrants").withIndex("by_user_start",q=>q.eq("userId",a.userId)).order("desc").take(100);
  for(const g of grants) if(!g.ended && g.expiresAt>now) await ctx.db.patch(g._id,{ended:true});
  await ctx.scheduler.runAt(data.sessionEnd,makeFunctionReference<"mutation">("sessions:expire"),{userId:a.userId,sessionId:a.requestId});
  return {serverNow:now,session:next};
}});
export const beginEmergency=mutation({args:sessionArgs,handler:async(ctx,a)=>{
  await authorize(ctx,a);const s=await state(ctx,a.userId);
  if(!s?.active || s.sessionId!==a.sessionId || s.sessionEnd<=Date.now()) throw new ConvexError("This focus session has already ended. Sync again.");
  const readyAt=s.emergencyReadyAt??Date.now()+30000;
  await ctx.db.patch(s._id,{emergencyReadyAt:readyAt});
  return {readyAt,serverNow:Date.now()};
}});
export const stop=mutation({args:{...sessionArgs,phrase:v.string()},handler:async(ctx,a)=>{
  await authorize(ctx,a);const s=await state(ctx,a.userId);
  if(!s || s.sessionId!==a.sessionId) throw new ConvexError("The focus session changed. Sync and try again.");
  if(s.active) {
    if(s.sessionEnd<=Date.now()) await finish(ctx,s,"completed");
    else {
      if(!s.emergencyReadyAt || Date.now()<s.emergencyReadyAt || a.phrase.trim().toLowerCase()!=="end my focus") throw new ConvexError("Wait 30 seconds, then type the confirmation phrase.");
      await finish(ctx,s,"emergency");
    }
  }
  return {serverNow:Date.now(),session:await state(ctx,a.userId)};
}});
export const expire=internalMutation({args:{userId:v.string(),sessionId:v.string()},handler:async(ctx,a)=>{
  const s=await state(ctx,a.userId);
  if(s?.serverManaged && s.active && s.sessionId===a.sessionId && s.sessionEnd<=Date.now()) await finish(ctx,s,"completed");
}});
