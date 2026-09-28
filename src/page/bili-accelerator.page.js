(function installBiliAccelerator(root) {
  "use strict";

  const core = root.BiliAcceleratorCore;
  const routing = root.BiliAcceleratorRouting;
  if (!core || !routing || root.__BILI_ACCELERATOR_INSTALLED__) {
    return;
  }
  root.__BILI_ACCELERATOR_INSTALLED__ = true;

  const VERSION = "0.5.0";
  const STORAGE_KEY = "biliAccelerator.config.v2";
  const LEGACY_KEY = "biliAccelerator.config.v1";
  // Per-host history of measured delivery, per region. It only orders the
  // hosts a race tries; nothing is ever picked from it without a race.
  const HISTORY_PREFIX = "biliAccelerator.hosts.v1.";
  // Rankings cached by 0.4.x. Nothing reads them any more.
  const LEGACY_RANK_PREFIX = "biliAccelerator.rank.";
  const BUTTON_ID = "bili-accelerator-button";
  const PANEL_ID = "bili-accelerator-panel";
  const IMMERSED_CLASS = "ba-immersed";
  const LIFTED_CLASS = "ba-lifted";
  const REVEAL_HOTZONE = 150;
  const REVEAL_TIMEOUT = 2600;
  const STALL_GRACE_MS = 2500;
  const ENGINE_TICK_MS = 500;
  // After a synthetic timeout the player retries the same range at once. If
  // no retry shows up this soon, the technique isn't working in this browser
  // and the page stops using it.
  const RETRY_WINDOW_MS = 3000;
  // A request that fails on the active host sends its retry elsewhere for this
  // long, so taking over routing never disables the player's own failover.
  const AVOID_MS = 3000;
  const MANUAL_SPACING_MS = 10000;
  const VERDICT_NOTE_MS = 12000;
  const MAX_SESSIONS = 4;

  const nativeJsonParse = JSON.parse;
  const nativeFetch = root.fetch;
  const NativeXHR = root.XMLHttpRequest;

  let immersive = false;
  let revealTimer = null;
  let playerObserver = null;
  let observedContainer = null;
  let watchedVideo = null;
  let stallTimer = null;

  const state = {
    rewrites: [],
    rewriteCount: 0,
    lastSource: "",
    status: "idle",
    stalls: 0,
    switches: 0,
    races: 0,
    p2pBlocked: 0,
    // Distinct P2P/PCDN hosts kept out of playback, for the panel's count.
    p2pAvoided: {},
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
      "--ba-slider-off": "#c9d3dd", "--ba-panel-shadow": "rgba(21,32,43,.24)",
      "--ba-chevron": "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%236b7785' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E\")"
    },
    dark: {
      "--ba-surface": "rgba(22,26,32,.975)", "--ba-card": "#1c222b",
      "--ba-border": "#2b323d", "--ba-border-in": "#38414d",
      "--ba-ink": "#e8edf2", "--ba-ink-strong": "#f4f7fa", "--ba-ink-mid": "#b9c3ce",
      "--ba-ink-soft": "#93a0ac", "--ba-ink-faint": "#6f7b87",
      "--ba-dot-bg": "#262d37", "--ba-dot": "#6f7b87",
      "--ba-good-bg": "rgba(25,169,116,.16)", "--ba-good": "#2ed3a0",
      "--ba-warn-bg": "rgba(232,145,12,.16)", "--ba-warn": "#f0a838",
      "--ba-slider-off": "#3a434f", "--ba-panel-shadow": "rgba(0,0,0,.5)",
      "--ba-chevron": "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%2393a0ac' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E\")"
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

  function loadHistory() {
    try {
      const raw = root.localStorage.getItem(HISTORY_PREFIX + regionKey());
      const parsed = raw ? JSON.parse(raw) : null;
      return parsed && typeof parsed === "object" && parsed.hosts && typeof parsed.hosts === "object"
        ? parsed
        : { hosts: {} };
    } catch (_) {
      return { hosts: {} };
    }
  }

  function saveHistory() {
    try {
      root.localStorage.setItem(HISTORY_PREFIX + regionKey(), JSON.stringify(engine.history));
    } catch (_) {
      // best effort; history only orders race contenders.
    }
  }

  function dropLegacyRankings() {
    try {
      const store = root.localStorage;
      const doomed = [];
      for (let i = 0; i < store.length; i += 1) {
        const key = store.key(i);
        if (key && key.indexOf(LEGACY_RANK_PREFIX) === 0) {
          doomed.push(key);
        }
      }
      doomed.forEach(function (key) { store.removeItem(key); });
    } catch (_) {}
  }

  // ---- rewrite plumbing ---------------------------------------------------

  const P2P_REASONS = ["pcdn-host", "mcdn-host", "mcdn-proxy", "szbdyd-source", "live-pcdn-filter", "pcdn-promote"];

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
      const fromHost = core.hostOf(item.original);
      if (fromHost && P2P_REASONS.indexOf(item.reason) !== -1) {
        state.p2pAvoided[fromHost] = true;
      }
      return {
        at: new Date().toISOString(),
        source,
        reason: item.reason,
        fromHost,
        toHost: core.hostOf(item.url)
      };
    })).slice(-50);
    if (state.status === "idle") {
      state.status = "smooth";
    }
    renderStatus();
  }

  // The config the per-URL rules run with. Fixed selection uses the settings as
  // saved. Auto selection only keeps P2P, PCDN and MCDN off playback: which
  // healthy host serves the video is the routing engine's call, made from
  // measurements, so force mode, the Akamai rewrite and a saved target host
  // don't apply there.
  function rewriteConfig() {
    if (config.selection !== "auto") {
      return config;
    }
    return Object.assign({}, config, {
      mode: config.mode === "off" ? "off" : "bad-only",
      rewriteAkamai: false,
      pcdnHost: core.DEFAULT_CONFIG.pcdnHost
    });
  }

  function isUsableUrl(value) {
    try {
      const url = new URL(value);
      const verdict = core.classify(url, config);
      return !verdict.isPcdn && !verdict.isMcdn && verdict.kind !== "scheduler";
    } catch (_) {
      return false;
    }
  }

  // When Bilibili hands out a PCDN node as a representation's base URL and a
  // proper CDN URL as its backup, use the backup: it is issued, signed for its
  // own host, and needs no host swap. The player's own filterPdn does the same
  // under some conditions.
  function promoteIssued(payload, tracker) {
    if (config.selection !== "auto" || !config.enabled || config.mode === "off") {
      return;
    }
    routing.dashContainers(payload).forEach(function (dash) {
      ["video", "audio"].forEach(function (kind) {
        (Array.isArray(dash[kind]) ? dash[kind] : []).forEach(function (entry) {
          if (!entry || typeof entry !== "object") {
            return;
          }
          const baseKey = typeof entry.baseUrl === "string" ? "baseUrl" : "base_url";
          const backupKey = baseKey === "baseUrl" ? "backupUrl" : "backup_url";
          const base = entry[baseKey];
          const backups = Array.isArray(entry[backupKey]) ? entry[backupKey] : [];
          if (typeof base !== "string" || isUsableUrl(base)) {
            return;
          }
          const index = backups.findIndex(function (u) { return typeof u === "string" && isUsableUrl(u); });
          if (index === -1) {
            return;
          }
          const promoted = backups[index];
          entry[baseKey] = promoted;
          entry[backupKey] = backups.slice(0, index).concat(backups.slice(index + 1));
          tracker.changed = true;
          tracker.rewrites.push({ changed: true, original: base, url: promoted, reason: "pcdn-promote" });
        });
      });
    });
  }

  // Every playurl goes through the same steps, in this order: the engine reads
  // the URLs as issued, a PCDN base gives way to an issued backup, and then the
  // per-URL rules run.
  function rewritePlayurl(payload, tracker) {
    ingestPlayurl(payload);
    promoteIssued(payload, tracker);
    return core.rewriteObject(payload, rewriteConfig(), tracker);
  }

  function rewritePayload(payload, source) {
    const tracker = { changed: false, rewrites: [] };
    try {
      const rewritten = rewritePlayurl(payload, tracker);
      record(tracker.rewrites, source);
      filterLivePcdn(rewritten, source);
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

  // Where one outgoing media request goes: the per-URL rules first (P2P,
  // PCDN, MCDN; in fixed mode also the fixed host), then, in auto mode, the
  // routing engine once it has taken over this video.
  function routeRequestUrl(rawUrl) {
    if (!core.hasMediaSignal(rawUrl)) {
      return rawUrl;
    }
    let url = rawUrl;
    try {
      const detail = core.rewriteUrlDetail(rawUrl, rewriteConfig());
      if (detail.changed) {
        record([detail], "segment");
        url = detail.url;
      }
    } catch (_) {
      return rawUrl;
    }
    try {
      return engineRoute(url);
    } catch (_) {
      return url;
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
        const swapped = routeRequestUrl(reqUrl);
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
            rewritePlayurl(parsed, tracker);
            live = core.filterLiveUrlInfo(parsed, config);
          } catch (_) {
            return response;
          }
          if (!tracker.changed && !live.changed) {
            return response;
          }
          record(tracker.rewrites, "fetch");
          record(live.rewrites, "fetch");
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
    const setRequestHeader = NativeXHR.prototype.setRequestHeader;

    NativeXHR.prototype.open = function patchedOpen(method, url) {
      const urlStr = typeof url === "string"
        ? url
        : (url && typeof url.href === "string" ? url.href : "");
      let finalUrl = url;
      if (config.enabled && urlStr && core.hasMediaSignal(urlStr)) {
        finalUrl = routeRequestUrl(urlStr);
      }
      this.__baAccel = { url: urlStr, finalUrl: typeof finalUrl === "string" ? finalUrl : urlStr, range: null };
      return open.apply(this, [method, finalUrl].concat([].slice.call(arguments, 2)));
    };

    // The player sends its byte range as a header; the engine needs it to know
    // which fragment a request carries and how big it is.
    if (typeof setRequestHeader === "function") {
      NativeXHR.prototype.setRequestHeader = function patchedSetRequestHeader(name, value) {
        if (this.__baAccel && /^range$/i.test(String(name))) {
          this.__baAccel.range = String(value);
        }
        return setRequestHeader.apply(this, arguments);
      };
    }

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
        // The same request, as the routing engine sees it. Listeners only:
        // the player's own handlers are properties and stay untouched.
        let req = null;
        try {
          req = beginRequest(xhr, meta);
        } catch (_) {
          req = null;
        }
        if (req) {
          xhr.addEventListener("progress", function onProgress(event) {
            if (event && typeof event.loaded === "number") {
              noteProgress(req, event.loaded);
            }
          });
          xhr.addEventListener("abort", function onAbort() { req.aborted = true; });
          xhr.addEventListener("loadend", function onEnd(event) {
            endRequest(req, xhr.status, event && typeof event.loaded === "number" ? event.loaded : 0);
          });
        }
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
            rewritePlayurl(parsed, tracker);
            const live = core.filterLiveUrlInfo(parsed, config);
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

  // ---- VOD routing --------------------------------------------------------
  //
  // docs/vod-routing.md has the measurements behind this. The player is a
  // dash.js fork that already fails over between the URLs it was issued, but
  // only on errors and timeouts. It can't see a host that answers at once and
  // then delivers below the stream's bitrate, which is what an overseas edge
  // does while it relays a file it hasn't cached. So the engine watches the
  // player's own fragment downloads; when the host can't keep up it races two
  // alternatives on the bytes the player needs next, routes the rest of the
  // video to the winner, and stays there. A single fragment that hangs on a
  // host that has been keeping up is retried on the winner, and the video
  // stays put.

  const engine = {
    sessions: new Map(),        // cid -> session, one per video on the page
    current: null,              // the session whose video fragments came last
    history: loadHistory(),
    synthetic: { used: 0, disabled: false, pending: null, noRetry: 0 },
    hiddenSince: null,
    hiddenSpans: [],
    stalling: false,
    timer: null,
    rendered: ""
  };

  function autoRouting() {
    return config.enabled && config.mode !== "off" && config.selection === "auto";
  }

  // Races need Auto-switch on and a real player page. Hover previews on the
  // home page load playurls too, and racing for a muted thumbnail would only
  // cost bandwidth.
  function switchingAllowed() {
    return autoRouting() && config.stallRecovery && isPlayerPage();
  }

  function isPlayerPage() {
    let path = "";
    try {
      path = root.location.pathname || new URL(root.location.href).pathname;
    } catch (_) {
      path = "";
    }
    return /^\/(?:video|bangumi\/play|list|medialist\/play|festival|cheese\/play)\//.test(path || "");
  }

  function newSession(cid) {
    return {
      cid,
      table: { cid, reps: {} },
      requiredBps: 0,
      assigned: null,        // the host the player used first
      lastHost: null,        // the host of the latest video request
      active: null,          // where the engine routes; null leaves the player's URLs alone
      fallback: null,
      avoid: null,
      detour: null,          // { host, until }: a stuck fragment's retry, while the video stays
      lastVideoKey: null,
      ends: {},              // file -> end of the last completed video range
      hosts: {},
      requested: {},         // "file|start" -> seen, to tell a retry from a first attempt
      inflight: [],
      racing: null,
      nextRaceAt: 0,
      cooldownMs: 0,
      manualAt: -Infinity,
      failed: {},
      lost: {},
      measured: {},
      races: [],
      switches: [],
      stalls: 0,
      verdict: null
    };
  }

  function sessionFor(cid) {
    let session = engine.sessions.get(cid);
    if (!session) {
      session = newSession(cid);
      engine.sessions.set(cid, session);
      if (engine.sessions.size > MAX_SESSIONS) {
        const oldest = engine.sessions.keys().next().value;
        if (engine.sessions.get(oldest) !== engine.current) {
          engine.sessions.delete(oldest);
        }
      }
    }
    return session;
  }

  // Every DASH playurl the page receives, before anything is rewritten: the
  // issued URLs are what reaches Akamai at all, and what a host swap borrows
  // its signature from.
  function ingestPlayurl(payload) {
    if (!config.enabled || !payload || typeof payload !== "object") {
      return;
    }
    let table = null;
    try {
      table = routing.buildTable(payload, isUsableUrl);
    } catch (_) {
      table = null;
    }
    if (!table || !table.cid) {
      return;
    }
    const session = sessionFor(table.cid);
    // A refresh of the same video brings fresh signatures; take them.
    Object.keys(table.reps).forEach(function (key) {
      session.table.reps[key] = table.reps[key];
    });
  }

  function hostStats(session, host) {
    if (!session.hosts[host]) {
      session.hosts[host] = {
        est: routing.createEstimator(), requests: 0, bytes: 0, errors: [], ttfbs: []
      };
    }
    return session.hosts[host];
  }

  function hostOfUrl(value) {
    try {
      return new URL(value, root.location.href).host.toLowerCase();
    } catch (_) {
      return "";
    }
  }

  function beginRequest(xhr, meta) {
    const url = meta.finalUrl || meta.url;
    const key = routing.fileKey(url);
    const cid = routing.cidOf(key);
    if (!key || !cid || String(url).indexOf("/live-bvc/") !== -1) {
      return null;
    }
    const session = sessionFor(cid);
    const rep = session.table.reps[key];
    const kind = rep ? rep.kind : (routing.AUDIO_ID_RE.test(routing.repIdOf(key) || "") ? "audio" : "video");
    const range = routing.parseRange(meta.range);
    const start = range ? range.start : 0;
    const slot = key + "|" + start;
    const req = {
      xhr,
      session,
      key,
      kind,
      host: hostOfUrl(url),
      start,
      end: range && !isNaN(range.end) ? range.end : NaN,
      total: range && range.length > 0 ? range.length : NaN,
      startedAt: nowMs(),
      firstByteAt: null,
      loaded: 0,
      samples: [],
      retry: !!session.requested[slot],
      handed: false,
      raced: false,
      aborted: false,
      ended: false
    };
    session.requested[slot] = true;
    const pending = engine.synthetic.pending;
    if (pending && pending.slot === slot) {
      engine.synthetic.pending = null;
    }
    if (kind === "video") {
      // Nothing to watch until a video fragment is actually requested.
      startEngine();
      engine.current = session;
      session.lastVideoKey = key;
      session.lastHost = req.host;
      if (!session.assigned) {
        session.assigned = req.host;
      }
      if (rep && rep.bandwidth > session.requiredBps) {
        session.requiredBps = rep.bandwidth;
      }
      session.inflight.push(req);
    }
    return req;
  }

  function noteProgress(req, loaded) {
    const now = nowMs();
    if (!req.firstByteAt && loaded > 0) {
      req.firstByteAt = now;
    }
    req.loaded = loaded;
    req.samples.push([now, loaded]);
    if (req.samples.length > 60) {
      req.samples.splice(0, req.samples.length - 60);
    }
  }

  function endRequest(req, status, loaded) {
    const session = req.session;
    req.ended = true;
    const index = session.inflight.indexOf(req);
    if (index !== -1) {
      session.inflight.splice(index, 1);
    }
    if (req.handed) {
      return;
    }
    const now = nowMs();
    // The player cancels fragments it no longer needs (a seek, a quality
    // change), which says nothing about the host. It also aborts a request
    // that got no first byte within its ~2 s deadline, and that one does.
    const missedDeadline = req.aborted && !req.firstByteAt && now - req.startedAt >= 1800;
    if (req.aborted && !missedDeadline) {
      return;
    }
    const stats = hostStats(session, req.host);
    stats.requests += 1;
    if (missedDeadline || !((status === 200 || status === 206) && loaded > 0)) {
      stats.errors.push(now);
      session.failed[req.host] = (session.failed[req.host] || 0) + 1;
      engine.history = routing.recordFailure(engine.history, req.host, Date.now());
      if (session.active && req.host === session.active) {
        session.avoid = { host: req.host, until: now + AVOID_MS };
      }
      return;
    }
    stats.bytes += loaded;
    // An init or index segment is a few KB and says nothing about throughput.
    if (loaded >= 128 * 1024) {
      session.measured[req.host] = true;
    }
    if (req.firstByteAt) {
      stats.ttfbs.push(req.firstByteAt - req.startedAt);
      if (stats.ttfbs.length > 30) {
        stats.ttfbs.shift();
      }
    }
    if (req.kind === "video") {
      if (!overlapsHidden(req.startedAt, now)) {
        stats.est.sample(now - req.startedAt, loaded);
      }
      if (!isNaN(req.end)) {
        session.ends[req.key] = Math.max(session.ends[req.key] == null ? -1 : session.ends[req.key], req.end);
      }
    }
  }

  // A transfer that overlapped a hidden period measured the browser's
  // background throttling, not the host.
  function overlapsHidden(from, to) {
    if (engine.hiddenSince !== null && to > engine.hiddenSince) {
      return true;
    }
    return engine.hiddenSpans.some(function (span) { return from < span[1] && to > span[0]; });
  }

  function engineRoute(url) {
    if (!autoRouting()) {
      return url;
    }
    const key = routing.fileKey(url);
    const session = key ? engine.sessions.get(routing.cidOf(key)) : null;
    const rep = session ? session.table.reps[key] : null;
    if (!rep) {
      return url;
    }
    // A stuck fragment is being retried on the host that won its race. The
    // player sends the retry to the next URL in its own list, so for these few
    // seconds everything goes there, whatever host the request names.
    if (session.detour && nowMs() < session.detour.until) {
      return routing.urlFor(rep, session.detour.host) || url;
    }
    if (!session.active) {
      return url;
    }
    let target = session.active;
    // The active host just failed a request: its retry goes to the runner-up,
    // or where the player sends it, as the player's own failover would.
    if (session.avoid && session.avoid.host === target && nowMs() < session.avoid.until) {
      target = session.fallback;
    }
    return (target && routing.urlFor(rep, target)) || url;
  }

  function bufferAhead() {
    try {
      const video = watchedVideo;
      if (!video || !video.buffered) {
        return 0;
      }
      const t = video.currentTime;
      for (let i = 0; i < video.buffered.length; i += 1) {
        if (video.buffered.start(i) <= t + 0.3 && video.buffered.end(i) > t) {
          return video.buffered.end(i) - t;
        }
      }
    } catch (_) {}
    return 0;
  }

  function startEngine() {
    if (!engine.timer && typeof setInterval === "function") {
      engine.timer = setInterval(engineTick, ENGINE_TICK_MS);
    }
  }

  function engineTick() {
    const now = nowMs();
    const pending = engine.synthetic.pending;
    if (pending && now > pending.deadline) {
      // The player didn't retry the range it was handed a timeout for. Stop
      // doing that on this page; switches still apply to later requests.
      engine.synthetic.pending = null;
      engine.synthetic.disabled = true;
      engine.synthetic.noRetry += 1;
    }
    const session = engine.current;
    if (session && !document.hidden && switchingAllowed() && !session.racing &&
        now >= session.nextRaceAt && session.switches.length < routing.MAX_SWITCHES) {
      const host = session.active || session.lastHost;
      if (host) {
        const stats = hostStats(session, host);
        const verdict = routing.evaluate({
          now,
          requiredBps: session.requiredBps,
          bufferAheadS: bufferAhead(),
          // Only requests on the host the video is on say anything about it. A
          // retry sent elsewhere for a moment is left to the player's own timeouts.
          inflight: session.inflight.filter(function (r) {
            return r.kind === "video" && !r.handed && !r.raced && r.host === host;
          })
            .map(function (r) {
              return {
                total: r.total, loaded: r.loaded, startedAt: r.startedAt, firstByteAt: r.firstByteAt,
                rateBps: routing.recentRate(r.samples, now, 1000), ref: r
              };
            }),
          estimateBps: stats.est.estimate(),
          measuredBytes: stats.est.bytes(),
          measuredMs: stats.est.ms(),
          recentErrors: recentErrors(stats, now)
        });
        if (verdict) {
          startRace(session, verdict.trigger, verdict.req ? verdict.req.ref : null);
        }
      }
    }
    refreshStatus();
  }

  // Errors within the window, or only those before a given time.
  function recentErrors(stats, now, before) {
    return stats.errors.filter(function (t) {
      return now - t < routing.ERROR_WINDOW_MS && !(t >= before);
    }).length;
  }

  function startRace(session, trigger, stuckReq) {
    if (typeof nativeFetch !== "function") {
      return false;
    }
    const key = stuckReq ? stuckReq.key : session.lastVideoKey;
    const rep = key ? session.table.reps[key] : null;
    const current = session.active || session.lastHost;
    if (!rep || !current) {
      return false;
    }
    if (stuckReq && trigger === "stuck") {
      // Its bytes are raced once; after that the player's timeouts have it.
      stuckReq.raced = true;
    }
    const start = stuckReq ? stuckReq.start : (session.ends[key] != null ? session.ends[key] + 1 : NaN);
    if (!(start >= 0)) {
      return false;
    }
    let end = start + routing.RACE_BYTES - 1;
    if (stuckReq && stuckReq.end >= start) {
      end = Math.min(end, stuckReq.end);
    }
    const wall = Date.now();
    const now = nowMs();
    const challengers = routing.pickChallengers({
      candidates: routing.candidatesFor(rep, config.candidatePool),
      current,
      issued: rep.issued,
      measured: session.measured,
      failed: session.failed,
      lost: session.lost,
      history: engine.history,
      now: wall
    });
    let currentRate = 0;
    if (trigger !== "errors") {
      currentRate = stuckReq
        ? (stuckReq.loaded > 0 ? 8000 * stuckReq.loaded / Math.max(1, now - stuckReq.startedAt) : 0)
        : (hostStats(session, current).est.estimate() || 0);
    }
    const contenders = challengers.map(function (host) { return { host, url: routing.urlFor(rep, host) }; })
      .filter(function (c) { return c.url; });
    // A manual test with no measurement of the current host yet races it as
    // well, so every host is compared on the same bytes.
    const currentUrl = routing.urlFor(rep, current);
    if (trigger === "manual" && !(currentRate > 0) && currentUrl && contenders.length) {
      contenders.push({ host: current, url: currentUrl, incumbent: true });
    }
    if (!contenders.length) {
      concludeRace(session, trigger, [], currentRate, end - start + 1, current, null);
      return false;
    }
    session.racing = {
      trigger,
      compared: contenders.length + (contenders.some(function (c) { return c.incumbent; }) ? 0 : 1)
    };
    state.races += 1;
    renderStatus();
    runRace(contenders, start, end, function (late) {
      learnFromRace(session, late, true);
    }).then(function (results) {
      concludeRace(session, trigger, results, currentRate, end - start + 1, current, stuckReq);
    }, function () {
      session.racing = null;
    });
    return true;
  }

  // Fetch the same bytes from every contender at once and decide as soon as
  // the outcome is known: when the first challenger finishes, or, if the
  // current host is racing too, when it finishes or has taken SWITCH_GAIN
  // times the winner's time without finishing. Contenders still running then
  // get another second so their numbers reach history, and are cancelled.
  function runRace(contenders, start, end, onLate) {
    const expected = end - start + 1;
    return new Promise(function (resolve) {
      const t0 = nowMs();
      const results = contenders.map(function (c) {
        return { host: c.host, incumbent: !!c.incumbent, ok: false, status: 0, bytes: 0, ms: 0, cut: false, settled: false };
      });
      const incumbent = results.filter(function (r) { return r.incumbent; })[0] || null;
      const controllers = [];
      let left = results.length;
      let decided = false;
      let decideTimer = null;
      let cutTimer = null;
      let pendingAtDecision = [];
      const snapshot = function () { return results.map(function (r) { return Object.assign({}, r); }); };
      function decide() {
        if (decided) {
          return;
        }
        decided = true;
        if (decideTimer) {
          clearTimeout(decideTimer);
        }
        if (incumbent && !incumbent.settled) {
          incumbent.ms = nowMs() - t0;
        }
        pendingAtDecision = results.filter(function (r) { return !r.settled; }).map(function (r) { return r.host; });
        resolve(snapshot());
        cutTimer = setTimeout(function () {
          results.forEach(function (r, i) {
            if (!r.settled) {
              r.cut = true;
              try { if (controllers[i]) { controllers[i].abort(); } } catch (_) {}
            }
          });
        }, 1000);
      }
      function settle(i) {
        const r = results[i];
        r.settled = true;
        left -= 1;
        if (!decided) {
          if (r.incumbent || (r.ok && !incumbent)) {
            decide();
          } else if (r.ok && !decideTimer) {
            decideTimer = setTimeout(decide, Math.max(0, r.ms * routing.SWITCH_GAIN - (nowMs() - t0)));
          }
        }
        if (!left) {
          if (cutTimer) {
            clearTimeout(cutTimer);
          }
          if (!decided) {
            decide();
          } else if (onLate && pendingAtDecision.length) {
            // Only what was still running at the decision: the rest was
            // already learned from.
            onLate(snapshot().filter(function (x) { return pendingAtDecision.indexOf(x.host) !== -1; }));
          }
        }
      }
      contenders.forEach(function (c, i) {
        const ctl = typeof AbortController === "function" ? new AbortController() : null;
        controllers.push(ctl);
        const timer = setTimeout(function () {
          try { if (ctl) { ctl.abort(); } } catch (_) {}
        }, routing.RACE_TIMEOUT_MS);
        fetchRange(c.url, start, end, ctl, function (bytes) {
          results[i].bytes = bytes;
          results[i].ms = nowMs() - t0;
        }).then(function (r) {
          results[i].status = r.status;
          results[i].bytes = r.bytes;
          results[i].ms = nowMs() - t0;
          results[i].ok = (r.status === 206 || r.status === 200) && r.bytes >= Math.min(expected, 64 * 1024);
        }, function () {
          results[i].ms = nowMs() - t0;
        }).then(function () {
          clearTimeout(timer);
          settle(i);
        });
      });
    });
  }

  function fetchRange(url, start, end, ctl, onBytes) {
    const init = {
      method: "GET",
      mode: "cors",
      credentials: "omit",
      cache: "no-store",
      headers: { Range: "bytes=" + start + "-" + end }
    };
    if (ctl) {
      init.signal = ctl.signal;
    }
    return nativeFetch.call(root, url, init).then(function (response) {
      const status = response.status;
      const body = response.body;
      if (!body || typeof body.getReader !== "function") {
        return response.arrayBuffer().then(function (buf) { return { status, bytes: buf.byteLength }; });
      }
      const reader = body.getReader();
      let bytes = 0;
      function pump() {
        return reader.read().then(function (chunk) {
          if (chunk.done) {
            return { status, bytes };
          }
          bytes += chunk.value ? chunk.value.length : 0;
          onBytes(bytes);
          return pump();
        });
      }
      return pump();
    });
  }

  // What a race taught about each contender. At decision time only settled
  // contenders count; the rest are learned from when they finish or are cut.
  function learnFromRace(session, results, late) {
    const wall = Date.now();
    results.forEach(function (r) {
      if (!r.settled) {
        return;
      }
      if (r.ok || (r.cut && r.bytes >= 64 * 1024)) {
        engine.history = routing.recordSample(engine.history, r.host, r.bytes * 8 / 1000 / Math.max(1, r.ms), wall);
        session.measured[r.host] = true;
        if (late && r.ok && session.active && r.host !== session.active && !session.fallback) {
          session.fallback = r.host;
        }
      } else if (!r.cut) {
        engine.history = routing.recordFailure(engine.history, r.host, wall);
        session.failed[r.host] = (session.failed[r.host] || 0) + 1;
      }
    });
    if (late) {
      saveHistory();
    }
  }

  function concludeRace(session, trigger, results, currentRate, raceBytes, current, stuckReq) {
    session.racing = null;
    const wall = Date.now();
    const now = nowMs();
    learnFromRace(session, results, false);
    const challengers = results.filter(function (r) { return !r.incumbent; });
    const incumbent = results.filter(function (r) { return r.incumbent && r.ok; })[0];
    let baseRate = incumbent ? incumbent.bytes * 8000 / Math.max(1, incumbent.ms) : currentRate;
    let verdict;
    if (trigger === "stuck" && !incumbent) {
      // Errors from before the stuck request: if the player's own timeout
      // ended it during the race, that is this same hang, not an earlier one.
      const stats = hostStats(session, current);
      verdict = routing.stuckRaceVerdict(challengers, currentRate, stats.est.estimate(),
        recentErrors(stats, now, stuckReq ? stuckReq.startedAt : undefined), raceBytes);
      baseRate = verdict.hostRateBps;
    } else {
      verdict = routing.raceVerdict(challengers, baseRate, raceBytes);
    }
    const retryOn = verdict.retryOn || null;
    results.forEach(function (r) {
      if (!r.incumbent && r.host !== verdict.switchTo && r.host !== retryOn) {
        session.lost[r.host] = wall;
      }
    });
    session.races.push({
      at: new Date(wall).toISOString(),
      trigger,
      from: current,
      currentMbps: round1(baseRate / 1e6),
      stuckMbps: trigger === "stuck" ? round1(currentRate / 1e6) : undefined,
      contenders: results.map(function (r) {
        return {
          host: r.host, ok: r.ok, ms: Math.round(r.ms), kb: Math.round(r.bytes / 1024),
          status: r.status, incumbent: r.incumbent || undefined, cut: r.cut || undefined
        };
      }),
      switchTo: verdict.switchTo,
      retryOn: retryOn || undefined
    });
    if (session.races.length > 10) {
      session.races.shift();
    }
    if (verdict.switchTo) {
      // The host being left was measured too, by the request that started the
      // race or by its traffic: it lost, so it rests like any other loser, and
      // what it delivered goes into history.
      if (current && current !== verdict.switchTo) {
        session.measured[current] = true;
        session.lost[current] = wall;
        if (baseRate > 0) {
          engine.history = routing.recordSample(engine.history, current, baseRate / 1e6, wall);
        }
      }
      session.active = verdict.switchTo;
      session.fallback = verdict.runnerUp && verdict.runnerUp !== verdict.switchTo ? verdict.runnerUp : null;
      session.avoid = null;
      session.detour = null;
      session.verdict = null;
      session.switches.push({
        at: new Date(wall).toISOString(), from: current, to: verdict.switchTo, trigger,
        beforeMbps: round1(baseRate / 1e6)
      });
      state.switches += 1;
      session.cooldownMs = 0;
      session.nextRaceAt = now + routing.nextCooldown("switch", session.switches.length);
      if (trigger === "stuck" && stuckReq) {
        handTimeout(stuckReq);
      }
    } else if (retryOn && stuckReq) {
      // The video stays and only this fragment moves. The next race may
      // start once the retry is under way, and by then the hang counts
      // against the host, whether our timeout or the player's ended it.
      retryStuck(session, current, retryOn, stuckReq);
      session.nextRaceAt = now + AVOID_MS;
    } else {
      session.cooldownMs = routing.nextCooldown("none", 0, session.cooldownMs);
      session.nextRaceAt = now + session.cooldownMs;
      session.verdict = {
        at: now, tested: results.length + (incumbent ? 0 : 1), rateBps: baseRate, manual: trigger === "manual"
      };
    }
    if (trigger === "manual") {
      session.manualAt = now;
    }
    saveHistory();
    renderStatus();
  }

  // End a stuck fragment request the way the player's own total timeout
  // would. Its handlers are properties set before send(): detach them, abort
  // the request natively so none of them hears it, then call its ontimeout
  // and onloadend. The player retries the range at once, and the retry is
  // routed to the host that just won. A native abort() alone won't do: the
  // loader takes an abort as deliberate and would run both its abort path and,
  // through onloadend, its retry path.
  function handTimeout(req) {
    const xhr = req.xhr;
    // A race can outlast the request: the player's own timeout may have ended
    // it already, and after abort() readyState reads 0, not 4.
    if (engine.synthetic.disabled || req.retry || req.handed || req.ended || !xhr || xhr.readyState === 4) {
      return false;
    }
    const onTimeout = xhr.ontimeout;
    const onEnd = xhr.onloadend;
    if (typeof onTimeout !== "function" || typeof onEnd !== "function") {
      return false;
    }
    req.handed = true;
    xhr.onload = null;
    xhr.onloadend = null;
    xhr.onerror = null;
    xhr.onprogress = null;
    xhr.onabort = null;
    xhr.ontimeout = null;
    xhr.onreadystatechange = null;
    try { xhr.abort(); } catch (_) {}
    engine.synthetic.used += 1;
    engine.synthetic.pending = { slot: req.key + "|" + req.start, deadline: nowMs() + RETRY_WINDOW_MS };
    try { onTimeout.call(xhr, progressEvent("timeout")); } catch (_) {}
    try { onEnd.call(xhr, progressEvent("loadend")); } catch (_) {}
    return true;
  }

  // Retry one stuck fragment on another host and leave the video where it is.
  // After a timeout, the player's own or ours, the player moves to the next
  // URL in its list for good, so leaving the video where it is means routing
  // it there from now on; a request that fails there retries on the winner.
  // The detour goes in before the timeout is handed over, because the player
  // may open its retry from inside the timeout handler. The hang counts
  // against its host like a failed request, so a second one within the error
  // window moves the video. When no timeout can be handed over (the player's
  // own timeout ended the request first, it is a retry, or synthetic timeouts
  // are off), the player's timeout does the retry and records the error.
  function retryStuck(session, current, host, req) {
    if (!session.active) {
      session.active = current;
    }
    session.fallback = host;
    session.detour = { host, until: nowMs() + AVOID_MS };
    if (!handTimeout(req)) {
      session.detour = null;
      return;
    }
    hostStats(session, req.host || current).errors.push(nowMs());
  }

  function progressEvent(type) {
    try {
      return new ProgressEvent(type);
    } catch (_) {
      return { type };
    }
  }

  // "测试其他线路": a race now, for the fragment in flight or the bytes after
  // the last one. It follows the same rule as an automatic race and never
  // saves anything.
  function retest() {
    const session = engine.current;
    if (!session || session.racing || !autoRouting() || nowMs() - session.manualAt < MANUAL_SPACING_MS) {
      return false;
    }
    const inflight = session.inflight.filter(function (r) {
      return r.kind === "video" && !r.handed && r.total >= 128 * 1024;
    })[0];
    return startRace(session, "manual", inflight || null);
  }

  // ---- playback state -----------------------------------------------------

  function handleStall() {
    // Browsers throttle media/MSE work in background tabs, which can make the
    // player emit a transient waiting/stalled event. A stall is counted only
    // once the page is visible (see onVisibilityChange). Stalls are recorded
    // for the panel; the routing engine acts on what the downloads show.
    stallTimer = null;
    if (document.hidden || !watchedVideo || watchedVideo.paused || watchedVideo.ended) {
      return;
    }
    if (watchedVideo.readyState >= 3) {
      return;
    }
    if (!engine.stalling) {
      engine.stalling = true;
      state.stalls += 1;
      if (engine.current) {
        engine.current.stalls += 1;
      }
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
    if (engine.stalling) {
      engine.stalling = false;
      renderStatus();
    }
  }

  function onVisibilityChange() {
    const now = nowMs();
    if (document.hidden) {
      if (engine.hiddenSince === null) {
        engine.hiddenSince = now;
      }
      if (stallTimer) {
        clearTimeout(stallTimer);
        stallTimer = null;
      }
      return;
    }
    if (engine.hiddenSince !== null) {
      engine.hiddenSpans.push([engine.hiddenSince, now]);
      if (engine.hiddenSpans.length > 20) {
        engine.hiddenSpans.shift();
      }
      engine.hiddenSince = null;
    }

    // A waiting event fired while hidden is deliberately ignored, and 'waiting'
    // does not re-fire for an element that is already waiting. Re-check once
    // foregrounded, so a stall that began hidden and is still unresolved gets
    // counted. The grace period keeps the brief readyState dip a tab switch
    // itself produces from counting: handleStall re-tests readyState first.
    if (watchedVideo && !watchedVideo.paused && !watchedVideo.ended &&
        watchedVideo.readyState < 3) {
      onWaiting();
    } else {
      onPlaying();
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

  function round1(value) {
    return Math.round((Number(value) || 0) * 10) / 10;
  }

  function median(list) {
    if (!list || !list.length) {
      return null;
    }
    const sorted = list.slice().sort(function (a, b) { return a - b; });
    return Math.round(sorted[Math.floor(sorted.length / 2)]);
  }

  // No URL, query string or video id: hosts, sizes and timings only.
  function sessionReport(session) {
    const hosts = {};
    Object.keys(session.hosts).forEach(function (host) {
      const s = session.hosts[host];
      const est = s.est.estimate();
      hosts[host] = {
        requests: s.requests,
        mb: round1(s.bytes / 1e6),
        mbps: est === null ? null : round1(est / 1e6),
        firstByteMs: median(s.ttfbs),
        errors: s.errors.length
      };
    });
    const issued = {};
    Object.keys(session.table.reps).forEach(function (key) {
      const rep = session.table.reps[key];
      issued[rep.kind + " " + rep.id + " " + String(rep.codecs || "").split(".")[0]] = rep.issued.slice();
    });
    return {
      requiredMbps: round1(session.requiredBps / 1e6),
      assignedHost: session.assigned,
      activeHost: session.active,
      bufferS: round1(bufferAhead()),
      stalls: session.stalls,
      hosts,
      issued,
      races: session.races.slice(),
      switches: session.switches.slice()
    };
  }

  function buildDiagnostics() {
    return {
      version: VERSION,
      installedAt: state.installedAt,
      region: regionKey().split("|")[0],   // timezone only — drop locale
      config,
      status: computeStatus().key,
      counters: {
        rewrites: state.rewriteCount,
        stalls: state.stalls,
        switches: state.switches,
        races: state.races,
        p2pAvoided: Object.keys(state.p2pAvoided).length,
        p2pBlocked: state.p2pBlocked
      },
      synthetic: {
        used: engine.synthetic.used,
        disabled: engine.synthetic.disabled,
        noRetry: engine.synthetic.noRetry
      },
      session: engine.current ? sessionReport(engine.current) : null,
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

  // Live rooms run a different player: no .bpx-player-container, no data-screen,
  // nothing detectScreenMode() can read (checked against a real room — a live
  // page has zero bpx-* elements). Without this the badge sits permanently over
  // the chat column.
  //
  // Kept separate from detectScreenMode() on purpose. That function answers
  // "what screen mode is the player in", and answering "web" for a live page
  // would also satisfy the setLifted() test below, nudging the badge to
  // bottom:84px on every live page as a side effect.
  function isLivePage() {
    const host = root.location && typeof root.location.hostname === "string"
      ? root.location.hostname.toLowerCase()
      : "";
    return host === "live.bilibili.com" || host === "live.bilibili.tv";
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
    setImmersive(mode === "web" || mode === "full" || isLivePage());
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
    document.addEventListener("visibilitychange", onVisibilityChange);
    ensurePlayerObserver();
    setInterval(ensurePlayerObserver, 1500);
  }

  // ---- UI -----------------------------------------------------------------

  const STRINGS = {
    en: {
      title: "Bilibili Accelerator",
      status: {
        off: ["Acceleration off", "Turn it on to move slow videos to faster servers"],
        idle: ["Ready", "Open a video and it'll kick in"],
        smooth: ["Playing smoothly", ""],
        testing: ["Testing other servers…", ""],
        buffering: ["Buffering", ""],
        slow: ["Slow network", ""]
      },
      notes: {
        native: function (server) { return "Native server · " + server; },
        switched: function (server) { return "Switched to " + server; },
        fixed: function (server) { return "Fixed server · " + server; },
        short: "The current server is too slow for this video",
        failing: "The current server is failing requests",
        stuck: "This part of the video is downloading too slowly",
        comparing: function (n) { return "Comparing " + n + " servers"; },
        keepingUp: "The server is keeping up; waiting for the player",
        measuring: "Measuring the current server",
        fastest: function (n) { return "Compared " + n + " servers; this one is fastest"; }
      },
      regions: { overseas: "Overseas", mainland: "Mainland" },
      vendors: { tencent: "Tencent Cloud", alibaba: "Alibaba Cloud", huawei: "Huawei Cloud", akamai: "Akamai" },
      switchCount: function (n) { return "Switched servers " + n + (n === 1 ? " time" : " times") + " on this video"; },
      p2pCount: function (n) { return "Kept " + n + " P2P node" + (n === 1 ? "" : "s") + " out of playback"; },
      spdTitle: "Download speed",
      spdUnit: "Mbps",
      spdPeak: "peak",
      spdBuffering: "seconds buffered ahead",
      bufTitle: "Buffer ahead",
      bufUnit: "s",
      spdWaiting: "Waiting for playback…",
      masterTitle: "Acceleration",
      masterNote: "Speed up slow videos automatically",
      retest: "Test other servers",
      advShow: "Advanced settings",
      advHide: "Hide advanced",
      fAccent: "Accent",
      themeLight: "Light theme", themeDark: "Dark theme",
      accents: {
        bili: "Bilibili Blue", teal: "Teal", emerald: "Emerald", violet: "Violet",
        pink: "Pink", sunset: "Sunset", graphite: "Graphite"
      },
      fServer: "Server", fWhen: "Apply to", fFixed: "Fixed server", fMcdn: "MCDN",
      selAuto: "Auto (by measurement)", selFixed: "Use a fixed server",
      hostCustom: "Custom…", fCustomHost: "Server address", hostPlaceholder: "Enter a server address",
      modeBad: "P2P/PCDN nodes only", modeForce: "All video requests",
      mcdnAll: "Proxy all MCDN", mcdnV1: "Proxy /v1 only", mcdnReplace: "Replace host",
      portTitle: "Catch hidden PCDN", portNote: "Treat odd ports as slow (recommended)",
      stallTitle: "Auto-switch servers", stallNote: "Switch when a server can't keep up",
      akamaiTitle: "Rewrite Akamai", akamaiNote: "Only if Akamai is slow on your network",
      p2pTitle: "Stop bandwidth sharing", p2pNote: "Block Bilibili's P2P upload (reload to apply)",
      diag: "Copy report", diagCopied: "Copied ✓", diagConsole: "See console",
      reload: "Reload"
    },
    zh: {
      title: "Bilibili Accelerator",
      status: {
        off: ["已关闭加速", "打开后自动为慢视频选择更快的线路"],
        idle: ["就绪", "打开视频后自动生效"],
        smooth: ["播放流畅", ""],
        testing: ["正在测试其他线路…", ""],
        buffering: ["缓冲中", ""],
        slow: ["网络较慢", ""]
      },
      notes: {
        native: function (server) { return "原生线路 · " + server; },
        switched: function (server) { return "已切换到 " + server; },
        fixed: function (server) { return "固定线路 · " + server; },
        short: "当前线路速度不足",
        failing: "当前线路请求失败",
        stuck: "当前片段下载过慢",
        comparing: function (n) { return "正在比较 " + n + " 条线路"; },
        keepingUp: "线路速度正常，等待播放器缓冲",
        measuring: "正在测量当前线路",
        fastest: function (n) { return "已比较 " + n + " 条线路，当前线路最快"; }
      },
      regions: { overseas: "海外", mainland: "大陆" },
      vendors: { tencent: "腾讯云", alibaba: "阿里云", huawei: "华为云", akamai: "Akamai" },
      switchCount: function (n) { return "本视频切换了 " + n + " 次线路"; },
      p2pCount: function (n) { return "已避开 " + n + " 个 P2P 节点"; },
      spdTitle: "下载速度",
      spdUnit: "Mbps",
      spdPeak: "峰值",
      spdBuffering: "已缓冲秒数",
      bufTitle: "缓冲时长",
      bufUnit: "秒",
      spdWaiting: "等待播放…",
      masterTitle: "加速",
      masterNote: "自动为慢视频提速",
      retest: "测试其他线路",
      advShow: "高级设置",
      advHide: "收起高级设置",
      fAccent: "主题色",
      themeLight: "浅色", themeDark: "深色",
      accents: {
        bili: "哔哩蓝", teal: "青碧", emerald: "翠绿", violet: "星紫",
        pink: "少女粉", sunset: "落日橙", graphite: "石墨灰"
      },
      fServer: "服务器", fWhen: "适用范围", fFixed: "固定服务器", fMcdn: "MCDN",
      selAuto: "自动（按实测选择）", selFixed: "使用固定服务器",
      hostCustom: "自定义…", fCustomHost: "服务器地址", hostPlaceholder: "请输入服务器地址",
      modeBad: "仅 P2P/PCDN 节点", modeForce: "所有视频请求",
      mcdnAll: "代理所有 MCDN", mcdnV1: "仅代理 /v1", mcdnReplace: "替换域名",
      portTitle: "抓取隐藏 PCDN", portNote: "把奇怪端口的服务器当作慢节点（推荐）",
      stallTitle: "自动切换线路", stallNote: "线路速度不足时，自动切换到更快的线路",
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

  // What the panel reports, from what the engine measured and did. Live pages
  // and pages without a video keep the simple states.
  function computeStatus() {
    if (!config.enabled) {
      return { key: "off", legacy: true };
    }
    const session = engine.current;
    if (!session || isLivePage()) {
      return { key: state.status === "smooth" ? "smooth" : "idle", legacy: true };
    }
    const host = session.active || session.lastHost;
    const stats = host ? session.hosts[host] : null;
    const rateBps = stats ? stats.est.estimate() : null;
    const info = {
      key: "smooth",
      session,
      host,
      rateBps,
      // Below what the stream needs, by the same margin a shortfall race uses.
      short: rateBps !== null && session.requiredBps > 0 &&
        rateBps < routing.SHORTFALL_RATE_FACTOR * session.requiredBps,
      // A retry can pin the video to the host it is on without switching it.
      switched: session.switches.length > 0 && !!session.active && session.active !== session.assigned
    };
    if (session.racing) {
      info.key = "testing";
    } else if (engine.stalling) {
      info.key = "buffering";
    } else if (session.verdict && info.short) {
      info.key = "slow";
    }
    if (session.verdict && (info.key === "slow" ||
        (session.verdict.manual && nowMs() - session.verdict.at < VERDICT_NOTE_MS))) {
      info.verdict = session.verdict;
    }
    return info;
  }

  // "海外 · 腾讯云" rather than upos-sz-mirrorcosov.bilivideo.com.
  function hostLabel(host) {
    const d = routing.describeHost(host);
    const s = STRINGS[lang()];
    const vendor = d.vendor ? s.vendors[d.vendor] : d.id;
    return d.region ? s.regions[d.region] + " · " + vendor : vendor;
  }

  // The status line says which server is in use and what happened, with no
  // rates: the speed card below it is the one place that shows one. The
  // engine's own estimate counts video fragments only, per request, and would
  // never match the card, which averages every media transfer over a few
  // seconds. Each note fits one line of the panel in both languages.
  function statusNote(info) {
    const s = STRINGS[lang()];
    if (info.legacy || !info.session) {
      return s.status[info.key] ? s.status[info.key][1] : s.status.idle[1];
    }
    const n = s.notes;
    const server = info.host ? hostLabel(info.host) : "";
    if (info.key === "testing") {
      const racing = info.session.racing;
      if (racing.trigger === "manual") {
        return n.comparing(racing.compared);
      }
      if (racing.trigger === "errors") {
        return n.failing;
      }
      return racing.trigger === "stuck" ? n.stuck : n.short;
    }
    if (info.key === "buffering") {
      if (info.rateBps === null) {
        return n.measuring;
      }
      return info.short ? n.short : n.keepingUp;
    }
    if (info.verdict) {
      return n.fastest(info.verdict.tested);
    }
    if (!server) {
      return n.measuring;
    }
    if (config.selection !== "auto") {
      return n.fixed(server);
    }
    return info.switched ? n.switched(server) : n.native(server);
  }

  function countText(info) {
    const s = STRINGS[lang()];
    const switches = info && info.session ? info.session.switches.length : 0;
    if (switches > 0) {
      return s.switchCount(switches);
    }
    const p2p = Object.keys(state.p2pAvoided).length;
    return p2p > 0 ? s.p2pCount(p2p) : "";
  }

  // Redraw when anything the panel shows would change: the state, the server,
  // the switch count, the verdict, or whether the server measures short (which
  // decides whether 测试其他线路 is offered).
  function refreshStatus() {
    const info = computeStatus();
    const signature = [info.key, info.host || "", info.session ? info.session.switches.length : 0,
      !!info.short, info.verdict ? info.verdict.at : 0].join("|");
    if (signature !== engine.rendered) {
      engine.rendered = signature;
      renderStatus();
    }
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
    shadow.querySelectorAll("[data-i18n-placeholder]").forEach(function (el) {
      el.placeholder = t(el.dataset.i18nPlaceholder);
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
    const info = computeStatus();
    const strings = STRINGS[lang()];
    const words = strings.status[info.key] || strings.status.idle;

    const dot = shadow.getElementById("ba-dot");
    const word = shadow.getElementById("ba-word");
    const note = shadow.getElementById("ba-note");
    const count = shadow.getElementById("ba-count");
    const retestButton = shadow.getElementById("ba-retest");
    const master = shadow.getElementById("ba-master");

    if (dot) {
      dot.className = "ba-dot ba-" + info.key;
    }
    if (word) {
      word.textContent = words[0];
    }
    if (note) {
      note.textContent = statusNote(info);
    }
    if (count) {
      count.textContent = countText(info);
    }
    if (master) {
      master.checked = config.enabled;
    }
    if (retestButton) {
      // Offered only when there is something to fix: this video stalled, or
      // the server measured below what the stream needs.
      const session = info.session;
      const relevant = !info.legacy && !!session && !session.racing && autoRouting() && isPlayerPage() &&
        (session.stalls > 0 || info.key === "buffering" || info.short);
      retestButton.style.display = relevant ? "block" : "none";
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
      ":host{--ba-accent:#00aeec;--ba-accent-strong:#0091cc;--ba-grad-a:#00b5f5;--ba-grad-b:#0091cc;--ba-accent-shadow:rgba(0,174,236,.42);--ba-surface:rgba(255,255,255,.97);--ba-card:#fff;--ba-border:#e5eaf0;--ba-border-in:#d5dde5;--ba-ink:#17202a;--ba-ink-strong:#111827;--ba-ink-mid:#46515c;--ba-ink-soft:#6b7785;--ba-ink-faint:#8a95a1;--ba-dot-bg:#eef2f6;--ba-dot:#9aa6b2;--ba-good-bg:#e6f8ee;--ba-good:#19a974;--ba-warn-bg:#fff4e0;--ba-warn:#e8910c;--ba-slider-off:#c9d3dd;--ba-panel-shadow:rgba(21,32,43,.24);--ba-chevron:url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%236b7785' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E\")}",
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
      ".ba-dot.ba-testing,.ba-dot.ba-buffering,.ba-dot.ba-slow{background:var(--ba-warn-bg)}.ba-dot.ba-testing:after,.ba-dot.ba-buffering:after,.ba-dot.ba-slow:after{background:var(--ba-warn)}",
      ".ba-dot.ba-off:after{background:var(--ba-dot)}",
      ".ba-word{font-size:15px;font-weight:800;color:var(--ba-ink)}",
      // Notes are written to fit one line. When one can't (a custom host name,
      // a narrow window), balance the two lines rather than leave a stub.
      ".ba-subnote{font-size:11px;color:var(--ba-ink-soft);margin-top:2px;line-height:1.4;text-wrap:balance}",
      ".ba-count{font-size:11px;color:var(--ba-ink-faint);margin-top:6px;text-wrap:balance}",
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
      ".ba-switch-row[hidden]{display:none}",
      ".ba-switch-text{display:grid;gap:2px}",
      ".ba-switch-title{font-size:13px;font-weight:750;color:var(--ba-ink)}",
      ".ba-switch-note{font-size:11px;color:var(--ba-ink-soft);line-height:1.3;text-wrap:balance}",
      ".ba-switch{position:relative;display:inline-flex;width:42px;height:24px;flex:0 0 auto}",
      ".ba-switch input{position:absolute;opacity:0;width:1px;height:1px}",
      ".ba-slider{position:absolute;inset:0;border-radius:999px;background:var(--ba-slider-off);cursor:pointer;transition:background .16s ease}",
      ".ba-slider:before{content:'';position:absolute;width:20px;height:20px;left:2px;top:2px;border-radius:50%;background:#fff;box-shadow:0 2px 6px rgba(0,0,0,.22);transition:transform .16s ease}",
      ".ba-switch input:checked+.ba-slider{background:var(--ba-accent)}",
      ".ba-switch input:checked+.ba-slider:before{transform:translateX(18px)}",
      ".ba-retest{display:none;width:100%;height:38px;margin-top:4px;border:1px solid var(--ba-accent);border-radius:10px;background:var(--ba-accent);color:#fff;font-size:13px;font-weight:700;cursor:pointer}",
      ".ba-retest:hover{background:var(--ba-accent-strong);border-color:var(--ba-accent-strong)}",
      ".ba-adv-toggle{display:flex;align-items:center;justify-content:center;gap:5px;width:100%;flex:0 0 auto;margin-top:10px;padding-top:11px;border:none;border-top:1px solid var(--ba-border);background:none;color:var(--ba-ink-soft);font-size:11px;font-weight:650;cursor:pointer}",
      ".ba-adv-toggle:hover{color:var(--ba-accent)}",
      ".ba-adv{display:none;margin-top:8px}",
      ".ba-adv.open{display:block}",
      ".ba-field{display:grid;grid-template-columns:96px 1fr;align-items:center;gap:9px;margin:9px 0;font-size:12px}",
      ".ba-field[hidden]{display:none}",
      ".ba-field span{color:var(--ba-ink-mid);font-weight:650}",
      ".ba-control,.ba-field input[type=text],.ba-field select{width:100%;min-width:0;height:32px;border:1px solid var(--ba-border-in);border-radius:8px;padding:0 9px;background:var(--ba-card);color:var(--ba-ink);outline:none;font-size:11px}",
      // Native <select> adds its own start inset on top of our padding (4px in
      // Chromium, 8px in WebKit), so its text never lined up with a text input.
      // Dropping the native appearance removes the inset; the chevron is ours.
      ".ba-field select{-webkit-appearance:none;appearance:none;padding-right:26px;background-image:var(--ba-chevron);background-repeat:no-repeat;background-position:right 8px center;background-size:8px 5px}",
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

    // Contextual action: one race now, for the fragment the player is on. It
    // follows the same rule as an automatic race and never saves anything.
    const retestButton = document.createElement("button");
    retestButton.id = "ba-retest";
    retestButton.className = "ba-retest";
    retestButton.type = "button";
    retestButton.dataset.i18n = "retest";
    retestButton.textContent = t("retest");
    retestButton.addEventListener("click", function () { retest(); });

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
      syncHostControls();
      renderStatus();
    });

    // What the fixed server is used for. In auto mode the routing engine picks
    // healthy hosts from measurements, so neither this nor the Akamai rewrite
    // applies there and both rows are hidden.
    const mode = createSelect([
      { value: "bad-only", key: "modeBad" },
      { value: "force", key: "modeForce" }
    ], config.mode, function (value) {
      saveConfig(Object.assign({}, config, { mode: value }));
      renderStatus();
    });
    const modeField = createField("fWhen", mode);
    const akamaiRow = createSwitchRow("akamaiTitle", "akamaiNote",
      config.rewriteAkamai, function (checked) {
        saveConfig(Object.assign({}, config, { rewriteAkamai: checked }));
      });

    const hostInput = document.createElement("input");
    hostInput.type = "text";
    hostInput.id = "ba-custom-host";
    hostInput.className = "ba-control";
    hostInput.dataset.i18nPlaceholder = "hostPlaceholder";
    hostInput.placeholder = t("hostPlaceholder");
    const customHostField = createField("fCustomHost", hostInput);
    const hostSelect = document.createElement("select");
    hostSelect.id = "ba-fixed-host";
    hostSelect.className = "ba-control";
    core.CANDIDATE_POOL.forEach(function (h) {
      const option = document.createElement("option");
      option.value = h;
      option.textContent = h;
      hostSelect.appendChild(option);
    });
    // This sentinel belongs only to the UI; never persist it as a host.
    hostSelect.appendChild(makeOption("custom", "hostCustom", ""));
    const fixedHostField = createField("fFixed", hostSelect);

    // Show the host in use. Only fixed mode displays these rows, and in fixed
    // mode nothing but these two controls changes pcdnHost.
    function syncHostControls() {
      const fixed = config.selection === "fixed";
      const listed = core.CANDIDATE_POOL.indexOf(config.pcdnHost) !== -1;
      hostSelect.value = listed ? config.pcdnHost : "custom";
      hostInput.value = config.pcdnHost;
      fixedHostField.hidden = !fixed;
      customHostField.hidden = !fixed || listed;
      modeField.hidden = !fixed;
      akamaiRow.hidden = !fixed;
    }
    syncHostControls();

    hostInput.addEventListener("change", function () {
      const value = hostInput.value.trim();
      if (value) {
        saveConfig(Object.assign({}, config, { pcdnHost: value }));
      }
      // An empty address is never saved: this puts the host in use back.
      syncHostControls();
    });
    hostSelect.addEventListener("change", function () {
      if (hostSelect.value === "custom") {
        customHostField.hidden = false;
        hostInput.focus();
        hostInput.select();
        return;
      }
      saveConfig(Object.assign({}, config, { pcdnHost: hostSelect.value }));
      syncHostControls();
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
    adv.appendChild(fixedHostField);
    adv.appendChild(customHostField);
    adv.appendChild(modeField);
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
    body.appendChild(retestButton);
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
    rewriteUrl: function (url) { return core.rewriteUrl(url, rewriteConfig()); },
    retest: function () { return retest(); }
  };

  dropLegacyRankings();
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
