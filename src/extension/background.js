(function cacheStatusRelay(root) {
  "use strict";

  // Bilibili's CDN says in every media response whether the edge served it
  // from cache, but exposes only Content-Length and Content-Range to page
  // scripts, so the page engine can't see it. webRequest can. For each video
  // or audio fragment on a Bilibili tab this reads the cache status
  // (routing.cacheVerdict, built in ahead of this file) and hands it to the
  // tab's content script, which posts it into the page. Nothing is stored and
  // nothing leaves the browser.

  const api = typeof browser !== "undefined" ? browser : chrome;
  const routing = root.BiliAcceleratorRouting;
  if (!api || !api.webRequest || !api.webRequest.onHeadersReceived || !api.tabs || !routing) {
    return;
  }

  const MEDIA_RE = /\.m4s(?:$|[?#])/i;

  api.webRequest.onHeadersReceived.addListener(function onHeaders(details) {
    if (details.tabId < 0 || (details.statusCode !== 200 && details.statusCode !== 206) ||
        !MEDIA_RE.test(details.url)) {
      return;
    }
    const verdict = routing.cacheVerdict(details.responseHeaders || []);
    if (!verdict) {
      return;
    }
    const message = { __biliAccel: "cache", url: details.url, verdict };
    try {
      const sent = api.tabs.sendMessage(details.tabId, message, { frameId: details.frameId });
      if (sent && typeof sent.catch === "function") {
        // A tab without the content script (or one that just navigated).
        sent.catch(function () {});
      }
    } catch (_) {
      // same
    }
  }, {
    urls: ["https://*.bilivideo.com/*", "https://*.akamaized.net/*"],
    types: ["xmlhttprequest"]
  }, ["responseHeaders"]);
})(globalThis);
