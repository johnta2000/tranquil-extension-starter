import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { randomUUID } from "node:crypto";

// Run the WHOLE content script, including refresh, storage waits, DOM styles,
// navigation observation and timers, not just the URL helper or its prefix.
const content = await readFile(new URL("../content.js", import.meta.url), "utf8");
const helper = await readFile(new URL("../linkedin-links.js", import.meta.url), "utf8");
const feed = "https://www.linkedin.com/feed/";
const notification = feed + "?highlightedUpdateUrn=urn%3Ali%3Aactivity%3A7508649276630265856&highlightedUpdateType=RESHARED_YOUR_UPDATE&origin=inapp&showCommentBox=true";
const post = "https://www.linkedin.com/feed/update/urn:li:activity:7508649276630265856/?showCommentBox=true";
const tick = () => new Promise(resolve => setImmediate(resolve));

function page(url, settings = {}) {
  const nodes = new Map(), attrs = new Map(), timers = [], navigations = [], pending = [];
  const events = {}, changes = [];
  let href = url, holdStorage = false, failStorage = false, mutation;
  const location = {
    get href() { return href; }, get hostname() { return new URL(href).hostname; },
    get pathname() { return new URL(href).pathname; },
    replace(next) { navigations.push(next); href = next; },
    assign(next) { navigations.push(next); href = next; }
  };
  const document = {
    visibilityState: "visible",
    getElementById: id => nodes.get(id),
    addEventListener: (name, fn) => { events[name] = fn; },
    documentElement: {
      appendChild(node) { nodes.set(node.id, node); },
      setAttribute(k, v) { attrs.set(k, v); }, removeAttribute(k) { attrs.delete(k); }
    },
    createElement(tagName) {
      return { tagName, setAttribute() {}, attachShadow() { return {}; }, remove() { nodes.delete(this.id); } };
    }
  };
  const sandbox = { URL, location, document, crypto: { randomUUID },
    window: { addEventListener: (name, fn) => { events[name] = fn; } },
    MutationObserver: class { constructor(fn) { mutation = fn; } observe() {} },
    setInterval(fn, ms) { timers.push({ fn, ms }); return timers.length; }, clearInterval() {},
    chrome: {
      runtime: { async sendMessage() { return { ok: true }; }, getURL: path => `chrome-extension://test/${path}` },
      storage: {
        onChanged: { addListener(fn) { changes.push(fn); } },
        local: { async get(defaults) {
          if (failStorage) throw new Error("Extension context invalidated");
          if (holdStorage) await new Promise(resolve => pending.push(resolve));
          return { ...defaults, attentionGuardEnabled: false, ...settings };
        } }
      }
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(helper, sandbox);
  vm.runInContext(content, sandbox);
  return {
    nodes, attrs, timers, navigations, events, changes, sandbox,
    navigate(next) { href = next; },
    hold() { holdStorage = true; },
    release() { holdStorage = false; pending.splice(0).forEach(resolve => resolve()); },
    fail() { failStorage = true; },
    mutate() { mutation([{ addedNodes: [] }]); },
    pollRoute() { timers.find(t => t.ms === 500).fn(); },
    get blocked() { return nodes.has("stillspace-feed-styles") || nodes.has("stillspace-feed-placeholder"); }
  };
}

const pasted = page(notification);
await tick();
assert.deepEqual(pasted.navigations, [post], "the exact reported URL opens its specific post");
assert.equal(pasted.blocked, false);

// Sept 28 report: /feed without a trailing slash, reaction-to-mention notification.
const reactionNotification = "https://www.linkedin.com/feed?highlightedUpdateUrn=urn%3Ali%3Aactivity%3A7510316772386918400&highlightedUpdateType=REACTED_TO_UPDATE_MENTIONING_YOU&origin=inapp&showCommentBox=true";
const reactionPost = "https://www.linkedin.com/feed/update/urn:li:activity:7510316772386918400/?showCommentBox=true";
const reaction = page(reactionNotification);
await tick();
assert.deepEqual(reaction.navigations, [reactionPost]);
assert.equal(reaction.blocked, false);
const reactionSpa = page(feed);
await tick();
assert.equal(reactionSpa.blocked, true);
reactionSpa.navigate(reactionNotification);
reactionSpa.pollRoute();
assert.deepEqual(reactionSpa.navigations, [reactionPost]);
assert.equal(reactionSpa.blocked, false);

const spa = page(feed);
await tick();
assert.equal(spa.blocked, true, "ordinary feed remains hidden");
spa.navigate(notification); // pushState, deliberately NO mutation/popstate event.
spa.pollRoute();
assert.deepEqual(spa.navigations, [post], "notification recognized with guard OFF and no DOM mutations");
assert.equal(spa.blocked, false, "old feed overlay and CSS removed before navigation");
assert.equal(spa.attrs.has("data-stillspace-feed-hidden"), false);

const direct = page(feed);
await tick();
direct.hold();
direct.navigate(post);
direct.pollRoute();
assert.equal(direct.blocked, false, "direct-post SPA transition clears overlay before storage returns");
direct.release();
await tick();
direct.navigate(feed); direct.pollRoute(); await tick();
assert.equal(direct.blocked, true, "going back to ordinary feed restores blocking");
direct.fail(); direct.navigate(post); direct.pollRoute(); await tick();
assert.equal(direct.blocked, false, "invalidated storage context cannot strand an overlay on a direct post");

const race = page(feed);
await tick();
race.hold();
const refreshing = race.changes[0]();
race.navigate(notification); // Route changes WHILE refresh awaits storage.
race.release(); await refreshing;
assert.deepEqual(race.navigations, [post]);
assert.equal(race.blocked, false, "in-flight refresh cannot reapply the old feed overlay");

const strict = page(post, { sitePolicies: { linkedin: { level: "blocked" } } });
await tick();
assert.match(strict.navigations[0], /blocked.html\?site=linkedin&source=strict_policy$/,
  "direct posts do not bypass strict policies");
for (const url of [feed, feed + "?highlightedUpdateUrn=bogus", feed + "?showCommentBox=true"]) {
  const ordinary = page(url); await tick();
  assert.equal(ordinary.blocked, true);
  assert.equal(ordinary.navigations.length, 0);
}
console.log("Full LinkedIn content-script tests passed: exact URL, overlay cleanup, SPA, storage race, strict policy, feed protection");
