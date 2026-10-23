import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";

const credentials = { userId: v.string(), accessToken: v.string() };
const focusLevel = v.union(v.literal("standard"), v.literal("deep"));
const endReason = v.union(v.literal("completed"), v.literal("emergency"));
const eventType = v.union(
  v.literal("session_started"),
  v.literal("session_ended"),
  v.literal("distraction_blocked"),
);
const usageEventType = v.union(v.literal("site_opened"), v.literal("visible_time"));
const supportedSiteKeys = new Set(["threads", "instagram", "facebook", "x", "linkedin", "reddit", "youtube", "tiktok", "bookface"]);
const localDayPattern = /^\d{4}-\d{2}-\d{2}$/;

async function requireUser(ctx: QueryCtx | MutationCtx, userId: string, accessToken: string) {
  const user = await ctx.db.query("users").withIndex("by_user_id", (q) => q.eq("userId", userId)).unique();
  if (user?.accessToken === accessToken) return user;
  const credential = await ctx.db.query("accountCredentials")
    .withIndex("by_access_token", (q) => q.eq("accessToken", accessToken)).unique();
  if (!credential || credential.userId !== userId) throw new ConvexError("Invalid Tranquil user credentials.");
  return credential;
}

async function linkedUserIds(ctx: QueryCtx, userId: string) {
  const legacyLink = await ctx.db.query("accountLinks").withIndex("by_legacy_user", (q) => q.eq("legacyUserId", userId)).unique();
  const canonicalUserId = legacyLink?.userId ?? userId;
  const links = await ctx.db.query("accountLinks").withIndex("by_user", (q) => q.eq("userId", canonicalUserId)).collect();
  return [...new Set([canonicalUserId, ...links.map((link) => link.legacyUserId)])];
}

function emptyStats(userId: string, updatedAt: number) {
  return {
    userId,
    sessionsStarted: 0,
    completedSessions: 0,
    emergencyStops: 0,
    distractionsBlocked: 0,
    plannedMinutes: 0,
    completedMinutes: 0,
    updatedAt,
  };
}

function utcDay(timestamp: number) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

export const registerClient = mutation({
  args: {
    ...credentials,
    installationId: v.string(),
    browserId: v.string(),
    browserLabel: v.string(),
    clientNow: v.number(),
  },
  handler: async (ctx, args) => {
    let user = await ctx.db.query("users").withIndex("by_user_id", (q) => q.eq("userId", args.userId)).unique();
    if (user && user.accessToken !== args.accessToken) await requireUser(ctx, args.userId, args.accessToken);
    if (!user) {
      const tokenOwner = await ctx.db.query("users").withIndex("by_access_token", (q) => q.eq("accessToken", args.accessToken)).unique();
      if (tokenOwner) throw new ConvexError("This access token is already registered.");
      const id = await ctx.db.insert("users", {
        userId: args.userId,
        accessToken: args.accessToken,
        createdAt: args.clientNow,
        lastSeenAt: args.clientNow,
      });
      user = await ctx.db.get(id);
      await ctx.db.insert("userStats", emptyStats(args.userId, args.clientNow));
    } else {
      await ctx.db.patch(user._id, { lastSeenAt: args.clientNow });
    }

    const installation = await ctx.db.query("installations")
      .withIndex("by_installation", (q) => q.eq("installationId", args.installationId)).unique();
    if (installation && installation.userId !== args.userId) {
      const link = await ctx.db.query("accountLinks").withIndex("by_legacy_user", (q) => q.eq("legacyUserId", installation.userId)).unique();
      if (!link || link.userId !== args.userId) throw new ConvexError("This installation belongs to another user.");
      await ctx.db.patch(installation._id, { userId: args.userId });
    }
    if (installation) {
      await ctx.db.patch(installation._id, {
        browserId: args.browserId,
        browserLabel: args.browserLabel,
        lastSeenAt: args.clientNow,
      });
    } else {
      await ctx.db.insert("installations", {
        userId: args.userId,
        installationId: args.installationId,
        browserId: args.browserId,
        browserLabel: args.browserLabel,
        createdAt: args.clientNow,
        lastSeenAt: args.clientNow,
        sessionsStarted: 0,
        distractionsBlocked: 0,
      });
    }
    return { userId: args.userId };
  },
});

