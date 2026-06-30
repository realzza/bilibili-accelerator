// ==UserScript==
// @name         Bilibili Accelerator
// @name:zh-CN   Bilibili Accelerator - B站海外播放加速
// @namespace    https://github.com/realzza/bilibili-accelerator
// @version      0.2.0
// @description  Rewrite slow Bilibili playback CDN URLs for smoother overseas playback.
// @description:zh-CN 自动改写 B 站慢 CDN 播放地址，缓解海外用户看冷门视频时的卡顿。
// @author       realzza
// @license      MIT
// @homepageURL  https://github.com/realzza/bilibili-accelerator
// @supportURL   https://github.com/realzza/bilibili-accelerator/issues
// @match        https://*.bilibili.com/*
// @match        https://*.bilibili.tv/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function initBiliAcceleratorCore(root, factory) {
  const core = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = core;
  }

  root.BiliAcceleratorCore = core;
})(typeof globalThis !== "undefined" ? globalThis : window, function createCore() {
  "use strict";

  const SCHEMA_VERSION = 2;

  // Healthy UPOS mirrors we are willing to rewrite toward. The first entry is
  // the default target; the whole list seeds the auto-selection candidate pool.
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

  // Candidates that are safe to auto-probe and rank: non-akamai, non-overseas
  // mirrors that work well as generic rewrite targets.
  const CANDIDATE_POOL = Object.freeze([
    "upos-sz-mirrorcos.bilivideo.com",
    "upos-sz-mirrorali.bilivideo.com",
    "upos-sz-mirrorhw.bilivideo.com",
    "upos-tf-all-hw.bilivideo.com",
    "upos-tf-all-tx.bilivideo.com"
  ]);

  const DEFAULT_CONFIG = Object.freeze({
    enabled: true,
    lang: "en",                                    // en | zh (UI language)
    mode: "bad-only",                              // bad-only | force | off
    selection: "auto",                             // auto | fixed
    pcdnHost: "upos-sz-mirrorcos.bilivideo.com",
    candidatePool: CANDIDATE_POOL.slice(),
    mcdnStrategy: "proxy-all",                      // proxy-all | proxy-v1 | replace
    proxyHost: "proxy-tf-all-ws.bilivideo.com",
    rewriteAkamai: false,
    portHeuristic: true,                           // non-default port ⇒ PCDN
    stallRecovery: true,                           // live failover on buffering
    p2pGuard: false,                               // opt-in WebRTC/PCDN neutralizer
    maxDepth: 20,
    schemaVersion: SCHEMA_VERSION
  });

  const MEDIA_PATH_RE = /\.(m4s|mp4|flv|m3u8)(?:$|[?#])/i;
  const IP_RE = /^(?:\d{1,3}\.){3}\d{1,3}$/;
  const XY_MCDN_RE = /^xy(?:\d+x){3}\d+xy\.mcdn\.bilivideo\.(?:cn|com|net)$/i;

  // Forward-migrate any stored config (v1 or partial) onto the v2 defaults.
  function normalizeConfig(config) {
    const merged = Object.assign({}, DEFAULT_CONFIG, config || {});
    if (!Array.isArray(merged.candidatePool) || merged.candidatePool.length === 0) {
      merged.candidatePool = CANDIDATE_POOL.slice();
    }
    if (merged.mode !== "bad-only" && merged.mode !== "force" && merged.mode !== "off") {
      merged.mode = DEFAULT_CONFIG.mode;
    }
    if (merged.selection !== "auto" && merged.selection !== "fixed") {
      merged.selection = DEFAULT_CONFIG.selection;
    }
    if (merged.lang !== "en" && merged.lang !== "zh") {
      merged.lang = DEFAULT_CONFIG.lang;
    }
    merged.schemaVersion = SCHEMA_VERSION;
    return merged;
  }

  function hasBiliMediaSignal(value) {
    return typeof value === "string" &&
      (value.includes("bilivideo") ||
        value.includes("akamaized.net") ||
        value.includes("szbdyd.com") ||
        value.includes("mcdn.bili") ||
        value.includes("os=mcdn") ||
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

  function isBiliCdnHost(hostname) {
    return hostname.endsWith(".bilivideo.com") ||
      hostname.endsWith(".bilivideo.cn") ||
      hostname.endsWith(".bilivideo.net") ||
      hostname.endsWith(".akamaized.net");
  }

  function hasNonDefaultPort(url) {
    // URL drops the port when it matches the protocol default (80/443), so any
    // remaining port string means a non-standard endpoint — a strong PCDN tell.
    return url.port !== "" && url.port !== "80" && url.port !== "443";
  }

  function hasMcdnQuery(url) {
    return url.searchParams.get("os") === "mcdn" || /(?:^|[?&])os=mcdn(?:&|$)/i.test(url.search);
  }

  function isOverseasMirror(hostname) {
    return hostname.includes("mirroraliov") ||
      hostname.includes("mirrorcosov") ||
      hostname.includes("mirrorhwov");
  }

  // Single source of truth for "what is this host, and is it slow for us".
  // Behavior-based so renamed PCDN families (e.g. *.edge.mountaintoys.cn) are
  // caught by the port/os=mcdn heuristics without needing a hostname update.
  function classify(url, rawConfig) {
    const config = normalizeConfig(rawConfig);
    const hostname = url.hostname.toLowerCase();

    let schedulerSource = null;
    if (hostname.endsWith(".szbdyd.com")) {
      schedulerSource = cleanHost(url.searchParams.get("xy_usource") || "") || null;
    }

    const ipLike = IP_RE.test(hostname);
    const xyMcdn = XY_MCDN_RE.test(hostname);
    const mcdn = isMcdnHost(hostname);
    const akamai = hostname.endsWith(".akamaized.net");
    const portPcdn = config.portHeuristic && hasNonDefaultPort(url);
    const queryMcdn = hasMcdnQuery(url);

    const isPcdn = ipLike || xyMcdn || portPcdn || queryMcdn;

    let kind = "unknown";
    if (schedulerSource !== null || hostname.endsWith(".szbdyd.com")) {
      kind = "scheduler";
    } else if (mcdn) {
      kind = "mcdn";
    } else if (ipLike || xyMcdn || portPcdn || queryMcdn) {
      kind = "pcdn";
    } else if (akamai) {
      kind = "akamai";
    } else if (hostname.startsWith("upos-") || hostname.endsWith(".bilivideo.com")) {
      kind = "upos";
    }

    const isSlow = isPcdn ||
      isOverseasMirror(hostname) ||
      (config.rewriteAkamai && akamai);

    return {
      host: hostname,
      port: url.port || "",
      kind,
      isPcdn,
      isMcdn: mcdn,
      isAkamai: akamai,
      isSlow,
      schedulerSource
    };
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

  function shouldProxyMcdn(verdict, url, config) {
    if (!verdict.isMcdn) {
      return false;
    }
    if (config.mcdnStrategy === "proxy-all") {
      return true;
    }
    return config.mcdnStrategy === "proxy-v1" && url.pathname.startsWith("/v1/resource/");
  }

  // The host to rewrite slow UPOS/PCDN URLs toward. In auto mode the runtime
  // keeps config.pcdnHost pointed at the current best-ranked candidate.
  function selectTarget(config) {
    return cleanHost(config.pcdnHost) || CDN_HOSTS[0];
  }

  function rewriteUrlDetail(value, rawConfig) {
    const config = normalizeConfig(rawConfig);
    const original = String(value || "");
    const url = parseUrl(original);

    if (!config.enabled || config.mode === "off" || !url || !isMediaUrl(url) ||
        url.hostname === cleanHost(config.proxyHost)) {
      return { changed: false, original, url: original, reason: "ignored" };
    }

    const verdict = classify(url, config);

    if (verdict.schedulerSource) {
      const rewritten = replaceHost(url, verdict.schedulerSource);
      return {
        changed: rewritten !== original,
        original,
        url: rewritten,
        reason: "szbdyd-source",
        targetHost: cleanHost(verdict.schedulerSource)
      };
    }

    if (shouldProxyMcdn(verdict, url, config)) {
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
    if (verdict.isSlow || verdict.isMcdn || (force && isBiliCdnHost(url.hostname))) {
      const target = selectTarget(config);
      const rewritten = replaceHost(url, target);
      return {
        changed: rewritten !== original,
        original,
        url: rewritten,
        reason: verdict.isPcdn ? "pcdn-host" : (verdict.isMcdn ? "mcdn-host" : "cdn-host"),
        targetHost: target
      };
    }

    return { changed: false, original, url: original, reason: "ok" };
  }

  function rewriteUrl(value, config) {
    return rewriteUrlDetail(value, config).url;
  }

  // Build host-swapped alternatives of a media URL for DASH backupUrl fan-out.
  // Returns rewritten URL strings for each candidate host except the current one.
  function alternativesFor(value, rawConfig, hosts) {
    const config = normalizeConfig(rawConfig);
    const url = parseUrl(String(value || ""));
    if (!url || !isMediaUrl(url)) {
      return [];
    }
    const pool = (hosts && hosts.length ? hosts : config.candidatePool) || [];
    const current = url.hostname.toLowerCase();
    const seen = {};
    const out = [];
    pool.forEach(function eachHost(host) {
      const clean = cleanHost(host).toLowerCase();
      if (!clean || clean === current || seen[clean]) {
        return;
      }
      seen[clean] = true;
      out.push(replaceHost(url, host));
    });
    return out;
  }

  // Pure ranking of probed hosts. samples: [{host, ttfb:number|null, ok:bool}].
  // Healthy hosts first (lowest TTFB wins); failures sink to the bottom.
  function rankHosts(samples) {
    return (samples || [])
      .slice()
      .sort(function compare(a, b) {
        const aOk = a.ok && typeof a.ttfb === "number";
        const bOk = b.ok && typeof b.ttfb === "number";
        if (aOk !== bOk) {
          return aOk ? -1 : 1;
        }
        if (aOk && bOk) {
          return a.ttfb - b.ttfb;
        }
        return 0;
      })
      .map(function pickHost(sample) {
        return cleanHost(sample.host);
      });
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
    SCHEMA_VERSION,
    CDN_HOSTS,
    CANDIDATE_POOL,
    DEFAULT_CONFIG,
    normalizeConfig,
    hasMediaSignal: hasBiliMediaSignal,
    classify,
    selectTarget,
    alternativesFor,
    rankHosts,
    rewriteJsonText,
    rewriteObject,
    rewriteUrl,
    rewriteUrlDetail
  };
});

(function installBiliAccelerator(root) {
  "use strict";

  const core = root.BiliAcceleratorCore;
  if (!core || root.__BILI_ACCELERATOR_INSTALLED__) {
    return;
  }
  root.__BILI_ACCELERATOR_INSTALLED__ = true;

  const STORAGE_KEY = "biliAccelerator.config.v2";
  const LEGACY_KEY = "biliAccelerator.config.v1";
  const RANK_PREFIX = "biliAccelerator.rank.";
  const RANK_TTL_MS = 6 * 60 * 60 * 1000;
  const BUTTON_ID = "bili-accelerator-button";
  const PANEL_ID = "bili-accelerator-panel";
  const IMMERSED_CLASS = "ba-immersed";
  const LIFTED_CLASS = "ba-lifted";
  const REVEAL_HOTZONE = 150;
  const REVEAL_TIMEOUT = 2600;
  const STALL_GRACE_MS = 2500;

  const nativeJsonParse = JSON.parse;
  const nativeFetch = root.fetch;
  const NativeXHR = root.XMLHttpRequest;

  let immersive = false;
  let revealTimer = null;
  let playerObserver = null;
  let observedContainer = null;
  let probed = false;
  let watchedVideo = null;
  let stallTimer = null;

  const recovery = { avoidHost: null, clearTimer: null };

  const state = {
    rewrites: [],
    rewriteCount: 0,
    lastSource: "",
    status: "idle",
    stalls: 0,
    recoveries: 0,
    p2pBlocked: 0,
    ranking: [],
    probedAt: null,
    installedAt: new Date().toISOString()
  };

  // ---- config -------------------------------------------------------------

  function loadConfig() {
    try {
      const stored = root.localStorage.getItem(STORAGE_KEY) ||
        root.localStorage.getItem(LEGACY_KEY);
      return core.normalizeConfig(stored ? JSON.parse(stored) : null);
    } catch (_) {
      return core.normalizeConfig();
    }
  }

  let config = loadConfig();

  function saveConfig(nextConfig) {
    config = core.normalizeConfig(nextConfig);
    try {
      root.localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
    } catch (_) {
      // storage may be unavailable; in-memory config still applies.
    }
  }

  function regionKey() {
    try {
      return (Intl.DateTimeFormat().resolvedOptions().timeZone || "unknown") +
        "|" + (root.navigator && root.navigator.language || "");
    } catch (_) {
      return "unknown";
    }
  }

  function loadRanking() {
    try {
      const raw = root.localStorage.getItem(RANK_PREFIX + regionKey());
      if (!raw) {
        return null;
      }
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.ranking) || !parsed.at) {
        return null;
      }
      if (Date.now() - parsed.at > RANK_TTL_MS) {
        return null;
      }
      return parsed.ranking;
    } catch (_) {
      return null;
    }
  }

  function saveRanking(ranking) {
    try {
      root.localStorage.setItem(RANK_PREFIX + regionKey(),
        JSON.stringify({ ranking, at: Date.now() }));
    } catch (_) {
      // best-effort cache only.
    }
  }

  // Apply a learned ranking by pointing the active target at the best host.
  function applyRanking(ranking) {
    if (!ranking || !ranking.length || config.selection !== "auto") {
      return;
    }
    state.ranking = ranking;
    config.pcdnHost = ranking[0];
  }

  // ---- rewrite plumbing ---------------------------------------------------

  function record(rewrites, source) {
    if (!rewrites || rewrites.length === 0) {
      return;
    }
    state.lastSource = source;
    state.rewriteCount += rewrites.length;
    state.rewrites = state.rewrites.concat(rewrites.map(function mapRewrite(item) {
      return {
        at: new Date().toISOString(),
        source,
        reason: item.reason,
        targetHost: item.targetHost,
        from: item.original,
        to: item.url
      };
    })).slice(-50);
    if (state.status === "idle") {
      state.status = "smooth";
    }
    renderStatus();
  }

  function rememberSample(payload) {
    if (probed || config.selection !== "auto") {
      return;
    }
    const sample = findMediaUrl(payload, 0, new WeakSet());
    if (sample) {
      scheduleProbe(sample);
    }
  }

  function findMediaUrl(value, depth, seen) {
    if (value == null || depth > config.maxDepth) {
      return null;
    }
    if (typeof value === "string") {
      return /\.(m4s|mp4|flv|m3u8)(?:$|[?#])/i.test(value) && core.hasMediaSignal(value)
        ? value
        : null;
    }
    if (typeof value !== "object" || seen.has(value)) {
      return null;
    }
    seen.add(value);
    const keys = Array.isArray(value) ? value.map(function (_, i) { return i; }) : Object.keys(value);
    for (let i = 0; i < keys.length; i += 1) {
      const found = findMediaUrl(value[keys[i]], depth + 1, seen);
      if (found) {
        return found;
      }
    }
    return null;
  }

  // Add host-swapped alternatives to DASH entries so Bilibili's own backupUrl
  // failover can recover for free if the primary host stalls.
  function enrichBackups(payload) {
    if (config.selection !== "auto" || !payload || typeof payload !== "object") {
      return;
    }
    const dash = (payload.data && payload.data.dash) ||
      (payload.result && payload.result.dash) ||
      payload.dash;
    if (!dash) {
      return;
    }
    ["video", "audio"].forEach(function eachKind(kind) {
      const list = dash[kind];
      if (!Array.isArray(list)) {
        return;
      }
      list.forEach(function eachEntry(entry) {
        if (!entry || typeof entry.baseUrl !== "string") {
          return;
        }
        const alts = core.alternativesFor(entry.baseUrl, config, state.ranking.length ? state.ranking : config.candidatePool);
        if (!alts.length) {
          return;
        }
        const existing = Array.isArray(entry.backupUrl) ? entry.backupUrl : [];
        const merged = alts.concat(existing).filter(function uniq(u, i, arr) {
          return arr.indexOf(u) === i;
        });
        entry.backupUrl = merged.slice(0, 8);
      });
    });
  }

  function rewritePayload(payload, source) {
    const tracker = { changed: false, rewrites: [] };
    try {
      const rewritten = core.rewriteObject(payload, config, tracker);
      enrichBackups(rewritten);
      record(tracker.rewrites, source);
      rememberSample(rewritten);
      return rewritten;
    } catch (error) {
      console.warn("[BiliAccelerator] rewrite failed", error);
      return payload;
    }
  }

  // Quick check on a response body: does it plausibly carry media URLs?
  // Broader than "bilivideo" so renamed PCDN payloads aren't skipped.
  function bodyHasSignal(text) {
    return typeof text === "string" &&
      (text.indexOf("bilivideo") !== -1 ||
        text.indexOf("mcdn") !== -1 ||
        text.indexOf("upgcxcode") !== -1 ||
        text.indexOf("os=mcdn") !== -1 ||
        text.indexOf("akamaized") !== -1);
  }

  // Rewrite a single outgoing request URL (segment fetches, live failover).
  function rewriteRequestUrl(rawUrl) {
    if (!core.hasMediaSignal(rawUrl)) {
      return rawUrl;
    }
    try {
      let host = "";
      try {
        host = new URL(rawUrl, root.location.href).hostname;
      } catch (_) {
        host = "";
      }
      // During recovery, force-redirect away from the stalling host even if it
      // would normally be considered healthy.
      const cfg = (recovery.avoidHost && host === recovery.avoidHost)
        ? Object.assign({}, config, { mode: "force" })
        : config;
      const detail = core.rewriteUrlDetail(rawUrl, cfg);
      if (detail.changed) {
        record([detail], "segment");
        return detail.url;
      }
      return rawUrl;
    } catch (_) {
      return rawUrl;
    }
  }

  // ---- interception -------------------------------------------------------

  function isInterestingFetch(input) {
    const url = typeof input === "string" ? input : input && input.url;
    return typeof url === "string" &&
      (url.includes("/x/player") ||
        url.includes("/pgc/player") ||
        url.includes("playurl") ||
        url.includes("bilivideo"));
  }

  function patchJsonParse() {
    JSON.parse = function patchedJsonParse(text) {
      const parsed = nativeJsonParse.apply(this, arguments);
      if (config.enabled && bodyHasSignal(text)) {
        return rewritePayload(parsed, "JSON.parse");
      }
      return parsed;
    };
  }

  function requestUrlOf(input) {
    if (typeof input === "string") {
      return input;
    }
    if (input && typeof input.url === "string") {
      return input.url;
    }
    return null;
  }

  function patchFetch() {
    if (!nativeFetch) {
      return;
    }
    root.fetch = function patchedFetch(input, init) {
      let args = arguments;
      if (config.enabled) {
        const reqUrl = requestUrlOf(input);
        if (reqUrl && core.hasMediaSignal(reqUrl)) {
          const swapped = rewriteRequestUrl(reqUrl);
          if (swapped !== reqUrl) {
            input = typeof input === "string" ? swapped : new Request(swapped, input);
            args = [input, init];
          }
        }
      }

      return nativeFetch.apply(this, args).then(function handleResponse(response) {
        if (!config.enabled || !isInterestingFetch(args[0])) {
          return response;
        }
        const contentType = response.headers && response.headers.get("content-type");
        if (contentType && !contentType.includes("json") && !contentType.includes("text")) {
          return response;
        }
        return response.clone().text().then(function rewriteText(text) {
          if (!bodyHasSignal(text)) {
            return response;
          }
          let parsed;
          const tracker = { changed: false, rewrites: [] };
          try {
            parsed = nativeJsonParse(text);
            core.rewriteObject(parsed, config, tracker);
            enrichBackups(parsed);
          } catch (_) {
            return response;
          }
          if (!tracker.changed) {
            rememberSample(parsed);
            return response;
          }
          record(tracker.rewrites, "fetch");
          rememberSample(parsed);
          const headers = new Headers(response.headers);
          headers.delete("content-length");
          return new Response(JSON.stringify(parsed), {
            status: response.status,
            statusText: response.statusText,
            headers
          });
        }).catch(function ignore() {
          return response;
        });
      });
    };
  }

  // XHR was the biggest coverage gap in v0.1.x: quality switches and some
  // playurl paths use it. Rewrite the request URL on open() and the JSON body
  // on load() via a responseText/response shim.
  function patchXHR() {
    if (!NativeXHR) {
      return;
    }
    const open = NativeXHR.prototype.open;
    const send = NativeXHR.prototype.send;

    NativeXHR.prototype.open = function patchedOpen(method, url) {
      this.__baAccel = { url: typeof url === "string" ? url : "" };
      let finalUrl = url;
      if (config.enabled && typeof url === "string" && core.hasMediaSignal(url)) {
        finalUrl = rewriteRequestUrl(url);
      }
      return open.apply(this, [method, finalUrl].concat([].slice.call(arguments, 2)));
    };

    NativeXHR.prototype.send = function patchedSend() {
      const xhr = this;
      const meta = xhr.__baAccel || {};
      const interesting = typeof meta.url === "string" &&
        (meta.url.includes("playurl") || meta.url.includes("/x/player") ||
          meta.url.includes("/pgc/player") || core.hasMediaSignal(meta.url));

      if (config.enabled && interesting) {
        xhr.addEventListener("load", function onLoad() {
          try {
            const ct = xhr.getResponseHeader && xhr.getResponseHeader("content-type");
            if (ct && !ct.includes("json") && !ct.includes("text")) {
              return;
            }
            const text = xhr.responseText;
            if (!bodyHasSignal(text)) {
              return;
            }
            const parsed = nativeJsonParse(text);
            const tracker = { changed: false, rewrites: [] };
            core.rewriteObject(parsed, config, tracker);
            enrichBackups(parsed);
            rememberSample(parsed);
            if (!tracker.changed) {
              return;
            }
            const rewrittenText = JSON.stringify(parsed);
            const shim = {
              configurable: true,
              get: function () { return rewrittenText; }
            };
            try { Object.defineProperty(xhr, "responseText", shim); } catch (_) {}
            try {
              Object.defineProperty(xhr, "response", {
                configurable: true,
                get: function () {
                  return xhr.responseType === "json" ? parsed : rewrittenText;
                }
              });
            } catch (_) {}
            record(tracker.rewrites, "xhr");
          } catch (_) {
            // leave the original response intact on any failure.
          }
        });
      }
      return send.apply(this, arguments);
    };
  }

  function patchGlobalPlayInfo(name) {
    let currentValue;
    const existing = Object.getOwnPropertyDescriptor(root, name);
    if (existing && existing.configurable === false) {
      return;
    }
    if (existing && "value" in existing) {
      currentValue = rewritePayload(existing.value, name);
    }
    try {
      Object.defineProperty(root, name, {
        configurable: true,
        enumerable: true,
        get: function () { return currentValue; },
        set: function (value) { currentValue = rewritePayload(value, name); }
      });
    } catch (_) {
      if (root[name]) {
        root[name] = rewritePayload(root[name], name);
      }
    }
  }

  // ---- optional P2P / bandwidth guard ------------------------------------

  function installP2PGuard() {
    if (!config.p2pGuard) {
      return;
    }
    ["RTCPeerConnection", "webkitRTCPeerConnection", "mozRTCPeerConnection"].forEach(function (name) {
      try {
        const Blocked = function BlockedRTCPeerConnection() {
          state.p2pBlocked += 1;
          renderStatus();
          throw new DOMException("Blocked by Bilibili Accelerator", "NotAllowedError");
        };
        Object.defineProperty(root, name, {
          configurable: false,
          writable: false,
          value: Blocked
        });
      } catch (_) {
        // some environments freeze these; ignore.
      }
    });
  }

  // ---- health: probing + stall recovery ----------------------------------

  function swapHost(sampleUrl, host) {
    try {
      const u = new URL(sampleUrl);
      u.protocol = "https:";
      u.host = host;
      if (host.indexOf(":") === -1) {
        u.port = "";
      }
      return u.toString();
    } catch (_) {
      return null;
    }
  }

  function probeHost(host, sampleUrl) {
    const url = swapHost(sampleUrl, host);
    if (!url) {
      return Promise.resolve({ host, ttfb: null, ok: false });
    }
    const started = (root.performance && root.performance.now) ? root.performance.now() : Date.now();
    const timeout = new Promise(function (resolve) {
      setTimeout(function () { resolve({ host, ttfb: null, ok: false }); }, 4000);
    });
    const probe = nativeFetch(url, {
      method: "GET",
      headers: { Range: "bytes=0-1" },
      mode: "no-cors",
      cache: "no-store",
      credentials: "omit"
    }).then(function () {
      const now = (root.performance && root.performance.now) ? root.performance.now() : Date.now();
      return { host, ttfb: now - started, ok: true };
    }).catch(function () {
      return { host, ttfb: null, ok: false };
    });
    return Promise.race([probe, timeout]);
  }

  function scheduleProbe(sampleUrl) {
    if (probed || config.selection !== "auto" || !nativeFetch) {
      return;
    }
    probed = true;
    const cached = loadRanking();
    if (cached) {
      applyRanking(cached);
      renderStatus();
      return;
    }
    const hosts = (config.candidatePool || []).slice(0, 6);
    if (!hosts.length) {
      return;
    }
    state.status = state.status === "idle" ? "optimizing" : state.status;
    renderStatus();
    Promise.all(hosts.map(function (h) { return probeHost(h, sampleUrl); }))
      .then(function (samples) {
        const ranking = core.rankHosts(samples.filter(function (s) { return s.ok; }));
        if (ranking.length) {
          applyRanking(ranking);
          saveRanking(ranking);
          state.probedAt = new Date().toISOString();
          state.status = "smooth";
          renderStatus();
        }
      })
      .catch(function () {});
  }

  function rotateTarget(stallingHost) {
    const pool = (state.ranking.length ? state.ranking : config.candidatePool).slice();
    const current = config.pcdnHost;
    const next = pool.filter(function (h) {
      return h !== current && h !== stallingHost;
    })[0] || pool.find(function (h) { return h !== current; });
    if (next) {
      config.pcdnHost = next;
    }
    recovery.avoidHost = stallingHost || current;
    if (recovery.clearTimer) {
      clearTimeout(recovery.clearTimer);
    }
    // Stop forcing the old host away once the player has moved on.
    recovery.clearTimer = setTimeout(function () { recovery.avoidHost = null; }, 15000);
  }

  function currentVideoHost() {
    try {
      if (watchedVideo && watchedVideo.currentSrc) {
        return new URL(watchedVideo.currentSrc).hostname;
      }
    } catch (_) {}
    return null;
  }

  function handleStall() {
    if (!watchedVideo || watchedVideo.paused || watchedVideo.ended) {
      return;
    }
    if (watchedVideo.readyState >= 3) {
      return;
    }
    state.stalls += 1;
    state.status = "buffering";
    if (config.stallRecovery && config.selection === "auto") {
      rotateTarget(currentVideoHost());
      state.recoveries += 1;
    }
    renderStatus();
  }

  function onWaiting() {
    if (stallTimer) {
      clearTimeout(stallTimer);
    }
    stallTimer = setTimeout(handleStall, STALL_GRACE_MS);
  }

  function onPlaying() {
    if (stallTimer) {
      clearTimeout(stallTimer);
      stallTimer = null;
    }
    if (state.status === "buffering") {
      state.status = "smooth";
      renderStatus();
    }
  }

  function watchVideo() {
    const video = document.querySelector("video");
    if (!video || video === watchedVideo) {
      return;
    }
    watchedVideo = video;
    video.addEventListener("waiting", onWaiting, { passive: true });
    video.addEventListener("stalled", onWaiting, { passive: true });
    video.addEventListener("playing", onPlaying, { passive: true });
    video.addEventListener("canplay", onPlaying, { passive: true });
  }

  // ---- diagnostics --------------------------------------------------------

  function buildDiagnostics() {
    return {
      version: "0.2.0",
      installedAt: state.installedAt,
      region: regionKey(),
      config,
      status: state.status,
      counters: {
        rewrites: state.rewriteCount,
        stalls: state.stalls,
        recoveries: state.recoveries,
        p2pBlocked: state.p2pBlocked
      },
      ranking: state.ranking,
      probedAt: state.probedAt,
      recentRewrites: state.rewrites.slice(-15)
    };
  }

  // ---- immersive badge handling ------------------------------------------

  function setBadgeHidden(hidden) {
    const host = document.getElementById(BUTTON_ID);
    if (!host) {
      return;
    }
    host.classList.toggle(IMMERSED_CLASS, hidden);
  }

  function panelIsOpen() {
    const host = document.getElementById(BUTTON_ID);
    return !!(host && host.shadowRoot && host.shadowRoot.querySelector(".ba-panel.open"));
  }

  function revealBadge() {
    setBadgeHidden(false);
    if (revealTimer) {
      clearTimeout(revealTimer);
    }
    revealTimer = setTimeout(function () {
      if (immersive && !panelIsOpen()) {
        setBadgeHidden(true);
      }
    }, REVEAL_TIMEOUT);
  }

  function setImmersive(next) {
    if (next === immersive) {
      return;
    }
    immersive = next;
    if (revealTimer) {
      clearTimeout(revealTimer);
      revealTimer = null;
    }
    setBadgeHidden(immersive && !panelIsOpen());
  }

  function detectScreenMode() {
    const container = document.querySelector(".bpx-player-container");
    if (container) {
      const mode = container.getAttribute("data-screen");
      if (mode) {
        return mode;
      }
    }
    if (document.querySelector(".mode-webscreen")) {
      return "web";
    }
    return "normal";
  }

  function setLifted(lifted) {
    const host = document.getElementById(BUTTON_ID);
    if (host) {
      host.classList.toggle(LIFTED_CLASS, lifted);
    }
  }

  function refreshImmersive() {
    const mode = detectScreenMode();
    setLifted(mode === "web" || mode === "full" || mode === "wide");
    setImmersive(mode === "web" || mode === "full");
  }

  function ensurePlayerObserver() {
    const container = document.querySelector(".bpx-player-container");
    if (container && container !== observedContainer) {
      if (playerObserver) {
        playerObserver.disconnect();
      }
      observedContainer = container;
      playerObserver = new MutationObserver(refreshImmersive);
      playerObserver.observe(container, {
        attributes: true,
        attributeFilter: ["data-screen", "class"]
      });
    }
    refreshImmersive();
    watchVideo();
  }

  function handlePointerMove(event) {
    if (!immersive) {
      return;
    }
    const nearRight = (root.innerWidth - event.clientX) < REVEAL_HOTZONE;
    const nearBottom = (root.innerHeight - event.clientY) < REVEAL_HOTZONE;
    if (nearRight && nearBottom) {
      revealBadge();
    }
  }

  function installImmersiveWatch() {
    document.addEventListener("mousemove", handlePointerMove, { passive: true });
    document.addEventListener("fullscreenchange", refreshImmersive);
    document.addEventListener("webkitfullscreenchange", refreshImmersive);
    ensurePlayerObserver();
    setInterval(ensurePlayerObserver, 1500);
  }

  // ---- UI -----------------------------------------------------------------

  const STRINGS = {
    en: {
      title: "Bilibili Accelerator",
      status: {
        off: ["Acceleration off", "Turn it on to speed up slow videos."],
        idle: ["Ready", "Open a video and it'll kick in."],
        optimizing: ["Finding the fastest server…", "Picking the best route for you."],
        buffering: ["Finding a faster server…", "Recovering from a slow connection."],
        smooth: ["Playing smoothly", "Connected to the fastest server near you."]
      },
      count: function (n) { return n + " slow connection" + (n === 1 ? "" : "s") + " fixed"; },
      masterTitle: "Acceleration",
      masterNote: "Speed up slow videos automatically.",
      boost: "Still buffering? Boost harder",
      advShow: "Advanced settings",
      advHide: "Hide advanced",
      fServer: "Server", fWhen: "When", fFixed: "Fixed server", fMcdn: "MCDN",
      selAuto: "Auto (pick fastest)", selFixed: "Use a fixed server",
      modeBad: "Only fix slow servers", modeForce: "Always switch server",
      mcdnAll: "Proxy all MCDN", mcdnV1: "Proxy /v1 only", mcdnReplace: "Replace host",
      portTitle: "Catch hidden PCDN", portNote: "Treat odd-port servers as slow (recommended).",
      stallTitle: "Auto-recover", stallNote: "Switch servers live if it stalls — no reload.",
      akamaiTitle: "Rewrite Akamai", akamaiNote: "Only if Akamai is slow on your network.",
      p2pTitle: "Stop bandwidth sharing", p2pNote: "Block Bilibili's P2P upload (reload to apply).",
      diag: "Copy report", diagCopied: "Copied ✓", diagConsole: "See console",
      reload: "Reload"
    },
    zh: {
      title: "Bilibili Accelerator",
      status: {
        off: ["已关闭加速", "打开后自动为慢视频提速。"],
        idle: ["就绪", "打开视频后自动生效。"],
        optimizing: ["正在寻找最快的服务器…", "正在为你挑选最佳线路。"],
        buffering: ["正在切换更快的服务器…", "正在从卡顿中恢复。"],
        smooth: ["播放流畅", "已连接到离你最近的最快服务器。"]
      },
      count: function (n) { return "已修复 " + n + " 个慢连接"; },
      masterTitle: "加速",
      masterNote: "自动为慢视频提速。",
      boost: "还在卡？再加把劲",
      advShow: "高级设置",
      advHide: "收起高级设置",
      fServer: "服务器", fWhen: "何时", fFixed: "固定服务器", fMcdn: "MCDN",
      selAuto: "自动（选最快）", selFixed: "使用固定服务器",
      modeBad: "仅修复慢服务器", modeForce: "总是切换服务器",
      mcdnAll: "代理所有 MCDN", mcdnV1: "仅代理 /v1", mcdnReplace: "替换域名",
      portTitle: "抓取隐藏 PCDN", portNote: "把奇怪端口的服务器当作慢节点（推荐）。",
      stallTitle: "自动恢复", stallNote: "卡顿时实时切换服务器，无需刷新。",
      akamaiTitle: "改写 Akamai", akamaiNote: "仅当 Akamai 在你的网络上很慢时使用。",
      p2pTitle: "停止带宽共享", p2pNote: "阻止 B 站的 P2P 上传（刷新后生效）。",
      diag: "复制诊断报告", diagCopied: "已复制 ✓", diagConsole: "见控制台",
      reload: "刷新"
    }
  };

  function lang() {
    return config.lang === "zh" ? "zh" : "en";
  }

  function t(key) {
    return STRINGS[lang()][key];
  }

  function getShadow() {
    const host = document.getElementById(BUTTON_ID);
    return host && host.shadowRoot;
  }

  function currentStatusKey() {
    if (!config.enabled) {
      return "off";
    }
    return state.status || "idle";
  }

  // Re-translate every tagged node + the dynamic bits, no reload needed.
  function applyLang() {
    const shadow = getShadow();
    if (!shadow) {
      return;
    }
    shadow.querySelectorAll("[data-i18n]").forEach(function (el) {
      el.textContent = t(el.dataset.i18n);
    });
    const adv = shadow.querySelector(".ba-adv");
    setAdvToggleLabel(adv && adv.classList.contains("open"));
    updateLangButtons();
    renderStatus();
  }

  function updateLangButtons() {
    const shadow = getShadow();
    if (!shadow) {
      return;
    }
    shadow.querySelectorAll(".ba-lang-btn").forEach(function (b) {
      b.classList.toggle("active", b.dataset.lang === lang());
    });
  }

  function setAdvToggleLabel(open) {
    const shadow = getShadow();
    if (!shadow) {
      return;
    }
    const label = shadow.getElementById("ba-adv-label");
    const arrow = shadow.getElementById("ba-adv-arrow");
    if (label) {
      label.textContent = t(open ? "advHide" : "advShow");
    }
    if (arrow) {
      arrow.textContent = open ? "▴" : "▾";
    }
  }

  function makeOption(value, key, selectedValue) {
    const option = document.createElement("option");
    option.value = value;
    option.dataset.i18n = key;
    option.textContent = t(key);
    option.selected = value === selectedValue;
    return option;
  }

  function createSelect(options, value, onChange) {
    const select = document.createElement("select");
    select.className = "ba-control";
    select.addEventListener("change", function () { onChange(select.value); });
    options.forEach(function (option) {
      select.appendChild(makeOption(option.value, option.key, value));
    });
    return select;
  }

  function createField(key, control) {
    const label = document.createElement("label");
    label.className = "ba-field";
    const caption = document.createElement("span");
    caption.dataset.i18n = key;
    caption.textContent = t(key);
    label.appendChild(caption);
    label.appendChild(control);
    return label;
  }

  function createSwitchRow(titleKey, noteKey, checked, onChange) {
    const row = document.createElement("label");
    row.className = "ba-switch-row";
    const copy = document.createElement("span");
    copy.className = "ba-switch-text";
    const titleEl = document.createElement("span");
    titleEl.className = "ba-switch-title";
    titleEl.dataset.i18n = titleKey;
    titleEl.textContent = t(titleKey);
    const noteEl = document.createElement("span");
    noteEl.className = "ba-switch-note";
    noteEl.dataset.i18n = noteKey;
    noteEl.textContent = t(noteKey);
    copy.appendChild(titleEl);
    copy.appendChild(noteEl);
    const sw = document.createElement("span");
    sw.className = "ba-switch";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = checked;
    input.addEventListener("change", function () { onChange(input.checked); });
    const slider = document.createElement("span");
    slider.className = "ba-slider";
    sw.appendChild(input);
    sw.appendChild(slider);
    row.appendChild(copy);
    row.appendChild(sw);
    return row;
  }

  function renderStatus() {
    const host = document.getElementById(BUTTON_ID);
    const shadow = host && host.shadowRoot;
    if (!shadow) {
      return;
    }
    const key = currentStatusKey();
    const strings = STRINGS[lang()];
    const info = strings.status[key] || strings.status.idle;

    const dot = shadow.getElementById("ba-dot");
    const word = shadow.getElementById("ba-word");
    const note = shadow.getElementById("ba-note");
    const count = shadow.getElementById("ba-count");
    const boost = shadow.getElementById("ba-boost");
    const master = shadow.getElementById("ba-master");

    if (dot) {
      dot.className = "ba-dot ba-" + key;
    }
    if (word) {
      word.textContent = info[0];
    }
    if (note) {
      note.textContent = info[1];
    }
    if (count) {
      count.textContent = strings.count(state.rewriteCount);
    }
    if (master) {
      master.checked = config.enabled;
    }
    if (boost) {
      // Surface "boost harder" only when relevant: still on bad-only and the
      // user is hitting buffering.
      const relevant = config.enabled && config.mode !== "force" &&
        (key === "buffering" || state.stalls > 0);
      boost.style.display = relevant ? "block" : "none";
    }
  }

  function installUi() {
    if (!document.documentElement || document.getElementById(BUTTON_ID)) {
      return;
    }

    const host = document.createElement("div");
    host.id = BUTTON_ID;
    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = [
      ":host{position:fixed;right:18px;bottom:18px;z-index:2147483647;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#17202a;transition:opacity .25s ease}",
      ":host(.ba-immersed){opacity:0;pointer-events:none}",
      ":host(.ba-lifted){bottom:84px}",
      "*{box-sizing:border-box}",
      "button,input,select{font:inherit}",
      ".ba-toggle{display:grid;place-items:center;width:40px;height:40px;border:1px solid rgba(255,255,255,.4);border-radius:50%;background:linear-gradient(135deg,#00b5f5,#0091cc);color:#fff;box-shadow:0 8px 22px rgba(0,174,236,.42),0 1px 0 rgba(255,255,255,.45) inset;cursor:pointer;padding:0;transition:transform .16s ease,box-shadow .16s ease}",
      ".ba-toggle:hover{transform:translateY(-1px)}",
      ".ba-toggle svg{width:20px;height:20px;display:block}",
      ".ba-panel{display:none;flex-direction:column;position:absolute;right:0;bottom:48px;width:min(340px,calc(100vw - 36px));max-height:calc(100vh - 96px);padding:16px;border:1px solid rgba(23,32,42,.12);border-radius:14px;background:rgba(255,255,255,.97);box-shadow:0 18px 46px rgba(21,32,43,.24);backdrop-filter:saturate(180%) blur(18px);-webkit-backdrop-filter:saturate(180%) blur(18px)}",
      ".ba-panel.open{display:flex}",
      ".ba-body{overflow-y:auto;min-height:0}",
      ".ba-head{display:flex;align-items:center;gap:8px;margin-bottom:14px}",
      ".ba-head svg{width:18px;height:18px;color:#00aeec;flex:0 0 auto}",
      ".ba-title{font-size:14px;font-weight:800;margin:0;color:#111827}",
      ".ba-lang{margin-left:auto;display:inline-flex;border:1px solid #d5dde5;border-radius:8px;overflow:hidden;flex:0 0 auto}",
      ".ba-lang-btn{border:none;background:#fff;color:#6b7785;font-size:11px;font-weight:700;padding:4px 10px;cursor:pointer;line-height:1.4}",
      ".ba-lang-btn+.ba-lang-btn{border-left:1px solid #e5eaf0}",
      ".ba-lang-btn.active{background:#00aeec;color:#fff}",
      ".ba-hero{display:flex;flex-direction:column;align-items:center;text-align:center;padding:4px 0 14px}",
      ".ba-dot{width:46px;height:46px;border-radius:50%;display:grid;place-items:center;margin-bottom:8px;background:#eef2f6}",
      ".ba-dot:after{content:'';width:14px;height:14px;border-radius:50%;background:#9aa6b2}",
      ".ba-dot.ba-smooth{background:#e6f8ee}.ba-dot.ba-smooth:after{background:#19a974}",
      ".ba-dot.ba-optimizing,.ba-dot.ba-buffering{background:#fff4e0}.ba-dot.ba-optimizing:after,.ba-dot.ba-buffering:after{background:#e8910c}",
      ".ba-dot.ba-off:after{background:#9aa6b2}",
      ".ba-word{font-size:15px;font-weight:800;color:#1b2733}",
      ".ba-subnote{font-size:11px;color:#6b7785;margin-top:2px;line-height:1.4}",
      ".ba-count{font-size:11px;color:#8a95a1;margin-top:6px}",
      ".ba-switch-row{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:8px 0;padding:10px 12px;border:1px solid #e5eaf0;border-radius:10px;background:#fff}",
      ".ba-switch-text{display:grid;gap:2px}",
      ".ba-switch-title{font-size:13px;font-weight:750;color:#202a33}",
      ".ba-switch-note{font-size:11px;color:#6b7785;line-height:1.3}",
      ".ba-switch{position:relative;display:inline-flex;width:42px;height:24px;flex:0 0 auto}",
      ".ba-switch input{position:absolute;opacity:0;width:1px;height:1px}",
      ".ba-slider{position:absolute;inset:0;border-radius:999px;background:#c9d3dd;cursor:pointer;transition:background .16s ease}",
      ".ba-slider:before{content:'';position:absolute;width:20px;height:20px;left:2px;top:2px;border-radius:50%;background:#fff;box-shadow:0 2px 6px rgba(0,0,0,.22);transition:transform .16s ease}",
      ".ba-switch input:checked+.ba-slider{background:#00aeec}",
      ".ba-switch input:checked+.ba-slider:before{transform:translateX(18px)}",
      ".ba-boost{display:none;width:100%;height:38px;margin-top:4px;border:1px solid #00aeec;border-radius:10px;background:#00aeec;color:#fff;font-size:13px;font-weight:700;cursor:pointer}",
      ".ba-boost:hover{background:#0099cf}",
      ".ba-adv-toggle{display:flex;align-items:center;justify-content:center;gap:5px;width:100%;flex:0 0 auto;margin-top:10px;padding-top:11px;border:none;border-top:1px solid #eef1f4;background:none;color:#6b7785;font-size:11px;font-weight:650;cursor:pointer}",
      ".ba-adv-toggle:hover{color:#00aeec}",
      ".ba-adv{display:none;margin-top:8px}",
      ".ba-adv.open{display:block}",
      ".ba-field{display:grid;grid-template-columns:96px 1fr;align-items:center;gap:9px;margin:9px 0;font-size:12px}",
      ".ba-field span{color:#46515c;font-weight:650}",
      ".ba-control,.ba-field input[type=text],.ba-field select{width:100%;min-width:0;height:32px;border:1px solid #d5dde5;border-radius:8px;padding:0 9px;background:#fff;color:#17202a;outline:none;font-size:11px}",
      ".ba-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:12px}",
      ".ba-actions button{height:32px;border:1px solid #d5dde5;border-radius:8px;background:#fff;color:#25313d;padding:0 11px;cursor:pointer;font-size:12px;font-weight:700}",
      ".ba-actions button.primary{border-color:#00aeec;background:#00aeec;color:#fff}",
      ".ba-mini{font-size:11px;color:#6b7785;margin:8px 0 0;line-height:1.4}"
    ].join("");

    const toggle = document.createElement("button");
    toggle.className = "ba-toggle";
    toggle.type = "button";
    toggle.title = "Bilibili Accelerator";
    toggle.setAttribute("aria-label", "Bilibili Accelerator");
    toggle.innerHTML = "<svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path fill=\"currentColor\" d=\"M13 2 4 14h7l-1 8 10-13h-7l1-7Z\"/></svg>";
    toggle.addEventListener("mouseenter", function () { if (immersive) { revealBadge(); } });

    const panel = document.createElement("section");
    panel.className = "ba-panel";
    panel.id = PANEL_ID;

    // Header
    const head = document.createElement("div");
    head.className = "ba-head";
    head.innerHTML = "<svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path fill=\"currentColor\" d=\"M13 2 4 14h7l-1 8 10-13h-7l1-7Z\"/></svg>";
    const title = document.createElement("p");
    title.className = "ba-title";
    title.dataset.i18n = "title";
    title.textContent = t("title");
    head.appendChild(title);

    // Language toggle (upper-right). Defaults to English.
    const langWrap = document.createElement("div");
    langWrap.className = "ba-lang";
    [["en", "EN"], ["zh", "中"]].forEach(function (pair) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "ba-lang-btn";
      b.dataset.lang = pair[0];
      b.textContent = pair[1];
      b.addEventListener("click", function () {
        if (config.lang === pair[0]) {
          return;
        }
        saveConfig(Object.assign({}, config, { lang: pair[0] }));
        applyLang();
      });
      langWrap.appendChild(b);
    });
    head.appendChild(langWrap);

    // Hero status
    const hero = document.createElement("div");
    hero.className = "ba-hero";
    const dot = document.createElement("div");
    dot.id = "ba-dot";
    dot.className = "ba-dot";
    const word = document.createElement("div");
    word.id = "ba-word";
    word.className = "ba-word";
    const subnote = document.createElement("div");
    subnote.id = "ba-note";
    subnote.className = "ba-subnote";
    const count = document.createElement("div");
    count.id = "ba-count";
    count.className = "ba-count";
    hero.appendChild(dot);
    hero.appendChild(word);
    hero.appendChild(subnote);
    hero.appendChild(count);

    // Master switch
    const master = createSwitchRow("masterTitle", "masterNote",
      config.enabled, function (checked) {
        saveConfig(Object.assign({}, config, { enabled: checked }));
        if (!checked) {
          state.status = "off";
        } else if (state.status === "off") {
          state.status = "idle";
        }
        renderStatus();
      });
    master.querySelector("input").id = "ba-master";

    // Contextual boost
    const boost = document.createElement("button");
    boost.id = "ba-boost";
    boost.className = "ba-boost";
    boost.type = "button";
    boost.dataset.i18n = "boost";
    boost.textContent = t("boost");
    boost.addEventListener("click", function () {
      saveConfig(Object.assign({}, config, { mode: "force" }));
      recovery.avoidHost = currentVideoHost();
      renderStatus();
      root.location.reload();
    });

    // Advanced toggle (pinned at panel bottom) + section. Keeping the toggle as
    // the bottom-most element means expanding grows the panel upward while the
    // toggle stays under the cursor — click to expand, click again to collapse.
    const adv = document.createElement("div");
    adv.className = "ba-adv";
    const advToggle = document.createElement("button");
    advToggle.className = "ba-adv-toggle";
    advToggle.id = "ba-adv-toggle";
    advToggle.type = "button";
    advToggle.innerHTML = "<span id=\"ba-adv-label\"></span><span id=\"ba-adv-arrow\">▾</span>";
    advToggle.addEventListener("click", function () {
      const open = adv.classList.toggle("open");
      setAdvToggleLabel(open);
    });

    const selection = createSelect([
      { value: "auto", key: "selAuto" },
      { value: "fixed", key: "selFixed" }
    ], config.selection, function (value) {
      saveConfig(Object.assign({}, config, { selection: value }));
    });

    const mode = createSelect([
      { value: "bad-only", key: "modeBad" },
      { value: "force", key: "modeForce" }
    ], config.mode, function (value) {
      saveConfig(Object.assign({}, config, { mode: value }));
      renderStatus();
    });

    const hostInput = document.createElement("input");
    hostInput.type = "text";
    hostInput.className = "ba-control";
    hostInput.value = config.pcdnHost;
    hostInput.setAttribute("list", "ba-hosts");
    hostInput.addEventListener("change", function () {
      saveConfig(Object.assign({}, config, { pcdnHost: hostInput.value }));
    });
    const hostList = document.createElement("datalist");
    hostList.id = "ba-hosts";
    core.CDN_HOSTS.forEach(function (h) {
      const option = document.createElement("option");
      option.value = h;
      hostList.appendChild(option);
    });

    const mcdn = createSelect([
      { value: "proxy-all", key: "mcdnAll" },
      { value: "proxy-v1", key: "mcdnV1" },
      { value: "replace", key: "mcdnReplace" }
    ], config.mcdnStrategy, function (value) {
      saveConfig(Object.assign({}, config, { mcdnStrategy: value }));
    });

    const portRow = createSwitchRow("portTitle", "portNote",
      config.portHeuristic, function (checked) {
        saveConfig(Object.assign({}, config, { portHeuristic: checked }));
      });

    const stallRow = createSwitchRow("stallTitle", "stallNote",
      config.stallRecovery, function (checked) {
        saveConfig(Object.assign({}, config, { stallRecovery: checked }));
      });

    const akamaiRow = createSwitchRow("akamaiTitle", "akamaiNote",
      config.rewriteAkamai, function (checked) {
        saveConfig(Object.assign({}, config, { rewriteAkamai: checked }));
      });

    const p2pRow = createSwitchRow("p2pTitle", "p2pNote",
      config.p2pGuard, function (checked) {
        saveConfig(Object.assign({}, config, { p2pGuard: checked }));
      });

    const diag = document.createElement("button");
    diag.type = "button";
    diag.dataset.i18n = "diag";
    diag.textContent = t("diag");
    diag.addEventListener("click", function () {
      const text = JSON.stringify(buildDiagnostics(), null, 2);
      try {
        root.navigator.clipboard.writeText(text);
        diag.textContent = t("diagCopied");
        setTimeout(function () { diag.textContent = t("diag"); }, 1500);
      } catch (_) {
        console.info("[BiliAccelerator] diagnostics", text);
        diag.textContent = t("diagConsole");
      }
    });

    const reload = document.createElement("button");
    reload.type = "button";
    reload.className = "primary";
    reload.dataset.i18n = "reload";
    reload.textContent = t("reload");
    reload.addEventListener("click", function () { root.location.reload(); });

    const actions = document.createElement("div");
    actions.className = "ba-actions";
    actions.appendChild(diag);
    actions.appendChild(reload);

    adv.appendChild(createField("fServer", selection));
    adv.appendChild(createField("fWhen", mode));
    adv.appendChild(createField("fFixed", hostInput));
    adv.appendChild(hostList);
    adv.appendChild(createField("fMcdn", mcdn));
    adv.appendChild(portRow);
    adv.appendChild(stallRow);
    adv.appendChild(akamaiRow);
    adv.appendChild(p2pRow);
    adv.appendChild(actions);

    // Scrollable body holds everything; the advanced toggle is pinned below it
    // as a footer so it never moves when the section expands.
    const body = document.createElement("div");
    body.className = "ba-body";
    body.appendChild(head);
    body.appendChild(hero);
    body.appendChild(master);
    body.appendChild(boost);
    body.appendChild(adv);

    panel.appendChild(body);
    panel.appendChild(advToggle);

    function closePanel() {
      if (!panel.classList.contains("open")) {
        return;
      }
      panel.classList.remove("open");
      if (immersive) {
        revealBadge();
      }
    }

    toggle.addEventListener("click", function () {
      panel.classList.toggle("open");
      renderStatus();
      if (!immersive) {
        return;
      }
      if (panel.classList.contains("open")) {
        if (revealTimer) {
          clearTimeout(revealTimer);
          revealTimer = null;
        }
        setBadgeHidden(false);
      } else {
        revealBadge();
      }
    });

    document.addEventListener("click", function (event) {
      if (!panel.classList.contains("open")) {
        return;
      }
      const path = typeof event.composedPath === "function" ? event.composedPath() : [];
      if (path.indexOf(host) !== -1 || event.target === host) {
        return;
      }
      closePanel();
    });

    shadow.appendChild(style);
    shadow.appendChild(panel);
    shadow.appendChild(toggle);
    document.documentElement.appendChild(host);
    applyLang();
  }

  // ---- external config bridge (extension popup → page) -------------------

  function installConfigBridge() {
    if (typeof root.addEventListener !== "function") {
      return;
    }
    root.addEventListener("message", function (event) {
      if (event.source !== root) {
        return;
      }
      const data = event.data;
      if (data && data.__biliAccel === "config" && data.config) {
        saveConfig(Object.assign({}, config, data.config));
        applyLang();
      }
    });
  }

  root.BiliAccelerator = {
    getConfig: function () { return Object.assign({}, config); },
    setConfig: function (next) { saveConfig(Object.assign({}, config, next || {})); renderStatus(); return this.getConfig(); },
    getStats: function () { return JSON.parse(JSON.stringify(state)); },
    getDiagnostics: function () { return buildDiagnostics(); },
    rewriteUrl: function (url) { return core.rewriteUrl(url, config); }
  };

  applyRanking(loadRanking());
  patchJsonParse();
  patchFetch();
  patchXHR();
  patchGlobalPlayInfo("__playinfo__");
  patchGlobalPlayInfo("__INITIAL_STATE__");
  installP2PGuard();
  installConfigBridge();

  function bootstrapUi() {
    installUi();
    installImmersiveWatch();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootstrapUi, { once: true });
  } else {
    bootstrapUi();
  }

  console.info("[BiliAccelerator] installed", root.BiliAccelerator.getConfig());
})(typeof globalThis !== "undefined" ? globalThis : window);

