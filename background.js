import "./linkedin-links.js";
import { CONFIG } from "./config.js";

const CONVEX_URL = CONFIG.convexUrl.replace(/\/$/, "");
const ACCOUNT_CONNECT_URL = CONFIG.accountConnectUrl;
const DEFAULT_SESSION_MINUTES = 30;
const MIN_SESSION_MINUTES = 5;
const MAX_SESSION_MINUTES = 240;
const EMERGENCY_DELAY_MS = 30 * 1000;
const FEED_DISABLE_MIN_DELAY_SECONDS = 5;
const FEED_DISABLE_MAX_DELAY_SECONDS = 15;
const SESSION_ALARM = "stillspace-session-end";
const WORK_PASS_ALARM = "tranquil-work-pass-end";
const SYNC_ALARM = "stillspace-cross-browser-sync";
const USAGE_ALARM = "tranquil-usage-upload";
const USAGE_BATCH_SIZE = 50;
const FEED_GUARD_ALARM_PREFIX = "stillspace-feed-guard:";
const FEED_LIMIT_ALARM_PREFIX = "stillspace-feed-limit:";
const FEED_ACTIVE_LIMIT_MS = 5 * 60 * 1000;
const FEED_WARNING_MS = 60 * 1000;
const FEED_VISIT_RESET_MS = 30 * 60 * 1000;
const FEED_HEARTBEAT_CREDIT_MS = 10 * 1000;
const RULE_ID_START = 1000;

const SITES = {
  threads: { name: "Threads", domains: ["threads.com"] },
  instagram: { name: "Instagram", domains: ["instagram.com"] },
  facebook: { name: "Facebook", domains: ["facebook.com"] },
  x: { name: "X / Twitter", domains: ["x.com", "twitter.com"] },
  linkedin: { name: "LinkedIn", domains: ["linkedin.com"] },
  reddit: { name: "Reddit", domains: ["reddit.com"] },
  youtube: {
    name: "YouTube",
    domains: ["youtube.com"],
    // Google uses this host to finish account sign-in and synchronize cookies.
    // It is authentication infrastructure, not a browsable YouTube surface.
    excludedDomains: ["accounts.youtube.com"]
  },
  tiktok: { name: "TikTok", domains: ["tiktok.com"] },
  bookface: { name: "YC Bookface", domains: ["bookface.ycombinator.com"] }
};
const DEEP_ONLY_SITES = {
  gmail: { name: "Gmail", domains: ["mail.google.com"], exactHost: true }
};
const BLOCKABLE_SITES = { ...SITES, ...DEEP_ONLY_SITES };
const DEFAULT_SITE_POLICIES = Object.fromEntries(Object.keys(SITES).map((key) => [key, {
  level: key === "youtube" ? "work_pass" : "feed_only",
  maxMinutes: key === "youtube" ? 30 : 15
}]));

const EMERGENCY_PHRASES = [
  "I am choosing emergency access",
  "This cannot wait until the session ends",
  "I accept ending this focus session",
  "Stop this session for an emergency"
];

const EMPTY_STATS = {
  sessionsStarted: 0,
  completedSessions: 0,
  emergencyStops: 0,
  distractionsBlocked: 0,
  plannedMinutes: 0
};

const DEFAULT_SETTINGS = {
  feedBlockingEnabled: true,
  feedDisableRequest: null,
  siteDisableRequest: null,
  enabledSites: Object.fromEntries(Object.keys(SITES).map((key) => [key, true])),
  feedExceptions: [],
  attentionGuardEnabled: true,
  feedUsage: {},
  guardBlockedSites: {},
  lastSessionMinutes: DEFAULT_SESSION_MINUTES,
  lastFocusLevel: "standard",
  sessionStart: null,
  sessionEnd: null,
  sessionDurationMinutes: null,
  sessionFocusLevel: null,
  sessionSiteKeys: null,
  clientSessionId: null,
  emergencyRequest: null,
  emergencyUntil: null,
  emergencyUsed: false,
  emergencyLog: [],
  installationId: null,
  browserId: null,
  browserLabel: null,
  userId: null,
  accessToken: null,
  accountConnected: false,
  accountLinkRequest: null,
  clientRegistered: false,
  pendingSyncUpdate: null,
  serverManagedSession: false,
  focusSyncError: null,
  accountStatsCache: null,
  blockedReturnUrls: {},
  statsQueue: [],
  usageQueue: [],
  feedAccessQueue: [],
  localFeedAccessDaily: {},
  sitePolicies: DEFAULT_SITE_POLICIES,
  workPass: null,
  sharedAccess: null,
  sharedAccessError: null,
  localStats: EMPTY_STATS
};

let statsPersistChain = Promise.resolve();
let statsFlushPromise = null;
let usagePersistChain = Promise.resolve();
let usageFlushPromise = null;
let feedAccessPersistChain = Promise.resolve();
let feedAccessFlushPromise = null;
let feedActivityChain = Promise.resolve();
let sharedSyncPromise = null;
let sharedMutationRevision = 0;
let returnUrlPersistChain = Promise.resolve();

async function getSettings() {
  const [saved, syncedPolicy] = await Promise.all([
    chrome.storage.local.get(DEFAULT_SETTINGS),
    chrome.storage.sync.get({ sitePolicies: null })
  ]);
  const persistedPolicies = syncedPolicy.sitePolicies || saved.sitePolicies || {};
  const result = {
    ...DEFAULT_SETTINGS,
    ...saved,
    enabledSites: { ...DEFAULT_SETTINGS.enabledSites, ...(saved.enabledSites || {}) },
    sitePolicies: {
      ...DEFAULT_SITE_POLICIES,
      ...persistedPolicies,
      ...Object.fromEntries(Object.entries(persistedPolicies).map(([key, policy]) => [key, { ...DEFAULT_SITE_POLICIES[key], ...policy }]))
    },
    feedExceptions: Array.isArray(saved.feedExceptions) ? saved.feedExceptions : [],
    feedUsage: saved.feedUsage && typeof saved.feedUsage === "object" ? saved.feedUsage : {},
    guardBlockedSites: saved.guardBlockedSites && typeof saved.guardBlockedSites === "object" ? saved.guardBlockedSites : {},
    emergencyLog: Array.isArray(saved.emergencyLog) ? saved.emergencyLog : [],
    statsQueue: Array.isArray(saved.statsQueue) ? saved.statsQueue : [],
    usageQueue: Array.isArray(saved.usageQueue) ? saved.usageQueue : [],
    feedAccessQueue: Array.isArray(saved.feedAccessQueue) ? saved.feedAccessQueue : [],
    localFeedAccessDaily: saved.localFeedAccessDaily && typeof saved.localFeedAccessDaily === "object" ? saved.localFeedAccessDaily : {},
    localStats: { ...EMPTY_STATS, ...(saved.localStats || {}) }
  };
  if (saved.sharedAccess?.enabled) {
    for (const p of saved.sharedAccess.policies) {
      result.sitePolicies[p.siteKey] = { level: p.blocked ? "blocked" : "work_pass", maxMinutes: p.maxMinutes };
      result.enabledSites[p.siteKey] = true;
    }
    result.workPass = saved.sharedAccess.grants.find(g => g.installationId === saved.installationId && g.expiresAt > Date.now()) || null;
  }
  return result;
}

