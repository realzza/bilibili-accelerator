(function initBiliAcceleratorCore(root, factory) {
  const core = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = core;
  }

  root.BiliAcceleratorCore = core;
})(typeof globalThis !== "undefined" ? globalThis : window, function createCore() {
  "use strict";

  const DEFAULT_CONFIG = Object.freeze({
    enabled: true,
    mode: "bad-only",
    pcdnHost: "upos-sz-mirrorcos.bilivideo.com",
    mcdnStrategy: "proxy-all",
    proxyHost: "proxy-tf-all-ws.bilivideo.com",
    rewriteAkamai: false,
    maxDepth: 20
  });

  const CDN_HOSTS = Object.freeze([
    "upos-sz-mirrorcos.bilivideo.com",
    "upos-sz-mirrorali.bilivideo.com",
    "upos-sz-mirrorhw.bilivideo.com",
    "upos-tf-all-hw.bilivideo.com",
    "upos-tf-all-tx.bilivideo.com",
    "upos-hz-mirrorakam.akamaized.net",
    "upos-sz-mirrorakam.akamaized.net",
    "upos-sz-mirroraliov.bilivideo.com",
    "upos-sz-mirrorcosov.bilivideo.com",
    "upos-sz-mirrorhwov.bilivideo.com"
  ]);

  const MEDIA_PATH_RE = /\.(m4s|mp4|flv|m3u8)(?:$|[?#])/i;
  const IP_RE = /^(?:\d{1,3}\.){3}\d{1,3}$/;
  const XY_MCDN_RE = /^xy(?:\d+x){3}\d+xy\.mcdn\.bilivideo\.(?:cn|com|net)$/i;

  function normalizeConfig(config) {
    return Object.assign({}, DEFAULT_CONFIG, config || {});
  }

  function hasBiliMediaSignal(value) {
    return typeof value === "string" &&
      (value.includes("bilivideo") ||
        value.includes("akamaized.net") ||
        value.includes("szbdyd.com") ||
        value.includes("/upgcxcode/") ||
        value.includes("/v1/resource/"));
  }

  function parseUrl(value) {
    if (!hasBiliMediaSignal(value)) {
      return null;
    }

    try {
      const url = new URL(value);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        return null;
      }
      return url;
    } catch (_) {
      return null;
    }
  }

  function isMediaUrl(url) {
    return MEDIA_PATH_RE.test(url.pathname + url.search) ||
      url.pathname.startsWith("/upgcxcode/") ||
      url.pathname.startsWith("/v1/resource/");
  }

  function isMcdnHost(hostname) {
    return /\.mcdn\.bilivideo\.(?:cn|com|net)$/i.test(hostname);
  }

  function isPcdnHost(url) {
    return IP_RE.test(url.hostname) || XY_MCDN_RE.test(url.hostname) || isMcdnHost(url.hostname);
  }

  function isBiliCdnHost(hostname) {
    return hostname.endsWith(".bilivideo.com") ||
      hostname.endsWith(".bilivideo.cn") ||
      hostname.endsWith(".bilivideo.net") ||
      hostname.endsWith(".akamaized.net");
  }

  function isKnownSlowHost(url, config) {
    const hostname = url.hostname.toLowerCase();

    if (isPcdnHost(url)) {
      return true;
    }

    if (hostname.endsWith(".szbdyd.com")) {
      return true;
    }

    if (hostname.includes("mirroraliov") || hostname.includes("mirrorcosov") || hostname.includes("mirrorhwov")) {
      return true;
    }

    return config.rewriteAkamai && hostname.endsWith(".akamaized.net");
  }

  function cleanHost(host) {
    const trimmed = String(host || "").trim();
    return trimmed.replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
  }

  function replaceHost(url, host) {
    const next = new URL(url.toString());
    next.protocol = "https:";
    next.host = cleanHost(host);
    if (!cleanHost(host).includes(":")) {
      next.port = "";
    }
    return next.toString();
  }

  function proxyUrl(url, config) {
    const next = new URL("https://" + cleanHost(config.proxyHost) + "/");
    next.searchParams.set("url", url.toString());
    return next.toString();
  }

  function shouldProxyMcdn(url, config) {
    if (!isMcdnHost(url.hostname)) {
      return false;
    }

    if (config.mcdnStrategy === "proxy-all") {
      return true;
    }

    return config.mcdnStrategy === "proxy-v1" && url.pathname.startsWith("/v1/resource/");
  }

  function rewriteUrlDetail(value, rawConfig) {
    const config = normalizeConfig(rawConfig);
    const original = String(value || "");
    const url = parseUrl(original);

    if (!config.enabled || !url || !isMediaUrl(url) || url.hostname === cleanHost(config.proxyHost)) {
      return {
        changed: false,
        original,
        url: original,
        reason: "ignored"
      };
    }

    if (url.hostname.endsWith(".szbdyd.com")) {
      const source = url.searchParams.get("xy_usource");
      if (source) {
        const rewritten = replaceHost(url, source);
        return {
          changed: rewritten !== original,
          original,
          url: rewritten,
          reason: "szbdyd-source",
          targetHost: cleanHost(source)
        };
      }
    }

    if (shouldProxyMcdn(url, config)) {
      const rewritten = proxyUrl(url, config);
      return {
        changed: rewritten !== original,
        original,
        url: rewritten,
        reason: "mcdn-proxy",
        targetHost: cleanHost(config.proxyHost)
      };
    }

    const force = config.mode === "force";
    if (isKnownSlowHost(url, config) || (force && isBiliCdnHost(url.hostname))) {
      const rewritten = replaceHost(url, config.pcdnHost);
      return {
        changed: rewritten !== original,
        original,
        url: rewritten,
        reason: isPcdnHost(url) ? "pcdn-host" : "cdn-host",
        targetHost: cleanHost(config.pcdnHost)
      };
    }

    return {
      changed: false,
      original,
      url: original,
      reason: "ok"
    };
  }

  function rewriteUrl(value, config) {
    return rewriteUrlDetail(value, config).url;
  }

  function rewriteObject(value, rawConfig, state, depth, seen) {
    const config = normalizeConfig(rawConfig);
    const tracker = state || { changed: false, rewrites: [] };
    const level = depth || 0;
    const visited = seen || new WeakSet();

    if (!config.enabled || value == null || level > config.maxDepth) {
      return value;
    }

    if (typeof value === "string") {
      const detail = rewriteUrlDetail(value, config);
      if (detail.changed) {
        tracker.changed = true;
        tracker.rewrites.push(detail);
      }
      return detail.url;
    }

    if (typeof value !== "object") {
      return value;
    }

    if (visited.has(value)) {
      return value;
    }
    visited.add(value);

    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        value[index] = rewriteObject(value[index], config, tracker, level + 1, visited);
      }
      return value;
    }

    for (const key of Object.keys(value)) {
      value[key] = rewriteObject(value[key], config, tracker, level + 1, visited);
    }

    return value;
  }

  function rewriteJsonText(text, rawConfig) {
    const state = { changed: false, rewrites: [] };
    const parsed = JSON.parse(text);
    rewriteObject(parsed, rawConfig, state);

    return {
      changed: state.changed,
      text: state.changed ? JSON.stringify(parsed) : text,
      value: parsed,
      rewrites: state.rewrites
    };
  }

  return {
    CDN_HOSTS,
    DEFAULT_CONFIG,
    normalizeConfig,
    rewriteJsonText,
    rewriteObject,
    rewriteUrl,
    rewriteUrlDetail
  };
});