export const beginClerkLink = mutation({
  args: {
    ...credentials,
    code: v.string(),
    proposedAccessToken: v.string(),
    installationId: v.string(),
    clientNow: v.number(),
  },
  handler: async (ctx, args) => {
    await requireUser(ctx, args.userId, args.accessToken);
    if (args.code.length < 32 || args.proposedAccessToken.length < 64) throw new ConvexError("Invalid account-link request.");
    const existing = await ctx.db.query("clerkLinkRequests").withIndex("by_code", (q) => q.eq("code", args.code)).unique();
    if (existing) throw new ConvexError("This account-link request already exists.");
    await ctx.db.insert("clerkLinkRequests", {
      code: args.code,
      proposedAccessToken: args.proposedAccessToken,
      installationId: args.installationId,
      legacyUserId: args.userId,
      legacyAccessToken: args.accessToken,
      createdAt: args.clientNow,
      expiresAt: args.clientNow + 10 * 60_000,
    });
    return { expiresAt: args.clientNow + 10 * 60_000 };
  },
});

export const claimClerkLink = mutation({
  args: { code: v.string() },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new ConvexError("Sign in before connecting Tranquil.");
    const request = await ctx.db.query("clerkLinkRequests").withIndex("by_code", (q) => q.eq("code", args.code)).unique();
    if (!request || request.expiresAt < Date.now()) throw new ConvexError("This connection link expired. Start again from Tranquil.");
    if (request.claimedUserId && request.claimedUserId !== identity.subject) throw new ConvexError("This connection link was already used.");
    const legacyUser = await ctx.db.query("users").withIndex("by_user_id", (q) => q.eq("userId", request.legacyUserId)).unique();
    if (!legacyUser || legacyUser.accessToken !== request.legacyAccessToken) throw new ConvexError("The original Tranquil profile could not be verified.");
    const tokenOwner = await ctx.db.query("accountCredentials").withIndex("by_access_token", (q) => q.eq("accessToken", request.proposedAccessToken)).unique();
    if (tokenOwner && tokenOwner.userId !== identity.subject) throw new ConvexError("This connection credential is already in use.");
    if (!tokenOwner) await ctx.db.insert("accountCredentials", {
      userId: identity.subject,
      accessToken: request.proposedAccessToken,
      installationId: request.installationId,
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
    });
    let user = await ctx.db.query("users").withIndex("by_user_id", (q) => q.eq("userId", identity.subject)).unique();
    if (!user) {
      const id = await ctx.db.insert("users", { userId: identity.subject, accessToken: request.proposedAccessToken, createdAt: Date.now(), lastSeenAt: Date.now() });
      user = await ctx.db.get(id);
      await ctx.db.insert("userStats", emptyStats(identity.subject, Date.now()));
    }
    if (user) await ctx.db.patch(user._id, {
      ...(!user.displayName && identity.name ? {displayName:identity.name.slice(0,80)} : {}),
      ...(identity.email ? {email:identity.email} : {}),
    });
    const link = await ctx.db.query("accountLinks").withIndex("by_legacy_user", (q) => q.eq("legacyUserId", request.legacyUserId)).unique();
    if (link && link.userId !== identity.subject) throw new ConvexError("This Tranquil history is already connected to another account.");
    if (!link && request.legacyUserId !== identity.subject) await ctx.db.insert("accountLinks", { userId: identity.subject, legacyUserId: request.legacyUserId, linkedAt: Date.now() });
    await ctx.db.patch(request._id, { claimedUserId: identity.subject, claimedAt: Date.now() });
    return { connected: true };
  },
});

export const completeClerkLink = mutation({
  args: { code: v.string(), proposedAccessToken: v.string() },
  handler: async (ctx, args) => {
    const request = await ctx.db.query("clerkLinkRequests").withIndex("by_code", (q) => q.eq("code", args.code)).unique();
    if (!request || request.proposedAccessToken !== args.proposedAccessToken || request.expiresAt < Date.now()) return { connected: false, reason: "expired" };
    if (!request.claimedUserId) return { connected: false, reason: "pending" };
    return { connected: true, userId: request.claimedUserId, accessToken: request.proposedAccessToken };
  },
});

