import {convexTest} from "convex-test";
import {it,expect} from "vitest";
import {anyApi} from "convex/server";
import schema from "../convex/schema";
import {workDestination,accountDay} from "../convex/accessRules";
const modules=import.meta.glob("../convex/**/*.ts");
async function setup(){
 const t=convexTest(schema,modules),auth={userId:"alice",accessToken:"alice-secret"};
 await t.run(async ctx=>{for(const userId of ["alice","bob"]){
  await ctx.db.insert("accountCredentials",{userId,accessToken:userId+"-secret",installationId:userId+"-phone",createdAt:Date.now(),lastSeenAt:Date.now()});
  for(const d of ["phone","chrome","brave"])await ctx.db.insert("installations",{userId,installationId:userId+"-"+d,browserId:d,browserLabel:d,createdAt:Date.now(),lastSeenAt:Date.now(),sessionsStarted:0,distractionsBlocked:0});
 }});
 await t.mutation(anyApi.access.enable,{...auth,timeZone:"America/Los_Angeles"});
 return {t,auth,args:{...auth,installationId:"alice-phone",requestId:crypto.randomUUID(),url:"https://reddit.com/r/test/comments/abc/title",purpose:"Work discussion",minutes:5}};
}
it("shares three uses, retries without double counting, denies a fourth",async()=>{
 const {t,auth,args}=await setup();
 for(const d of ["phone","chrome","brave"]){const a={...args,installationId:"alice-"+d,requestId:crypto.randomUUID()};await t.mutation(anyApi.access.grant,a);await t.mutation(anyApi.access.grant,a);await t.mutation(anyApi.access.end,{...auth,requestId:a.requestId});}
 expect((await t.query(anyApi.access.status,auth)).policies.find(p=>p.siteKey==="reddit").used).toBe(3);
 await expect(t.mutation(anyApi.access.grant,args)).rejects.toThrow(/No work allowances/);
});
it("only grants one concurrent request",async()=>{
 const {t,args}=await setup();
 const results=await Promise.allSettled([t.mutation(anyApi.access.grant,args),t.mutation(anyApi.access.grant,{...args,requestId:crypto.randomUUID(),installationId:"alice-chrome"})]);
 expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);
});
it("rejects account and installation spoofing",async()=>{
 const {t,args}=await setup();
 await expect(t.mutation(anyApi.access.grant,{...args,accessToken:"bob-secret"})).rejects.toThrow(/Clerk/);
 await expect(t.mutation(anyApi.access.grant,{...args,installationId:"bob-phone"})).rejects.toThrow(/Register/);
});
it("revokes on block and does not duplicate migrated stats",async()=>{
 const {t,auth,args}=await setup();await t.mutation(anyApi.access.grant,args);await t.mutation(anyApi.access.block,{...auth,siteKey:"reddit"});
 expect((await t.query(anyApi.access.status,auth)).grants).toHaveLength(0);
 await expect(t.mutation(anyApi.access.grant,{...args,requestId:crypto.randomUUID()})).rejects.toThrow(/fully blocked/);
 const data={...auth,sourceId:"legacy-phone",completed:4,minutes:120,attempts:7,passes:2,endedEarly:1};
 await t.mutation(anyApi.access.syncMobile,data);await t.mutation(anyApi.access.syncMobile,data);
 expect((await t.query(anyApi.access.status,auth)).mobile.completed).toBe(4);
});
it.each(["https://facebook.com/","https://facebook.com/reels/123","https://facebook.com/groups/feed","https://linkedin.com/feed","https://reddit.com/r/test","https://youtube.com/shorts/abc","https://youtube.com.evil.test/watch?v=dQw4w9WgXcQ"])("rejects feed %s",u=>expect(()=>workDestination(u)).toThrow());
it.each(["https://facebook.com/groups/123","https://facebook.com/laurel.lu.925","https://linkedin.com/feed/update/urn:li:activity:123","https://reddit.com/r/test/comments/abc/title","https://youtu.be/dQw4w9WgXcQ"])("accepts useful URL %s",u=>expect(workDestination(u).url).toMatch(/^https:\/\/www\./));
it("preserves identifiers and uses account timezone",()=>{
 expect(workDestination("https://facebook.com/profile.php?id=123&track=4").url).toBe("https://www.facebook.com/profile.php?id=123");
 expect(accountDay(Date.parse("2026-09-14T01:00:00Z"),"America/Los_Angeles")).toBe("2026-09-13");
});
it("connects a fresh iPhone through Clerk, registers it, enables access and opens a work page",async()=>{
 const t=convexTest(schema,modules);
 const legacy={userId:"new-phone",accessToken:"legacy-phone-token"};
 const device={installationId:"new-iphone",browserId:"ios",browserLabel:"Tranquil iPhone",clientNow:Date.now()};
 await t.mutation(anyApi.focus.registerClient,{...legacy,...device});
 const code="x".repeat(72),proposedAccessToken="y".repeat(72);
 await t.mutation(anyApi.focus.beginClerkLink,{...legacy,code,proposedAccessToken,installationId:device.installationId,clientNow:Date.now()});
 expect(await t.mutation(anyApi.focus.completeClerkLink,{code,proposedAccessToken})).toEqual({connected:false,reason:"pending"});
 await t.withIdentity({subject:"clerk-user",issuer:"https://clerk.example.test"}).mutation(anyApi.focus.claimClerkLink,{code});
 const connected=await t.mutation(anyApi.focus.completeClerkLink,{code,proposedAccessToken});
 expect(connected.connected).toBe(true);
 const auth={userId:"clerk-user",accessToken:proposedAccessToken};
 await t.mutation(anyApi.focus.registerClient,{...auth,...device});
 await t.mutation(anyApi.access.enable,{...auth,timeZone:"America/Los_Angeles"});
 await t.mutation(anyApi.access.syncMobile,{...auth,sourceId:"iphone-history",completed:2,minutes:60,attempts:3,passes:0,endedEarly:0});
 const grant=await t.mutation(anyApi.access.grant,{...auth,installationId:device.installationId,requestId:crypto.randomUUID(),url:"https://facebook.com/groups/123",purpose:"Reply to a work discussion",minutes:5});
 const status=await t.query(anyApi.access.status,auth);
 expect(status.enabled).toBe(true);expect(status.mobile?.completed).toBe(2);expect(status.grants[0].url).toBe(grant.url);
 expect((await t.query(anyApi.focus.summary,auth)).completedSessions).toBe(0);
});
it("reports expired login links instead of waiting forever",async()=>{
 const t=convexTest(schema,modules);
 expect(await t.mutation(anyApi.focus.completeClerkLink,{code:"expired",proposedAccessToken:"invalid"})).toEqual({connected:false,reason:"expired"});
});
it("does not revive an ended grant on retry",async()=>{
 const {t,auth,args}=await setup();await t.mutation(anyApi.access.grant,args);
 await t.mutation(anyApi.access.end,{...auth,requestId:args.requestId});
 await expect(t.mutation(anyApi.access.grant,args)).rejects.toThrow(/has ended/);
});

