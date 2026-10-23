import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const helper = await readFile(new URL("../linkedin-links.js", import.meta.url), "utf8");
const content = await readFile(new URL("../content.js", import.meta.url), "utf8");
const sandbox = { URL };
vm.runInNewContext(helper, sandbox);
const normalize = sandbox.TranquilLinks.linkedinPostUrl;
const notification = "https://www.linkedin.com/feed/?highlightedUpdateUrn=urn%3Ali%3Aactivity%3A7506345272147398656&highlightedUpdateType=MENTIONED_YOU_IN_THIS&origin=inapp&showCommentBox=true";
const direct = "https://www.linkedin.com/feed/update/urn:li:activity:7506345272147398656/?showCommentBox=true";
assert.equal(normalize(notification), direct);
assert.equal(normalize(direct), null, "direct posts must not redirect again");
const comments = new URL(notification);
comments.searchParams.set("dashCommentUrn", "urn:li:fsd_comment:(123,urn:li:activity:7506345272147398656)");
comments.searchParams.set("replyUrn", "urn:li:comment:456");
comments.searchParams.set("redirect", "https://example.invalid");
comments.hash = "#comment";
const preserved = new URL(normalize(comments.href));
assert.equal(preserved.searchParams.get("dashCommentUrn"), comments.searchParams.get("dashCommentUrn"));
assert.equal(preserved.searchParams.get("replyUrn"), comments.searchParams.get("replyUrn"));
assert.equal(preserved.searchParams.has("redirect"), false);
assert.equal(preserved.searchParams.has("origin"), false);
assert.equal(preserved.hash, "#comment");
assert.equal(normalize("https://linkedin.com/feed?highlightedUpdateUrn=urn:li:activity:123"), "https://www.linkedin.com/feed/update/urn:li:activity:123/");
assert.equal(normalize(notification.replaceAll("%3A", "%3a")), direct);
for (const url of [
  "https://www.linkedin.com/feed/", "https://www.linkedin.com/feed/?showCommentBox=true",
  notification.replace("www.linkedin.com", "www.linkedin.com.evil.test"),
  notification.replace("www.linkedin.com", "www.linkedin.com@evil.test"),
  notification.replace("https:", "http:"), notification.replace("/feed/", "/other/"),
  notification + "&highlightedUpdateUrn=urn:li:activity:321",
  notification.replace("7506345272147398656", "123%2F..%2Ffeed"),
  notification.replace("urn%3Ali%3Aactivity", "urn%3Ali%3Aprofile"),
  notification.replaceAll("%3A", "%253A"), "not a URL"
]) assert.equal(normalize(url), null, `must not normalize ${url}`);

// Exercise the actual content-script handlers without loading a real LinkedIn account.
const listeners = {}, navigations = [];
class Element {
  constructor(href, target="") { this.href=href;this.target=target; }
  closest() {return this;}
  hasAttribute() {return false;}
}
const location = {href:notification,hostname:"www.linkedin.com",replace:url=>navigations.push(["replace",url]),assign:url=>navigations.push(["assign",url])};
const context = {URL,Element,location,document:{getElementById:()=>null,addEventListener:(name,fn)=>{listeners[name]=fn;}}};
vm.runInNewContext(helper,context);
vm.runInNewContext(content.slice(0,content.indexOf("const SITE_CONFIG"))+"globalThis.testRedirect=redirectLinkedInMention;})();",context);
assert.equal(context.testRedirect(),true);
assert.deepEqual(navigations.pop(),["replace",direct]);
location.href=direct;assert.equal(context.testRedirect(),false);
location.href=notification;assert.equal(context.testRedirect(),true,"SPA arrival uses the same URL conversion");
navigations.length=0;
function event(anchor,overrides={}) {return {type:"click",target:anchor,button:0,preventDefault(){this.prevented=true;},stopImmediatePropagation(){this.stopped=true;},...overrides};}
const anchor = new Element(notification);
listeners.pointerdown(event(anchor,{type:"pointerdown"}));
assert.equal(anchor.href,direct);
const click=event(anchor);listeners.click(click);
assert.equal(click.prevented,true);assert.equal(click.stopped,true);
assert.deepEqual(navigations.pop(),["assign",direct],"pointerdown rewriting must not lose normal click navigation");
for(const overrides of [{ctrlKey:true},{metaKey:true},{shiftKey:true},{button:1}]) {
  const a=new Element(notification),e=event(a,overrides);listeners.click(e);
  assert.equal(a.href,direct);assert.equal(e.prevented,undefined,"modified clicks keep native browser behavior");
}
const newTab=new Element(notification,"_blank"),newTabClick=event(newTab);listeners.click(newTabClick);
assert.equal(newTab.href,direct);assert.equal(newTabClick.prevented,undefined);
const ordinary=new Element("https://www.linkedin.com/feed/");listeners.click(event(ordinary));
assert.equal(ordinary.href,"https://www.linkedin.com/feed/");
assert.equal(navigations.length,0);
const refresh=content.slice(content.indexOf("async function refresh()"),content.indexOf("function sharedWorkMatches"));
assert.ok(refresh.indexOf("redirectLinkedInMention()")<refresh.indexOf("chrome.storage.local.get"),"convert before feed/strict-policy checks; destination navigation still goes through network blocking");
const manifest=JSON.parse(await readFile(new URL("../manifest.json",import.meta.url),"utf8"));
assert.deepEqual(manifest.content_scripts[0].js,["linkedin-links.js","content.js"]);
console.log("LinkedIn notification normalization, comment context, SPA and click checks passed");
