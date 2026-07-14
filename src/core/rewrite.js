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

  // P2P/PCDN families known from community research (Bilibili-Evolved, MBGTEB):
  // szbdyd is the legacy scheduler, mountaintoys the 2025 rename, nexusedgeio and
  // ahdohpiechei are where the upos-*302* redirect hosts land, and mirror14b is a
  // mirror-named host that actually serves PCDN (its TLS cert is *.bilivideo.cn).
  const KNOWN_P2P_SUFFIXES = Object.freeze([
    ".szbdyd.com",
    ".mountaintoys.cn",
    ".nexusedgeio.com",
    ".ahdohpiechei.com"
  ]);
  const KNOWN_P2P_HOSTS = Object.freeze([
    "upos-sz-mirror14b.bilivideo.com"
  ]);

  function isKnownP2pHost(hostname) {
    if (KNOWN_P2P_HOSTS.indexOf(hostname) !== -1) {
      return true;
    }
    for (let i = 0; i < KNOWN_P2P_SUFFIXES.length; i += 1) {
      if (hostname.length > KNOWN_P2P_SUFFIXES[i].length &&
          hostname.indexOf(KNOWN_P2P_SUFFIXES[i]) === hostname.length - KNOWN_P2P_SUFFIXES[i].length) {
        return true;
      }
    }
    // upos-sz-302ppio / upos-sz-302kodo style hosts answer with an HTTP 302 to a
    // residential P2P node; the "302" only ever appears in that first label.
    return hostname.indexOf("upos-") === 0 && hostname.split(".")[0].indexOf("302") !== -1;
  }

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
        value.includes("mountaintoys") ||
        value.includes("nexusedgeio") ||
        value.includes("ahdohpiechei") ||
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
      // Payloads occasionally carry protocol-relative URLs ("//host/path").
      const url = new URL(value.slice(0, 2) === "//" ? "https:" + value : value);
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

  // Live streams (/live-bvc/ FLV & HLS) are served by a separate CDN tier — the
  // VOD upos mirrors and the MCDN proxy cannot serve them, so a host swap or
  // proxy wrap would hard-break live playback. Live PCDN is handled upstream by
  // filtering the getRoomPlayInfo host list instead (see filterLiveUrlInfo).
  function isLiveMediaUrl(url) {
    return url.pathname.indexOf("/live-bvc/") !== -1;
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
    const knownP2p = isKnownP2pHost(hostname);

    const isPcdn = ipLike || xyMcdn || portPcdn || queryMcdn || knownP2p;

    let kind = "unknown";
    if (schedulerSource !== null || hostname.endsWith(".szbdyd.com")) {
      kind = "scheduler";
    } else if (mcdn) {
      kind = "mcdn";
    } else if (isPcdn) {
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

    if (isLiveMediaUrl(url)) {
      return { changed: false, original, url: original, reason: "live-skip" };
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
    if (!url || !isMediaUrl(url) || isLiveMediaUrl(url)) {
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

  // Convert a transferred byte count over a duration into megabits per second.
  // Pure so the speed meter's math stays unit-tested.
  function throughputMbps(bytes, durationMs) {
    if (!(bytes > 0) || !(durationMs > 0)) {
      return 0;
    }
    return (bytes * 8 / 1e6) / (durationMs / 1000);
  }

  // Total length of a set of [start, end] intervals with overlaps merged, so
  // two segments downloaded in parallel count their shared time only once.
  function unionDurationMs(intervals) {
    if (!intervals || !intervals.length) {
      return 0;
    }
    const sorted = intervals.slice().sort(function byStart(a, b) {
      return a[0] - b[0];
    });
    let total = 0;
    let curStart = sorted[0][0];
    let curEnd = sorted[0][1];
    for (let i = 1; i < sorted.length; i += 1) {
      const s = sorted[i][0];
      const e = sorted[i][1];
      if (s > curEnd) {
        total += curEnd - curStart;
        curStart = s;
        curEnd = e;
      } else if (e > curEnd) {
        curEnd = e;
      }
    }
    total += curEnd - curStart;
    return total;
  }

  // Aggregate "active" throughput: bytes moved per second of time actually spent
  // transferring, measured over the trailing `windowMs`. Unlike dividing by
  // wall-clock, idle gaps between the player's burst downloads don't drag the
  // rate to zero — this reflects the link's real capacity. Bytes from transfers
  // straddling the window edge are prorated to the in-window fraction, and the
  // active time is the union of all transfer intervals (parallel video+audio
  // segments count their overlap once). transfers: [{ start, end, bytes }] in ms.
  function aggregateThroughput(transfers, now, windowMs) {
    if (!transfers || !transfers.length || !(windowMs > 0)) {
      return 0;
    }
    const windowStart = now - windowMs;
    let bytes = 0;
    const intervals = [];
    for (let i = 0; i < transfers.length; i += 1) {
      const tr = transfers[i];
      if (!tr || !(tr.bytes > 0) || !(tr.end > tr.start)) {
        continue;
      }
      const s = Math.max(tr.start, windowStart);
      const e = Math.min(tr.end, now);
      if (e <= s) {
        continue;
      }
      bytes += tr.bytes * ((e - s) / (tr.end - tr.start));
      intervals.push([s, e]);
    }
    return throughputMbps(bytes, unionDurationMs(intervals));
  }

  // Bare host[:port] of a URL, for diagnostics that must never carry the query
  // string — segment URLs pack the viewer's mid, buvid, IP-derived oi and signed
  // access tokens there, and the report is meant to be shared. "" on failure.
  function hostOf(value) {
    try {
      return new URL(String(value)).host;
    } catch (_) {
      return "";
    }
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

  // Live playurl payloads (getRoomPlayInfo) don't carry full media URLs — each
  // stream/format/codec entry lists candidate hosts in url_info: [{host, extra}].
  // A host like "https://xy…xy.mcdn.bilivideo.cn:486" is a residential PCDN node;
  // slow for overseas viewers. This decides "is this live host slow" from the
  // same behavioral signals as classify(), minus the media-path requirement.
  function isSlowLiveHost(hostValue, extra, rawConfig) {
    const config = normalizeConfig(rawConfig);
    const raw = String(hostValue || "");
    let url;
    try {
      url = new URL(raw.indexOf("://") !== -1 ? raw : "https://" + raw.replace(/^\/\//, ""));
    } catch (_) {
      return false;
    }
    const hostname = url.hostname.toLowerCase();
    if (IP_RE.test(hostname) || XY_MCDN_RE.test(hostname) ||
        isMcdnHost(hostname) || isKnownP2pHost(hostname)) {
      return true;
    }
    if (config.portHeuristic && hasNonDefaultPort(url)) {
      return true;
    }
    return typeof extra === "string" && /(?:^|[?&])os=mcdn(?:&|$)/i.test(extra);
  }

  // Drop PCDN/MCDN entries from live url_info host lists, keeping the official
  // CDN entries the player can fail over to. Never removes the last usable host:
  // if every entry looks slow, the list is left untouched. Returns rewrite-shaped
  // entries ({original, url, reason}) so callers can log them like URL rewrites.
  function filterLiveUrlInfo(payload, rawConfig, depth, seen) {
    const config = normalizeConfig(rawConfig);
    const level = depth || 0;
    const visited = seen || new WeakSet();
    const result = { changed: false, rewrites: [] };

    if (!config.enabled || config.mode === "off" ||
        payload == null || typeof payload !== "object" ||
        level > config.maxDepth || visited.has(payload)) {
      return result;
    }
    visited.add(payload);

    const list = payload.url_info;
    if (Array.isArray(list) && list.length > 1 &&
        list.every(function (item) { return item && typeof item.host === "string"; })) {
      const kept = list.filter(function (item) {
        return !isSlowLiveHost(item.host, item.extra, config);
      });
      if (kept.length > 0 && kept.length < list.length) {
        list.forEach(function (item) {
          if (kept.indexOf(item) === -1) {
            result.rewrites.push({
              changed: true,
              original: item.host,
              url: kept[0].host,
              reason: "live-pcdn-filter"
            });
          }
        });
        list.length = 0;
        kept.forEach(function (item) { list.push(item); });
        result.changed = true;
      }
    }

    const keys = Array.isArray(payload)
      ? payload.map(function (_, i) { return i; })
      : Object.keys(payload);
    for (let i = 0; i < keys.length; i += 1) {
      const child = filterLiveUrlInfo(payload[keys[i]], config, level + 1, visited);
      if (child.changed) {
        result.changed = true;
        result.rewrites = result.rewrites.concat(child.rewrites);
      }
    }
    return result;
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
    isSlowLiveHost,
    filterLiveUrlInfo,
    selectTarget,
    alternativesFor,
    throughputMbps,
    unionDurationMs,
    aggregateThroughput,
    hostOf,
    rankHosts,
    rewriteJsonText,
    rewriteObject,
    rewriteUrl,
    rewriteUrlDetail
  };
});