export const recordEvent = mutation({
  args: {
    ...credentials,
    eventId: v.string(),
    installationId: v.string(),
    browserId: v.string(),
    browserLabel: v.string(),
    sessionId: v.string(),
    eventType,
    occurredAt: v.number(),
    plannedMinutes: v.optional(v.number()),
    focusLevel: v.optional(focusLevel),
    siteKey: v.optional(v.string()),
    endReason: v.optional(endReason),
    sessionStart: v.optional(v.number()),
    sessionEnd: v.optional(v.number()),
    siteKeys: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    await requireUser(ctx, args.userId, args.accessToken);
    const managedSession = await ctx.db.query("focusSessions").withIndex("by_session_id", q=>q.eq("sessionId",args.sessionId)).unique();
    if (managedSession?.serverManaged && args.eventType !== "distraction_blocked") return managedSession._id;
    const existing = await ctx.db.query("focusEvents").withIndex("by_event_id", (q) => q.eq("eventId", args.eventId)).unique();
    if (existing) return existing._id;

    const { accessToken: _accessToken, sessionStart, sessionEnd, siteKeys, ...event } = args;
    const eventId = await ctx.db.insert("focusEvents", event);
    const stats = await ctx.db.query("userStats").withIndex("by_user", (q) => q.eq("userId", args.userId)).unique();
    const current = stats ?? emptyStats(args.userId, args.occurredAt);
    const daily = await ctx.db.query("dailyStats")
      .withIndex("by_user_day", (q) => q.eq("userId", args.userId).eq("day", utcDay(args.occurredAt))).unique();
    const dayCurrent = daily ?? {
      userId: args.userId, day: utcDay(args.occurredAt), sessionsStarted: 0, completedSessions: 0,
      distractionsBlocked: 0, plannedMinutes: 0, completedMinutes: 0, updatedAt: args.occurredAt,
    };
    const installation = await ctx.db.query("installations")
      .withIndex("by_installation", (q) => q.eq("installationId", args.installationId)).unique();

    let statsPatch = { ...current, updatedAt: args.occurredAt };
    let dayPatch = { ...dayCurrent, updatedAt: args.occurredAt };
    if (args.eventType === "session_started") {
      const planned = args.plannedMinutes ?? 0;
      statsPatch = { ...statsPatch, sessionsStarted: current.sessionsStarted + 1, plannedMinutes: current.plannedMinutes + planned };
      dayPatch = { ...dayPatch, sessionsStarted: dayCurrent.sessionsStarted + 1, plannedMinutes: dayCurrent.plannedMinutes + planned };
      if (installation) await ctx.db.patch(installation._id, { sessionsStarted: installation.sessionsStarted + 1, lastSeenAt: args.occurredAt });
      const session = await ctx.db.query("focusSessions").withIndex("by_session_id", (q) => q.eq("sessionId", args.sessionId)).unique();
      if (!session) await ctx.db.insert("focusSessions", {
        userId: args.userId,
        sessionId: args.sessionId,
        startedAt: sessionStart ?? args.occurredAt,
        scheduledEndAt: sessionEnd ?? args.occurredAt + planned * 60_000,
        durationMinutes: planned,
        focusLevel: args.focusLevel ?? "standard",
        siteKeys: siteKeys ?? [],
        status: "active",
        startedByInstallationId: args.installationId,
        updatedAt: args.occurredAt,
      });
    }
    if (args.eventType === "session_ended") {
      const session = await ctx.db.query("focusSessions").withIndex("by_session_id", (q) => q.eq("sessionId", args.sessionId)).unique();
      const completedMinutes = args.endReason === "completed" ? (session?.durationMinutes ?? 0) : 0;
      statsPatch = {
        ...statsPatch,
        completedSessions: current.completedSessions + (args.endReason === "completed" ? 1 : 0),
        emergencyStops: current.emergencyStops + (args.endReason === "emergency" ? 1 : 0),
        completedMinutes: current.completedMinutes + completedMinutes,
      };
      dayPatch = {
        ...dayPatch,
        completedSessions: dayCurrent.completedSessions + (args.endReason === "completed" ? 1 : 0),
        completedMinutes: dayCurrent.completedMinutes + completedMinutes,
      };
      if (session) await ctx.db.patch(session._id, {
        endedAt: args.occurredAt,
        status: args.endReason ?? "completed",
        updatedAt: args.occurredAt,
      });
    }
    if (args.eventType === "distraction_blocked") {
      statsPatch = { ...statsPatch, distractionsBlocked: current.distractionsBlocked + 1 };
      dayPatch = { ...dayPatch, distractionsBlocked: dayCurrent.distractionsBlocked + 1 };
      if (installation) await ctx.db.patch(installation._id, { distractionsBlocked: installation.distractionsBlocked + 1, lastSeenAt: args.occurredAt });
      if (args.siteKey) {
        const site = await ctx.db.query("siteStats")
          .withIndex("by_user_site", (q) => q.eq("userId", args.userId).eq("siteKey", args.siteKey!)).unique();
        if (site) await ctx.db.patch(site._id, { distractionsBlocked: site.distractionsBlocked + 1, updatedAt: args.occurredAt });
        else await ctx.db.insert("siteStats", { userId: args.userId, siteKey: args.siteKey, distractionsBlocked: 1, updatedAt: args.occurredAt });
      }
    }

    const { _id: _statsId, _creationTime: _statsCreated, ...statsValue } = statsPatch as typeof statsPatch & { _id?: unknown; _creationTime?: unknown };
    if (stats) await ctx.db.patch(stats._id, statsValue);
    else await ctx.db.insert("userStats", statsValue);
    const { _id: _dayId, _creationTime: _dayCreated, ...dayValue } = dayPatch as typeof dayPatch & { _id?: unknown; _creationTime?: unknown };
    if (daily) await ctx.db.patch(daily._id, dayValue);
    else await ctx.db.insert("dailyStats", dayValue);
    return eventId;
  },
});