function localDay(timestamp = Date.now()) {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function randomFeedDisableDelayMs(priorOpenCount = 0) {
  const range = FEED_DISABLE_MAX_DELAY_SECONDS - FEED_DISABLE_MIN_DELAY_SECONDS + 1;
  const random = new Uint32Array(1);
  crypto.getRandomValues(random);
  const repeatedUsePenaltySeconds = Math.min(Math.max(0, priorOpenCount), 3) * 15;
  return (FEED_DISABLE_MIN_DELAY_SECONDS + (random[0] % range) + repeatedUsePenaltySeconds) * 1000;
}

function localFeedOpenCountToday(settings, timestamp = Date.now()) {
  return settings.localFeedAccessDaily[localDay(timestamp)] || 0;
}

function localFeedOpenCountRecent(settings, timestamp = Date.now(), days = 14) {
  const includedDays = new Set();
  for (let offset = 0; offset < days; offset += 1) includedDays.add(localDay(timestamp - offset * 24 * 60 * 60 * 1000));
  return Object.entries(settings.localFeedAccessDaily)
    .filter(([day]) => includedDays.has(day))
    .reduce((sum, [, count]) => sum + count, 0);
}

function getActiveSiteKeys(settings) {
  return Object.keys(SITES).filter((key) => settings.enabledSites[key] !== false);
}

function getBlockingSiteKeys(settings, focusLevel = settings.sessionFocusLevel) {
  if (settings.sessionEnd && Array.isArray(settings.sessionSiteKeys)) return settings.sessionSiteKeys;
  const keys = getActiveSiteKeys(settings);
  if (focusLevel === "deep") keys.push("gmail");
  return keys;
}

function getStrictSiteKeys(settings) {
  return Object.keys(SITES).filter((key) => ["work_pass", "blocked"].includes(settings.sitePolicies?.[key]?.level));
}

function getRuleSiteKeys(settings) {
  const sessionKeys = settings.sessionEnd && settings.sessionEnd > Date.now() ? getBlockingSiteKeys(settings) : [];
  return [...new Set([...sessionKeys, ...getStrictSiteKeys(settings)])];
}

function regexEscape(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function activeWorkPass(settings) {
  return settings.workPass?.expiresAt > Date.now() ? settings.workPass : null;
}

function buildWorkPassRule(settings) {
  if (settings.sessionEnd > Date.now()) return null;
  const pass = activeWorkPass(settings);
  if (!pass) return null;
  return {
    id: RULE_ID_START - 1,
    priority: 100,
    action: { type: "allow" },
    condition: { regexFilter: pass.requestId ? sharedPassRegex(pass.url) : `^${regexEscape(pass.url)}([&#].*)?$`, resourceTypes: ["main_frame"] }
  };
}

function buildSessionRules(siteKeys) {
  const redirectBase = chrome.runtime.getURL("blocked.html");
  let ruleId = RULE_ID_START;
  return siteKeys.flatMap((siteKey) =>
    BLOCKABLE_SITES[siteKey].domains.map((domain) => ({
      id: ruleId++,
      priority: 1,
      action: { type: "redirect", redirect: { regexSubstitution: `${redirectBase}?site=${encodeURIComponent(siteKey)}` } },
      condition: {
        regexFilter: BLOCKABLE_SITES[siteKey].exactHost
          ? `^https?://${domain.replaceAll(".", "\\.")}(/.*)?$`
          : `^https?://([^/]+\\.)?${domain.replaceAll(".", "\\.")}(/.*)?$`,
        ...(BLOCKABLE_SITES[siteKey].excludedDomains?.length
          ? { excludedRequestDomains: BLOCKABLE_SITES[siteKey].excludedDomains }
          : {}),
        resourceTypes: ["main_frame"]
      }
    }))
  );
}

async function clearRules() {
  const current = await chrome.declarativeNetRequest.getDynamicRules();
  if (!current.length) return;
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: current.map((rule) => rule.id) });
}

async function installRules(settings) {
  const rules = buildSessionRules(getRuleSiteKeys(settings));
  const workPassRule = buildWorkPassRule(settings);
  if (workPassRule) rules.push(workPassRule);
  if (settings.sharedAccess?.enabled) {
    rules.push({id:900,priority:200,action:{type:"allow"},condition:{regexFilter:"^https://(www\\.|m\\.)?(facebook\\.com|linkedin\\.com|reddit\\.com)/(login|login\\.php|checkpoint|auth|oauth|signin|uas/login)([/?].*)?$",resourceTypes:["main_frame"]}});
  }
  const current = await chrome.declarativeNetRequest.getDynamicRules();
  await chrome.declarativeNetRequest.updateDynamicRules({removeRuleIds:current.map(r=>r.id),addRules:rules});
}

function sharedPassRegex(raw) {
  const u=new URL(raw), host=u.hostname.replace(/^www\./,"");
  const prefix=`^https://(www\\.|m\\.|mobile\\.)?${regexEscape(host)}`;
  const group=host==="facebook.com" && /^\/groups\/[^/]+$/.test(u.pathname);
  return prefix+regexEscape(u.pathname)+(group?"(/posts/[^?#]*)?":"/?")+regexEscape(u.search)+(u.search?"([&#].*)?$":"([?#].*)?$");
}

let accessSyncPromise=null;
async function reconcileAccess() {
  if(accessSyncPromise)return accessSyncPromise;
  accessSyncPromise=(async()=>{
    const settings=await getSettings();
    if(!settings.accountConnected)return;
    try {
      const identity=await ensureClientRegistration();
      let value=await convexCall("query","access:status",{userId:identity.userId,accessToken:identity.accessToken});
      if(!value.enabled) {
        await convexCall("mutation","access:enable",{userId:identity.userId,accessToken:identity.accessToken,timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone});
        value=await convexCall("query","access:status",{userId:identity.userId,accessToken:identity.accessToken});
      }
      await chrome.storage.local.set({sharedAccess:value,sharedAccessError:null});
      const next=await getSettings();await installRules(next);
      const pass=activeWorkPass(next);
      if(pass) await chrome.alarms.create(WORK_PASS_ALARM,{when:pass.expiresAt});
      await redirectOpenBlockedTabs(next,"shared_allowance");
    } catch {await chrome.storage.local.set({sharedAccessError:"Shared sync unavailable; cached restrictions remain active."});}
  })().finally(()=>{accessSyncPromise=null;});
  return accessSyncPromise;
}

function findSiteKey(url, siteKeys) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    return siteKeys.find((key) => {
      const site = BLOCKABLE_SITES[key];
      if (site.excludedDomains?.some((domain) => host === domain || host.endsWith(`.${domain}`))) return false;
      return site.domains.some((domain) => host === domain || (!site.exactHost && host.endsWith(`.${domain}`)));
    });
  } catch {
    return null;
  }
}

async function redirectOpenBlockedTabs(settings, source = "session_start") {
  const siteKeys = getRuleSiteKeys(settings);
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.map(async (tab) => {
    if (!tab.id || !tab.url) return;
    const siteKey = findSiteKey(tab.url, siteKeys);
    if (!siteKey) return;
    if(settings.sharedAccess?.enabled && /^https:\/\/(www\.|m\.)?(facebook\.com|linkedin\.com|reddit\.com)\/(login|login\.php|checkpoint|auth|oauth|signin|uas\/login)([/?]|$)/.test(tab.url))return;
    const pass=activeWorkPass(settings);
    if(!(settings.sessionEnd>Date.now()) && pass && new RegExp(pass.requestId?sharedPassRegex(pass.url):`^${regexEscape(pass.url)}([&#].*)?$`).test(tab.url))return;
    try {
      await rememberBlockedReturnUrl(tab.id, tab.url, siteKey, settings.clientSessionId);
      await chrome.tabs.update(tab.id, {
        url: chrome.runtime.getURL(`blocked.html?site=${encodeURIComponent(siteKey)}&source=${encodeURIComponent(source)}`)
      });
    } catch {
      // The tab may disappear between query and update.
    }
  }));
}

function sanitizeReturnUrl(url, siteKey) {
  try {
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol)) return null;
    return findSiteKey(parsed.href, [siteKey]) === siteKey ? parsed.href : null;
  } catch {
    return null;
  }
}

