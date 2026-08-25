(function initBiliAcceleratorCore(root, factory) {
  const core = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = core;
  }

  root.BiliAcceleratorCore = core;
})(typeof globalThis !== "undefined" ? globalThis : window, function createCore() {
  "use strict";

  const SCHEMA_VERSION = 3;

  // Healthy UPOS mirrors we are willing to rewrite toward. The default target
  // is DEFAULT_CONFIG.pcdnHost and the auto-selection pool is CANDIDATE_POOL;
  // this list is the wider allowlist, and its first entry is only the last-ditch
  // fallback for a config whose pcdnHost has somehow been emptied.
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

  // Panel appearance options. Keys only — the actual accent hexes and dark/light
  // surface tokens live in the page UI; core just owns the allowed values so a
  // stored or bridged config can be validated back to a known-good default.
  const ACCENT_KEYS = Object.freeze([
    "bili",     // Bilibili blue (default — unchanged for existing users)
    "teal",
    "emerald",
    "violet",
    "pink",     // Little-TV pink
    "sunset",
    "graphite"
  ]);
  const THEME_MODES = Object.freeze(["system", "light", "dark"]);

  // Candidates that are safe to auto-probe and rank as rewrite targets. Akamai
  // is excluded: it rejects a upos-signed path with 403, so it can never win a
  // probe and only wastes a slot.
  //
  // Both tiers belong here and the probe decides between them; the order below
  // only sets the pre-probe preference. Overseas leads because that is this
  // tool's audience — measured from Seattle, re-requesting the same signed
  // segment on each host gave 33-70 Mbps for the *ov mirrors against 3-20 for
  // mainland, so a mainland-only pool made every rotation a large downgrade off
  // the host Bilibili had already picked correctly.
  //
  // Do not read that as "overseas is always right". The reporter in #26 watches
  // from Tokyo and measured mirrorcosov as no slower than mainland mirrorcos —
  // their v0.3.0 ranking put mirrorcos first, but that was a mainland-only pool
  // scored on TTFB, so it never measured an *ov host and is not evidence either
  // way. Probing the whole pool is what settles it per viewer. Baking either
  // geography into this list is the bug, not the fix.
  const CANDIDATE_POOL = Object.freeze([
    "upos-sz-mirrorcosov.bilivideo.com",
    "upos-sz-mirroraliov.bilivideo.com",
    "upos-sz-mirrorhwov.bilivideo.com",
    "upos-sz-mirrorali.bilivideo.com",
    "upos-tf-all-hw.bilivideo.com",
    "upos-sz-mirrorhw.bilivideo.com",
    "upos-sz-mirrorcos.bilivideo.com",
    "upos-tf-all-tx.bilivideo.com"
  ]);

  const DEFAULT_CONFIG = Object.freeze({
    enabled: true,
    lang: "en",                                    // en | zh (UI language)
    accent: "bili",                                // panel accent (see ACCENT_KEYS)
    theme: "system",                               // system | light | dark surface
    mode: "bad-only",                              // bad-only | force | off
    selection: "auto",                             // auto | fixed
    // Pre-probe rewrite target. Overseas by default to match the audience; auto
    // selection replaces it with the best-ranked host once probing finishes.
    pcdnHost: "upos-sz-mirrorcosov.bilivideo.com",
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

  // Forward-migrate any stored config (v1 or partial) onto the current defaults.
  function normalizeConfig(config) {
    // Read the version off the raw input: the merge below backfills it from
    // DEFAULT_CONFIG, which would make every stored config look current.
    const storedVersion = config && config.schemaVersion;
    const merged = Object.assign({}, DEFAULT_CONFIG, config || {});

    // v3 widened the candidate pool to take in the overseas mirrors. The pool is
    // not user-editable, so a stored copy is only ever an older default — and
    // since a non-empty array satisfies the check below, leaving it alone would
    // pin existing installs to the mainland-only pool permanently.
    if (!(storedVersion >= 3)) {
      merged.candidatePool = CANDIDATE_POOL.slice();
      // Retire the old default target, which auto mode would otherwise keep
      // using until its first probe lands. Narrow on purpose: only a config
      // that carries an older version is a saved one, so an explicit host from
      // a partial/ad-hoc config is never second-guessed. A host the user pinned
      // is left alone too — in auto mode it is ephemeral anyway, since
      // applyRanking overwrites it as soon as probing finishes.
      if (typeof storedVersion === "number" && merged.selection !== "fixed" &&
          cleanHost(merged.pcdnHost) === "upos-sz-mirrorcos.bilivideo.com") {
        merged.pcdnHost = DEFAULT_CONFIG.pcdnHost;
      }
    }

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
    if (ACCENT_KEYS.indexOf(merged.accent) === -1) {
      merged.accent = DEFAULT_CONFIG.accent;
    }
    if (THEME_MODES.indexOf(merged.theme) === -1) {
      merged.theme = DEFAULT_CONFIG.theme;
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

  // String-level version of the check above, for callers that hold a raw value
  // rather than a parsed URL. Deliberately independent of parseUrl: the marker
  // alone is decisive, so a live path that arrives without a host (live payloads
  // carry base_url as a bare path) still answers true instead of falling through
  // as "not live".
  function isLiveUrl(value) {
    const raw = String(value || "");
    if (raw.indexOf("/live-bvc/") === -1) {
      return false;
    }
    try {
      return isLiveMediaUrl(new URL(raw.slice(0, 2) === "//" ? "https:" + raw : raw));
    } catch (_) {
      return true;
    }
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

    // Only genuinely bad hosts are "slow": P2P/PCDN families, plus Akamai when a
    // user explicitly opts in. Bilibili's overseas UPOS mirrors (mirrorcosov /
    // mirroraliov / mirrorhwov) are deliberately NOT slow — this tool is for
    // overseas viewers, and those mirrors are the geographically-correct, fast
    // hosts for them. Rewriting them to a mainland host built a thin forward
    // buffer that Safari's background-tab throttling then starved into a stall.
    const isSlow = isPcdn || (config.rewriteAkamai && akamai);

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

    // Force mode rewrites every bili CDN host onto the selected target, overseas
    // mirrors included. An earlier revision carved the *ov mirrors out, because
    // force mode was seen rewriting mirrorcosov onto a mainland mirror the probe
    // had mis-ranked first. The mis-ranking was the bug — TTFB scoring over a
    // mainland-only pool — and it is fixed. Ranking on measured throughput over
    // both tiers means the target here is the host that actually tested fastest
    // for this viewer, which is exactly what force mode is asked to do.
    //
    // The carve-out also had to go because stall recovery reaches force mode
    // through recovery.avoidHost. While it stood, a stalling *ov host could not
    // be routed away from at all: recovery counted a rotation, rewrote nothing,
    // and the panel reported a switch that never happened.
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

  // Pure ranking of probed hosts. samples: [{host, ttfb:number|null,
  // mbps?:number, ok:bool}]. Healthy hosts first; failures sink to the bottom.
  //
  // Transfer rate decides when it was measured, and TTFB only breaks ties. Time
  // to first byte is mostly RTT, and on these hosts it swings about tenfold
  // between back-to-back samples of the same host — ranking on it let a mainland
  // mirror that answered headers promptly outrank an overseas one that actually
  // moves 3-4x the bytes. What a stalling player needs is sustained throughput.
  function rankHosts(samples) {
    return (samples || [])
      .slice()
      .sort(function compare(a, b) {
        const aOk = a.ok && (typeof a.mbps === "number" || typeof a.ttfb === "number");
        const bOk = b.ok && (typeof b.mbps === "number" || typeof b.ttfb === "number");
        if (aOk !== bOk) {
          return aOk ? -1 : 1;
        }
        if (!aOk) {
          return 0;
        }
        const aRate = typeof a.mbps === "number" ? a.mbps : 0;
        const bRate = typeof b.mbps === "number" ? b.mbps : 0;
        if (aRate !== bRate) {
          return bRate - aRate;
        }
        const aLat = typeof a.ttfb === "number" ? a.ttfb : Infinity;
        const bLat = typeof b.ttfb === "number" ? b.ttfb : Infinity;
        return aLat - bLat;
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

  // Same verdict for a live entry that carries a whole signed URL instead of a
  // bare host — the legacy playUrl `durl` shape. host includes the port, which
  // the port heuristic needs, and the URL's own query is where os=mcdn lands.
  function isSlowLiveDurlEntry(value, config) {
    try {
      const url = new URL(String(value));
      return isSlowLiveHost(url.host, url.search, config);
    } catch (_) {
      return false;
    }
  }

  // Drop the entries `isSlow` marks, in place, unless that would empty the list:
  // a live payload whose every candidate looks slow is left alone, because a
  // slow stream still plays and no stream at all does not. Returns the dropped
  // entries ([] when nothing was), so callers can log them.
  function dropSlowLiveEntries(list, isSlow) {
    const kept = list.filter(function (item) { return !isSlow(item); });
    if (kept.length === 0 || kept.length === list.length) {
      return [];
    }
    const dropped = list.filter(function (item) { return kept.indexOf(item) === -1; });
    list.length = 0;
    kept.forEach(function (item) { list.push(item); });
    return dropped;
  }

  // Drop PCDN/MCDN entries from a live payload's candidate list, keeping the
  // official CDN entries the player can fail over to. Never removes the last
  // usable host: if every entry looks slow, the list is left untouched. Returns
  // rewrite-shaped entries ({original, url, reason}) so callers can log them
  // like URL rewrites, plus `live`: whether a live candidate list was seen at
  // all. Filtering is the only lever live playback has — live URLs are signed
  // per host, so rewriteUrlDetail cannot move a live stream anywhere (see
  // isLiveMediaUrl) — and `live` is what lets the UI say so instead of waiting
  // on a VOD rewrite that will never come.
  //
  // Two payload shapes carry that list. getRoomPlayInfo splits it into
  // url_info: [{host, extra}] beside a path-only base_url; the legacy
  // /room/v1/Room/playUrl returns durl: [{url}] with complete signed URLs. Only
  // the first was handled here, so a viewer on the legacy shape kept whatever
  // residential PCDN node Bilibili picked.
  function filterLiveUrlInfo(payload, rawConfig, depth, seen) {
    const config = normalizeConfig(rawConfig);
    const level = depth || 0;
    const visited = seen || new WeakSet();
    const result = { changed: false, live: false, rewrites: [] };

    if (!config.enabled || config.mode === "off" ||
        payload == null || typeof payload !== "object" ||
        level > config.maxDepth || visited.has(payload)) {
      return result;
    }
    visited.add(payload);

    const list = payload.url_info;
    if (Array.isArray(list) && list.length > 0 &&
        list.every(function (item) { return item && typeof item.host === "string"; })) {
      result.live = true;
      const dropped = dropSlowLiveEntries(list, function (item) {
        return isSlowLiveHost(item.host, item.extra, config);
      });
      dropped.forEach(function (item) {
        result.rewrites.push({
          changed: true,
          original: item.host,
          url: list[0].host,
          reason: "live-pcdn-filter"
        });
      });
      result.changed = result.changed || dropped.length > 0;
    }

    // Only a list whose every entry is a live URL: a VOD durl carries
    // /upgcxcode/ URLs that rewriteUrlDetail already handles by host swap, and
    // dropping entries from it would take away the player's own fallbacks.
    const durl = payload.durl;
    if (Array.isArray(durl) && durl.length > 0 &&
        durl.every(function (item) {
          return item && typeof item.url === "string" && isLiveUrl(item.url);
        })) {
      result.live = true;
      const dropped = dropSlowLiveEntries(durl, function (item) {
        return isSlowLiveDurlEntry(item.url, config);
      });
      dropped.forEach(function (item) {
        result.rewrites.push({
          changed: true,
          original: item.url,
          url: durl[0].url,
          reason: "live-pcdn-filter"
        });
      });
      result.changed = result.changed || dropped.length > 0;
    }

    const keys = Array.isArray(payload)
      ? payload.map(function (_, i) { return i; })
      : Object.keys(payload);
    for (let i = 0; i < keys.length; i += 1) {
      const child = filterLiveUrlInfo(payload[keys[i]], config, level + 1, visited);
      result.live = result.live || child.live;
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
    ACCENT_KEYS,
    THEME_MODES,
    DEFAULT_CONFIG,
    normalizeConfig,
    hasMediaSignal: hasBiliMediaSignal,
    classify,
    isSlowLiveHost,
    isLiveUrl,
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