const usageFields = {
  eventId: v.string(),
  installationId: v.string(),
  siteKey: v.string(),
  visitId: v.string(),
  eventType: usageEventType,
  occurredAt: v.number(),
  durationSeconds: v.optional(v.number()),
};
type UsageEvent = {
  eventId: string; installationId: string; siteKey: string; visitId: string;
  eventType: "site_opened" | "visible_time"; occurredAt: number; durationSeconds?: number;
};

// Raw events remain the retry ledger; aggregates are read and written once per batch.
async function recordUsageEvents(ctx: MutationCtx, userId: string, accessToken: string, events: UsageEvent[]) {
  if (events.length < 1 || events.length > 50) throw new ConvexError("Send 1–50 usage events per batch.");
  await requireUser(ctx, userId, accessToken);
  const totals = new Map<string, { id?: Id<"siteUsageStats">; value: Omit<Doc<"siteUsageStats">, "_id" | "_creationTime"> }>();
  const days = new Map<string, { id?: Id<"siteUsageDaily">; value: Omit<Doc<"siteUsageDaily">, "_id" | "_creationTime"> }>();
  const visits = new Map<string, { id?: Id<"siteVisits">; value: Omit<Doc<"siteVisits">, "_id" | "_creationTime"> }>();
  const ids: Id<"usageEvents">[] = [];
  for (const event of events) {
    if (!supportedSiteKeys.has(event.siteKey)) throw new ConvexError("Unsupported analytics site.");
    if (!Number.isFinite(event.occurredAt) || Math.abs(event.occurredAt) > 8.64e15) throw new ConvexError("Invalid event time.");
    if (event.eventType === "visible_time" && (!Number.isInteger(event.durationSeconds) || event.durationSeconds! < 1 || event.durationSeconds! > 60)) {
      throw new ConvexError("Visible-time events must contain 1–60 seconds.");
    }
    const existing = await ctx.db.query("usageEvents").withIndex("by_event_id", q => q.eq("eventId", event.eventId)).unique();
    if (existing) {
      if (existing.userId !== userId) throw new ConvexError("This event belongs to another user.");
      ids.push(existing._id);
      continue;
    }
    const day = utcDay(event.occurredAt);
    const dayKey = JSON.stringify([day, event.siteKey]);
    if (!totals.has(event.siteKey)) {
      const doc = await ctx.db.query("siteUsageStats").withIndex("by_user_site", q => q.eq("userId", userId).eq("siteKey", event.siteKey)).unique();
      const { _id, _creationTime, ...value } = doc ?? {};
      totals.set(event.siteKey, { id: _id, value: doc ? value as Omit<Doc<"siteUsageStats">, "_id" | "_creationTime"> : { userId, siteKey: event.siteKey, opens: 0, visibleSeconds: 0, updatedAt: event.occurredAt } });
    }
    if (!days.has(dayKey)) {
      const doc = await ctx.db.query("siteUsageDaily").withIndex("by_user_day_site", q => q.eq("userId", userId).eq("day", day).eq("siteKey", event.siteKey)).unique();
      const { _id, _creationTime, ...value } = doc ?? {};
      days.set(dayKey, { id: _id, value: doc ? value as Omit<Doc<"siteUsageDaily">, "_id" | "_creationTime"> : { userId, day, siteKey: event.siteKey, opens: 0, visibleSeconds: 0, updatedAt: event.occurredAt } });
    }
    if (!visits.has(event.visitId)) {
      const doc = await ctx.db.query("siteVisits").withIndex("by_visit_id", q => q.eq("visitId", event.visitId)).unique();
      const { _id, _creationTime, ...value } = doc ?? {};
      visits.set(event.visitId, { id: _id, value: doc ? value as Omit<Doc<"siteVisits">, "_id" | "_creationTime"> : { userId, visitId: event.visitId, siteKey: event.siteKey, installationId: event.installationId, startedAt: event.occurredAt, lastActiveAt: event.occurredAt, visibleSeconds: 0 } });
    }
    const visit = visits.get(event.visitId)!.value;
    if (visit.userId !== userId || visit.siteKey !== event.siteKey || visit.installationId !== event.installationId) throw new ConvexError("This visit belongs to another user, site, or installation.");
    const duration = event.eventType === "visible_time" ? event.durationSeconds! : 0;
    const opens = event.eventType === "site_opened" ? 1 : 0;
    const total = totals.get(event.siteKey)!.value;
    const daily = days.get(dayKey)!.value;
    for (const value of [total, daily]) {
      value.opens += opens;
      value.visibleSeconds += duration;
      value.updatedAt = Math.max(value.updatedAt, event.occurredAt);
    }
    if (opens) total.lastOpenedAt = Math.max(total.lastOpenedAt ?? event.occurredAt, event.occurredAt);
    visit.startedAt = Math.min(visit.startedAt, event.occurredAt);
    visit.lastActiveAt = Math.max(visit.lastActiveAt, event.occurredAt);
    visit.visibleSeconds += duration;
    ids.push(await ctx.db.insert("usageEvents", { userId, ...event }));
  }
  for (const { id, value } of totals.values()) {
    if (id) await ctx.db.patch(id, value); else await ctx.db.insert("siteUsageStats", value);
  }
  for (const { id, value } of days.values()) {
    if (id) await ctx.db.patch(id, value); else await ctx.db.insert("siteUsageDaily", value);
  }
  for (const { id, value } of visits.values()) {
    if (id) await ctx.db.patch(id, value); else await ctx.db.insert("siteVisits", value);
  }
  return ids;
}

