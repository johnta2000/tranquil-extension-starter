import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

const focusLevel = v.union(v.literal("standard"), v.literal("deep"));
const endReason = v.union(v.literal("completed"), v.literal("emergency"));

export default defineSchema({
  accessAccounts: defineTable({ userId: v.string(), timeZone: v.string(), createdAt: v.number() }).index("by_user", ["userId"]),
  accessPolicies: defineTable({ userId: v.string(), siteKey: v.string(), blocked: v.boolean(), updatedAt: v.number() }).index("by_user_site", ["userId", "siteKey"]),
  accessDays: defineTable({ userId: v.string(), siteKey: v.string(), day: v.string(), used: v.number() }).index("by_user_site_day", ["userId", "siteKey", "day"]),
  accessGrants: defineTable({ userId: v.string(), requestId: v.string(), installationId: v.string(), siteKey: v.string(), url: v.string(), purpose: v.string(), startedAt: v.number(), expiresAt: v.number(), ended: v.boolean() }).index("by_user_request", ["userId", "requestId"]).index("by_user_start", ["userId", "startedAt"]),
  mobileSummaries: defineTable({ userId: v.string(), sourceId: v.string(), completed: v.number(), minutes: v.number(), attempts: v.number(), passes: v.number(), endedEarly: v.number(), updatedAt: v.number(), days: v.optional(v.array(v.object({day:v.string(),completed:v.number(),minutes:v.number()}))) }).index("by_user_source", ["userId", "sourceId"]),
  users: defineTable({
    userId: v.string(),
    accessToken: v.string(),
    createdAt: v.number(),
    lastSeenAt: v.number(),
    displayName: v.optional(v.string()),
    email: v.optional(v.string()),
  })
    .index("by_user_id", ["userId"])
    .index("by_access_token", ["accessToken"]),

  accountCredentials: defineTable({
    userId: v.string(),
    accessToken: v.string(),
    installationId: v.string(),
    createdAt: v.number(),
    lastSeenAt: v.number(),
  })
    .index("by_access_token", ["accessToken"])
    .index("by_user", ["userId", "lastSeenAt"]),

  accountLinks: defineTable({
    userId: v.string(),
    legacyUserId: v.string(),
    linkedAt: v.number(),
  })
    .index("by_user", ["userId", "linkedAt"])
    .index("by_legacy_user", ["legacyUserId"]),

  clerkLinkRequests: defineTable({
    code: v.string(),
    proposedAccessToken: v.string(),
    installationId: v.string(),
    legacyUserId: v.string(),
    legacyAccessToken: v.string(),
    createdAt: v.number(),
    expiresAt: v.number(),
    claimedUserId: v.optional(v.string()),
    claimedAt: v.optional(v.number()),
  }).index("by_code", ["code"]),

  installations: defineTable({
    userId: v.string(),
    installationId: v.string(),
    browserId: v.string(),
    browserLabel: v.string(),
    createdAt: v.number(),
    lastSeenAt: v.number(),
    sessionsStarted: v.number(),
    distractionsBlocked: v.number(),
  })
    .index("by_installation", ["installationId"])
    .index("by_user", ["userId", "lastSeenAt"]),

  focusSessions: defineTable({
    serverManaged: v.optional(v.boolean()),
    userId: v.string(),
    sessionId: v.string(),
    startedAt: v.number(),
    scheduledEndAt: v.number(),
    endedAt: v.optional(v.number()),
    durationMinutes: v.number(),
    focusLevel,
    siteKeys: v.array(v.string()),
    status: v.union(v.literal("active"), v.literal("completed"), v.literal("emergency")),
    startedByInstallationId: v.string(),
    updatedAt: v.number(),
  })
    .index("by_session_id", ["sessionId"])
    .index("by_user_started", ["userId", "startedAt"]),

  focusEvents: defineTable({
    userId: v.string(),
    eventId: v.string(),
    installationId: v.string(),
    browserId: v.string(),
    browserLabel: v.string(),
    sessionId: v.string(),
    eventType: v.union(
      v.literal("session_started"),
      v.literal("session_ended"),
      v.literal("distraction_blocked"),
    ),
    occurredAt: v.number(),
    plannedMinutes: v.optional(v.number()),
    focusLevel: v.optional(focusLevel),
    siteKey: v.optional(v.string()),
    endReason: v.optional(endReason),
  })
    .index("by_event_id", ["eventId"])
    .index("by_user_occurred", ["userId", "occurredAt"]),

  userStats: defineTable({
    userId: v.string(),
    sessionsStarted: v.number(),
    completedSessions: v.number(),
    emergencyStops: v.number(),
    distractionsBlocked: v.number(),
    plannedMinutes: v.number(),
    completedMinutes: v.number(),
    updatedAt: v.number(),
  }).index("by_user", ["userId"]),

  siteStats: defineTable({
    userId: v.string(),
    siteKey: v.string(),
    distractionsBlocked: v.number(),
    updatedAt: v.number(),
  }).index("by_user_site", ["userId", "siteKey"]),

  usageEvents: defineTable({
    userId: v.string(),
    eventId: v.string(),
    installationId: v.string(),
    siteKey: v.string(),
    visitId: v.string(),
    eventType: v.union(v.literal("site_opened"), v.literal("visible_time")),
    occurredAt: v.number(),
    durationSeconds: v.optional(v.number()),
  })
    .index("by_event_id", ["eventId"])
    .index("by_user_occurred", ["userId", "occurredAt"]),

  siteUsageStats: defineTable({
    userId: v.string(),
    siteKey: v.string(),
    opens: v.number(),
    visibleSeconds: v.number(),
    lastOpenedAt: v.optional(v.number()),
    updatedAt: v.number(),
  }).index("by_user_site", ["userId", "siteKey"]),

  siteUsageDaily: defineTable({
    userId: v.string(),
    day: v.string(),
    siteKey: v.string(),
    opens: v.number(),
    visibleSeconds: v.number(),
    updatedAt: v.number(),
  }).index("by_user_day_site", ["userId", "day", "siteKey"]),

  siteVisits: defineTable({
    userId: v.string(),
    visitId: v.string(),
    siteKey: v.string(),
    installationId: v.string(),
    startedAt: v.number(),
    lastActiveAt: v.number(),
    visibleSeconds: v.number(),
  })
    .index("by_visit_id", ["visitId"])
    .index("by_user_started", ["userId", "startedAt"]),

  feedAccessEvents: defineTable({
    userId: v.string(),
    eventId: v.string(),
    installationId: v.string(),
    scope: v.union(v.literal("all"), v.literal("site")),
    siteKey: v.optional(v.string()),
    occurredAt: v.number(),
    localDay: v.string(),
  })
    .index("by_event_id", ["eventId"])
    .index("by_user_occurred", ["userId", "occurredAt"]),

  feedAccessDaily: defineTable({
    userId: v.string(),
    day: v.string(),
    unblocks: v.number(),
    updatedAt: v.number(),
  }).index("by_user_day", ["userId", "day"]),

  dailyStats: defineTable({
    userId: v.string(),
    day: v.string(),
    sessionsStarted: v.number(),
    completedSessions: v.number(),
    distractionsBlocked: v.number(),
    plannedMinutes: v.number(),
    completedMinutes: v.number(),
    updatedAt: v.number(),
  }).index("by_user_day", ["userId", "day"]),

  focusSyncStates: defineTable({
    serverManaged: v.optional(v.boolean()),
    emergencyReadyAt: v.optional(v.number()),
    userId: v.string(),
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
  }).index("by_user", ["userId"]),
});