async function rememberBlockedReturnUrl(tabId, url, siteKey, sessionId = null) {
  if (!Number.isInteger(tabId) || tabId < 0) return false;
  const safeUrl = sanitizeReturnUrl(url, siteKey);
  if (!safeUrl) return false;
  returnUrlPersistChain = returnUrlPersistChain.catch(() => {}).then(async () => {
    const settings = await getSettings();
    const entries = Object.entries(settings.blockedReturnUrls || {})
      .filter(([key]) => key !== String(tabId))
      .slice(-49);
    await chrome.storage.local.set({
      blockedReturnUrls: Object.fromEntries([...entries, [String(tabId), {
        url: safeUrl,
        siteKey,
        sessionId: sessionId || settings.clientSessionId,
        capturedAt: Date.now()
      }]])
    });
  });
  await returnUrlPersistChain;
  return true;
}

async function getBlockedReturnUrl(tabId, siteKey) {
  await returnUrlPersistChain.catch(() => {});
  const settings = await getSettings();
  const entry = settings.blockedReturnUrls?.[String(tabId)];
  return entry?.siteKey === siteKey ? sanitizeReturnUrl(entry.url, siteKey) : null;
}

async function clearBlockedReturnUrl(tabId) {
  const settings = await getSettings();
  const blockedReturnUrls = { ...(settings.blockedReturnUrls || {}) };
  delete blockedReturnUrls[String(tabId)];
  await chrome.storage.local.set({ blockedReturnUrls });
}

