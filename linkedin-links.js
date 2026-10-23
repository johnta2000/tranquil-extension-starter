// Normalize only a specific post notification. This never grants access or changes blocking rules.
(() => {
  function linkedinPostUrl(raw) {
    let url;
    try { url = new URL(raw); } catch { return null; }
    if (url.protocol !== "https:" || url.username || url.password || url.port ||
        !["linkedin.com", "www.linkedin.com", "m.linkedin.com"].includes(url.hostname) ||
        !/^\/feed\/?$/.test(url.pathname)) return null;
    const urns = url.searchParams.getAll("highlightedUpdateUrn");
    if (urns.length !== 1 || !/^urn:li:activity:\d{1,25}$/.test(urns[0])) return null;
    const post = new URL(`https://www.linkedin.com/feed/update/${urns[0]}/`);
    // Retain comment context, not notification/tracking parameters or arbitrary redirect targets.
    for (const key of ["commentUrn", "dashCommentUrn", "replyUrn", "showCommentBox"]) {
      const value = url.searchParams.get(key);
      if (value) post.searchParams.set(key, value);
    }
    post.hash = url.hash;
    return post.href;
  }
  globalThis.TranquilLinks = { linkedinPostUrl };
})();