// Keep the existing endpoint for extension copies that have not reloaded yet.
export const recordUsage = mutation({
  args: { ...credentials, ...usageFields },
  handler: async (ctx, { userId, accessToken, ...event }) =>
    (await recordUsageEvents(ctx, userId, accessToken, [event]))[0],
});

export const recordUsageBatch = mutation({
  args: { ...credentials, events: v.array(v.object(usageFields)) },
  handler: async (ctx, { userId, accessToken, events }) => {
    await recordUsageEvents(ctx, userId, accessToken, events);
    return { accepted: events.length };
  },
});

export const recordFeedAccess = mutation({
  args: {
    ...credentials,
    eventId: v.string(),
    installationId: v.string(),
    scope: v.union(v.literal("all"), v.literal("site")),
    siteKey: v.optional(v.string()),
    occurredAt: v.number(),
    localDay: v.string(),
  },
  handler: async (ctx, args) => {
    await requireUser(ctx, args.userId, args.accessToken);
    if (!localDayPattern.test(args.localDay)) throw new ConvexError("Invalid local analytics day.");
    if (args.scope === "site" && (!args.siteKey || !supportedSiteKeys.has(args.siteKey))) {
      throw new ConvexError("Unsupported feed-access site.");
    }
    const existing = await ctx.db.query("feedAccessEvents").withIndex("by_event_id", (q) => q.eq("eventId", args.eventId)).unique();
    if (existing) {
      const current = await ctx.db.query("feedAccessDaily")
        .withIndex("by_user_day", (q) => q.eq("userId", args.userId).eq("day", args.localDay)).unique();
      return { count: current?.unblocks ?? 0 };
    }

    const { accessToken: _accessToken, ...event } = args;
    await ctx.db.insert("feedAccessEvents", event);
    const daily = await ctx.db.query("feedAccessDaily")
      .withIndex("by_user_day", (q) => q.eq("userId", args.userId).eq("day", args.localDay)).unique();
    const count = (daily?.unblocks ?? 0) + 1;
    if (daily) await ctx.db.patch(daily._id, { unblocks: count, updatedAt: args.occurredAt });
    else await ctx.db.insert("feedAccessDaily", {
      userId: args.userId,
      day: args.localDay,
      unblocks: count,
      updatedAt: args.occurredAt,
    });
    return { count };
  },
});