async function convexCall(kind, path, args) {
  if (!CONVEX_URL) throw new Error("Cloud sync is off. Configure your own Convex deployment in config.js to enable it.");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(`${CONVEX_URL}/api/${kind}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, args, format: "json" }),
      signal: controller.signal
    });
    const payload = await response.json();
    if (!response.ok || payload.status === "error") throw new Error(payload.errorMessage || `Convex ${kind} failed.`);
    return payload.value;
  } finally {
    clearTimeout(timeout);
  }
}

async function detectBrowserLabel() {
  let browserName = "Chrome";
  try {
    if (globalThis.navigator?.brave?.isBrave && await globalThis.navigator.brave.isBrave()) browserName = "Brave";
  } catch {
    // Browser identification is cosmetic only.
  }
  const platform = globalThis.navigator?.userAgentData?.platform || globalThis.navigator?.platform || "Computer";
  const device = /mac/i.test(platform) ? "Mac" : /win/i.test(platform) ? "Windows" : /linux/i.test(platform) ? "Linux" : "Computer";
  return `${browserName} – ${device}`;
}

async function ensureBrowserIdentity() {
  const settings = await getSettings();
  const installationId = settings.installationId || crypto.randomUUID();
  const browserId = settings.browserId || crypto.randomUUID();
  const browserLabel = settings.browserLabel || await detectBrowserLabel();
  if (!settings.installationId || !settings.browserId || !settings.browserLabel) {
    await chrome.storage.local.set({ installationId, browserId, browserLabel });
  }
  return { installationId, browserId, browserLabel };
}

async function ensureUserIdentity() {
  const settings = await getSettings();
  let synced = {};
  try {
    synced = await chrome.storage.sync.get({ userId: null, accessToken: null });
  } catch {
    // Local credentials still work when browser sync is unavailable or disabled.
  }
  const userId = synced.userId || settings.userId || crypto.randomUUID();
  const accessToken = synced.accessToken || settings.accessToken || `${crypto.randomUUID()}${crypto.randomUUID()}`;
  if (settings.userId !== userId || settings.accessToken !== accessToken) {
    await chrome.storage.local.set({ userId, accessToken, clientRegistered: false });
  }
  if (synced.userId !== userId || synced.accessToken !== accessToken) {
    try { await chrome.storage.sync.set({ userId, accessToken }); } catch { /* Local-only identity is a valid fallback. */ }
  }
  return { userId, accessToken };
}

async function ensureClientRegistration() {
  const user = await ensureUserIdentity();
  const browser = await ensureBrowserIdentity();
  const settings = await getSettings();
  if (!settings.clientRegistered) {
    await convexCall("mutation", "focus:registerClient", { ...user, ...browser, clientNow: Date.now() });
    await chrome.storage.local.set({ clientRegistered: true });
  }
  return { ...user, ...browser };
}

function randomHex(byteLength) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function startAccountLink() {
  if (!CONVEX_URL || !ACCOUNT_CONNECT_URL) throw new Error("Account linking is not configured for this fork. Local blocking works without sign-in.");
  const identity = await ensureClientRegistration();
  const code = randomHex(24);
  const proposedAccessToken = randomHex(48);
  const result = await convexCall("mutation", "focus:beginClerkLink", {
    userId: identity.userId,
    accessToken: identity.accessToken,
    installationId: identity.installationId,
    code,
    proposedAccessToken,
    clientNow: Date.now()
  });
  const request = { code, proposedAccessToken, expiresAt: result.expiresAt };
  await chrome.storage.local.set({ accountLinkRequest: request });
  await chrome.tabs.create({ url: `${ACCOUNT_CONNECT_URL}?code=${encodeURIComponent(code)}` });
  return { pending: true, expiresAt: result.expiresAt };
}

async function checkAccountLink() {
  const settings = await getSettings();
  if (settings.accountConnected) return { connected: true };
  const request = settings.accountLinkRequest;
  if (!request || request.expiresAt < Date.now()) return { connected: false, pending: false };
  const result = await convexCall("mutation", "focus:completeClerkLink", {
    code: request.code,
    proposedAccessToken: request.proposedAccessToken
  });
  if (!result.connected) return { connected: false, pending: true, expiresAt: request.expiresAt };
  await chrome.storage.local.set({
    userId: result.userId,
    accessToken: result.accessToken,
    accountConnected: true,
    accountLinkRequest: null,
    clientRegistered: false
  });
  try { await chrome.storage.sync.set({ userId: result.userId, accessToken: result.accessToken, accountConnected: true }); } catch { /* Local account connection remains valid. */ }
  await ensureClientRegistration();
  return { connected: true };
}

function incrementLocalStats(stats, event) {
  const next = { ...stats };
  if (event.eventType === "session_started") {
    next.sessionsStarted += 1;
    next.plannedMinutes += event.plannedMinutes || 0;
  }
  if (event.eventType === "session_ended" && event.endReason === "completed") next.completedSessions += 1;
  if (event.eventType === "session_ended" && event.endReason === "emergency") next.emergencyStops += 1;
  if (event.eventType === "distraction_blocked") next.distractionsBlocked += 1;
  return next;
}

async function recordFocusEvent(event) {
  statsPersistChain = statsPersistChain.then(async () => {
    const settings = await getSettings();
    const identity = await ensureBrowserIdentity();
    const queuedEvent = { ...event, ...identity };
    await chrome.storage.local.set({
      statsQueue: [...settings.statsQueue, queuedEvent],
      localStats: incrementLocalStats(settings.localStats, event)
    });
  });
  await statsPersistChain;
  flushStatsQueue();
}

async function flushStatsQueue() {
  if (statsFlushPromise) return statsFlushPromise;
  statsFlushPromise = (async () => {
    await statsPersistChain;
    let settings = await getSettings();
    let identity;
    try {
      identity = await ensureClientRegistration();
      settings = await getSettings();
    } catch {
      return;
    }
    const remaining = [...settings.statsQueue];
    while (remaining.length) {
      try {
        const queued = remaining[0];
        const event = Object.fromEntries([
          "eventId", "installationId", "browserId", "browserLabel", "sessionId", "eventType", "occurredAt",
          "plannedMinutes", "focusLevel", "siteKey", "endReason", "sessionStart", "sessionEnd", "siteKeys"
        ].filter((key) => queued[key] !== undefined).map((key) => [key, queued[key]]));
        await convexCall("mutation", "focus:recordEvent", { userId: identity.userId, accessToken: identity.accessToken, ...event });
        remaining.shift();
        await chrome.storage.local.set({ statsQueue: remaining });
      } catch {
        break;
      }
    }
  })().finally(() => { statsFlushPromise = null; });
  return statsFlushPromise;
}

// Both appends and acknowledgments use the same lock. Never replace the queue
// with a stale snapshot after awaiting a network request.
function updateUsageQueue(update) {
  const next = usagePersistChain.catch(() => {}).then(async () => {
    const settings = await getSettings();
    const queue = await update(settings.usageQueue);
    await chrome.storage.local.set({ usageQueue: queue });
    return queue;
  });
  usagePersistChain = next;
  return next;
}

async function ensureUsageAlarm() {
  if (!await chrome.alarms.get(USAGE_ALARM)) {
    await chrome.alarms.create(USAGE_ALARM, { periodInMinutes: 1 });
  }
}

async function recordSiteUsageEvent(event) {
  const queue = await updateUsageQueue(async current => {
    const identity = await ensureBrowserIdentity();
    return [...current, { ...event, ...identity }];
  });
  await ensureUsageAlarm();
  if (queue.length >= USAGE_BATCH_SIZE) void flushUsageQueue();
}

async function flushUsageQueue() {
  if (usageFlushPromise) return usageFlushPromise;
  usageFlushPromise = (async () => {
    await usagePersistChain;
    if (!(await getSettings()).usageQueue.length) return;
    let identity;
    try { identity = await ensureClientRegistration(); } catch { return; }
    // Bound each wakeup; a durable alarm resumes any remaining offline backlog.
    for (let i = 0; i < 5; i++) {
      try {
        await usagePersistChain;
        const queued = (await getSettings()).usageQueue.slice(0, USAGE_BATCH_SIZE);
        if (!queued.length) break;
        const events = queued.map(event => ({
          eventId: event.eventId,
          installationId: event.installationId,
          siteKey: event.siteKey,
          visitId: event.visitId,
          eventType: event.eventType,
          occurredAt: event.occurredAt,
          ...(event.durationSeconds === undefined ? {} : { durationSeconds: event.durationSeconds })
        }));
        const result = await convexCall("mutation", "focus:recordUsageBatch", {
          userId: identity.userId, accessToken: identity.accessToken, events
        });
        if (result?.accepted !== events.length) throw new Error("Usage batch was not acknowledged.");
        const acknowledged = new Set(events.map(event => event.eventId));
        await updateUsageQueue(current => current.filter(event => !acknowledged.has(event.eventId)));
      } catch {
        break; // Leave the durable queue intact for a safe idempotent retry.
      }
    }
  })().finally(() => { usageFlushPromise = null; });
  return usageFlushPromise;
}

async function recordFeedAccess(scope, siteKey) {
  const occurredAt = Date.now();
  const day = localDay(occurredAt);
  feedAccessPersistChain = feedAccessPersistChain.catch(() => {}).then(async () => {
    const settings = await getSettings();
    const identity = await ensureBrowserIdentity();
    const daily = { ...settings.localFeedAccessDaily, [day]: (settings.localFeedAccessDaily[day] || 0) + 1 };
    const recentDays = Object.fromEntries(Object.entries(daily).sort(([a], [b]) => b.localeCompare(a)).slice(0, 31));
    await chrome.storage.local.set({
      feedAccessQueue: [...settings.feedAccessQueue, {
        eventId: `feed-access:${crypto.randomUUID()}`,
        installationId: identity.installationId,
        scope,
        ...(siteKey ? { siteKey } : {}),
        occurredAt,
        localDay: day
      }].slice(-1000),
      localFeedAccessDaily: recentDays
    });
  });
  await feedAccessPersistChain;
  flushFeedAccessQueue();
}

async function flushFeedAccessQueue() {
  if (feedAccessFlushPromise) return feedAccessFlushPromise;
  feedAccessFlushPromise = (async () => {
    await feedAccessPersistChain;
    let identity;
    try { identity = await ensureClientRegistration(); } catch { return; }
    const settings = await getSettings();
    const remaining = [...settings.feedAccessQueue];
    while (remaining.length) {
      try {
        const queued = remaining[0];
        await convexCall("mutation", "focus:recordFeedAccess", {
          userId: identity.userId,
          accessToken: identity.accessToken,
          eventId: queued.eventId,
          installationId: queued.installationId,
          scope: queued.scope,
          ...(queued.siteKey ? { siteKey: queued.siteKey } : {}),
          occurredAt: queued.occurredAt,
          localDay: queued.localDay
        });
        remaining.shift();
        await chrome.storage.local.set({ feedAccessQueue: remaining });
      } catch {
        break;
      }
    }
  })().finally(() => { feedAccessFlushPromise = null; });
  return feedAccessFlushPromise;
}

async function getStats() {
  await Promise.all([flushStatsQueue(), flushUsageQueue(), flushFeedAccessQueue()]);
  const settings = await getSettings();
  const today = localDay();
  try {
    const { userId, accessToken } = await ensureClientRegistration();
    const stats=await convexCall("query", "focus:summary", { userId, accessToken, localDay: today,includeProfile:settings.accountConnected===true });
    if(settings.accountConnected && stats.profile) {
      const m=stats.profile.mobileTotals || {};
      stats.sessionsStarted+=(m.completed||0)+(m.endedEarly||0);
      stats.completedSessions+=m.completed||0;stats.completedMinutes+=m.minutes||0;
      stats.distractionsBlocked+=m.attempts||0;stats.emergencyStops+=m.endedEarly||0;
      stats.focusStreak=stats.profile.focusStreak;
      await chrome.storage.local.set({accountStatsCache:{userId,stats}});
    }
    return stats;
  } catch {
    if(settings.accountConnected && settings.accountStatsCache?.userId===settings.userId) return {...settings.accountStatsCache.stats,syncUnavailable:true};
    return {
      ...settings.localStats,
      feedUnblocksToday: settings.localFeedAccessDaily[today] || 0,
      feedUnblocksRecent: localFeedOpenCountRecent(settings),
      feedUnblocksDay: today
    };
  }
}

async function publishSharedSession(payload) {
  let identity;
  try { identity = await ensureClientRegistration(); } catch { return false; }
  const update = {
    ...payload,
    updatedAt: Date.now(),
    updatedByInstallationId: identity.installationId
  };
  await chrome.storage.local.set({ pendingSyncUpdate: update });
  try {
    await convexCall("mutation", "focus:publishSession", {
      userId: identity.userId,
      accessToken: identity.accessToken,
      ...update
    });
    const settings = await getSettings();
    if (settings.pendingSyncUpdate?.updatedAt === update.updatedAt) {
      await chrome.storage.local.set({ pendingSyncUpdate: null });
    }
    return true;
  } catch {
    return false;
  }
}

async function flushPendingSync() {
  const settings = await getSettings();
  if (!settings.pendingSyncUpdate) return true;
  try {
    const identity = await ensureClientRegistration();
    await convexCall("mutation", "focus:publishSession", {
      userId: identity.userId,
      accessToken: identity.accessToken,
      ...settings.pendingSyncUpdate
    });
    const current = await getSettings();
    if (current.pendingSyncUpdate?.updatedAt === settings.pendingSyncUpdate.updatedAt) {
      await chrome.storage.local.set({ pendingSyncUpdate: null });
    }
    return true;
  } catch {
    return false;
  }
}

async function endSession(reason = "completed", publish = true) {
  const settings = await getSettings();
  if (settings.serverManagedSession && reason === "emergency" && publish) throw new Error("Confirm the shared emergency stop online first.");
  const endedSettings = {
    ...settings,
    sessionStart: null,
    sessionEnd: null,
    sessionDurationMinutes: null,
    sessionFocusLevel: null,
    sessionSiteKeys: null,
    clientSessionId: null,
    serverManagedSession: false,
    emergencyRequest: null,
    emergencyUntil: null,
    emergencyUsed: false
  };
  await chrome.storage.local.set(endedSettings);
  await installRules(endedSettings);
  await chrome.alarms.clear(SESSION_ALARM);
  if (publish && settings.clientSessionId && !settings.serverManagedSession) {
    await publishSharedSession({
      sessionId: settings.clientSessionId,
      sessionStart: settings.sessionStart,
      sessionEnd: settings.sessionEnd,
      durationMinutes: settings.sessionDurationMinutes,
      focusLevel: settings.sessionFocusLevel,
      siteKeys: settings.sessionSiteKeys || getBlockingSiteKeys(settings),
      active: false,
      endReason: reason
    });
  }
  if (settings.clientSessionId && !settings.serverManagedSession) {
    await recordFocusEvent({
      eventId: `session:${settings.clientSessionId}:ended`,
      sessionId: settings.clientSessionId,
      eventType: "session_ended",
      occurredAt: Date.now(),
      endReason: reason
    });
  }
}

async function ensureSessionState() {
  const settings = await getSettings();
  if (!settings.sessionEnd) {
    await installRules(settings);
    return settings;
  }
  if (settings.sessionEnd <= Date.now()) {
    await endSession("completed");
    return { ...settings, sessionStart: null, sessionEnd: null, sessionDurationMinutes: null, sessionFocusLevel: null, sessionSiteKeys: null,
      clientSessionId: null, emergencyRequest: null, emergencyUntil: null, emergencyUsed: false };
  }
  const expectedCount = buildSessionRules(getRuleSiteKeys(settings)).length + (activeWorkPass(settings) ? 1 : 0);
  const existingRules = await chrome.declarativeNetRequest.getDynamicRules();
  if (existingRules.length !== expectedCount) await installRules(settings);
  await chrome.alarms.create(SESSION_ALARM, { when: settings.sessionEnd });
  return settings;
}

function normalizeDuration(value) {
  const minutes = Number(value);
  if (!Number.isInteger(minutes) || minutes < MIN_SESSION_MINUTES || minutes > MAX_SESSION_MINUTES) {
    throw new Error(`Choose a session from ${MIN_SESSION_MINUTES} to ${MAX_SESSION_MINUTES} minutes.`);
  }
  return minutes;
}

function normalizeFocusLevel(value) {
  if (value !== "standard" && value !== "deep") throw new Error("Choose Standard or Deep focus.");
  return value;
}

async function startSession(requestedMinutes, requestedFocusLevel) {
  const settings = await ensureSessionState();
  if (settings.sessionEnd && settings.sessionEnd > Date.now()) return settings.sessionEnd;
  const durationMinutes = normalizeDuration(requestedMinutes ?? settings.lastSessionMinutes);
  const focusLevel = normalizeFocusLevel(requestedFocusLevel ?? settings.lastFocusLevel ?? "standard");
  if (settings.accountConnected) {
    sharedMutationRevision++;
    const identity = await ensureClientRegistration();
    let result;
    try {
      result = await convexCall("mutation", "sessions:start", {
        userId:identity.userId, accessToken:identity.accessToken, installationId:identity.installationId,
        requestId:crypto.randomUUID(),minutes:durationMinutes,focusLevel,
        siteKeys:getBlockingSiteKeys({...settings,sessionEnd:null},focusLevel)
      });
    } catch {throw new Error("Couldn’t start focus across devices. Connect to the internet and retry.");}
    const remote=localizeSharedFocus(result);
    sharedMutationRevision++;
    await chrome.storage.local.set({lastSessionMinutes:durationMinutes,lastFocusLevel:focusLevel});
    await adoptSharedFocus(remote,settings);
    return remote.sessionEnd;
  }
  const sessionStart = Date.now();
  const sessionEnd = sessionStart + durationMinutes * 60 * 1000;
  const clientSessionId = crypto.randomUUID();
  const sessionSiteKeys = getBlockingSiteKeys({ ...settings, sessionEnd: null }, focusLevel);
  const activeSettings = { ...settings, lastSessionMinutes: durationMinutes, lastFocusLevel: focusLevel, sessionStart, sessionEnd,
    sessionDurationMinutes: durationMinutes, sessionFocusLevel: focusLevel, sessionSiteKeys, clientSessionId, emergencyRequest: null, emergencyUntil: null, emergencyUsed: false };
  await chrome.storage.local.set({ lastSessionMinutes: durationMinutes, lastFocusLevel: focusLevel, sessionStart, sessionEnd,
    sessionDurationMinutes: durationMinutes, sessionFocusLevel: focusLevel, sessionSiteKeys, clientSessionId, emergencyRequest: null, emergencyUntil: null, emergencyUsed: false });
  await installRules(activeSettings);
  await chrome.alarms.create(SESSION_ALARM, { when: sessionEnd });
  await redirectOpenBlockedTabs(activeSettings);
  await publishSharedSession({ sessionId: clientSessionId, sessionStart, sessionEnd, durationMinutes, focusLevel,
    siteKeys: sessionSiteKeys, active: true });
  await recordFocusEvent({ eventId: `session:${clientSessionId}:started`, sessionId: clientSessionId,
    eventType: "session_started", occurredAt: sessionStart, plannedMinutes: durationMinutes, focusLevel,
    sessionStart, sessionEnd, siteKeys: sessionSiteKeys });
  return sessionEnd;
}

function localizeSharedFocus(result) {
  if (!result.session) return null;
  const offset=result.serverNow-Date.now();
  return {...result.session,sessionStart:result.session.sessionStart-offset,sessionEnd:result.session.sessionEnd-offset};
}

async function adoptSharedFocus(remote,settings) {
  const values={sessionStart:remote.sessionStart,sessionEnd:remote.sessionEnd,
    sessionDurationMinutes:remote.durationMinutes,sessionFocusLevel:remote.focusLevel,
    sessionSiteKeys:remote.siteKeys,clientSessionId:remote.sessionId,serverManagedSession:remote.serverManaged===true,
    emergencyRequest:null,emergencyUntil:null,emergencyUsed:false};
  const activeSettings={...settings,...values};
  await chrome.storage.local.set(values);
  await installRules(activeSettings);
  await chrome.alarms.create(SESSION_ALARM,{when:remote.sessionEnd});
  await redirectOpenBlockedTabs(activeSettings,"cross_device_sync");
  return activeSettings;
}

async function reconcileSharedSession() {
  if (sharedSyncPromise) return sharedSyncPromise;
  sharedSyncPromise = (async () => {
    await reconcileAccess();
    const pendingFlushed = await flushPendingSync();
    const settings = await getSettings();
    if (!pendingFlushed && settings.pendingSyncUpdate) return ensureSessionState();

    let remote;
    const revision=sharedMutationRevision;
    try {
      const { userId, accessToken } = await ensureClientRegistration();
      remote = settings.accountConnected
        ? localizeSharedFocus(await convexCall("query","sessions:get",{userId,accessToken}))
        : await convexCall("query", "focus:getSession", { userId, accessToken });
      if(revision!==sharedMutationRevision)return getSettings();
      await chrome.storage.local.set({focusSyncError:null});
    } catch {
      await chrome.storage.local.set({focusSyncError:"Focus sync unavailable; saved restrictions remain active until their deadline."});
      return ensureSessionState();
    }

    if (!remote) {
      if (!settings.accountConnected && settings.sessionEnd && settings.sessionEnd > Date.now() && settings.clientSessionId) {
        await publishSharedSession({ sessionId: settings.clientSessionId, sessionStart: settings.sessionStart,
          sessionEnd: settings.sessionEnd, durationMinutes: settings.sessionDurationMinutes,
          focusLevel: settings.sessionFocusLevel, siteKeys: settings.sessionSiteKeys || getBlockingSiteKeys(settings), active: true });
      }
      return ensureSessionState();
    }

    if (remote.active && remote.sessionEnd > Date.now()) {
      if (settings.clientSessionId !== remote.sessionId || (remote.serverManaged && !settings.serverManagedSession)) {
        return adoptSharedFocus(remote,settings);
      }
      return ensureSessionState();
    }

    if (settings.clientSessionId === remote.sessionId && settings.sessionEnd) {
      await endSession(remote.endReason || "completed", false);
      return getSettings();
    }
    return ensureSessionState();
  })().finally(() => { sharedSyncPromise = null; });
  return sharedSyncPromise;
}

async function requestEmergency(reason) {
  const settings = await ensureSessionState();
  if (!settings.sessionEnd) throw new Error("There is no active focus session.");
  const cleanReason = String(reason || "").trim();
  if (cleanReason.length < 10) throw new Error("Briefly explain why access cannot wait.");
  if (settings.emergencyRequest) return settings.emergencyRequest;
  if (settings.accountConnected && settings.serverManagedSession) {
    const identity=await ensureClientRegistration();
    const result=await convexCall("mutation","sessions:beginEmergency",{userId:identity.userId,accessToken:identity.accessToken,sessionId:settings.clientSessionId});
    const emergencyRequest={reason:cleanReason.slice(0,280),phrase:"end my focus",requestedAt:Date.now(),availableAt:Date.now()+Math.max(0,result.readyAt-result.serverNow)};
    await chrome.storage.local.set({emergencyRequest});return emergencyRequest;
  }
  const emergencyRequest = {
    reason: cleanReason.slice(0, 280),
    phrase: EMERGENCY_PHRASES[Math.floor(Math.random() * EMERGENCY_PHRASES.length)],
    requestedAt: Date.now(),
    availableAt: Date.now() + EMERGENCY_DELAY_MS
  };
  await chrome.storage.local.set({ emergencyRequest });
  return emergencyRequest;
}

async function confirmEmergency(phrase) {
  const settings = await ensureSessionState();
  const request = settings.emergencyRequest;
  if (!settings.sessionEnd || !request) throw new Error("Start the emergency countdown first.");
  if (Date.now() < request.availableAt) throw new Error("The reflection countdown is still running.");
  if (String(phrase || "").trim() !== request.phrase) throw new Error("The confirmation phrase does not match.");
  if (settings.accountConnected && settings.serverManagedSession) {
    const identity=await ensureClientRegistration();
    sharedMutationRevision++;
    try {await convexCall("mutation","sessions:stop",{userId:identity.userId,accessToken:identity.accessToken,sessionId:settings.clientSessionId,phrase});}
    catch {throw new Error("Couldn’t confirm the stop across devices. Your session remains active; reconnect and retry.");}
    sharedMutationRevision++;
    await endSession("emergency",false);
    return {sessionEnded:true};
  }
  const emergencyLog = [{ usedAt: Date.now(), reason: request.reason, action: "session_stopped" }, ...settings.emergencyLog].slice(0, 25);
  await chrome.storage.local.set({ emergencyLog });
  await endSession("emergency");
  return { sessionEnded: true };
}

async function recordDistraction(siteKey) {
  const settings = await getSettings();
  if (!settings.sessionEnd || settings.sessionEnd <= Date.now() || !settings.clientSessionId) return false;
  if (!BLOCKABLE_SITES[siteKey] || !getBlockingSiteKeys(settings).includes(siteKey)) return false;
  await recordFocusEvent({ eventId: `distraction:${crypto.randomUUID()}`, sessionId: settings.clientSessionId,
    eventType: "distraction_blocked", occurredAt: Date.now(), siteKey });
  return true;
}

async function recordFeedActivity(siteKey) {
  feedActivityChain = feedActivityChain.catch(() => ({ monitoring: false })).then(async () => {
    const settings = await getSettings();
    if (!settings.attentionGuardEnabled || !SITES[siteKey]) return { monitoring: false };
    if (settings.feedBlockingEnabled !== false && settings.enabledSites[siteKey] !== false) {
      return { monitoring: false };
    }

    const now = Date.now();
    const current = settings.feedUsage[siteKey] || { activeMs: 0, lastHeartbeatAt: null, warningEndsAt: null };
    if (current.warningEndsAt) {
      return { monitoring: true, warning: true, warningEndsAt: current.warningEndsAt };
    }

    const gap = current.lastHeartbeatAt ? now - current.lastHeartbeatAt : FEED_HEARTBEAT_CREDIT_MS;
    if (current.lastHeartbeatAt && gap < FEED_HEARTBEAT_CREDIT_MS / 2) {
      return { monitoring: true, warning: false, warningEndsAt: null };
    }
    const activeMs = gap > FEED_VISIT_RESET_MS
      ? FEED_HEARTBEAT_CREDIT_MS
      : current.activeMs + Math.min(Math.max(gap, FEED_HEARTBEAT_CREDIT_MS), 15 * 1000);
    const next = { activeMs, lastHeartbeatAt: now, warningEndsAt: null };

    if (activeMs >= FEED_ACTIVE_LIMIT_MS) {
      next.warningEndsAt = now + FEED_WARNING_MS;
      await chrome.alarms.clear(`${FEED_LIMIT_ALARM_PREFIX}${siteKey}`);
      await chrome.alarms.create(`${FEED_GUARD_ALARM_PREFIX}${siteKey}`, { when: next.warningEndsAt });
    } else {
      await chrome.alarms.create(`${FEED_LIMIT_ALARM_PREFIX}${siteKey}`, { when: now + (FEED_ACTIVE_LIMIT_MS - activeMs) });
    }

    await chrome.storage.local.set({ feedUsage: { ...settings.feedUsage, [siteKey]: next } });
    return { monitoring: true, warning: Boolean(next.warningEndsAt), warningEndsAt: next.warningEndsAt };
  });
  return feedActivityChain;
}

async function requestFeedDisable() {
  const settings = await getSettings();
  if (settings.feedBlockingEnabled === false) return null;
  if (settings.feedDisableRequest) return settings.feedDisableRequest;
  const requestedAt = Date.now();
  const priorOpenCount = localFeedOpenCountToday(settings, requestedAt);
  const feedDisableRequest = {
    requestedAt,
    availableAt: requestedAt + randomFeedDisableDelayMs(priorOpenCount),
    priorOpenCount,
    attemptNumber: priorOpenCount + 1
  };
  await chrome.storage.local.set({ feedDisableRequest, siteDisableRequest: null });
  return feedDisableRequest;
}

async function confirmFeedDisable() {
  const settings = await getSettings();
  if (!settings.feedDisableRequest) throw new Error("Start the feed-access pause first.");
  if (Date.now() < settings.feedDisableRequest.availableAt) throw new Error("The pause is still running.");
  await chrome.storage.local.set({ feedBlockingEnabled: false, feedDisableRequest: null });
  await recordFeedAccess("all");
  return { feedBlockingEnabled: false };
}

async function cancelFeedDisable() {
  await chrome.storage.local.set({ feedDisableRequest: null });
  return { cancelled: true };
}

async function requestSiteDisable(siteKey) {
  if (!SITES[siteKey]) throw new Error("Unknown feed.");
  const settings = await getSettings();
  if (settings.enabledSites[siteKey] === false) return null;
  if (settings.siteDisableRequest?.siteKey === siteKey) return settings.siteDisableRequest;
  const requestedAt = Date.now();
  const priorOpenCount = localFeedOpenCountToday(settings, requestedAt);
  const siteDisableRequest = {
    siteKey,
    requestedAt,
    availableAt: requestedAt + randomFeedDisableDelayMs(priorOpenCount),
    priorOpenCount,
    attemptNumber: priorOpenCount + 1
  };
  await chrome.storage.local.set({ siteDisableRequest, feedDisableRequest: null });
  return siteDisableRequest;
}

async function confirmSiteDisable(siteKey) {
  const settings = await getSettings();
  const request = settings.siteDisableRequest;
  if (!SITES[siteKey] || request?.siteKey !== siteKey) throw new Error("Start this feed-access pause first.");
  if (Date.now() < request.availableAt) throw new Error("The pause is still running.");
  await chrome.storage.local.set({
    enabledSites: { ...settings.enabledSites, [siteKey]: false },
    siteDisableRequest: null
  });
  await recordFeedAccess("site", siteKey);
  return { siteKey, enabledSites: { ...settings.enabledSites, [siteKey]: false } };
}

async function cancelSiteDisable() {
  await chrome.storage.local.set({ siteDisableRequest: null });
  return { cancelled: true };
}

function normalizeWorkPassUrl(value) {
  let parsed;
  try { parsed = new URL(String(value).trim()); } catch { throw new Error("Enter a valid YouTube URL."); }
  if (!/^https?:$/.test(parsed.protocol)) throw new Error("Enter a valid supported-site URL.");
  const siteKey = findSiteKey(parsed.href, Object.keys(SITES));
  if (!siteKey) throw new Error("This URL is not a supported Tranquil site.");
  if (parsed.hostname === "accounts.youtube.com") throw new Error("Google sign-in does not need a work pass.");
  parsed.hash = "";
  if (siteKey === "youtube" && parsed.pathname === "/watch") {
    const videoId = parsed.searchParams.get("v");
    if (!videoId || !/^[A-Za-z0-9_-]{6,20}$/.test(videoId)) throw new Error("Use a specific YouTube video URL.");
    return { siteKey, url: `https://www.youtube.com/watch?v=${videoId}` };
  }
  parsed.search = "";
  return { siteKey, url: parsed.href.replace(/\/$/, "") };
}