it("combines legacy desktop and mobile days without duplicating retries or changing desktop totals",async()=>{
 const {t,auth}=await setup();
 await t.run(async ctx=>{
  await ctx.db.insert("accountLinks",{userId:"alice",legacyUserId:"old-chrome",linkedAt:Date.now()});
  await ctx.db.insert("dailyStats",{userId:"old-chrome",day:"2026-09-14",sessionsStarted:2,completedSessions:2,distractionsBlocked:0,plannedMinutes:60,completedMinutes:60,updatedAt:Date.now()});
 });
 const a={...auth,sourceId:"phone-one",completed:1,minutes:30,attempts:0,passes:0,endedEarly:0,days:[{day:"2026-09-14",completed:1,minutes:30}]};
 await t.mutation(anyApi.access.syncMobile,a);await t.mutation(anyApi.access.syncMobile,a);
 await t.mutation(anyApi.access.syncMobile,{...a,days:[],completed:0,minutes:0});
 await t.mutation(anyApi.access.syncMobile,{...a,sourceId:"phone-two",days:[{day:"2026-09-15",completed:1,minutes:30}]});
 const summary=await t.query(anyApi.focus.summary,{...auth,includeProfile:true,localDay:"2026-09-15"});
 expect(summary.profile.days).toEqual([{day:"2026-09-14",completed:3,minutes:90},{day:"2026-09-15",completed:1,minutes:30}]);
 expect(summary.profile.mobileDailyHistoryIncomplete).toBe(false);
 expect(summary.days.find(d=>d.day==="2026-09-14").completedSessions).toBe(2);
 expect((await t.query(anyApi.access.status,auth)).mobile.completed).toBe(2);
 const bob=await t.query(anyApi.focus.summary,{userId:"bob",accessToken:"bob-secret",includeProfile:true});
 expect(bob.profile.days).toEqual([]);
 await expect(t.query(anyApi.focus.summary,{...auth,accessToken:"bob-secret",includeProfile:true})).rejects.toThrow();
});
it("validates daily snapshots and flags older totals without daily data",async()=>{
 const {t,auth}=await setup();
 const a={...auth,sourceId:"older-phone",completed:4,minutes:120,attempts:0,passes:0,endedEarly:0};
 await t.mutation(anyApi.access.syncMobile,a);
 expect((await t.query(anyApi.focus.summary,{...auth,includeProfile:true})).profile.mobileDailyHistoryIncomplete).toBe(true);
 for(const day of ["nope","2026-02-31"])await expect(t.mutation(anyApi.access.syncMobile,{...a,days:[{day,completed:1,minutes:30}]})).rejects.toThrow(/Invalid daily/);
 await expect(t.mutation(anyApi.access.syncMobile,{...a,days:[{day:"2026-09-14",completed:-1,minutes:30}]})).rejects.toThrow(/Invalid daily/);
});
it("stores profile names only for the authenticated account",async()=>{
 const {t,auth}=await setup();
 await t.run(async ctx=>{await ctx.db.insert("users",{userId:"alice",accessToken:"alice-secret",createdAt:Date.now(),lastSeenAt:Date.now()});});
 await t.mutation(anyApi.access.setProfileName,{...auth,displayName:"  Alice  "});
 expect((await t.query(anyApi.focus.summary,{...auth,includeProfile:true})).profile.displayName).toBe("Alice");
 await expect(t.mutation(anyApi.access.setProfileName,{...auth,accessToken:"bob-secret",displayName:"Other"})).rejects.toThrow();
 await expect(t.mutation(anyApi.access.setProfileName,{...auth,displayName:" "})).rejects.toThrow();
});
