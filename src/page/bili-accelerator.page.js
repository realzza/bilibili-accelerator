(function installBiliAccelerator(root) {
  "use strict";

  const core = root.BiliAcceleratorCore;
  if (!core || root.__BILI_ACCELERATOR_INSTALLED__) {
    return;
  }
  root.__BILI_ACCELERATOR_INSTALLED__ = true;

  const VERSION = "0.4.0";
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
  const STALL_RETRY_MS = 5000;
  const PROBE_TIMEOUT_MS = 4000;

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
    lastMediaHost: null,
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

  // ---- panel appearance ---------------------------------------------------

  // Accent presets keyed by core.ACCENT_KEYS. `hex` is the primary accent,
  // `strong` the pressed/hover shade, `gradA`/`gradB` the ⚡ toggle gradient.
  const ACCENT_PRESETS = {
    bili:     { hex: "#00aeec", strong: "#0091cc", gradA: "#00b5f5", gradB: "#0091cc" },
    teal:     { hex: "#0d9488", strong: "#0b7d73", gradA: "#14b8a6", gradB: "#0b7d73" },
    emerald:  { hex: "#10b981", strong: "#0e9d6e", gradA: "#25c894", gradB: "#0e9d6e" },
    violet:   { hex: "#7c5cff", strong: "#6544e0", gradA: "#8f74ff", gradB: "#6544e0" },
    pink:     { hex: "#fb7299", strong: "#e85d86", gradA: "#ff86ab", gradB: "#e85d86" },
    sunset:   { hex: "#f97316", strong: "#db5f0c", gradA: "#ff8a3d", gradB: "#db5f0c" },
    graphite: { hex: "#46566a", strong: "#33404f", gradA: "#556579", gradB: "#33404f" }
  };

  // Header theme-toggle glyphs; swapped by updateAppearanceControls per resolved theme.
  const SUN_SVG = "<svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path fill=\"currentColor\" d=\"M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10Zm0-13a1 1 0 0 1 1 1v1a1 1 0 1 1-2 0V5a1 1 0 0 1 1-1Zm0 14a1 1 0 0 1 1 1v1a1 1 0 1 1-2 0v-1a1 1 0 0 1 1-1ZM4 12a1 1 0 0 1 1-1h1a1 1 0 1 1 0 2H5a1 1 0 0 1-1-1Zm14 0a1 1 0 0 1 1-1h1a1 1 0 1 1 0 2h-1a1 1 0 0 1-1-1ZM6.3 6.3a1 1 0 0 1 1.4 0l.7.7a1 1 0 1 1-1.4 1.4l-.7-.7a1 1 0 0 1 0-1.4Zm9.3 9.3a1 1 0 0 1 1.4 0l.7.7a1 1 0 1 1-1.4 1.4l-.7-.7a1 1 0 0 1 0-1.4Zm1.4-9.3a1 1 0 0 1 0 1.4l-.7.7a1 1 0 1 1-1.4-1.4l.7-.7a1 1 0 0 1 1.4 0ZM7.7 15.6a1 1 0 0 1 0 1.4l-.7.7a1 1 0 0 1-1.4-1.4l.7-.7a1 1 0 0 1 1.4 0Z\"/></svg>";
  const MOON_SVG = "<svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path fill=\"currentColor\" d=\"M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z\"/></svg>";

  // Surface tokens per resolved theme; the accent tokens are layered on top.
  const SURFACES = {
    light: {
      "--ba-surface": "rgba(255,255,255,.97)", "--ba-card": "#ffffff",
      "--ba-border": "#e5eaf0", "--ba-border-in": "#d5dde5",
      "--ba-ink": "#17202a", "--ba-ink-strong": "#111827", "--ba-ink-mid": "#46515c",
      "--ba-ink-soft": "#6b7785", "--ba-ink-faint": "#8a95a1",
      "--ba-dot-bg": "#eef2f6", "--ba-dot": "#9aa6b2",
      "--ba-good-bg": "#e6f8ee", "--ba-good": "#19a974",
      "--ba-warn-bg": "#fff4e0", "--ba-warn": "#e8910c",
      "--ba-slider-off": "#c9d3dd", "--ba-panel-shadow": "rgba(21,32,43,.24)"
    },
    dark: {
      "--ba-surface": "rgba(22,26,32,.975)", "--ba-card": "#1c222b",
      "--ba-border": "#2b323d", "--ba-border-in": "#38414d",
      "--ba-ink": "#e8edf2", "--ba-ink-strong": "#f4f7fa", "--ba-ink-mid": "#b9c3ce",
      "--ba-ink-soft": "#93a0ac", "--ba-ink-faint": "#6f7b87",
      "--ba-dot-bg": "#262d37", "--ba-dot": "#6f7b87",
      "--ba-good-bg": "rgba(25,169,116,.16)", "--ba-good": "#2ed3a0",
      "--ba-warn-bg": "rgba(232,145,12,.16)", "--ba-warn": "#f0a838",
      "--ba-slider-off": "#3a434f", "--ba-panel-shadow": "rgba(0,0,0,.5)"
    }
  };

  // The speed canvas can't cheaply read CSS vars per frame, so applyTheme caches
  // the values it needs: accent for the line/fill, card for the endpoint halo.
  const speedPaint = { accent: "#00aeec", accentRgb: "0,174,236", card: "#ffffff" };

  function resolveTheme() {
    if (config.theme === "light" || config.theme === "dark") {
      return config.theme;
    }
    try {
      return root.matchMedia && root.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark" : "light";
    } catch (_) {
      return "light";
    }
  }

  function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255].join(",");
  }

  // Push the resolved accent + surface onto the shadow host as CSS custom
  // properties; the panel styles read them through var(). Custom properties
  // inherit across the shadow boundary, so setting them on the host is enough.
  function applyTheme() {
    const host = document.getElementById(BUTTON_ID);
    if (!host) {
      return;
    }
    const accent = ACCENT_PRESETS[config.accent] || ACCENT_PRESETS.bili;
    const surface = SURFACES[resolveTheme()] || SURFACES.light;
    Object.keys(surface).forEach(function (name) {
      host.style.setProperty(name, surface[name]);
    });
    const rgb = hexToRgb(accent.hex);
    host.style.setProperty("--ba-accent", accent.hex);
    host.style.setProperty("--ba-accent-strong", accent.strong);
    host.style.setProperty("--ba-grad-a", accent.gradA);
    host.style.setProperty("--ba-grad-b", accent.gradB);
    host.style.setProperty("--ba-accent-shadow", "rgba(" + rgb + ",.42)");
    speedPaint.accent = accent.hex;
    speedPaint.accentRgb = rgb;
    speedPaint.card = surface["--ba-card"];
    drawSpeed();
    updateAppearanceControls();
  }

  function watchSystemTheme() {
    try {
      const mq = root.matchMedia("(prefers-color-scheme: dark)");
      const onChange = function () {
        if (config.theme === "system") {
          applyTheme();
        }
      };
      if (typeof mq.addEventListener === "function") {
        mq.addEventListener("change", onChange);
      } else if (typeof mq.addListener === "function") {
        mq.addListener(onChange);
      }
    } catch (_) {
      // matchMedia unavailable — system theme just won't live-update.
    }
  }

  // A two-option sliding toggle (the header language + theme pills share it).
  // Both cells are equal width, so the 50%-wide thumb slides exactly one cell.
  // Mounts with the active index already set, so it never animates on first
  // paint — only later taps slide. options: [{ html, value, label }].
  function createSegToggle(id, options, activeIndex, onSelect) {
    const seg = document.createElement("div");
    seg.className = "ba-seg";
    seg.id = id;
    seg.dataset.active = String(activeIndex);
    const thumb = document.createElement("span");
    thumb.className = "ba-seg-thumb";
    seg.appendChild(thumb);
    options.forEach(function (opt, i) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "ba-seg-opt";
      btn.innerHTML = opt.html;
      btn.setAttribute("aria-pressed", i === activeIndex ? "true" : "false");
      if (opt.label) {
        btn.title = opt.label;
        btn.setAttribute("aria-label", opt.label);
      }
      btn.addEventListener("click", function () { onSelect(opt.value, i); });
      seg.appendChild(btn);
    });
    return seg;
  }

  function setSegActive(seg, index) {
    if (!seg) {
      return;
    }
    seg.dataset.active = String(index);
    seg.querySelectorAll(".ba-seg-opt").forEach(function (opt, i) {
      opt.setAttribute("aria-pressed", i === index ? "true" : "false");
    });
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
      // Keep only bare host + reason — never the full media URL. Segment URLs
      // carry the viewer's mid, buvid, IP-derived oi and signed tokens, and the
      // diagnostics report is built to be pasted into public issues. Redacting
      // here (not just at display) means those tokens never persist in memory.
      return {
        at: new Date().toISOString(),
        source,
        reason: item.reason,
        fromHost: core.hostOf(item.original),
        toHost: core.hostOf(item.url)
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

  function backupPool() {
    return state.ranking.length ? state.ranking : config.candidatePool;
  }

  // Merge host-swapped alternatives of `base` into entry[key], deduped, max 8.
  function mergeBackups(entry, key, base) {
    const alts = core.alternativesFor(base, config, backupPool());
    if (!alts.length) {
      return;
    }
    const existing = Array.isArray(entry[key]) ? entry[key] : [];
    const merged = alts.concat(existing).filter(function uniq(u, i, arr) {
      return arr.indexOf(u) === i;
    });
    entry[key] = merged.slice(0, 8);
  }

  // Add host-swapped alternatives to DASH/durl entries so Bilibili's own
  // backup-URL failover can recover for free if the primary host stalls.
  // Payload shapes: data.dash (web player), result.video_info.dash (bangumi),
  // result.dash, bare dash; durl carries the legacy FLV/MP4 lists. Web-API DASH
  // uses camelCase (baseUrl/backupUrl); app-style payloads and durl use
  // snake_case (base_url/backup_url).
  function enrichBackups(payload) {
    if (config.selection !== "auto" || !payload || typeof payload !== "object") {
      return;
    }
    const containers = [
      payload.data,
      payload.result,
      payload.result && payload.result.video_info,
      payload
    ];
    containers.forEach(function eachContainer(container) {
      if (!container || typeof container !== "object") {
        return;
      }
      enrichDash(container.dash);
      enrichDurl(container.durl);
    });
  }

  function enrichDash(dash) {
    if (!dash || typeof dash !== "object") {
      return;
    }
    ["video", "audio"].forEach(function eachKind(kind) {
      const list = dash[kind];
      if (!Array.isArray(list)) {
        return;
      }
      list.forEach(function eachEntry(entry) {
        if (!entry) {
          return;
        }
        if (typeof entry.baseUrl === "string") {
          mergeBackups(entry, "backupUrl", entry.baseUrl);
        }
        if (typeof entry.base_url === "string") {
          mergeBackups(entry, "backup_url", entry.base_url);
        }
      });
    });
  }

  function enrichDurl(durl) {
    if (!Array.isArray(durl)) {
      return;
    }
    durl.forEach(function eachEntry(entry) {
      if (entry && typeof entry.url === "string") {
        mergeBackups(entry, "backup_url", entry.url);
      }
    });
  }

  function rewritePayload(payload, source) {
    const tracker = { changed: false, rewrites: [] };
    try {
      const rewritten = core.rewriteObject(payload, config, tracker);
      enrichBackups(rewritten);
      record(tracker.rewrites, source);
      filterLivePcdn(rewritten, source);
      rememberSample(rewritten);
      return rewritten;
    } catch (error) {
      console.warn("[BiliAccelerator] rewrite failed", error);
      return payload;
    }
  }

  // Live playurl payloads list candidate hosts (url_info) instead of full URLs;
  // drop the PCDN/MCDN entries so the live player only ever dials official CDN.
  function filterLivePcdn(payload, source) {
    try {
      const filtered = core.filterLiveUrlInfo(payload, config);
      if (filtered.changed) {
        record(filtered.rewrites, source);
      }
    } catch (_) {
      // never let live filtering break payload delivery.
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
      // Track which host actually serves the media: the <video> element only
      // exposes a blob: URL under MSE, so this is what stall recovery must avoid.
      try {
        state.lastMediaHost = detail.changed
          ? new URL(detail.url).hostname
          : (host || state.lastMediaHost);
      } catch (_) {}
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
    const url = requestUrlOf(input);
    return typeof url === "string" &&
      (url.includes("/x/player") ||
        url.includes("/pgc/player") ||
        url.includes("playurl") ||
        url.includes("getRoomPlayInfo") ||
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
    if (input && typeof input.href === "string") {
      return input.href; // URL instance
    }
    if (input && typeof input.url === "string") {
      return input.url; // Request instance
    }
    return null;
  }

  function patchFetch() {
    if (!nativeFetch) {
      return;
    }
    root.fetch = function patchedFetch(input, init) {
      let args = arguments;
      const reqUrl = requestUrlOf(input);
      const isMedia = !!reqUrl && core.hasMediaSignal(reqUrl);
      if (config.enabled && isMedia) {
        const swapped = rewriteRequestUrl(reqUrl);
        if (swapped !== reqUrl) {
          // string and URL inputs can be replaced by the string directly; only a
          // Request needs to be rebuilt to preserve its init options.
          input = (typeof input === "string" || typeof input.href === "string")
            ? swapped
            : new Request(swapped, input);
          args = [input, init];
        }
      }

      return nativeFetch.apply(this, args).then(function handleResponse(response) {
        if (!config.enabled) {
          return response;
        }
        const contentType = response.headers && response.headers.get("content-type");
        const isBinary = !contentType ||
          (!contentType.includes("json") && !contentType.includes("text"));

        // Never clone or consume media bodies here. In particular, Safari may
        // throttle the page-world reader after a tab is backgrounded; teeing the
        // player's response for the optional speed graph can then interfere with
        // MSE playback. XHR transfers are still measured below, and fetch-based
        // playback falls back to the buffer-ahead graph.
        if (isMedia && isBinary) {
          return response;
        }

        if (!isInterestingFetch(args[0]) || isBinary) {
          return response;
        }
        return response.clone().text().then(function rewriteText(text) {
          if (!bodyHasSignal(text)) {
            return response;
          }
          let parsed;
          const tracker = { changed: false, rewrites: [] };
          let live = { changed: false, rewrites: [] };
          try {
            parsed = nativeJsonParse(text);
            core.rewriteObject(parsed, config, tracker);
            enrichBackups(parsed);
            live = core.filterLiveUrlInfo(parsed, config);
          } catch (_) {
            return response;
          }
          if (!tracker.changed && !live.changed) {
            rememberSample(parsed);
            return response;
          }
          record(tracker.rewrites, "fetch");
          record(live.rewrites, "fetch");
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
      const urlStr = typeof url === "string"
        ? url
        : (url && typeof url.href === "string" ? url.href : "");
      this.__baAccel = { url: urlStr };
      let finalUrl = url;
      if (config.enabled && urlStr && core.hasMediaSignal(urlStr)) {
        finalUrl = rewriteRequestUrl(urlStr);
      }
      return open.apply(this, [method, finalUrl].concat([].slice.call(arguments, 2)));
    };

    NativeXHR.prototype.send = function patchedSend() {
      const xhr = this;
      const meta = xhr.__baAccel || {};
      const isMedia = typeof meta.url === "string" && core.hasMediaSignal(meta.url);
      const interesting = typeof meta.url === "string" &&
        (meta.url.includes("playurl") || meta.url.includes("/x/player") ||
          meta.url.includes("/pgc/player") || meta.url.includes("getRoomPlayInfo") ||
          isMedia);

      // Count downloaded bytes for media segments (free via loadend.loaded) and
      // time send→loadend as the transfer duration for the throughput window.
      if (config.enabled && isMedia) {
        const startTs = nowMs();
        xhr.addEventListener("loadend", function onLoadEnd(event) {
          if (event && typeof event.loaded === "number") {
            recordTransfer(startTs, nowMs(), event.loaded);
          }
        });
      }

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
            const live = core.filterLiveUrlInfo(parsed, config);
            rememberSample(parsed);
            if (!tracker.changed && !live.changed) {
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
            record(live.rewrites, "xhr");
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
    // Stub Bilibili's P2P SDK entry points so the player never boots the
    // PCDN/seeder mesh (same surface MBGTEB neutralizes). Instances only need
    // an `on` no-op to satisfy the player's wiring code.
    function NoopSdk() {}
    NoopSdk.prototype.on = function () {};
    ["PCDNLoader", "BPP2PSDK", "SeederSDK"].forEach(function (name) {
      try {
        Object.defineProperty(root, name, {
          configurable: false,
          writable: false,
          value: NoopSdk
        });
      } catch (_) {
        // already defined and frozen; ignore.
      }
    });
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

  // TTFB-probe one candidate host by re-requesting the signed sample URL on it.
  // Uses cors mode (the CDN sends ACAO for the player's own segment fetches) so
  // the real status is visible — under no-cors a host that fast-fails with 403
  // would look "healthy" and win the ranking. No Range header: it isn't
  // no-cors/preflight-safe everywhere, and the body is aborted right after the
  // headers arrive anyway, so only a few KB ever transfer.
  function probeHost(host, sampleUrl) {
    const url = swapHost(sampleUrl, host);
    if (!url) {
      return Promise.resolve({ host, ttfb: null, ok: false });
    }
    const started = nowMs();
    const init = { method: "GET", mode: "cors", cache: "no-store", credentials: "omit" };
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    let timer = null;
    let settled = false;
    if (controller) {
      init.signal = controller.signal;
      timer = setTimeout(function () { controller.abort(); }, PROBE_TIMEOUT_MS);
    }
    const probe = nativeFetch(url, init).then(function (response) {
      const ttfb = nowMs() - started;
      // Headers are in — stop the body download, we only wanted the timing.
      try {
        if (response.body && typeof response.body.cancel === "function") {
          response.body.cancel();
        }
      } catch (_) {}
      return { host, ttfb: response.ok ? ttfb : null, ok: !!response.ok };
    }).catch(function () {
      return { host, ttfb: null, ok: false };
    }).then(function (result) {
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      return result;
    });
    if (controller) {
      return probe;
    }
    // No AbortController (very old engines): fall back to racing a timeout.
    return Promise.race([probe, new Promise(function (resolve) {
      setTimeout(function () {
        if (!settled) {
          resolve({ host, ttfb: null, ok: false });
        }
      }, PROBE_TIMEOUT_MS);
    })]);
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
    // Browsers throttle media/MSE work in background tabs, which can make the
    // player emit a transient waiting/stalled event. Rotating CDN hosts in that
    // state turns a harmless suspension into a real interruption, so ignore it;
    // a genuine foreground stall will emit its own waiting/stalled event.
    stallTimer = null;
    if (document.hidden || !watchedVideo || watchedVideo.paused || watchedVideo.ended) {
      return;
    }
    if (watchedVideo.readyState >= 3) {
      return;
    }
    // Count distinct stall episodes once; re-checks of the same episode below
    // only add recovery rotations.
    if (state.status !== "buffering") {
      state.stalls += 1;
    }
    state.status = "buffering";
    if (config.stallRecovery && config.selection === "auto") {
      rotateTarget(state.lastMediaHost || currentVideoHost());
      state.recoveries += 1;
      // Keep rotating while the stall persists — 'waiting' fires only once per
      // episode, so without a re-check a single bad pick would strand playback.
      stallTimer = setTimeout(handleStall, STALL_RETRY_MS);
    }
    renderStatus();
  }

  function onWaiting() {
    if (stallTimer) {
      clearTimeout(stallTimer);
      stallTimer = null;
    }
    if (document.hidden) {
      return;
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
      version: VERSION,
      installedAt: state.installedAt,
      region: regionKey().split("|")[0],   // timezone only — drop locale
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

  // ---- speed visualization ------------------------------------------------

  const SPEED_SAMPLES = 60;       // ~60s of history at 1s resolution
  const SPEED_TICK_MS = 1000;
  const SPEED_WINDOW_MS = 3000;   // trailing window for active-throughput math
  const MIN_TRANSFER_MS = 8;      // ignore sub-8ms reads (cache hits) as rate noise
  const speed = {
    mode: "speed",                // "speed" (Mbps) | "buffer" (seconds ahead)
    mbpsSeries: [],
    bufSeries: [],
    transfers: [],                // recent { start, end, bytes } media transfers
    currentMbps: 0,               // displayed (eased) rate — mirrors dispMbps
    dispMbps: 0,                  // eased value driving the curve + big readout
    avgMbps: 0,                   // slow average, used as the idle anchor
    peakMbps: 0,
    bufferSec: 0,
    dispMax: 0,                   // eased y-axis maximum (smooth rescaling)
    sawBytes: false,
    activeTicks: 0,               // ticks where playback advanced
    lastTime: 0
  };
  let speedTimer = null;

  function nowMs() {
    return (root.performance && root.performance.now) ? root.performance.now() : Date.now();
  }

  // Record one completed media transfer for the active-throughput window. Bytes
  // are measured at the XHR layer rather than via Resource Timing, because
  // Bilibili's media CDN omits Timing-Allow-Origin and would report 0
  // transferSize. Fetch media bodies stay completely untouched; the graph falls
  // back to buffer health when the player uses fetch.
  function recordTransfer(start, end, bytes) {
    if (!(bytes > 0)) {
      return;
    }
    speed.sawBytes = true;
    // Near-instant reads are cache hits, not the network — counting them would
    // spike the rate to absurd values, so only their "bytes seen" flag matters.
    if (end - start >= MIN_TRANSFER_MS) {
      speed.transfers.push({ start: start, end: end, bytes: bytes });
    }
  }

  function installSpeedMeter() {
    if (!speedTimer && typeof setInterval === "function") {
      speedTimer = setInterval(tickSpeed, SPEED_TICK_MS);
    }
  }

  function tickSpeed() {
    const now = nowMs();
    // Active throughput: bytes per second of time actually spent transferring in
    // the trailing window, so the player's idle gaps between burst downloads
    // don't drag a fast link to zero.
    const sample = core.aggregateThroughput(speed.transfers, now, SPEED_WINDOW_MS);
    speed.transfers = speed.transfers.filter(function keep(tr) {
      return tr.end > now - SPEED_WINDOW_MS;
    });

    // Background tabs get throttled timers anyway; skip the series/UI work and
    // resume cleanly when the tab is visible again.
    if (document.hidden) {
      return;
    }

    let playing = false;
    try {
      if (watchedVideo) {
        if (watchedVideo.buffered && watchedVideo.buffered.length) {
          const end = watchedVideo.buffered.end(watchedVideo.buffered.length - 1);
          speed.bufferSec = Math.max(0, end - watchedVideo.currentTime);
        }
        playing = !watchedVideo.paused && !watchedVideo.ended &&
          watchedVideo.currentTime !== speed.lastTime;
        speed.lastTime = watchedVideo.currentTime;
      }
    } catch (_) {}

    if (sample > 0) {
      // Downloading: ease up toward the measured rate and keep a slow average
      // as the anchor to hold at once the burst ends.
      speed.avgMbps = speed.avgMbps > 0
        ? speed.avgMbps + (sample - speed.avgMbps) * 0.25
        : sample;
      speed.dispMbps += (sample - speed.dispMbps) * 0.45;
      if (sample > speed.peakMbps) {
        speed.peakMbps = sample;
      }
    } else if (playing) {
      // Buffer full, nothing in flight: the link is idle, not slow — drift
      // gently toward the recent average instead of dropping to 0.
      speed.dispMbps += (speed.avgMbps - speed.dispMbps) * 0.05;
    } else {
      // Genuinely idle (paused/ended): relax the reading toward 0.
      speed.dispMbps *= 0.8;
      speed.avgMbps *= 0.8;
    }
    if (speed.dispMbps < 0.05) {
      speed.dispMbps = 0;
    }
    speed.currentMbps = speed.dispMbps;

    speed.mbpsSeries.push(speed.dispMbps);
    if (speed.mbpsSeries.length > SPEED_SAMPLES) {
      speed.mbpsSeries.shift();
    }

    speed.bufSeries.push(speed.bufferSec);
    if (speed.bufSeries.length > SPEED_SAMPLES) {
      speed.bufSeries.shift();
    }

    // If playback is clearly advancing but the CDN never exposes byte sizes
    // (opaque cross-origin), fall back to visualizing buffer health instead.
    if (playing) {
      speed.activeTicks += 1;
    }
    if (speed.mode === "speed" && !speed.sawBytes && speed.activeTicks >= 6) {
      speed.mode = "buffer";
    }

    if (panelIsOpen()) {
      drawSpeed();
      updateSpeedReadouts();
    }
  }

  function speedSeries() {
    return speed.mode === "buffer" ? speed.bufSeries : speed.mbpsSeries;
  }

  // Round a value up to a "nice" axis maximum (1/2/5 × 10ⁿ) so the y-scale
  // lands on tidy numbers instead of arbitrary peaks.
  function niceCeil(v) {
    if (!(v > 0)) {
      return 1;
    }
    const pow = Math.pow(10, Math.floor(Math.log(v) / Math.LN10));
    const n = v / pow;
    const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
    return step * pow;
  }

  // Light 3-point moving average to calm per-second jitter before smoothing.
  function smoothSeries(arr) {
    if (arr.length < 3) {
      return arr.slice();
    }
    const out = arr.slice();
    for (let i = 1; i < arr.length - 1; i += 1) {
      out[i] = (arr[i - 1] + arr[i] * 2 + arr[i + 1]) / 4;
    }
    return out;
  }

  // Monotone cubic (Fritsch–Carlson) tangents — same family as d3.curveMonotoneX:
  // smooth through every point with no overshoot. Best fit for time series.
  function monotoneTangents(xs, ys) {
    const n = xs.length;
    const slopes = new Array(n - 1);
    const tan = new Array(n);
    for (let i = 0; i < n - 1; i += 1) {
      slopes[i] = (ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]);
    }
    tan[0] = slopes[0];
    tan[n - 1] = slopes[n - 2];
    for (let i = 1; i < n - 1; i += 1) {
      tan[i] = slopes[i - 1] * slopes[i] <= 0 ? 0 : (slopes[i - 1] + slopes[i]) / 2;
    }
    for (let i = 0; i < n - 1; i += 1) {
      if (slopes[i] === 0) {
        tan[i] = 0;
        tan[i + 1] = 0;
        continue;
      }
      const a = tan[i] / slopes[i];
      const b = tan[i + 1] / slopes[i];
      const s = a * a + b * b;
      if (s > 9) {
        const tau = 3 / Math.sqrt(s);
        tan[i] = tau * a * slopes[i];
        tan[i + 1] = tau * b * slopes[i];
      }
    }
    return tan;
  }

  function tracePath(ctx, xs, ys, tan) {
    ctx.moveTo(xs[0], ys[0]);
    if (xs.length < 2) {
      return;
    }
    for (let i = 0; i < xs.length - 1; i += 1) {
      const dx = (xs[i + 1] - xs[i]) / 3;
      ctx.bezierCurveTo(
        xs[i] + dx, ys[i] + tan[i] * dx,
        xs[i + 1] - dx, ys[i + 1] - tan[i + 1] * dx,
        xs[i + 1], ys[i + 1]
      );
    }
  }

  function drawSpeed() {
    const shadow = getShadow();
    const canvas = shadow && shadow.getElementById("ba-spd-canvas");
    if (!canvas || typeof canvas.getContext !== "function") {
      return;
    }
    const dpr = root.devicePixelRatio || 1;
    const w = canvas.clientWidth || 296;
    const h = canvas.clientHeight || 46;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    const series = smoothSeries(speedSeries());
    if (!series.length) {
      return;
    }

    const floor = speed.mode === "buffer" ? 30 : 1;
    let dataMax = floor;
    for (let i = 0; i < series.length; i += 1) {
      if (series[i] > dataMax) {
        dataMax = series[i];
      }
    }
    // Ease the displayed maximum toward a nice ceiling so rescaling glides.
    const target = niceCeil(dataMax);
    speed.dispMax = speed.dispMax > 0
      ? speed.dispMax + (target - speed.dispMax) * 0.25
      : target;
    const max = Math.max(speed.dispMax, floor);

    const padTop = 5;
    const padBottom = 2;
    // Elastic x-axis: while the series is still filling, stretch it across the
    // full width so the curve looks alive from the first seconds; once it caps
    // at SPEED_SAMPLES the step stabilizes and the window simply slides.
    const step = w / Math.max(1, series.length - 1);
    const xs = [];
    const ys = [];
    for (let i = 0; i < series.length; i += 1) {
      xs.push(i * step);
      ys.push(h - padBottom - (series[i] / max) * (h - padTop - padBottom));
    }
    const tan = series.length >= 2 ? monotoneTangents(xs, ys) : [0];

    // Gradient area fill.
    ctx.beginPath();
    tracePath(ctx, xs, ys, tan);
    ctx.lineTo(xs[xs.length - 1], h);
    ctx.lineTo(xs[0], h);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, "rgba(" + speedPaint.accentRgb + ",0.30)");
    grad.addColorStop(1, "rgba(" + speedPaint.accentRgb + ",0.02)");
    ctx.fillStyle = grad;
    ctx.fill();

    // Smooth line.
    ctx.beginPath();
    tracePath(ctx, xs, ys, tan);
    ctx.lineWidth = 2;
    ctx.strokeStyle = speedPaint.accent;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.stroke();

    // Leading-edge dot at the current value.
    const lx = xs[xs.length - 1];
    const ly = ys[ys.length - 1];
    ctx.beginPath();
    ctx.arc(lx, ly, 3.2, 0, Math.PI * 2);
    ctx.fillStyle = speedPaint.accent;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = speedPaint.card;
    ctx.stroke();
  }

  function updateSpeedReadouts() {
    const shadow = getShadow();
    if (!shadow) {
      return;
    }
    const card = shadow.getElementById("ba-speed");
    const label = shadow.getElementById("ba-spd-label");
    const value = shadow.getElementById("ba-spd-now");
    const unit = shadow.getElementById("ba-spd-unit");
    const foot = shadow.getElementById("ba-spd-foot");
    if (!card) {
      return;
    }
    const series = speedSeries();
    const empty = series.length === 0 || (!speed.sawBytes && speed.mode === "speed");
    card.className = empty ? "ba-speed empty" : "ba-speed";
    if (label) {
      label.textContent = t(speed.mode === "buffer" ? "bufTitle" : "spdTitle");
    }
    if (unit) {
      unit.textContent = speed.mode === "buffer" ? t("bufUnit") : t("spdUnit");
    }
    if (value) {
      value.textContent = speed.mode === "buffer"
        ? String(Math.round(speed.bufferSec))
        : speed.currentMbps.toFixed(1);
    }
    if (foot) {
      foot.textContent = speed.mode === "buffer"
        ? t("spdBuffering")
        : t("spdPeak") + " " + speed.peakMbps.toFixed(1) + " " + t("spdUnit");
    }
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
        off: ["Acceleration off", "Turn it on to speed up slow videos"],
        idle: ["Ready", "Open a video and it'll kick in"],
        optimizing: ["Finding the fastest server…", "Picking the best route for you"],
        buffering: ["Finding a faster server…", "Recovering from a slow connection"],
        smooth: ["Playing smoothly", "Connected to the fastest server near you"]
      },
      count: function (n) { return n + " slow connection" + (n === 1 ? "" : "s") + " fixed"; },
      spdTitle: "Download speed",
      spdUnit: "Mbps",
      spdPeak: "peak",
      spdBuffering: "seconds buffered ahead",
      bufTitle: "Buffer ahead",
      bufUnit: "s",
      spdWaiting: "Waiting for playback…",
      masterTitle: "Acceleration",
      masterNote: "Speed up slow videos automatically",
      boost: "Still buffering? Boost harder",
      advShow: "Advanced settings",
      advHide: "Hide advanced",
      fAccent: "Accent",
      themeLight: "Light theme", themeDark: "Dark theme",
      accents: {
        bili: "Bilibili Blue", teal: "Teal", emerald: "Emerald", violet: "Violet",
        pink: "Pink", sunset: "Sunset", graphite: "Graphite"
      },
      fServer: "Server", fWhen: "When", fFixed: "Fixed server", fMcdn: "MCDN",
      selAuto: "Auto (pick fastest)", selFixed: "Use a fixed server",
      modeBad: "Only fix slow servers", modeForce: "Always switch server",
      mcdnAll: "Proxy all MCDN", mcdnV1: "Proxy /v1 only", mcdnReplace: "Replace host",
      portTitle: "Catch hidden PCDN", portNote: "Treat odd-port servers as slow (recommended)",
      stallTitle: "Auto-recover", stallNote: "Switch servers live if it stalls — no reload",
      akamaiTitle: "Rewrite Akamai", akamaiNote: "Only if Akamai is slow on your network",
      p2pTitle: "Stop bandwidth sharing", p2pNote: "Block Bilibili's P2P upload (reload to apply)",
      diag: "Copy report", diagCopied: "Copied ✓", diagConsole: "See console",
      reload: "Reload"
    },
    zh: {
      title: "Bilibili Accelerator",
      status: {
        off: ["已关闭加速", "打开后自动为慢视频提速"],
        idle: ["就绪", "打开视频后自动生效"],
        optimizing: ["正在寻找最快的服务器…", "正在为你挑选最佳线路"],
        buffering: ["正在切换更快的服务器…", "正在从卡顿中恢复"],
        smooth: ["播放流畅", "已连接到离你最近的最快服务器"]
      },
      count: function (n) { return "已修复 " + n + " 个慢连接"; },
      spdTitle: "下载速度",
      spdUnit: "Mbps",
      spdPeak: "峰值",
      spdBuffering: "已缓冲秒数",
      bufTitle: "缓冲时长",
      bufUnit: "秒",
      spdWaiting: "等待播放…",
      masterTitle: "加速",
      masterNote: "自动为慢视频提速",
      boost: "还在卡？再加把劲",
      advShow: "高级设置",
      advHide: "收起高级设置",
      fAccent: "主题色",
      themeLight: "浅色", themeDark: "深色",
      accents: {
        bili: "哔哩蓝", teal: "青碧", emerald: "翠绿", violet: "星紫",
        pink: "少女粉", sunset: "落日橙", graphite: "石墨灰"
      },
      fServer: "服务器", fWhen: "何时", fFixed: "固定服务器", fMcdn: "MCDN",
      selAuto: "自动（选最快）", selFixed: "使用固定服务器",
      modeBad: "仅修复慢服务器", modeForce: "总是切换服务器",
      mcdnAll: "代理所有 MCDN", mcdnV1: "仅代理 /v1", mcdnReplace: "替换域名",
      portTitle: "抓取隐藏 PCDN", portNote: "把奇怪端口的服务器当作慢节点（推荐）",
      stallTitle: "自动恢复", stallNote: "卡顿时实时切换服务器，无需刷新",
      akamaiTitle: "改写 Akamai", akamaiNote: "仅当 Akamai 在你的网络上很慢时使用",
      p2pTitle: "停止带宽共享", p2pNote: "阻止 B 站的 P2P 上传（刷新后生效）",
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
    updateAppearanceControls();
    updateSpeedReadouts();
    renderStatus();
  }

  function updateLangButtons() {
    const shadow = getShadow();
    if (!shadow) {
      return;
    }
    setSegActive(shadow.getElementById("ba-lang-seg"), lang() === "zh" ? 1 : 0);
  }

  // Reflect the stored accent + theme back onto the picker controls, and keep
  // the swatch tooltips localized. Safe to call before the panel exists.
  function updateAppearanceControls() {
    const shadow = getShadow();
    if (!shadow) {
      return;
    }
    const names = STRINGS[lang()].accents || {};
    shadow.querySelectorAll(".ba-sw").forEach(function (b) {
      b.setAttribute("aria-pressed", b.dataset.accent === config.accent ? "true" : "false");
      const name = names[b.dataset.accent];
      if (name) {
        b.title = name;
        b.setAttribute("aria-label", name);
      }
    });
    const themeSeg = shadow.getElementById("ba-theme-seg");
    if (themeSeg) {
      // Slide the thumb to the resolved theme (also animates when the OS flips).
      setSegActive(themeSeg, resolveTheme() === "dark" ? 1 : 0);
      const opts = themeSeg.querySelectorAll(".ba-seg-opt");
      const labels = [t("themeLight"), t("themeDark")];
      opts.forEach(function (opt, i) {
        opt.title = labels[i];
        opt.setAttribute("aria-label", labels[i]);
      });
    }
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

  // Like createField but a plain <div> instead of <label>, so a row of buttons
  // (the accent swatches) doesn't forward stray clicks to the first button.
  function createSwatchField(key, control) {
    const row = document.createElement("div");
    row.className = "ba-field";
    const caption = document.createElement("span");
    caption.dataset.i18n = key;
    caption.textContent = t(key);
    row.appendChild(caption);
    row.appendChild(control);
    return row;
  }

  function createAccentPicker() {
    const wrap = document.createElement("div");
    wrap.className = "ba-swatches";
    core.ACCENT_KEYS.forEach(function (key) {
      const preset = ACCENT_PRESETS[key];
      if (!preset) {
        return;
      }
      const swatch = document.createElement("button");
      swatch.type = "button";
      swatch.className = "ba-sw";
      swatch.dataset.accent = key;
      swatch.style.background = preset.hex;
      swatch.setAttribute("aria-pressed", key === config.accent ? "true" : "false");
      swatch.addEventListener("click", function () {
        saveConfig(Object.assign({}, config, { accent: key }));
        applyTheme();
      });
      wrap.appendChild(swatch);
    });
    return wrap;
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
      // Appearance tokens (light + Bilibili-blue baseline). applyTheme() layers
      // the resolved accent + dark/light surface over these via inline vars on
      // the host, which inherit across the shadow boundary.
      ":host{--ba-accent:#00aeec;--ba-accent-strong:#0091cc;--ba-grad-a:#00b5f5;--ba-grad-b:#0091cc;--ba-accent-shadow:rgba(0,174,236,.42);--ba-surface:rgba(255,255,255,.97);--ba-card:#fff;--ba-border:#e5eaf0;--ba-border-in:#d5dde5;--ba-ink:#17202a;--ba-ink-strong:#111827;--ba-ink-mid:#46515c;--ba-ink-soft:#6b7785;--ba-ink-faint:#8a95a1;--ba-dot-bg:#eef2f6;--ba-dot:#9aa6b2;--ba-good-bg:#e6f8ee;--ba-good:#19a974;--ba-warn-bg:#fff4e0;--ba-warn:#e8910c;--ba-slider-off:#c9d3dd;--ba-panel-shadow:rgba(21,32,43,.24)}",
      ":host{position:fixed;right:18px;bottom:18px;z-index:2147483647;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:var(--ba-ink);transition:opacity .25s ease}",
      ":host(.ba-immersed){opacity:0;pointer-events:none}",
      ":host(.ba-lifted){bottom:84px}",
      "*{box-sizing:border-box}",
      "button,input,select{font:inherit}",
      ".ba-toggle{display:grid;place-items:center;width:40px;height:40px;border:1px solid rgba(255,255,255,.4);border-radius:50%;background:linear-gradient(135deg,var(--ba-grad-a),var(--ba-grad-b));color:#fff;box-shadow:0 8px 22px var(--ba-accent-shadow),0 1px 0 rgba(255,255,255,.45) inset;cursor:pointer;padding:0;transition:transform .16s ease,box-shadow .16s ease}",
      ".ba-toggle:hover{transform:translateY(-1px)}",
      ".ba-toggle svg{width:20px;height:20px;display:block}",
      ".ba-panel{display:none;flex-direction:column;position:absolute;right:0;bottom:48px;width:min(340px,calc(100vw - 36px));max-height:calc(100vh - 96px);padding:16px;border:1px solid var(--ba-border);border-radius:14px;background:var(--ba-surface);box-shadow:0 18px 46px var(--ba-panel-shadow);backdrop-filter:saturate(180%) blur(18px);-webkit-backdrop-filter:saturate(180%) blur(18px)}",
      ".ba-panel.open{display:flex}",
      ".ba-body{overflow-y:auto;min-height:0}",
      ".ba-head{display:flex;align-items:center;gap:8px;margin-bottom:14px}",
      ".ba-head>svg{width:18px;height:18px;color:var(--ba-accent);flex:0 0 auto}",
      ".ba-seg{position:relative;display:inline-grid;grid-template-columns:32px 32px;height:24px;border:1px solid var(--ba-border-in);border-radius:8px;background:var(--ba-dot-bg);overflow:hidden;flex:0 0 auto}",
      ".ba-seg-end{margin-left:auto}",
      ".ba-seg-thumb{position:absolute;z-index:0;top:0;bottom:0;left:0;width:50%;background:var(--ba-accent);border-radius:7px;transition:transform .2s cubic-bezier(.4,0,.2,1)}",
      ".ba-seg[data-active=\"1\"] .ba-seg-thumb{transform:translateX(100%)}",
      ".ba-seg-opt{position:relative;z-index:1;display:grid;place-items:center;border:none;background:none;padding:0;cursor:pointer;color:var(--ba-ink-soft);font-size:11px;font-weight:700;line-height:1;transition:color .18s ease}",
      ".ba-seg-opt svg{width:15px;height:15px;display:block}",
      ".ba-seg-opt[aria-pressed=\"true\"]{color:#fff}",
      "@media (prefers-reduced-motion:reduce){.ba-seg-thumb{transition:none}}",
      ".ba-hero{display:flex;flex-direction:column;align-items:center;text-align:center;padding:4px 0 14px}",
      ".ba-dot{width:46px;height:46px;border-radius:50%;display:grid;place-items:center;margin-bottom:8px;background:var(--ba-dot-bg)}",
      ".ba-dot:after{content:'';width:14px;height:14px;border-radius:50%;background:var(--ba-dot)}",
      ".ba-dot.ba-smooth{background:var(--ba-good-bg)}.ba-dot.ba-smooth:after{background:var(--ba-good)}",
      ".ba-dot.ba-optimizing,.ba-dot.ba-buffering{background:var(--ba-warn-bg)}.ba-dot.ba-optimizing:after,.ba-dot.ba-buffering:after{background:var(--ba-warn)}",
      ".ba-dot.ba-off:after{background:var(--ba-dot)}",
      ".ba-word{font-size:15px;font-weight:800;color:var(--ba-ink)}",
      ".ba-subnote{font-size:11px;color:var(--ba-ink-soft);margin-top:2px;line-height:1.4}",
      ".ba-count{font-size:11px;color:var(--ba-ink-faint);margin-top:6px}",
      ".ba-speed{margin:0 0 10px;padding:10px 12px;border:1px solid var(--ba-border);border-radius:10px;background:var(--ba-card)}",
      ".ba-speed-top{display:flex;align-items:baseline;justify-content:space-between;gap:8px}",
      ".ba-speed-label{font-size:12px;font-weight:700;color:var(--ba-ink-mid)}",
      ".ba-speed-val{font-size:11px;color:var(--ba-ink-faint);white-space:nowrap}",
      ".ba-speed-val b{font-size:17px;color:var(--ba-accent);font-weight:800;margin-right:3px}",
      ".ba-spd-canvas{display:block;width:100%;height:46px;margin-top:6px}",
      ".ba-spd-foot{font-size:10px;color:var(--ba-ink-faint);margin-top:4px}",
      ".ba-spd-empty{display:none;font-size:11px;color:var(--ba-ink-faint);padding:8px 0 4px;text-align:center}",
      ".ba-speed.empty .ba-spd-canvas,.ba-speed.empty .ba-spd-foot,.ba-speed.empty .ba-speed-val{display:none}",
      ".ba-speed.empty .ba-spd-empty{display:block}",
      ".ba-switch-row{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:8px 0;padding:10px 12px;border:1px solid var(--ba-border);border-radius:10px;background:var(--ba-card)}",
      ".ba-switch-text{display:grid;gap:2px}",
      ".ba-switch-title{font-size:13px;font-weight:750;color:var(--ba-ink)}",
      ".ba-switch-note{font-size:11px;color:var(--ba-ink-soft);line-height:1.3}",
      ".ba-switch{position:relative;display:inline-flex;width:42px;height:24px;flex:0 0 auto}",
      ".ba-switch input{position:absolute;opacity:0;width:1px;height:1px}",
      ".ba-slider{position:absolute;inset:0;border-radius:999px;background:var(--ba-slider-off);cursor:pointer;transition:background .16s ease}",
      ".ba-slider:before{content:'';position:absolute;width:20px;height:20px;left:2px;top:2px;border-radius:50%;background:#fff;box-shadow:0 2px 6px rgba(0,0,0,.22);transition:transform .16s ease}",
      ".ba-switch input:checked+.ba-slider{background:var(--ba-accent)}",
      ".ba-switch input:checked+.ba-slider:before{transform:translateX(18px)}",
      ".ba-boost{display:none;width:100%;height:38px;margin-top:4px;border:1px solid var(--ba-accent);border-radius:10px;background:var(--ba-accent);color:#fff;font-size:13px;font-weight:700;cursor:pointer}",
      ".ba-boost:hover{background:var(--ba-accent-strong);border-color:var(--ba-accent-strong)}",
      ".ba-adv-toggle{display:flex;align-items:center;justify-content:center;gap:5px;width:100%;flex:0 0 auto;margin-top:10px;padding-top:11px;border:none;border-top:1px solid var(--ba-border);background:none;color:var(--ba-ink-soft);font-size:11px;font-weight:650;cursor:pointer}",
      ".ba-adv-toggle:hover{color:var(--ba-accent)}",
      ".ba-adv{display:none;margin-top:8px}",
      ".ba-adv.open{display:block}",
      ".ba-field{display:grid;grid-template-columns:96px 1fr;align-items:center;gap:9px;margin:9px 0;font-size:12px}",
      ".ba-field span{color:var(--ba-ink-mid);font-weight:650}",
      ".ba-control,.ba-field input[type=text],.ba-field select{width:100%;min-width:0;height:32px;border:1px solid var(--ba-border-in);border-radius:8px;padding:0 9px;background:var(--ba-card);color:var(--ba-ink);outline:none;font-size:11px}",
      ".ba-swatches{display:flex;align-items:center;gap:7px;min-height:32px;flex-wrap:wrap}",
      ".ba-sw{width:22px;height:22px;border-radius:50%;padding:0;border:none;cursor:pointer;box-shadow:0 0 0 1px var(--ba-border-in) inset;transition:transform .12s ease}",
      ".ba-sw:hover{transform:scale(1.12)}",
      ".ba-sw[aria-pressed=\"true\"]{box-shadow:0 0 0 2px var(--ba-card),0 0 0 4px var(--ba-accent)}",
      ".ba-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:12px}",
      ".ba-actions button{height:32px;border:1px solid var(--ba-border-in);border-radius:8px;background:var(--ba-card);color:var(--ba-ink);padding:0 11px;cursor:pointer;font-size:12px;font-weight:700}",
      ".ba-actions button.primary{border-color:var(--ba-accent);background:var(--ba-accent);color:#fff}",
      ".ba-mini{font-size:11px;color:var(--ba-ink-soft);margin:8px 0 0;line-height:1.4}"
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

    // Header: ⚡ mark + theme toggle (left), language toggle (right). The product
    // name is dropped — the mark carries identity and frees room for the toggle.
    const head = document.createElement("div");
    head.className = "ba-head";
    head.innerHTML = "<svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path fill=\"currentColor\" d=\"M13 2 4 14h7l-1 8 10-13h-7l1-7Z\"/></svg>";

    // Theme toggle (sun | moon). Tapping a side picks it explicitly; the thumb
    // sits on the resolved side until then. Default stays "system".
    const themeSeg = createSegToggle("ba-theme-seg", [
      { html: SUN_SVG, value: "light", label: t("themeLight") },
      { html: MOON_SVG, value: "dark", label: t("themeDark") }
    ], resolveTheme() === "dark" ? 1 : 0, function (value) {
      saveConfig(Object.assign({}, config, { theme: value }));
      applyTheme();
    });
    head.appendChild(themeSeg);

    // Language toggle (EN | 中), pushed to the right edge of the header.
    const langSeg = createSegToggle("ba-lang-seg", [
      { html: "EN", value: "en" },
      { html: "中", value: "zh" }
    ], lang() === "zh" ? 1 : 0, function (value) {
      if (config.lang === value) {
        return;
      }
      saveConfig(Object.assign({}, config, { lang: value }));
      applyLang();
    });
    langSeg.classList.add("ba-seg-end");
    head.appendChild(langSeg);

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

    // Live speed card
    const speedCard = document.createElement("div");
    speedCard.id = "ba-speed";
    speedCard.className = "ba-speed empty";
    const speedTop = document.createElement("div");
    speedTop.className = "ba-speed-top";
    const speedLabel = document.createElement("span");
    speedLabel.className = "ba-speed-label";
    speedLabel.id = "ba-spd-label";
    speedLabel.textContent = t("spdTitle");
    const speedVal = document.createElement("span");
    speedVal.className = "ba-speed-val";
    const speedNow = document.createElement("b");
    speedNow.id = "ba-spd-now";
    speedNow.textContent = "0.0";
    const speedUnit = document.createElement("span");
    speedUnit.id = "ba-spd-unit";
    speedUnit.textContent = t("spdUnit");
    speedVal.appendChild(speedNow);
    speedVal.appendChild(speedUnit);
    speedTop.appendChild(speedLabel);
    speedTop.appendChild(speedVal);
    const speedCanvas = document.createElement("canvas");
    speedCanvas.id = "ba-spd-canvas";
    speedCanvas.className = "ba-spd-canvas";
    const speedFoot = document.createElement("div");
    speedFoot.className = "ba-spd-foot";
    speedFoot.id = "ba-spd-foot";
    const speedEmpty = document.createElement("div");
    speedEmpty.className = "ba-spd-empty";
    speedEmpty.dataset.i18n = "spdWaiting";
    speedEmpty.textContent = t("spdWaiting");
    speedCard.appendChild(speedTop);
    speedCard.appendChild(speedCanvas);
    speedCard.appendChild(speedFoot);
    speedCard.appendChild(speedEmpty);

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

    adv.appendChild(createSwatchField("fAccent", createAccentPicker()));
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
    body.appendChild(speedCard);
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
      if (panel.classList.contains("open")) {
        drawSpeed();
        updateSpeedReadouts();
      }
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
    applyTheme();
    watchSystemTheme();
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
        applyTheme();
      }
    });
  }

  root.BiliAccelerator = {
    getConfig: function () { return Object.assign({}, config); },
    setConfig: function (next) { saveConfig(Object.assign({}, config, next || {})); renderStatus(); applyTheme(); return this.getConfig(); },
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
  patchGlobalPlayInfo("__NEPTUNE_IS_MY_WAIFU__"); // live room initial state
  installP2PGuard();
  installConfigBridge();

  function bootstrapUi() {
    installUi();
    installImmersiveWatch();
    installSpeedMeter();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootstrapUi, { once: true });
  } else {
    bootstrapUi();
  }

  console.info("[BiliAccelerator] installed", root.BiliAccelerator.getConfig());
})(typeof globalThis !== "undefined" ? globalThis : window);
