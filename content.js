(() => {
const CONTENT_VERSION = "2.21.2";
if (globalThis.__tranquilContentVersion === CONTENT_VERSION) return;
globalThis.__tranquilContentVersion = CONTENT_VERSION;
const rewrittenMentionLinks = new WeakMap();

function redirectLinkedInMention() {
  const destination = globalThis.TranquilLinks?.linkedinPostUrl(location.href);
  if (!destination) return false;
  // Feed CSS from the previous SPA route must not cover the linked post.
  document.getElementById("stillspace-feed-styles")?.remove();
  document.getElementById("stillspace-feed-placeholder")?.remove();
  document.documentElement?.removeAttribute("data-stillspace-feed-hidden");
  // Navigate normally: full-site focus blocks and exact work-pass checks still apply to the post.
  location.replace(destination);
  return true;
}

function rewriteLinkedInMentionLink(event) {
  const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
  if (!anchor) return;
  const destination = globalThis.TranquilLinks?.linkedinPostUrl(anchor.href) ||
    (rewrittenMentionLinks.get(anchor) === anchor.href ? anchor.href : null);
  if (!destination) return;
  anchor.href = destination;
  rewrittenMentionLinks.set(anchor, destination);
  if (event.type === "click" && event.button === 0 && !event.metaKey && !event.ctrlKey &&
      !event.shiftKey && !event.altKey && !anchor.hasAttribute("download") &&
      (!anchor.target || anchor.target === "_self")) {
    // Bypass LinkedIn's feed-router handler, not Tranquil's network restrictions.
    event.preventDefault();
    event.stopImmediatePropagation();
    location.assign(destination);
  }
}
if (/(^|\.)linkedin\.com$/.test(location.hostname)) {
  document.addEventListener("click", rewriteLinkedInMentionLink, true);
  document.addEventListener("pointerdown", rewriteLinkedInMentionLink, true);
  document.addEventListener("contextmenu", rewriteLinkedInMentionLink, true);
}

const SITE_CONFIG = {
  threads: {
    name: "Threads",
    domains: ["threads.com"],
    feedPaths: [/^\/$/, /^\/following\/?$/, /^\/for_you\/?$/],
    selectors: [
      "[role='region'][aria-label='Column body']",
      "[aria-label='Column body']",
      "main",
      "[role='main']"
    ]
  },
  instagram: {
    name: "Instagram",
    domains: ["instagram.com"],
    feedPaths: [/^\/$/, /^\/explore\/?/, /^\/reels\/?/],
    selectors: ["main", "[role='main']"]
  },
  facebook: {
    name: "Facebook",
    domains: ["facebook.com"],
    feedPaths: [/^\/$/, /^\/home\.php\/?$/, /^\/watch\/?/, /^\/reel(s)?\/?/],
    selectors: ["[role='feed']", "[role='main']"]
  },
  x: {
    name: "X",
    domains: ["x.com", "twitter.com"],
    feedPaths: [/^\/$/, /^\/home\/?$/, /^\/explore\/?$/],
    selectors: ["[data-testid='primaryColumn'] section", "[aria-label*='Timeline']"]
  },
  linkedin: {
    name: "LinkedIn",
    domains: ["linkedin.com"],
    // LinkedIn post permalinks live below /feed/update/. Only the feed root
    // is an infinite feed; direct posts and their comment links stay useful.
    feedPaths: [/^\/$/, /^\/feed\/?$/],
    selectors: [
      "main",
      "[role='main']",
      "#main",
      "[aria-label='Feed updates']",
      "[aria-label='Main Feed']",
      "main.scaffold-layout__main",
      ".scaffold-layout__main",
      ".scaffold-finite-scroll",
      ".scaffold-finite-scroll__content",
      ".feed-container-theme",
      "[data-view-name='feed-full-update']",
      ".feed-shared-update-v2"
    ]
  },
  reddit: {
    name: "Reddit",
    domains: ["reddit.com"],
    feedPaths: [/^\/$/, /^\/(best|hot|new|top)\/?$/, /^\/r\/[^/]+\/?$/],
    selectors: ["shreddit-feed", "shreddit-post", "[data-testid='post-container']"]
  },
  youtube: {
    name: "YouTube",
    domains: ["youtube.com"],
    feedPaths: [/^\/$/, /^\/shorts(?:\/|$)/],
    selectors: ["ytd-browse[page-subtype='home'] #contents", "ytd-shorts", "ytd-reel-video-renderer"]
  },
  tiktok: {
    name: "TikTok",
    domains: ["tiktok.com"],
    feedPaths: [/^\/$/, /^\/(foryou|following)\/?$/],
    selectors: ["main", "[data-e2e='recommend-list-item-container']", "[data-e2e='browse-video']"]
  },
  bookface: {
    name: "YC Bookface",
    domains: ["bookface.ycombinator.com"],
    feedPaths: [/^\/$/, /^\/(home|feed)\/?$/],
    selectors: ["main", "[role='feed']", "[role='main']"]
  }
};

const STYLE_ID = "stillspace-feed-styles";
const PLACEHOLDER_ID = "stillspace-feed-placeholder";
const WARNING_ID = "stillspace-feed-warning";
const YOUTUBE_WORK_STYLE_ID = "tranquil-youtube-work-pass-styles";
const FACEBOOK_BASELINE_STYLE_ID = "tranquil-facebook-baseline-styles";
const FACEBOOK_HIDDEN_ATTRIBUTE = "data-tranquil-facebook-hidden";
const FACEBOOK_BLOCKED_ROUTE = /^\/(?:reel(?:s)?|watch|stories)(?:\/|$)/i;
const FACEBOOK_DISTRACTION_LABELS = new Set([
  "ad",
  "sponsored",
  "suggested for you",
  "suggested post",
  "recommended for you",
  "people you may know",
  "pages you may like",
  "people and groups to follow",
  "suggested groups"
]);
const ACTIVITY_HEARTBEAT_MS = 10 * 1000;
let lastUrl = location.href;
let monitoredSiteKey = null;
let warningTimer = null;
let facebookSanitizeTimer = null;
const usageVisitId = crypto.randomUUID();
let usageSiteKey = null;
let usageOpened = false;
let usageLastActiveAt = null;
let usageSequence = 0;

function sendUsageEvent(eventType, durationSeconds) {
  if (!usageSiteKey) return;
  usageSequence += 1;
  chrome.runtime.sendMessage({
    type: "RECORD_SITE_USAGE",
    eventId: `usage:${usageVisitId}:${usageSequence}`,
    visitId: usageVisitId,
    siteKey: usageSiteKey,
    eventType,
    occurredAt: Date.now(),
    ...(durationSeconds === undefined ? {} : { durationSeconds })
  }).catch(() => {});
}

function flushVisibleUsage(force = false) {
  if (!usageLastActiveAt || (!force && document.visibilityState !== "visible")) return;
  const now = Date.now();
  const durationSeconds = Math.min(60, Math.floor((now - usageLastActiveAt) / 1000));
  if (durationSeconds < 1) return;
  usageLastActiveAt = now;
  sendUsageEvent("visible_time", durationSeconds);
}

function updateUsageTracking(siteKey, active) {
  if (!active) {
    flushVisibleUsage(true);
    usageLastActiveAt = null;
    return;
  }
  usageSiteKey = siteKey;
  if (!usageOpened) {
    usageOpened = true;
    sendUsageEvent("site_opened");
  }
  if (document.visibilityState === "visible" && !usageLastActiveAt) usageLastActiveAt = Date.now();
}

function identifySite() {
  const host = location.hostname.replace(/^www\./, "");
  return Object.entries(SITE_CONFIG).find(([, config]) =>
    config.domains.some((domain) => host === domain || host.endsWith(`.${domain}`))
  );
}

function isFacebook() {
  const host = location.hostname.toLowerCase().replace(/^www\./, "");
  return host === "facebook.com" || host.endsWith(".facebook.com");
}

function isFacebookHomePath() {
  return /^\/(?:home\.php)?\/?$/i.test(location.pathname);
}

function installFacebookBaselineStyles() {
  if (!document.documentElement || document.getElementById(FACEBOOK_BASELINE_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = FACEBOOK_BASELINE_STYLE_ID;
  style.textContent = `
    [${FACEBOOK_HIDDEN_ATTRIBUTE}="true"] { display: none !important; visibility: hidden !important; }
    a[href^="/reel/"], a[href^="/reels/"], a[href^="/watch/"], a[href^="/stories/"],
    a[href*="facebook.com/reel/"], a[href*="facebook.com/reels/"],
    a[href*="facebook.com/watch/"], a[href*="facebook.com/stories/"] {
      display: none !important;
      visibility: hidden !important;
    }
  `;
  document.documentElement.appendChild(style);
  document.documentElement.setAttribute("data-tranquil-facebook-baseline", "active");
}

function hideFacebookElement(element, reason) {
  if (!(element instanceof HTMLElement) || element.hasAttribute(FACEBOOK_HIDDEN_ATTRIBUTE)) return;
  element.setAttribute(FACEBOOK_HIDDEN_ATTRIBUTE, "true");
  element.setAttribute("data-tranquil-facebook-reason", reason);
}

function restoreFacebookGroupPost(element) {
  if (!(element instanceof HTMLElement) || element.getAttribute("data-tranquil-facebook-reason") !== "non-group-home-content") return;
  element.removeAttribute(FACEBOOK_HIDDEN_ATTRIBUTE);
  element.removeAttribute("data-tranquil-facebook-reason");
}

function closestFacebookPost(element) {
  return element.closest("[role='article'], [data-pagelet^='FeedUnit_']");
}

function findFacebookFeedCard(element) {
  const identified = closestFacebookPost(element);
  if (identified) return identified;
  let candidate = element.parentElement;
  for (let depth = 0; candidate && depth < 14; depth += 1, candidate = candidate.parentElement) {
    if (candidate.matches("[role='feed'], [role='main'], body")) break;
    const hasMedia = Boolean(candidate.querySelector("img, video, [data-ad-preview], [data-ad-rendering-role]"));
    const hasPostMenu = Boolean(candidate.querySelector(`
      [aria-label*="Actions for this post"], [aria-label*="Actions for this Post"],
      [aria-label="More"], [aria-label="Hide post"]
    `));
    const engagementActions = candidate.querySelectorAll(`
      [aria-label^="Like"], [aria-label^="Comment"], [aria-label^="Share"], [aria-label^="Send"]
    `).length;
    if (hasMedia && (hasPostMenu || engagementActions >= 2)) return candidate;
  }
  return null;
}

function isFacebookGroupPost(element) {
  return Boolean(element.querySelector(`
    a[href^="/groups/"],
    a[href*="facebook.com/groups/"]
  `));
}

function discoverFacebookHomePosts(scope) {
  const posts = new Set(scope.querySelectorAll(`
    [role="feed"] [role="article"],
    [role="feed"] [data-pagelet^="FeedUnit_"],
    [data-pagelet^="FeedUnit_"]
  `));
  const postSignals = scope.querySelectorAll(`
    video,
    [aria-label^="Like"], [aria-label^="Comment"], [aria-label^="Share"], [aria-label^="Send"],
    [aria-label*="Actions for this post"], [aria-label*="Actions for this Post"],
    a[href*="/posts/"], a[href*="/videos/"], a[href*="/photo.php"], a[href*="/permalink.php"]
  `);
  for (const signal of postSignals) {
    const post = findFacebookFeedCard(signal);
    if (post) posts.add(post);
  }
  return posts;
}

function sanitizeFacebookHomeToGroups(scope) {
  if (!isFacebookHomePath()) return;
  const posts = discoverFacebookHomePosts(scope);
  for (const post of posts) {
    if (isFacebookGroupPost(post)) restoreFacebookGroupPost(post);
    else hideFacebookElement(post, "non-group-home-content");
  }
}

function queueFacebookSanitization() {
  if (!isFacebook() || facebookSanitizeTimer) return;
  facebookSanitizeTimer = setTimeout(() => {
    facebookSanitizeTimer = null;
    sanitizeFacebookBaseline(document);
  }, 180);
}

function smallestModuleWithLinks(element, selector, minimumLinks = 2) {
  let candidate = element.parentElement;
  for (let depth = 0; candidate && depth < 8; depth += 1, candidate = candidate.parentElement) {
    if (candidate.querySelectorAll(selector).length >= minimumLinks) return candidate;
    if (candidate.matches("[role='main'], [role='feed'], body")) break;
  }
  return null;
}

function sanitizeFacebookBaseline(root = document) {
  if (!isFacebook()) return false;
  installFacebookBaselineStyles();

  if (FACEBOOK_BLOCKED_ROUTE.test(location.pathname)) {
    const groupsUrl = `${location.origin}/groups/feed/`;
    if (location.href !== groupsUrl) location.replace(groupsUrl);
    return true;
  }

  const scope = root instanceof Element || root instanceof Document ? root : document;
  for (const video of scope.querySelectorAll("video")) {
    if (video.autoplay || video.hasAttribute("autoplay")) {
      video.autoplay = false;
      video.removeAttribute("autoplay");
      video.pause();
    }
  }

  const distractionLinks = scope.querySelectorAll(`
    a[href^="/reel/"], a[href^="/reels/"], a[href^="/watch/"], a[href^="/stories/"],
    a[href*="facebook.com/reel/"], a[href*="facebook.com/reels/"],
    a[href*="facebook.com/watch/"], a[href*="facebook.com/stories/"]
  `);
  for (const link of distractionLinks) {
    const post = closestFacebookPost(link);
    if (post) {
      hideFacebookElement(post, "reels-watch-or-stories-post");
      continue;
    }
    if (!isFacebookHomePath()) continue;
    const href = link.getAttribute("href") || "";
    const isStory = /\/stories\//i.test(href);
    const module = smallestModuleWithLinks(link, isStory ? "a[href*='/stories/']" : "a[href*='/reel']");
    if (module) hideFacebookElement(module, isStory ? "stories-module" : "reels-module");
  }

  const markers = scope.querySelectorAll("span, a, b, strong");
  for (const marker of markers) {
    const label = (marker.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
    if (!FACEBOOK_DISTRACTION_LABELS.has(label)) continue;
    const post = isFacebookHomePath() ? findFacebookFeedCard(marker) : closestFacebookPost(marker);
    if (post) hideFacebookElement(post, label.replaceAll(" ", "-"));
  }
  sanitizeFacebookHomeToGroups(scope);
  return true;
}

function normalizeAddress(value) {
  try {
    const candidate = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    const parsed = new URL(candidate);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    const path = parsed.pathname.replace(/\/+$/, "");
    return `${host}${path}`.toLowerCase();
  } catch {
    return "";
  }
}

function isExcepted(exceptions) {
  const current = normalizeAddress(location.href);
  return exceptions.some((entry) => {
    const allowed = normalizeAddress(String(entry));
    return allowed && (current === allowed || current.startsWith(`${allowed}/`));
  });
}

function isFeedPath(config) {
  return config.feedPaths.some((pattern) => pattern.test(location.pathname));
}

function removeSuppression() {
  document.getElementById(STYLE_ID)?.remove();
  document.getElementById(PLACEHOLDER_ID)?.remove();
  document.documentElement?.removeAttribute("data-stillspace-feed-hidden");
}

function removeWarning() {
  document.getElementById(WARNING_ID)?.remove();
  if (warningTimer) clearInterval(warningTimer);
  warningTimer = null;
}

function showWarning(config, siteKey, warningEndsAt) {
  if (!document.documentElement) return;
  let warning = document.getElementById(WARNING_ID);
  if (!warning) {
    warning = document.createElement("aside");
    warning.id = WARNING_ID;
    warning.setAttribute("aria-live", "assertive");
    const shadow = warning.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        .note {
          position: fixed; z-index: 2147483647; top: 18px; right: 18px;
          width: min(340px, calc(100vw - 36px)); box-sizing: border-box;
          padding: 17px 18px; border: 1px solid #d3cdbf; border-radius: 14px;
          background: #f6f3eb; color: #17231c; box-shadow: 0 12px 38px rgba(23,35,28,.18);
          font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        }
        .eyebrow { margin: 0 0 5px; color: #687269; font-size: 10px; font-weight: 800;
          letter-spacing: .13em; text-transform: uppercase; }
        .row { display: flex; align-items: center; justify-content: space-between; gap: 14px; }
        p { margin: 0; font-size: 14px; line-height: 1.4; }
        strong { font-variant-numeric: tabular-nums; }
        button { flex: none; padding: 9px 12px; border: 0; border-radius: 999px; background: #1f513a;
          color: white; font: 700 12px/1 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          cursor: pointer; }
        button:hover { background: #173f2d; }
      </style>
      <section class="note">
        <p class="eyebrow">Tranquil attention guard</p>
        <div class="row">
          <p>You’ve spent 5 active minutes on ${config.name}. Feed access closes in <strong id="remaining">1:00</strong>.</p>
          <button id="block-now" type="button">Block now</button>
        </div>
      </section>`;
    shadow.getElementById("block-now").addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "AUTO_BLOCK_FEED", siteKey });
      removeWarning();
    });
    document.documentElement.appendChild(warning);
  }

  const updateCountdown = () => {
    const remainingSeconds = Math.max(0, Math.ceil((warningEndsAt - Date.now()) / 1000));
    const countdown = warning.shadowRoot?.getElementById("remaining");
    if (countdown) countdown.textContent = `${Math.floor(remainingSeconds / 60)}:${String(remainingSeconds % 60).padStart(2, "0")}`;
    if (!remainingSeconds) removeWarning();
  };
  if (warningTimer) clearInterval(warningTimer);
  updateCountdown();
  warningTimer = setInterval(updateCountdown, 1000);
}

function addSuppression(config) {
  if (!document.documentElement || document.getElementById(STYLE_ID)) return;

  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `${config.selectors.join(",\n")} {
    display: none !important;
    visibility: hidden !important;
  }`;
  document.documentElement.appendChild(style);
  document.documentElement.setAttribute("data-stillspace-feed-hidden", "true");

  const placeholder = document.createElement("aside");
  placeholder.id = PLACEHOLDER_ID;
  placeholder.setAttribute("aria-label", `${config.name} feed hidden by Tranquil`);
  const shadow = placeholder.attachShadow({ mode: "closed" });
  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      .card {
        position: fixed; z-index: 2147483646; top: 50%; left: 50%;
        width: min(360px, calc(100vw - 48px)); transform: translate(-50%, -50%);
        box-sizing: border-box; padding: 28px; border: 1px solid #d8d5cc;
        border-radius: 18px; background: #f6f3eb; color: #17231c;
        box-shadow: 0 18px 55px rgba(23,35,28,.12); text-align: center;
        font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        pointer-events: none;
      }
      .mark { width: 40px; height: 40px; margin: 0 auto 18px; border: 1.5px solid #17231c;
        border-radius: 50%; display: grid; place-items: center; font-size: 17px; }
      .eyebrow { margin: 0 0 9px; color: #647068; font-size: 10px; font-weight: 800;
        letter-spacing: .14em; text-transform: uppercase; }
      h1 { margin: 0 0 10px; font: 500 28px/1.08 Georgia, serif; letter-spacing: -.03em; }
      p { margin: 0; color: #667068; font-size: 13px; line-height: 1.5; }
    </style>
    <section class="card">
      <div class="mark" aria-hidden="true">◌</div>
      <p class="eyebrow">${config.name} feed removed</p>
      <h1>Nothing here needs you.</h1>
      <p>The feed container is suppressed. Navigation, direct links, profiles, messages, and searches remain available.</p>
    </section>`;
  document.documentElement.appendChild(placeholder);
}

async function refresh() {
  if (globalThis.__tranquilContentVersion !== CONTENT_VERSION) return;
  if (redirectLinkedInMention()) return;
  const identified = identifySite();
  if (!identified || !document.documentElement) return;
  const [siteKey, config] = identified;
  // Clear stale feed-only CSS synchronously, even if storage is slow or this
  // tab's old extension context was invalidated during an extension reload.
  if (siteKey === "linkedin" && !isFeedPath(config)) removeSuppression();
  if (siteKey === "youtube" && location.hostname === "accounts.youtube.com") return;
  if (siteKey === "facebook") sanitizeFacebookBaseline();
  const refreshUrl = location.href;
  let settings;
  try { settings = await chrome.storage.local.get({
    feedBlockingEnabled: true,
    enabledSites: {},
    feedExceptions: [],
    attentionGuardEnabled: true,
    guardBlockedSites: {},
    sitePolicies: {},
    workPass: null
    ,sharedAccess: null, installationId: null, sessionEnd: null
  }); } catch { return; }
  if (globalThis.__tranquilContentVersion !== CONTENT_VERSION) return;
  // LinkedIn can change the route while storage is resolving. Never apply
  // the previous route's suppression or skip notification normalization.
  if (location.href !== refreshUrl) return refresh();
  const shared=settings.sharedAccess?.enabled && settings.sharedAccess.policies.find(p=>p.siteKey===siteKey);
  if(shared) {
    settings.sitePolicies[siteKey]={level:shared.blocked?"blocked":"work_pass"};
    settings.workPass=settings.sharedAccess.grants.find(g=>g.installationId===settings.installationId&&g.expiresAt>Date.now())||null;
    if (/^\/(login|login\.php|checkpoint|auth|oauth|signin|uas\/login)(\/|$)/.test(location.pathname))return;
  }
  const workPassActive = settings.workPass?.expiresAt > Date.now();
  const workPassMatches = !(settings.sessionEnd>Date.now()) && workPassActive && (settings.workPass.requestId ? sharedWorkMatches(settings.workPass.url) : (
    location.href === settings.workPass.url ||
    location.href.startsWith(`${settings.workPass.url}&`) ||
    location.href.startsWith(`${settings.workPass.url}#`)
  ));
  const accessLevel=settings.sitePolicies?.[siteKey]?.level;
  if (["work_pass","blocked"].includes(accessLevel) && !workPassMatches) {
    location.replace(chrome.runtime.getURL(`blocked.html?site=${encodeURIComponent(siteKey)}&source=strict_policy`));
    return;
  }
  let youtubeWorkStyle=document.getElementById(YOUTUBE_WORK_STYLE_ID);
  if(siteKey === "youtube" && workPassMatches) {
    if(!youtubeWorkStyle) {
      youtubeWorkStyle=document.createElement("style"); youtubeWorkStyle.id=YOUTUBE_WORK_STYLE_ID;
      youtubeWorkStyle.textContent="#secondary,#comments,ytd-comments,ytd-watch-next-secondary-results-renderer,.ytp-endscreen-content,.ytp-ce-element{display:none!important}";
      document.documentElement.appendChild(youtubeWorkStyle);
    }
  } else youtubeWorkStyle?.remove();
  const onFeed = isFeedPath(config);
  const excepted = isExcepted(settings.feedExceptions || []);
  const shouldSuppress = (
    !!shared && onFeed || settings.feedBlockingEnabled !== false &&
    settings.enabledSites?.[siteKey] !== false &&
    onFeed &&
    !excepted
  );

  if (shouldSuppress) {
    addSuppression(config);
    removeWarning();
  } else {
    removeSuppression();
  }
  updateUsageTracking(siteKey, !shouldSuppress);
  monitoredSiteKey = settings.attentionGuardEnabled !== false && !excepted && !shouldSuppress ? siteKey : null;
  if (!monitoredSiteKey) removeWarning();
  else if (document.visibilityState === "visible") sendActivityHeartbeat();
}

function sharedWorkMatches(raw) {
  const expected=new URL(raw),actual=new URL(location.href);
  if(expected.hostname.replace(/^(www|m|mobile)\./,"")!==actual.hostname.replace(/^(www|m|mobile)\./,""))return false;
  if(siteIsYoutube(expected))return actual.pathname==="/watch"&&actual.searchParams.get("v")===expected.searchParams.get("v");
  const path=actual.pathname.replace(/\/$/,""),target=expected.pathname.replace(/\/$/,"");
  const group=expected.hostname.endsWith("facebook.com")&&/^\/groups\/[^/]+$/.test(target);
  if(path!==target&&!(group&&path.startsWith(target+"/posts/")))return false;
  return [...expected.searchParams].every(([k,v])=>actual.searchParams.get(k)===v);
}
function siteIsYoutube(url){return /(^|\.)youtube\.com$/.test(url.hostname);}

async function sendActivityHeartbeat() {
  if (redirectLinkedInMention()) return;
  if (!monitoredSiteKey || document.visibilityState !== "visible") return;
  try {
    const siteKey = monitoredSiteKey;
    const response = await chrome.runtime.sendMessage({ type: "FEED_ACTIVITY", siteKey });
    if (response?.ok && response.warning && monitoredSiteKey === siteKey) {
      const config = SITE_CONFIG[siteKey];
      showWarning(config, siteKey, response.warningEndsAt);
    }
  } catch {
    // The extension may be reloading while the page is still open.
  }
}

function checkRouteChange() {
  if (globalThis.__tranquilContentVersion !== CONTENT_VERSION) return;
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    refresh();
  }
}
const observer = new MutationObserver((mutations) => {
  if (isFacebook() && mutations.some((mutation) => mutation.addedNodes.length)) queueFacebookSanitization();
  checkRouteChange();
});

observer.observe(document, { childList: true, subtree: true });
chrome.storage.onChanged.addListener(refresh);
window.addEventListener("popstate", refresh);
window.addEventListener("hashchange", refresh);
// pushState does not fire popstate, and a hidden feed may not mutate the DOM.
// This inexpensive URL-only fallback is independent of the attention guard.
if (/(^|\.)linkedin\.com$/.test(location.hostname)) setInterval(checkRouteChange, 500);
setInterval(sendActivityHeartbeat, ACTIVITY_HEARTBEAT_MS);
setInterval(flushVisibleUsage, ACTIVITY_HEARTBEAT_MS);
function resetAttentionVisit() {
  if (monitoredSiteKey) chrome.runtime.sendMessage({ type: "FEED_INACTIVE", siteKey: monitoredSiteKey }).catch(() => {});
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    usageLastActiveAt = Date.now();
    sendActivityHeartbeat();
  } else {
    flushVisibleUsage(true);
    usageLastActiveAt = null;
    resetAttentionVisit();
  }
});
window.addEventListener("pagehide", () => { flushVisibleUsage(true); resetAttentionVisit(); });
sanitizeFacebookBaseline();
refresh();
})();