export const summary = query({
  args: { ...credentials, localDay: v.optional(v.string()), includeProfile: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    await requireUser(ctx, args.userId, args.accessToken);
    const requestedDay = args.localDay && localDayPattern.test(args.localDay) ? args.localDay : utcDay(Date.now());
    const userIds = await linkedUserIds(ctx, args.userId);
    const groups = await Promise.all(userIds.map(async (userId) => ({
      stats: await ctx.db.query("userStats").withIndex("by_user", (q) => q.eq("userId", userId)).unique(),
      installations: await ctx.db.query("installations").withIndex("by_user", (q) => q.eq("userId", userId)).collect(),
      sites: await ctx.db.query("siteStats").withIndex("by_user_site", (q) => q.eq("userId", userId)).collect(),
      days: await ctx.db.query("dailyStats").withIndex("by_user_day", (q) => q.eq("userId", userId)).order("desc").take(400),
      sessions: await ctx.db.query("focusSessions").withIndex("by_user_started", (q) => q.eq("userId", userId)).order("desc").take(10),
      siteUsage: await ctx.db.query("siteUsageStats").withIndex("by_user_site", (q) => q.eq("userId", userId)).collect(),
      recentSiteVisits: await ctx.db.query("siteVisits").withIndex("by_user_started", (q) => q.eq("userId", userId)).order("desc").take(25),
      usageDays: await ctx.db.query("siteUsageDaily").withIndex("by_user_day_site", (q) => q.eq("userId", userId)).order("desc").take(250),
      feedAccessToday: await ctx.db.query("feedAccessDaily").withIndex("by_user_day", (q) => q.eq("userId", userId).eq("day", requestedDay)).unique(),
      feedAccessDays: await ctx.db.query("feedAccessDaily").withIndex("by_user_day", (q) => q.eq("userId", userId)).order("desc").take(14),
    })));
    const totals = groups.reduce((sum, group) => {
      if (!group.stats) return sum;
      for (const key of ["sessionsStarted", "completedSessions", "emergencyStops", "distractionsBlocked", "plannedMinutes", "completedMinutes"] as const) sum[key] += group.stats[key];
      sum.updatedAt = Math.max(sum.updatedAt, group.stats.updatedAt);
      return sum;
    }, emptyStats(args.userId, 0));
    const installations = groups.flatMap((group) => group.installations);
    const sessions = groups.flatMap((group) => group.sessions).sort((a, b) => b.startedAt - a.startedAt).slice(0, 10);
    const recentSiteVisits = groups.flatMap((group) => group.recentSiteVisits).sort((a, b) => b.startedAt - a.startedAt).slice(0, 25);
    const siteMap = new Map<string, number>();
    for (const site of groups.flatMap((group) => group.sites)) siteMap.set(site.siteKey, (siteMap.get(site.siteKey) ?? 0) + site.distractionsBlocked);
    const usageMap = new Map<string, { siteKey: string; opens: number; visibleSeconds: number; lastOpenedAt?: number }>();
    for (const item of groups.flatMap((group) => group.siteUsage)) {
      const current = usageMap.get(item.siteKey) ?? { siteKey: item.siteKey, opens: 0, visibleSeconds: 0 };
      current.opens += item.opens; current.visibleSeconds += item.visibleSeconds;
      current.lastOpenedAt = Math.max(current.lastOpenedAt ?? 0, item.lastOpenedAt ?? 0) || undefined;
      usageMap.set(item.siteKey, current);
    }
    const dayMap = new Map<string, ReturnType<typeof emptyStats> & { day: string }>();
    for (const item of groups.flatMap((group) => group.days)) {
      const current = dayMap.get(item.day) ?? { ...emptyStats(args.userId, 0), day: item.day };
      current.sessionsStarted += item.sessionsStarted; current.completedSessions += item.completedSessions;
      current.distractionsBlocked += item.distractionsBlocked; current.plannedMinutes += item.plannedMinutes; current.completedMinutes += item.completedMinutes;
      dayMap.set(item.day, current);
    }
    const completedDaySet = new Set([...dayMap.values()].filter((day) => day.completedSessions > 0).map((day) => day.day));
    const previousDay = (day: string) => utcDay(Date.parse(`${day}T12:00:00Z`) - 24 * 60 * 60 * 1000);
    let streakCursor = requestedDay;
    if (!completedDaySet.has(streakCursor)) streakCursor = previousDay(streakCursor);
    let focusStreak = 0;
    while (completedDaySet.has(streakCursor)) { focusStreak += 1; streakCursor = previousDay(streakCursor); }
    // Keep legacy desktop totals unchanged. The profile activity series combines devices once.
    let profile;
    if (args.includeProfile) {
      const user=await ctx.db.query("users").withIndex("by_user_id",q=>q.eq("userId",args.userId)).unique();
      const mobile=await ctx.db.query("mobileSummaries").withIndex("by_user_source",q=>q.eq("userId",args.userId)).collect();
      const activity=new Map([...dayMap.values()].map(d=>[d.day,{day:d.day,completed:d.completedSessions,minutes:d.completedMinutes}]));
      for(const source of mobile) for(const d of source.days??[]) {
        const prior=activity.get(d.day)??{day:d.day,completed:0,minutes:0};
        activity.set(d.day,{day:d.day,completed:prior.completed+d.completed,minutes:prior.minutes+d.minutes});
      }
      const focusDays=new Set([...activity.values()].filter(d=>d.completed>0).map(d=>d.day));
      let cursor=focusDays.has(requestedDay)?requestedDay:previousDay(requestedDay),combinedStreak=0;
      while(focusDays.has(cursor)){combinedStreak++;cursor=previousDay(cursor);}
      profile={displayName:user?.displayName??null,email:user?.email??null,
        focusStreak:combinedStreak,
        mobileTotals:mobile.reduce((s,r)=>({completed:s.completed+r.completed,minutes:s.minutes+r.minutes,attempts:s.attempts+r.attempts,endedEarly:s.endedEarly+r.endedEarly}),{completed:0,minutes:0,attempts:0,endedEarly:0}),
        days:[...activity.values()].filter(d=>d.day<=requestedDay).sort((a,b)=>a.day.localeCompare(b.day)).slice(-400),
        mobileDailyHistoryIncomplete:mobile.some(s=>s.completed>(s.days??[]).reduce((sum,d)=>sum+d.completed,0))};
    }
    const usageDayMap = new Map<string, { day: string; siteKey: string; opens: number; visibleSeconds: number }>();
    for (const item of groups.flatMap((group) => group.usageDays)) {
      const key = `${item.day}:${item.siteKey}`;
      const current = usageDayMap.get(key) ?? { day: item.day, siteKey: item.siteKey, opens: 0, visibleSeconds: 0 };
      current.opens += item.opens; current.visibleSeconds += item.visibleSeconds; usageDayMap.set(key, current);
    }
    return {
      ...totals,
      feedUnblocksToday: groups.reduce((sum, group) => sum + (group.feedAccessToday?.unblocks ?? 0), 0),
      feedUnblocksRecent: groups.reduce((sum, group) => sum + group.feedAccessDays.reduce((daySum, day) => daySum + day.unblocks, 0), 0),
      feedUnblocksDay: requestedDay,
      focusStreak,
      ...(profile ? {profile} : {}),
      browsers: installations.map((item) => ({
        browserId: item.browserId,
        browserLabel: item.browserLabel,
        sessionsStarted: item.sessionsStarted,
        distractionsBlocked: item.distractionsBlocked,
        lastSeenAt: item.lastSeenAt,
      })).sort((a, b) => b.lastSeenAt - a.lastSeenAt),
      topSites: [...siteMap].map(([siteKey, count]) => ({ siteKey, count })).sort((a, b) => b.count - a.count).slice(0, 8),
      days: [...dayMap.values()].sort((a, b) => a.day.localeCompare(b.day)).slice(-14).map(({ day, sessionsStarted, completedSessions, distractionsBlocked, plannedMinutes, completedMinutes }) =>
        ({ day, sessionsStarted, completedSessions, distractionsBlocked, plannedMinutes, completedMinutes })),
      recentSessions: sessions.map(({ sessionId, startedAt, endedAt, durationMinutes, focusLevel, status }) =>
        ({ sessionId, startedAt, endedAt, durationMinutes, focusLevel, status })),
      siteUsage: [...usageMap.values()].sort((a, b) => b.visibleSeconds - a.visibleSeconds).map(({ siteKey, opens, visibleSeconds, lastOpenedAt }) =>
        ({ siteKey, opens, visibleSeconds, lastOpenedAt })),
      recentSiteVisits: recentSiteVisits.map(({ visitId, siteKey, startedAt, lastActiveAt, visibleSeconds }) =>
        ({ visitId, siteKey, startedAt, lastActiveAt, visibleSeconds })),
      usageDays: [...usageDayMap.values()].sort((a, b) => a.day.localeCompare(b.day)).slice(-250),
      accountConnected: (await ctx.db.query("accountCredentials").withIndex("by_access_token", (q) => q.eq("accessToken", args.accessToken)).unique()) !== null,
    };
  },
});