async function startWorkPass(url, reason, requestedMinutes) {
  const minutes = Number(requestedMinutes);
  const purpose = String(reason || "").trim();
  if (purpose.length < 5 || purpose.length > 160) throw new Error("Briefly state what you need to accomplish.");
  const normalized = normalizeWorkPassUrl(url);
  const settings = await getSettings();
  if (settings.sessionEnd > Date.now()) throw new Error("Finish your focus session first.");
  if (settings.accountConnected || settings.sharedAccess?.enabled) {
    const identity=await ensureClientRegistration();
    const fingerprint=JSON.stringify([url,purpose,minutes]);
    const old=(await chrome.storage.local.get({sharedPassRequest:null})).sharedPassRequest;
    const request=old?.fingerprint===fingerprint ? old : {fingerprint,requestId:crypto.randomUUID()};
    await chrome.storage.local.set({sharedPassRequest:request});
    const grant=await convexCall("mutation","access:grant",{userId:identity.userId,accessToken:identity.accessToken,installationId:settings.installationId,requestId:request.requestId,url,purpose,minutes});
    await reconcileAccess();
    if(grant.expiresAt<=Date.now())throw new Error("This pass has expired. Submit a new request.");
    await chrome.storage.local.set({sharedPassRequest:null});
    return grant;
  }
  const policy = settings.sitePolicies?.[normalized.siteKey] || DEFAULT_SITE_POLICIES[normalized.siteKey];
  if (policy.level !== "work_pass") throw new Error(policy.level === "blocked" ? "This site is fully blocked." : "Set this site to Work pass required first.");
  const maxMinutes = Math.min(30, Number(policy.maxMinutes) || 15);
  if (!Number.isInteger(minutes) || minutes < 5 || minutes > maxMinutes) throw new Error(`Choose a work pass from 5 to ${maxMinutes} minutes.`);
  const workPass = { siteKey: normalized.siteKey, url: normalized.url, reason: purpose, startedAt: Date.now(), expiresAt: Date.now() + minutes * 60 * 1000, minutes };
  const next = { ...settings, workPass };
  await chrome.storage.local.set({ workPass });
  await installRules(next);
  await chrome.alarms.create(WORK_PASS_ALARM, { when: workPass.expiresAt });
  return workPass;
}

