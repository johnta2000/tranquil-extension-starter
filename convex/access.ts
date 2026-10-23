import { mutation, query } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import type { QueryCtx, MutationCtx } from "./_generated/server";
import { accountDay, allowance, maxMinutes, services, workDestination } from "./accessRules";
const credentials = {userId:v.string(), accessToken:v.string()};
async function owner(ctx: QueryCtx | MutationCtx, args: {userId:string, accessToken:string}) {
  const c = await ctx.db.query("accountCredentials").withIndex("by_access_token", q => q.eq("accessToken", args.accessToken)).unique();
  if (!c || c.userId !== args.userId) throw new ConvexError("Connect your Clerk account before using shared allowances.");
}
async function account(ctx: QueryCtx | MutationCtx, args: {userId:string, accessToken:string}) {
  await owner(ctx,args);
  return ctx.db.query("accessAccounts").withIndex("by_user", q=>q.eq("userId",args.userId)).unique();
}
export const enable = mutation({args:{...credentials,timeZone:v.string()}, handler:async(ctx,a)=>{
  const existing = await account(ctx,a);
  if (existing) return;
  try { accountDay(Date.now(),a.timeZone); } catch { throw new ConvexError("Invalid account timezone."); }
  await ctx.db.insert("accessAccounts",{userId:a.userId,timeZone:a.timeZone,createdAt:Date.now()});
}});
export const status = query({args:credentials,handler:async(ctx,a)=>{
  const config = await account(ctx,a);
  if (!config) return {enabled:false,serverNow:Date.now(),policies:[],grants:[],mobile:null};
  const now=Date.now(), day=accountDay(now,config.timeZone);
  const policies = await Promise.all(services.map(async siteKey=>{
    const p=await ctx.db.query("accessPolicies").withIndex("by_user_site",q=>q.eq("userId",a.userId).eq("siteKey",siteKey)).unique();
    const d=await ctx.db.query("accessDays").withIndex("by_user_site_day",q=>q.eq("userId",a.userId).eq("siteKey",siteKey).eq("day",day)).unique();
    return {siteKey,blocked:p?.blocked??false,used:d?.used??0,limit:allowance,maxMinutes};
  }));
  const grants=(await ctx.db.query("accessGrants").withIndex("by_user_start",q=>q.eq("userId",a.userId)).order("desc").take(100)).filter(g=>!g.ended&&g.expiresAt>now);
  const summaries=await ctx.db.query("mobileSummaries").withIndex("by_user_source",q=>q.eq("userId",a.userId)).collect();
  const mobile=summaries.reduce((s,r)=>({completed:s.completed+r.completed,minutes:s.minutes+r.minutes,attempts:s.attempts+r.attempts,passes:s.passes+r.passes,endedEarly:s.endedEarly+r.endedEarly}),{completed:0,minutes:0,attempts:0,passes:0,endedEarly:0});
  return {enabled:true,serverNow:now,day,timeZone:config.timeZone,policies,grants:grants.map(({requestId,installationId,siteKey,url,purpose,startedAt,expiresAt})=>({requestId,installationId,siteKey,url,purpose,startedAt,expiresAt})),mobile};
}});
export const grant = mutation({args:{...credentials,installationId:v.string(),requestId:v.string(),url:v.string(),purpose:v.string(),minutes:v.number()},handler:async(ctx,a)=>{
  const config=await account(ctx,a); if(!config) throw new ConvexError("Enable shared allowances first.");
  const prior=await ctx.db.query("accessGrants").withIndex("by_user_request",q=>q.eq("userId",a.userId).eq("requestId",a.requestId)).unique();
  if(prior) {
    if(prior.installationId!==a.installationId) throw new ConvexError("Invalid retry.");
    if(prior.ended || prior.expiresAt<=Date.now()) throw new ConvexError("This work pass has ended. Close this form and request a new pass.");
    return prior;
  }
  if(a.requestId.length<16 || a.purpose.trim().length<5 || a.purpose.length>160 || !Number.isInteger(a.minutes) || a.minutes<1 || a.minutes>maxMinutes) throw new ConvexError("Use a purpose and a duration of 1–10 minutes.");
  const installation=await ctx.db.query("installations").withIndex("by_installation",q=>q.eq("installationId",a.installationId)).unique();
  if(installation?.userId!==a.userId) throw new ConvexError("Register this device first.");
  let destination; try {destination=workDestination(a.url);} catch(e) {throw new ConvexError((e as Error).message);}
  const now=Date.now();
  const focus=await ctx.db.query("focusSyncStates").withIndex("by_user",q=>q.eq("userId",a.userId)).unique();
  if(focus?.active && focus.sessionEnd>now) throw new ConvexError("Finish your focus session before opening work access.");
  const p=await ctx.db.query("accessPolicies").withIndex("by_user_site",q=>q.eq("userId",a.userId).eq("siteKey",destination.siteKey)).unique();
  if(p?.blocked) throw new ConvexError("This service is fully blocked.");
  const active=(await ctx.db.query("accessGrants").withIndex("by_user_start",q=>q.eq("userId",a.userId)).order("desc").take(100)).find(g=>!g.ended&&g.expiresAt>now);
  if(active) throw new ConvexError("You already have an active work pass. End it on the original device first.");
  const day=accountDay(now,config.timeZone);
  const d=await ctx.db.query("accessDays").withIndex("by_user_site_day",q=>q.eq("userId",a.userId).eq("siteKey",destination.siteKey).eq("day",day)).unique();
  if((d?.used??0)>=allowance) throw new ConvexError("No work allowances remain today, across all devices.");
  if(d) await ctx.db.patch(d._id,{used:d.used+1}); else await ctx.db.insert("accessDays",{userId:a.userId,siteKey:destination.siteKey,day,used:1});
  const data={userId:a.userId,requestId:a.requestId,installationId:a.installationId,...destination,purpose:a.purpose.trim(),startedAt:now,expiresAt:now+a.minutes*60000,ended:false};
  await ctx.db.insert("accessGrants",data); return data;
}});
export const end = mutation({args:{...credentials,requestId:v.string()},handler:async(ctx,a)=>{
  await owner(ctx,a); const g=await ctx.db.query("accessGrants").withIndex("by_user_request",q=>q.eq("userId",a.userId).eq("requestId",a.requestId)).unique();
  if(g) await ctx.db.patch(g._id,{ended:true});
}});
export const block = mutation({args:{...credentials,siteKey:v.string()},handler:async(ctx,a)=>{
  if(!await account(ctx,a) || !services.includes(a.siteKey as typeof services[number])) throw new ConvexError("Unknown service.");
  const p=await ctx.db.query("accessPolicies").withIndex("by_user_site",q=>q.eq("userId",a.userId).eq("siteKey",a.siteKey)).unique();
  const data={userId:a.userId,siteKey:a.siteKey,blocked:true,updatedAt:Date.now()};
  if(p) await ctx.db.patch(p._id,data); else await ctx.db.insert("accessPolicies",data);
  const grants=await ctx.db.query("accessGrants").withIndex("by_user_start",q=>q.eq("userId",a.userId)).order("desc").take(100);
  for(const g of grants) if(g.siteKey===a.siteKey&&!g.ended) await ctx.db.patch(g._id,{ended:true});
}});
export const syncMobile = mutation({args:{...credentials,sourceId:v.string(),completed:v.number(),minutes:v.number(),attempts:v.number(),passes:v.number(),endedEarly:v.number(),days:v.optional(v.array(v.object({day:v.string(),completed:v.number(),minutes:v.number()})))},handler:async(ctx,a)=>{
  await owner(ctx,a);
  const keys=["completed","minutes","attempts","passes","endedEarly"] as const;
  for(const k of keys) if(!Number.isSafeInteger(a[k])||a[k]<0) throw new ConvexError("Invalid summary.");
  const old=await ctx.db.query("mobileSummaries").withIndex("by_user_source",q=>q.eq("userId",a.userId).eq("sourceId",a.sourceId)).unique();
  const {accessToken:_,...data}=a;
  if(a.days && (a.days.length>400 || a.days.some(d=>!/^\d{4}-\d{2}-\d{2}$/.test(d.day) || !Number.isFinite(Date.parse(d.day+"T12:00:00Z")) || new Date(d.day+"T12:00:00Z").toISOString().slice(0,10)!==d.day || !Number.isSafeInteger(d.completed) || d.completed<0 || !Number.isSafeInteger(d.minutes) || d.minutes<0))) throw new ConvexError("Invalid daily summary.");
  const days=new Map((old?.days??[]).map(d=>[d.day,d]));
  for(const d of a.days??[]) {const prior=days.get(d.day);days.set(d.day,{day:d.day,completed:Math.max(d.completed,prior?.completed??0),minutes:Math.max(d.minutes,prior?.minutes??0)});}
  // Old clients omit days. Never erase newer clients' daily history on a stale retry.
  data.days=[...days.values()].sort((a,b)=>a.day.localeCompare(b.day)).slice(-400);
  // Monotonic per-source snapshots retry safely; a reinstall uses a new source ID.
  for(const k of keys) data[k]=Math.max(data[k],old?.[k]??0);
  if(old) await ctx.db.patch(old._id,{...data,updatedAt:Date.now()}); else await ctx.db.insert("mobileSummaries",{...data,updatedAt:Date.now()});
}});

export const setProfileName = mutation({args:{...credentials,displayName:v.string()},handler:async(ctx,a)=>{
  await owner(ctx,a);
  const name=a.displayName.trim();
  if(!name || name.length>80) throw new ConvexError("Use a name between 1 and 80 characters.");
  const user=await ctx.db.query("users").withIndex("by_user_id",q=>q.eq("userId",a.userId)).unique();
  if(!user) throw new ConvexError("Your account profile is not ready. Reconnect your account.");
  await ctx.db.patch(user._id,{displayName:name});
}});
