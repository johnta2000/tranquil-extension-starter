export const services = ["facebook", "linkedin", "reddit", "youtube"] as const;
export const allowance = 3;
export const maxMinutes = 10;
export function accountDay(now: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {timeZone, year:"numeric", month:"2-digit", day:"2-digit"}).formatToParts(new Date(now));
  return ["year", "month", "day"].map(key => parts.find(p => p.type === key)!.value).join("-");
}
export function workDestination(raw: string): {siteKey: string, url: string} {
  const u = new URL(raw);
  if (u.protocol !== "https:" || u.username || u.password || u.port) throw new Error("Use an HTTPS work destination.");
  let h = u.hostname.toLowerCase().replace(/^(www|m|mobile)\./, "");
  const p = u.pathname.replace(/\/+$/, "") || "/";
  let siteKey = "";
  if (h === "youtu.be" || h === "youtube.com") {
    const id = h === "youtu.be" ? p.slice(1) : p === "/watch" ? u.searchParams.get("v") : null;
    if (!id || !/^[\w-]{11}$/.test(id)) throw new Error("Choose one YouTube video, not Shorts or a feed.");
    return {siteKey:"youtube", url:`https://www.youtube.com/watch?v=${id}`};
  }
  if (h === "facebook.com") {
    if (p === "/" || /^\/(home\.php|reels?|watch|stories|gaming|marketplace|share)(\/|$)/i.test(p)) throw new Error("Choose a Facebook group, profile, post, or conversation.");
    if (p === "/groups" || /^\/groups\/(feed|discover|joins)(\/|$)/i.test(p)) throw new Error("Paste a specific Facebook group URL.");
    siteKey = "facebook";
  } else if (h === "linkedin.com") {
    if (!/^\/(in|company|messaging|posts)\/.+/i.test(p) && !/^\/feed\/update\/.+/i.test(p)) throw new Error("Choose a LinkedIn post, profile, or conversation.");
    siteKey = "linkedin";
  } else if (h === "reddit.com") {
    if (!/^\/r\/[^/]+\/comments\/[^/]+/i.test(p)) throw new Error("Choose one Reddit discussion, not a subreddit feed.");
    siteKey = "reddit";
  } else throw new Error("Work allowances currently support Facebook, LinkedIn, Reddit, and YouTube.");
  // Retain essential Facebook identifiers, discard tracking parameters.
  const query = new URLSearchParams();
  for (const key of ["id", "story_fbid", "fbid"]) if (u.searchParams.has(key)) query.set(key, u.searchParams.get(key)!);
  return {siteKey, url:`https://www.${h}${p}${query.size ? "?" + query : ""}`};
}
