import {convexTest} from "convex-test";
import {it,expect,vi,afterEach} from "vitest";
import {anyApi} from "convex/server";
import schema from "../convex/schema";
const modules=import.meta.glob("../convex/**/*.ts");
afterEach(()=>vi.useRealTimers());
async function setup(){
 vi.useFakeTimers();vi.setSystemTime(new Date("2026-09-16T18:00:00Z"));
 const t=convexTest(schema,modules),auth={userId:"alice",accessToken:"alice-secret"};
 await t.run(async ctx=>{for(const u of ["alice","bob"]){
  await ctx.db.insert("accountCredentials",{userId:u,accessToken:u+"-secret",installationId:u+"-phone",createdAt:Date.now(),lastSeenAt:Date.now()});
  for(const d of ["phone","chrome"]) await ctx.db.insert("installations",{userId:u,installationId:u+"-"+d,browserId:d,browserLabel:d,createdAt:Date.now(),lastSeenAt:Date.now(),sessionsStarted:0,distractionsBlocked:0});
 }});
 await t.mutation(anyApi.access.enable,{...auth,timeZone:"America/Los_Angeles"});
 const start={...auth,installationId:"alice-phone",requestId:crypto.randomUUID(),minutes:30,focusLevel:"deep" as const,siteKeys:["youtube","reddit"]};
 return {t,auth,start};
}
it("has one authoritative session and one start count during concurrent device starts",async()=>{
 const {t,auth,start}=await setup();
 const [a,b]=await Promise.all([t.mutation(anyApi.sessions.start,start),t.mutation(anyApi.sessions.start,{...start,requestId:crypto.randomUUID(),installationId:"alice-chrome",minutes:60})]);
 expect(a.session.sessionId).toBe(b.session.sessionId);expect(a.session.sessionEnd).toBe(b.session.sessionEnd);
 expect(a.session.siteKeys).toContain("gmail");
 expect((await t.query(anyApi.focus.summary,auth)).sessionsStarted).toBe(1);
 expect((await t.query(anyApi.sessions.get,auth)).session.sessionId).toBe(a.session.sessionId);
 expect((await t.query(anyApi.sessions.get,{userId:"bob",accessToken:"bob-secret"})).session).toBeNull();
});
it("enforces the server's thirty-second pause and stops across clients idempotently",async()=>{
 const {t,auth,start}=await setup();const {session:s}=await t.mutation(anyApi.sessions.start,start);
 const stop={...auth,sessionId:s.sessionId,phrase:"end my focus"};
 await expect(t.mutation(anyApi.sessions.stop,stop)).rejects.toThrow(/Wait 30/);
 const pause=await t.mutation(anyApi.sessions.beginEmergency,{...auth,sessionId:s.sessionId});
 expect(pause.readyAt-pause.serverNow).toBe(30000);
 expect(await t.mutation(anyApi.sessions.beginEmergency,{...auth,sessionId:s.sessionId})).toEqual(pause);
 await expect(t.mutation(anyApi.sessions.stop,stop)).rejects.toThrow(/Wait 30/);
 vi.setSystemTime(Date.now()+30000);
 await expect(t.mutation(anyApi.sessions.stop,{...stop,phrase:"wrong"})).rejects.toThrow();
 await t.mutation(anyApi.sessions.stop,stop);await t.mutation(anyApi.sessions.stop,stop);
 expect((await t.query(anyApi.sessions.get,auth)).session.active).toBe(false);
 const stats=await t.query(anyApi.focus.summary,auth);expect(stats.emergencyStops).toBe(1);expect(stats.completedSessions).toBe(0);
 await expect(t.mutation(anyApi.sessions.start,start)).rejects.toThrow(/already ended/);
});
it("completes once without any client online and ignores old-device end events",async()=>{
 const {t,auth,start}=await setup();const {session:s}=await t.mutation(anyApi.sessions.start,start);
 await vi.advanceTimersByTimeAsync(30*60000);await t.finishInProgressScheduledFunctions();
 expect((await t.query(anyApi.sessions.get,auth)).session.active).toBe(false);
 await t.mutation(anyApi.sessions.expire,{userId:"alice",sessionId:s.sessionId});
 await t.mutation(anyApi.focus.recordEvent,{...auth,eventId:"old-browser-end",installationId:"alice-chrome",browserId:"chrome",browserLabel:"Chrome",sessionId:s.sessionId,eventType:"session_ended",occurredAt:Date.now(),endReason:"completed"});
 const stats=await t.query(anyApi.focus.summary,{...auth,localDay:"2026-09-16",includeProfile:true});
 expect(stats.completedSessions).toBe(1);expect(stats.completedMinutes).toBe(30);expect(stats.profile.focusStreak).toBe(1);
});
it("old offline writes, old stops and old expiry cannot erase a new session",async()=>{
 const {t,auth,start}=await setup();const {session:old}=await t.mutation(anyApi.sessions.start,start);
 await t.mutation(anyApi.sessions.beginEmergency,{...auth,sessionId:old.sessionId});vi.setSystemTime(Date.now()+30000);
 await t.mutation(anyApi.sessions.stop,{...auth,sessionId:old.sessionId,phrase:"end my focus"});
 const {session:next}=await t.mutation(anyApi.sessions.start,{...start,requestId:crypto.randomUUID()});
 await t.mutation(anyApi.focus.publishSession,{...auth,sessionId:old.sessionId,sessionStart:old.sessionStart,sessionEnd:old.sessionEnd,durationMinutes:30,focusLevel:"deep",siteKeys:["youtube"],active:false,endReason:"emergency",updatedAt:Date.now()+99999999,updatedByInstallationId:"alice-chrome"});
 await expect(t.mutation(anyApi.sessions.stop,{...auth,sessionId:old.sessionId,phrase:"end my focus"})).rejects.toThrow(/changed/);
 await t.mutation(anyApi.sessions.expire,{userId:"alice",sessionId:old.sessionId});
 expect((await t.query(anyApi.sessions.get,auth)).session.sessionId).toBe(next.sessionId);
 expect((await t.query(anyApi.sessions.get,auth)).session.active).toBe(true);
});
it("revokes work passes on start and refuses new passes during focus",async()=>{
 const {t,auth,start}=await setup();
 const pass={...auth,installationId:"alice-phone",requestId:crypto.randomUUID(),url:"https://youtube.com/watch?v=dQw4w9WgXcQ",purpose:"Work tutorial",minutes:5};
 await t.mutation(anyApi.access.grant,pass);await t.mutation(anyApi.sessions.start,start);
 expect((await t.query(anyApi.access.status,auth)).grants).toEqual([]);
 await expect(t.mutation(anyApi.access.grant,{...pass,requestId:crypto.randomUUID()})).rejects.toThrow(/focus session/);
});
it("validates ownership, installation, duration, and blocked sites",async()=>{
 const {t,auth,start}=await setup();
 await expect(t.mutation(anyApi.sessions.start,{...start,accessToken:"bob-secret"})).rejects.toThrow();
 await expect(t.mutation(anyApi.sessions.start,{...start,installationId:"bob-phone"})).rejects.toThrow();
 await expect(t.mutation(anyApi.sessions.start,{...start,minutes:0})).rejects.toThrow();
 await expect(t.mutation(anyApi.sessions.start,{...start,siteKeys:["unknown"]})).rejects.toThrow();
 const {session}=await t.mutation(anyApi.sessions.start,{...start,focusLevel:"standard",siteKeys:["reddit","gmail"]});
 expect(session.siteKeys).toEqual(["reddit"]);
 await expect(t.mutation(anyApi.sessions.beginEmergency,{userId:"bob",accessToken:"bob-secret",sessionId:session.sessionId})).rejects.toThrow();
});