async function endWorkPass() {
  const settings = await getSettings();
  if (!settings.workPass) return false;
  if(settings.workPass.requestId) {
    const identity=await ensureClientRegistration();
    await convexCall("mutation","access:end",{userId:identity.userId,accessToken:identity.accessToken,requestId:settings.workPass.requestId});
    await reconcileAccess();return true;
  }
  const next = { ...settings, workPass: null };
  await chrome.storage.local.set({ workPass: null });
  await chrome.alarms.clear(WORK_PASS_ALARM);
  await installRules(next);
  await redirectOpenBlockedTabs(next, "work_pass_end");
  return true;
}

async function setSitePolicy(siteKey, level, requestedMaxMinutes) {
  if (!SITES[siteKey]) throw new Error("Unknown site policy.");
  if (!["feed_only", "work_pass", "blocked"].includes(level)) throw new Error("Unknown access level.");
  const settings = await getSettings();
  if(settings.sharedAccess?.enabled && settings.sharedAccess.policies.some(p=>p.siteKey===siteKey))throw new Error("This service uses shared account allowances. Its local policy cannot override them.");
  const maxMinutes = Math.min(30, Math.max(5, Number(requestedMaxMinutes) || settings.sitePolicies?.[siteKey]?.maxMinutes || 15));
  const sitePolicies = { ...settings.sitePolicies, [siteKey]: { level, maxMinutes } };
  const workPass = settings.workPass?.siteKey === siteKey && level !== "work_pass" ? null : settings.workPass;
  const next = { ...settings, sitePolicies, workPass };
  await chrome.storage.local.set({ sitePolicies, workPass });
  await chrome.storage.sync.set({ sitePolicies });
  await installRules(next);
  if (level !== "feed_only") await redirectOpenBlockedTabs(next, "strict_policy");
  return { sitePolicies };
}

