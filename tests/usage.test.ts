import {convexTest} from "convex-test";
import {it,expect} from "vitest";
import {anyApi} from "convex/server";
import schema from "../convex/schema";
const modules=import.meta.glob("../convex/**/*.ts");
const auth={userId:"alice",accessToken:"alice-secret"};
const time=Date.parse("2026-10-21T23:59:55Z");
const event=(id:string,extra={})=>({eventId:id,installationId:"alice-browser",siteKey:"reddit",visitId:"visit-1",eventType:"visible_time",occurredAt:time,durationSeconds:10,...extra});
async function setup(){
 const t=convexTest(schema,modules);
 await t.run(async ctx=>{
  for(const userId of ["alice","bob"])await ctx.db.insert("users",{userId,accessToken:userId+"-secret",createdAt:time,lastSeenAt:time});
 });return t;
}
async function snapshot(t:ReturnType<typeof convexTest>){
 return t.run(async ctx=>{
  const result:any={};
  for(const table of ["usageEvents","siteUsageStats","siteUsageDaily","siteVisits"] as const)
   result[table]=(await ctx.db.query(table).collect()).map(({_id,_creationTime,...row})=>row).sort((a:any,b:any)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return result;
 });
}
it("matches single-event totals across sites, visits, days and retries",async()=>{
 const single=await setup(),batch=await setup();
 const events=[event("open",{eventType:"site_opened",durationSeconds:undefined}),event("a"),event("b",{occurredAt:time+10000}),event("c",{siteKey:"youtube",visitId:"visit-2"})];
 for(const e of events)await single.mutation(anyApi.focus.recordUsage,{...auth,...e});
 await batch.mutation(anyApi.focus.recordUsageBatch,{...auth,events});
 expect(await snapshot(batch)).toEqual(await snapshot(single));
 const before=await snapshot(batch);
 await batch.mutation(anyApi.focus.recordUsageBatch,{...auth,events:[...events,events[0]]});
 expect(await snapshot(batch)).toEqual(before);
});
it("deduplicates within a batch and across overlapping retries",async()=>{
 const t=await setup();
 await t.mutation(anyApi.focus.recordUsageBatch,{...auth,events:[event("a"),event("a"),event("b")]});
 await t.mutation(anyApi.focus.recordUsageBatch,{...auth,events:[event("b"),event("c")]});
 const s=await snapshot(t);
 expect(s.usageEvents).toHaveLength(3);expect(s.siteUsageStats[0].visibleSeconds).toBe(30);expect(s.siteVisits[0].visibleSeconds).toBe(30);
});
it("preserves first and last visit timestamps when an offline batch arrives late",async()=>{
 const t=await setup();
 await t.mutation(anyApi.focus.recordUsageBatch,{...auth,events:[event("new",{occurredAt:time+20000})]});
 await t.mutation(anyApi.focus.recordUsageBatch,{...auth,events:[event("old",{eventType:"site_opened",durationSeconds:undefined})]});
 const s=await snapshot(t);expect(s.siteVisits[0]).toMatchObject({startedAt:time,lastActiveAt:time+20000,visibleSeconds:10});
 expect(s.siteUsageStats[0].updatedAt).toBe(time+20000);
});
it("rejects invalid batches atomically and limits their size",async()=>{
 const t=await setup();
 for(const events of [[],Array.from({length:51},(_,i)=>event(String(i))),[event("valid"),event("invalid",{durationSeconds:61})],[event("invalid",{siteKey:"unknown"})],[event("bad-time",{occurredAt:NaN})]]){
  await expect(t.mutation(anyApi.focus.recordUsageBatch,{...auth,events})).rejects.toThrow();
 }
 expect((await snapshot(t)).usageEvents).toHaveLength(0);
});
it("rejects invalid credentials and cross-account event or visit collisions",async()=>{
 const t=await setup();
 await t.mutation(anyApi.focus.recordUsageBatch,{...auth,events:[event("a")]});
 const before=await snapshot(t);
 await expect(t.mutation(anyApi.focus.recordUsageBatch,{...auth,accessToken:"wrong",events:[event("b")]})).rejects.toThrow();
 for(const e of [event("a"),event("other")])await expect(t.mutation(anyApi.focus.recordUsageBatch,{userId:"bob",accessToken:"bob-secret",events:[e]})).rejects.toThrow(/belongs/);
 expect(await snapshot(t)).toEqual(before);
});
it("does not duplicate data when the legacy endpoint retries a batched event",async()=>{
 const t=await setup();await t.mutation(anyApi.focus.recordUsageBatch,{...auth,events:[event("a")]});
 await t.mutation(anyApi.focus.recordUsage,{...auth,...event("a")});
 expect((await snapshot(t)).siteUsageStats[0].visibleSeconds).toBe(10);
});
it("reduces six events from 24 database writes to 9, without dropping raw events",async()=>{
 const {recordUsage,recordUsageBatch}=await import("../convex/focus");
 async function measure(batched:boolean){
  const t=await setup();const counts={insert:0,patch:0,reads:0};
  await t.run(async ctx=>{
   const db=new Proxy(ctx.db,{get(target,key){
    if(key==="insert"||key==="patch")return (...args:any[])=>{counts[key]++;return (target[key] as any)(...args);};
    if(key==="query")return (...args:any[])=>{
     const wrap=(query:any):any=>new Proxy(query,{get(q,k){
      const fn=q[k];if(typeof fn!=="function")return fn;
      return (...a:any[])=>{if(k==="unique")counts.reads++;const result=fn.apply(q,a);return k==="withIndex"?wrap(result):result;};
     }});return wrap((target.query as any)(...args));
    };return Reflect.get(target,key);
   }});
   const events=Array.from({length:6},(_,i)=>event(String(i),{occurredAt:time+i*100}));
   if(batched)await (recordUsageBatch as any)._handler({...ctx,db},{...auth,events});
   else for(const e of events)await (recordUsage as any)._handler({...ctx,db},{...auth,...e});
  });return {counts,data:await snapshot(t)};
 }
 const before=await measure(false),after=await measure(true);
 expect(after.data).toEqual(before.data);
 expect(before.counts.insert+before.counts.patch).toBe(24);
 expect(after.counts.insert+after.counts.patch).toBe(9);
 expect(before.counts.reads).toBe(30);expect(after.counts.reads).toBe(10);
});