export const getSession = query({
  args: credentials,
  handler: async (ctx, args) => {
    await requireUser(ctx, args.userId, args.accessToken);
    return await ctx.db.query("focusSyncStates").withIndex("by_user", (q) => q.eq("userId", args.userId)).unique();
  },
});

export const publishSession = mutation({
  args: {
    ...credentials,
    sessionId: v.string(),
    sessionStart: v.number(),
    sessionEnd: v.number(),
    durationMinutes: v.number(),
    focusLevel,
    siteKeys: v.array(v.string()),
    active: v.boolean(),
    endReason: v.optional(endReason),
    updatedAt: v.number(),
    updatedByInstallationId: v.string(),
  },
  handler: async (ctx, args) => {
    await requireUser(ctx, args.userId, args.accessToken);
    const existing = await ctx.db.query("focusSyncStates").withIndex("by_user", (q) => q.eq("userId", args.userId)).unique();
    // Updated clients use sessions:start / stop. An old queued write must never replace server state.
    if (existing?.serverManaged) return existing._id;
    if (existing && existing.updatedAt > args.updatedAt) return existing._id;
    const { accessToken: _accessToken, ...state } = args;
    if (existing) {
      await ctx.db.replace(existing._id, state);
      return existing._id;
    }
    return await ctx.db.insert("focusSyncStates", state);
  },
});