async function pauseFeedActivity(siteKey) {
  if (!SITES[siteKey]) return false;
  const settings = await getSettings();
  const feedUsage = { ...settings.feedUsage };
  delete feedUsage[siteKey];
  await chrome.storage.local.set({ feedUsage });
  await chrome.alarms.clear(`${FEED_LIMIT_ALARM_PREFIX}${siteKey}`);
  await chrome.alarms.clear(`${FEED_GUARD_ALARM_PREFIX}${siteKey}`);
  return true;
}

async function setAttentionGuard(enabled) {
  const attentionGuardEnabled = Boolean(enabled);
  const settings = await getSettings();
  await chrome.storage.local.set({ attentionGuardEnabled, feedUsage: {}, guardBlockedSites: {} });
  await Promise.all(Object.keys(SITES).flatMap((siteKey) => [
    chrome.alarms.clear(`${FEED_LIMIT_ALARM_PREFIX}${siteKey}`),
    chrome.alarms.clear(`${FEED_GUARD_ALARM_PREFIX}${siteKey}`)
  ]));
  return { attentionGuardEnabled, clearedSites: Object.keys(settings.feedUsage).length };
}

async function startFeedWarning(siteKey) {
  const settings = await getSettings();
  if (!settings.attentionGuardEnabled || !SITES[siteKey]) return false;
  if (settings.feedBlockingEnabled !== false && settings.enabledSites[siteKey] !== false) return false;
  const current = settings.feedUsage[siteKey];
  if (!current || current.warningEndsAt) return Boolean(current?.warningEndsAt);
  const warningEndsAt = Date.now() + FEED_WARNING_MS;
  await chrome.storage.local.set({
    feedUsage: { ...settings.feedUsage, [siteKey]: { ...current, activeMs: FEED_ACTIVE_LIMIT_MS, warningEndsAt } }
  });
  await chrome.alarms.create(`${FEED_GUARD_ALARM_PREFIX}${siteKey}`, { when: warningEndsAt });
  return true;
}

async function autoBlockFeed(siteKey) {
  const settings = await getSettings();
  if (!SITES[siteKey]) return false;
  const feedUsage = { ...settings.feedUsage };
  delete feedUsage[siteKey];
  await chrome.storage.local.set({
    feedBlockingEnabled: true,
    enabledSites: { ...settings.enabledSites, [siteKey]: true },
    siteDisableRequest: settings.siteDisableRequest?.siteKey === siteKey ? null : settings.siteDisableRequest,
    guardBlockedSites: { ...settings.guardBlockedSites, [siteKey]: true },
    feedUsage
  });
  await chrome.alarms.clear(`${FEED_GUARD_ALARM_PREFIX}${siteKey}`);
  await chrome.alarms.clear(`${FEED_LIMIT_ALARM_PREFIX}${siteKey}`);
  return true;
}

