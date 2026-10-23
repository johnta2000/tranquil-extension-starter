import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
globalThis.crypto ??= webcrypto;
const stored = {}, synced = {}, listeners = {};
let rules = [], requests = 0;
const event = name => ({ addListener(fn) { listeners[name] = fn; } });
globalThis.fetch = async () => { requests++; throw new Error("Local mode must not use the network"); };
globalThis.chrome = {
  storage: {
    local: { async get(defaults) { return { ...defaults, ...stored }; }, async set(values) { Object.assign(stored, values); } },
    sync: { async get(defaults) { return { ...defaults, ...synced }; }, async set(values) { Object.assign(synced, values); } }
  },
  tabs: { async query() { return []; }, onUpdated: event("tabUpdated"), onRemoved: event("tabRemoved") },
  alarms: { async create() {}, async clear() {}, onAlarm: event("alarm") },
  declarativeNetRequest: {
    async getDynamicRules() { return rules; },
    async updateDynamicRules({ addRules = [] }) { rules = addRules; }
  },
  webNavigation: { onBeforeNavigate: event("before"), onCommitted: event("commit"), onHistoryStateUpdated: event("history") },
  runtime: { getURL: file => `chrome-extension://test/${file}`, onInstalled: event("install"), onStartup: event("startup"), onMessage: event("message") }
};
await import("../background.js");
const send = message => new Promise(resolve => listeners.message(message, {}, resolve));
const initial = await send({ type: "GET_STATE" });
assert.equal(initial.ok, true);
const session = await send({ type: "START_SESSION", durationMinutes: 30, focusLevel: "deep" });
assert.equal(session.ok, true);
assert.ok(session.sessionEnd > Date.now());
assert.ok(rules.some(rule => rule.condition.regexFilter.includes("mail")), "Deep still blocks Gmail locally");
const stats = await send({ type: "GET_STATS" });
assert.equal(stats.ok, true);
assert.equal(stats.stats.sessionsStarted, 1, "local analytics still count sessions");
const link = await send({ type: "START_ACCOUNT_LINK" });
assert.equal(link.ok, false);
assert.match(link.error, /not configured/);
assert.equal(requests, 0, "the default fork must never contact John's services or any backend");
console.log("Local starter: focus, Gmail protection, local stats, and zero network requests passed");