async function ensureContentScriptsInOpenTabs() {
  if (!chrome.scripting?.executeScript) return;
  const tabs = await chrome.tabs.query({});
  await Promise.allSettled(tabs.map(async (tab) => {
    if (!tab.id || !tab.url || !findSiteKey(tab.url, Object.keys(SITES))) return;
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["linkedin-links.js", "content.js"] });
  }));
}

async function startBackgroundServices() {
  await chrome.alarms.create(SYNC_ALARM, { periodInMinutes: 0.5 });
  await ensureUsageAlarm();
  await ensureContentScriptsInOpenTabs();
  await reconcileSharedSession();
  flushStatsQueue();
  flushUsageQueue();
  flushFeedAccessQueue();
}

chrome.runtime.onInstalled.addListener(startBackgroundServices);
chrome.runtime.onStartup.addListener(startBackgroundServices);
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SESSION_ALARM) endSession("completed");
  if (alarm.name === WORK_PASS_ALARM) endWorkPass();
  if (alarm.name === SYNC_ALARM) reconcileSharedSession();
  if (alarm.name === USAGE_ALARM) return flushUsageQueue();
  if (alarm.name.startsWith(FEED_LIMIT_ALARM_PREFIX)) startFeedWarning(alarm.name.slice(FEED_LIMIT_ALARM_PREFIX.length));
  if (alarm.name.startsWith(FEED_GUARD_ALARM_PREFIX)) autoBlockFeed(alarm.name.slice(FEED_GUARD_ALARM_PREFIX.length));
});

function captureBlockedNavigation(tabId, url) {
  getSettings().then((settings) => {
    const siteKey = findSiteKey(url, getRuleSiteKeys(settings));
    if (siteKey) rememberBlockedReturnUrl(tabId, url, siteKey, settings.clientSessionId);
  });
}

chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  if (details.frameId === 0) captureBlockedNavigation(details.tabId, details.url);
});

// Convert notifications in the browser process as well as in the page. This
// works even when an already-open tab still has an older content script.
async function openLinkedInNotification(details) {
  if (details.frameId !== 0 || details.tabId < 0) return;
  const destination = globalThis.TranquilLinks.linkedinPostUrl(details.url);
  if (!destination) return;
  try {
    const tab = await chrome.tabs.get(details.tabId);
    // Do not replace a newer navigation with a delayed notification event.
    if (tab.url !== details.url || (tab.pendingUrl && tab.pendingUrl !== details.url)) return;
    await chrome.tabs.update(details.tabId, { url: destination });
  } catch { /* The tab may have closed while the event was in flight. */ }
}
chrome.webNavigation.onCommitted.addListener(openLinkedInNotification);
chrome.webNavigation.onHistoryStateUpdated.addListener(openLinkedInNotification);

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url) captureBlockedNavigation(tabId, changeInfo.url);
});
chrome.tabs.onRemoved.addListener((tabId) => { clearBlockedReturnUrl(tabId); });

let lastForegroundSync=0;
function foregroundSync() {
  if(Date.now()-lastForegroundSync<5000)return;
  lastForegroundSync=Date.now();
  reconcileSharedSession().catch(()=>{});
}
chrome.tabs.onActivated?.addListener(foregroundSync);
chrome.windows?.onFocusChanged?.addListener(foregroundSync);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const respond = (promise) => {
    promise.then((result) => sendResponse({ ok: true, ...result })).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  };
  if (message?.type === "START_SESSION") return respond(startSession(message.durationMinutes, message.focusLevel).then((sessionEnd) => ({ sessionEnd })));
  if (message?.type === "REQUEST_EMERGENCY") return respond(requestEmergency(message.reason).then((emergencyRequest) => ({ emergencyRequest })));
  if (message?.type === "CONFIRM_EMERGENCY") return respond(confirmEmergency(message.phrase));
  if (message?.type === "RECORD_DISTRACTION") return respond(recordDistraction(message.siteKey).then((recorded) => ({ recorded })));
  if (message?.type === "RECORD_SITE_USAGE") {
    const siteKey = message.siteKey;
    const eventType = message.eventType;
    const durationSeconds = Number(message.durationSeconds);
    if (!SITES[siteKey] || !["site_opened", "visible_time"].includes(eventType)) {
      return respond(Promise.reject(new Error("Invalid usage event.")));
    }
    if (eventType === "visible_time" && (!Number.isInteger(durationSeconds) || durationSeconds < 1 || durationSeconds > 60)) {
      return respond(Promise.reject(new Error("Invalid visible-time duration.")));
    }
    return respond(recordSiteUsageEvent({
      eventId: String(message.eventId),
      siteKey,
      visitId: String(message.visitId),
      eventType,
      occurredAt: Number(message.occurredAt),
      ...(eventType === "visible_time" ? { durationSeconds } : {})
    }).then(() => ({ recorded: true })));
  }
  if (message?.type === "REQUEST_FEED_DISABLE") return respond(requestFeedDisable().then((feedDisableRequest) => ({ feedDisableRequest })));
  if (message?.type === "CONFIRM_FEED_DISABLE") return respond(confirmFeedDisable());
  if (message?.type === "CANCEL_FEED_DISABLE") return respond(cancelFeedDisable());
  if (message?.type === "REQUEST_SITE_DISABLE") return respond(requestSiteDisable(message.siteKey).then((siteDisableRequest) => ({ siteDisableRequest })));
  if (message?.type === "CONFIRM_SITE_DISABLE") return respond(confirmSiteDisable(message.siteKey));
  if (message?.type === "CANCEL_SITE_DISABLE") return respond(cancelSiteDisable());
  if (message?.type === "FEED_ACTIVITY") {foregroundSync();return respond(recordFeedActivity(message.siteKey));}
  if (message?.type === "FEED_INACTIVE") return respond(pauseFeedActivity(message.siteKey).then((paused) => ({ paused })));
  if (message?.type === "SET_ATTENTION_GUARD") return respond(setAttentionGuard(message.enabled));
  if (message?.type === "SET_SITE_POLICY") return respond(setSitePolicy(message.siteKey, message.level, message.maxMinutes));
  if (message?.type === "START_WORK_PASS") return respond(startWorkPass(message.url, message.reason, message.durationMinutes).then((workPass) => ({ workPass })));
  if (message?.type === "END_WORK_PASS") return respond(endWorkPass().then((ended) => ({ ended })));
  if (message?.type === "AUTO_BLOCK_FEED") return respond(autoBlockFeed(message.siteKey).then((blocked) => ({ blocked })));
  if (message?.type === "GET_STATS") return respond(getStats().then((stats) => ({ stats })));
  if (message?.type === "START_ACCOUNT_LINK") return respond(startAccountLink());
  if (message?.type === "CHECK_ACCOUNT_LINK") return respond(checkAccountLink());
  if (message?.type === "GET_RETURN_URL") return respond(
    getBlockedReturnUrl(sender.tab?.id, message.siteKey).then((returnUrl) => ({ returnUrl }))
  );
  if (message?.type === "CLEAR_RETURN_URL") return respond(
    clearBlockedReturnUrl(sender.tab?.id).then(() => ({ cleared: true }))
  );
  if (message?.type === "GET_STATE") {
    ensureContentScriptsInOpenTabs();
    return respond(reconcileSharedSession().then((settings) => ({
      settings, sites: SITES, limits: { minSessionMinutes: MIN_SESSION_MINUTES, maxSessionMinutes: MAX_SESSION_MINUTES }
    })));
  }
});
