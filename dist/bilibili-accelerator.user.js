// ==UserScript==
// @name         Bilibili Accelerator
// @name:zh-CN   Bilibili Accelerator - B站海外播放加速
// @namespace    https://github.com/realzza/bilibili-accelerator
// @version      0.1.3
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

(function installBiliAccelerator(root) {
  "use strict";

  const core = root.BiliAcceleratorCore;
  if (!core || root.__BILI_ACCELERATOR_INSTALLED__) {
    return;
  }
  root.__BILI_ACCELERATOR_INSTALLED__ = true;

  const STORAGE_KEY = "biliAccelerator.config.v1";
  const PANEL_ID = "bili-accelerator-panel";
  const BUTTON_ID = "bili-accelerator-button";
  const IMMERSED_CLASS = "ba-immersed";
  const REVEAL_HOTZONE = 150;
  const REVEAL_TIMEOUT = 2600;
  const nativeJsonParse = JSON.parse;
  let immersive = false;
  let revealTimer = null;
  let playerObserver = null;
  let observedContainer = null;
  const state = {
    rewrites: [],
    rewriteCount: 0,
    lastSource: "",
    installedAt: new Date().toISOString()
  };

  function loadConfig() {
    try {
      const stored = root.localStorage.getItem(STORAGE_KEY);
      return core.normalizeConfig(stored ? JSON.parse(stored) : null);
    } catch (_) {
      return core.normalizeConfig();
    }
  }

  let config = loadConfig();

  function saveConfig(nextConfig) {
    config = core.normalizeConfig(nextConfig);
    root.localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  }

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

    renderStatus();
  }

  function rewritePayload(payload, source) {
    const tracker = { changed: false, rewrites: [] };
    try {
      const rewritten = core.rewriteObject(payload, config, tracker);
      record(tracker.rewrites, source);
      return rewritten;
    } catch (error) {
      console.warn("[BiliAccelerator] rewrite failed", error);
      return payload;
    }
  }

  function isInterestingFetch(input) {
    const url = typeof input === "string" ? input : input && input.url;
    return typeof url === "string" &&
      (url.includes("/x/player") ||
        url.includes("/pgc/player") ||
        url.includes("playurl") ||
        url.includes("bilivideo"));
  }

  function patchJsonParse() {
    JSON.parse = function patchedJsonParse(text, reviver) {
      const parsed = nativeJsonParse.apply(this, arguments);
      if (typeof text === "string" && text.includes("bilivideo")) {
        return rewritePayload(parsed, "JSON.parse");
      }
      return parsed;
    };
  }

  function patchFetch() {
    if (!root.fetch) {
      return;
    }

    const nativeFetch = root.fetch;
    root.fetch = function patchedFetch() {
      const args = arguments;
      return nativeFetch.apply(this, args).then(function handleResponse(response) {
        if (!config.enabled || !isInterestingFetch(args[0])) {
          return response;
        }

        const contentType = response.headers && response.headers.get("content-type");
        if (contentType && !contentType.includes("json") && !contentType.includes("text")) {
          return response;
        }

        return response.clone().text().then(function rewriteText(text) {
          if (!text || !text.includes("bilivideo")) {
            return response;
          }

          let parsed;
          const tracker = { changed: false, rewrites: [] };
          try {
            parsed = nativeJsonParse(text);
            core.rewriteObject(parsed, config, tracker);
          } catch (_) {
            return response;
          }

          if (!tracker.changed) {
            return response;
          }

          record(tracker.rewrites, "fetch");
          const headers = new Headers(response.headers);
          headers.delete("content-length");
          return new Response(JSON.stringify(parsed), {
            status: response.status,
            statusText: response.statusText,
            headers
          });
        }).catch(function ignoreRewriteError() {
          return response;
        });
      });
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
        get: function getPlayInfo() {
          return currentValue;
        },
        set: function setPlayInfo(value) {
          currentValue = rewritePayload(value, name);
        }
      });
    } catch (_) {
      if (root[name]) {
        root[name] = rewritePayload(root[name], name);
      }
    }
  }

  function makeOption(value, label, selectedValue) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    option.selected = value === selectedValue;
    return option;
  }

  function createSelect(options, value, onChange) {
    const select = document.createElement("select");
    select.className = "ba-control";
    select.addEventListener("change", function handleChange() {
      onChange(select.value);
    });
    options.forEach(function addOption(option) {
      select.appendChild(makeOption(option.value, option.label, value));
    });
    return select;
  }

  function createField(labelText, control) {
    const label = document.createElement("label");
    label.className = "ba-field";
    const caption = document.createElement("span");
    caption.textContent = labelText;
    label.appendChild(caption);
    label.appendChild(control);
    return label;
  }

  function renderStatus() {
    const host = document.getElementById(BUTTON_ID);
    const status = host && host.shadowRoot && host.shadowRoot.getElementById("ba-status");
    const count = host && host.shadowRoot && host.shadowRoot.getElementById("ba-count");
    const indicator = host && host.shadowRoot && host.shadowRoot.getElementById("ba-indicator");
    if (!status) {
      return;
    }

    const last = state.rewrites[state.rewrites.length - 1];
    if (count) {
      count.textContent = String(state.rewriteCount);
    }
    if (indicator) {
      indicator.textContent = config.enabled ? "On" : "Off";
      indicator.className = config.enabled ? "ba-pill is-on" : "ba-pill";
    }
    status.textContent = last
      ? "Last rewrite: " + last.reason + " -> " + last.targetHost
      : "Waiting for Bilibili playback URLs.";
  }

  function panelIsOpen() {
    const host = document.getElementById(BUTTON_ID);
    return !!(host && host.shadowRoot && host.shadowRoot.querySelector(".ba-panel.open"));
  }

  function setBadgeHidden(hidden) {
    const host = document.getElementById(BUTTON_ID);
    if (!host) {
      return;
    }
    if (hidden) {
      host.classList.add(IMMERSED_CLASS);
    } else {
      host.classList.remove(IMMERSED_CLASS);
    }
  }

  // Show the badge, then fade it back out after a short idle window —
  // mirrors how the player's own controls behave in fullscreen.
  function revealBadge() {
    setBadgeHidden(false);
    if (revealTimer) {
      clearTimeout(revealTimer);
    }
    revealTimer = setTimeout(function hideAfterIdle() {
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
    // Hidden by default while immersive so it never covers the video;
    // restored immediately when leaving web/true fullscreen.
    setBadgeHidden(immersive && !panelIsOpen());
  }

  // Bilibili's modern player exposes its layout via data-screen on
  // .bpx-player-container (normal/wide/web/full/mini). The legacy player
  // uses a mode-webscreen class. Either signals an immersive layout.
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

  function refreshImmersive() {
    const mode = detectScreenMode();
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
    // The player mounts after this script runs and is recreated on SPA
    // navigation, so keep re-binding the observer to the live container.
    ensurePlayerObserver();
    setInterval(ensurePlayerObserver, 1500);
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
      "*{box-sizing:border-box}",
      "button,input,select{font:inherit}",
      ".ba-toggle{display:grid;place-items:center;width:40px;height:40px;border:1px solid rgba(255,255,255,.4);border-radius:50%;background:linear-gradient(135deg,#00b5f5,#0091cc);color:#fff;box-shadow:0 8px 22px rgba(0,174,236,.42),0 1px 0 rgba(255,255,255,.45) inset;cursor:pointer;padding:0;transition:transform .16s ease,box-shadow .16s ease}",
      ".ba-toggle:hover{transform:translateY(-1px);box-shadow:0 12px 28px rgba(0,174,236,.5),0 1px 0 rgba(255,255,255,.45) inset}",
      ".ba-toggle:active{transform:translateY(0)}",
      ".ba-toggle svg{width:20px;height:20px;display:block;filter:drop-shadow(0 1px 1px rgba(0,80,110,.35))}",
      ".ba-panel{display:none;position:absolute;right:0;bottom:48px;width:min(340px,calc(100vw - 36px));padding:14px;border:1px solid rgba(23,32,42,.12);border-radius:12px;background:rgba(255,255,255,.96);box-shadow:0 18px 46px rgba(21,32,43,.24);backdrop-filter:saturate(180%) blur(18px);-webkit-backdrop-filter:saturate(180%) blur(18px)}",
      ".ba-panel.open{display:block}",
      ".ba-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:12px}",
      ".ba-title{font-size:14px;font-weight:800;margin:0;line-height:1.25;color:#111827}",
      ".ba-subtitle{font-size:11px;line-height:1.35;color:#5b6773;margin:3px 0 0}",
      ".ba-pill{display:inline-flex;align-items:center;height:22px;border-radius:999px;background:#eef2f6;color:#5b6773;font-size:11px;font-weight:700;padding:0 8px;white-space:nowrap}",
      ".ba-pill.is-on{background:#e6f8ff;color:#0077a3}",
      ".ba-stats{display:grid;grid-template-columns:84px 1fr;gap:10px;align-items:center;border:1px solid #e5eaf0;border-radius:10px;background:#f7fafc;padding:10px;margin-bottom:12px}",
      ".ba-count{font-size:22px;line-height:1;font-weight:800;color:#00aeec;text-align:center}",
      ".ba-count-label{display:block;font-size:10px;font-weight:700;color:#6b7785;text-transform:uppercase;letter-spacing:.04em;margin-top:3px;text-align:center}",
      "#ba-status{font-size:11px;line-height:1.45;color:#34495e;word-break:break-word}",
      ".ba-field{display:grid;grid-template-columns:88px 1fr;align-items:center;gap:9px;margin:9px 0;font-size:12px}",
      ".ba-field span{color:#46515c;font-weight:650}",
      ".ba-control,.ba-field input[type=text],.ba-field select{width:100%;min-width:0;height:32px;border:1px solid #d5dde5;border-radius:8px;padding:0 9px;background:#fff;color:#17202a;outline:none;font-size:11px}",
      ".ba-control:focus,.ba-field input[type=text]:focus{border-color:#00aeec;box-shadow:0 0 0 3px rgba(0,174,236,.14)}",
      ".ba-switch-row{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:10px 0;padding:9px 10px;border:1px solid #e5eaf0;border-radius:10px;background:#fff}",
      ".ba-switch-text{display:grid;gap:2px}",
      ".ba-switch-title{font-size:12px;font-weight:750;color:#202a33}",
      ".ba-switch-note{font-size:11px;color:#6b7785;line-height:1.3}",
      ".ba-switch{position:relative;display:inline-flex;width:42px;height:24px;flex:0 0 auto}",
      ".ba-switch input{position:absolute;opacity:0;width:1px;height:1px}",
      ".ba-slider{position:absolute;inset:0;border-radius:999px;background:#c9d3dd;cursor:pointer;transition:background .16s ease}",
      ".ba-slider:before{content:'';position:absolute;width:20px;height:20px;left:2px;top:2px;border-radius:50%;background:#fff;box-shadow:0 2px 6px rgba(0,0,0,.22);transition:transform .16s ease}",
      ".ba-switch input:checked+.ba-slider{background:#00aeec}",
      ".ba-switch input:checked+.ba-slider:before{transform:translateX(18px)}",
      ".ba-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:12px}",
      ".ba-actions button{height:32px;border:1px solid #d5dde5;border-radius:8px;background:#fff;color:#25313d;padding:0 11px;cursor:pointer;font-size:12px;font-weight:700}",
      ".ba-actions button.primary{border-color:#00aeec;background:#00aeec;color:#fff}",
      ".ba-note{font-size:11px;line-height:1.4;color:#6b7785;margin:10px 0 0}"
    ].join("");

    const toggle = document.createElement("button");
    toggle.className = "ba-toggle";
    toggle.type = "button";
    toggle.title = "Bilibili Accelerator";
    toggle.setAttribute("aria-label", "Bilibili Accelerator");
    toggle.innerHTML = "<svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path fill=\"currentColor\" d=\"M13 2 4 14h7l-1 8 10-13h-7l1-7Z\"/></svg>";
    toggle.addEventListener("mouseenter", function handleToggleEnter() {
      if (immersive) {
        revealBadge();
      }
    });

    const panel = document.createElement("section");
    panel.className = "ba-panel";
    panel.id = PANEL_ID;

    const head = document.createElement("div");
    head.className = "ba-head";
    const headText = document.createElement("div");
    const title = document.createElement("p");
    title.className = "ba-title";
    title.textContent = "Bilibili Accelerator";
    const subtitle = document.createElement("p");
    subtitle.className = "ba-subtitle";
    subtitle.textContent = "Playback CDN rewrite";
    const indicator = document.createElement("span");
    indicator.id = "ba-indicator";
    indicator.className = config.enabled ? "ba-pill is-on" : "ba-pill";
    indicator.textContent = config.enabled ? "On" : "Off";
    headText.appendChild(title);
    headText.appendChild(subtitle);
    head.appendChild(headText);
    head.appendChild(indicator);

    const stats = document.createElement("div");
    stats.className = "ba-stats";
    const countBox = document.createElement("div");
    const countValue = document.createElement("div");
    countValue.className = "ba-count";
    countValue.id = "ba-count";
    countValue.textContent = String(state.rewriteCount);
    const countLabel = document.createElement("span");
    countLabel.className = "ba-count-label";
    countLabel.textContent = "rewrites";
    countBox.appendChild(countValue);
    countBox.appendChild(countLabel);
    const status = document.createElement("div");
    status.id = "ba-status";
    stats.appendChild(countBox);
    stats.appendChild(status);

    const enabled = document.createElement("input");
    enabled.type = "checkbox";
    enabled.checked = config.enabled;
    enabled.addEventListener("change", function handleEnabled() {
      saveConfig(Object.assign({}, config, { enabled: enabled.checked }));
      renderStatus();
    });
    const enabledSwitch = document.createElement("span");
    enabledSwitch.className = "ba-switch";
    const enabledSlider = document.createElement("span");
    enabledSlider.className = "ba-slider";
    enabledSwitch.appendChild(enabled);
    enabledSwitch.appendChild(enabledSlider);
    const enabledRow = document.createElement("label");
    enabledRow.className = "ba-switch-row";
    const enabledCopy = document.createElement("span");
    enabledCopy.className = "ba-switch-text";
    const enabledTitle = document.createElement("span");
    enabledTitle.className = "ba-switch-title";
    enabledTitle.textContent = "Enabled";
    const enabledNote = document.createElement("span");
    enabledNote.className = "ba-switch-note";
    enabledNote.textContent = "Rewrite slow playback hosts before buffering.";
    enabledCopy.appendChild(enabledTitle);
    enabledCopy.appendChild(enabledNote);
    enabledRow.appendChild(enabledCopy);
    enabledRow.appendChild(enabledSwitch);

    const mode = createSelect([
      { value: "bad-only", label: "Bad CDN only" },
      { value: "force", label: "Force all video CDN" }
    ], config.mode, function handleMode(value) {
      saveConfig(Object.assign({}, config, { mode: value }));
    });

    const mcdn = createSelect([
      { value: "proxy-all", label: "Proxy all MCDN" },
      { value: "proxy-v1", label: "Proxy /v1 only" },
      { value: "replace", label: "Replace host" }
    ], config.mcdnStrategy, function handleMcdn(value) {
      saveConfig(Object.assign({}, config, { mcdnStrategy: value }));
    });

    const hostInput = document.createElement("input");
    hostInput.type = "text";
    hostInput.className = "ba-control";
    hostInput.value = config.pcdnHost;
    hostInput.setAttribute("list", "ba-hosts");
    hostInput.addEventListener("change", function handleHost() {
      saveConfig(Object.assign({}, config, { pcdnHost: hostInput.value }));
    });

    const hostList = document.createElement("datalist");
    hostList.id = "ba-hosts";
    core.CDN_HOSTS.forEach(function addHost(host) {
      const option = document.createElement("option");
      option.value = host;
      hostList.appendChild(option);
    });

    const akamai = document.createElement("input");
    akamai.type = "checkbox";
    akamai.checked = config.rewriteAkamai;
    akamai.addEventListener("change", function handleAkamai() {
      saveConfig(Object.assign({}, config, { rewriteAkamai: akamai.checked }));
    });
    const akamaiSwitch = document.createElement("span");
    akamaiSwitch.className = "ba-switch";
    const akamaiSlider = document.createElement("span");
    akamaiSlider.className = "ba-slider";
    akamaiSwitch.appendChild(akamai);
    akamaiSwitch.appendChild(akamaiSlider);
    const akamaiRow = document.createElement("label");
    akamaiRow.className = "ba-switch-row";
    const akamaiCopy = document.createElement("span");
    akamaiCopy.className = "ba-switch-text";
    const akamaiTitle = document.createElement("span");
    akamaiTitle.className = "ba-switch-title";
    akamaiTitle.textContent = "Rewrite Akamai";
    const akamaiNote = document.createElement("span");
    akamaiNote.className = "ba-switch-note";
    akamaiNote.textContent = "Use only if Akamai is slow on your network.";
    akamaiCopy.appendChild(akamaiTitle);
    akamaiCopy.appendChild(akamaiNote);
    akamaiRow.appendChild(akamaiCopy);
    akamaiRow.appendChild(akamaiSwitch);

    const note = document.createElement("p");
    note.className = "ba-note";
    note.textContent = "Change settings, then reload the video page.";

    const reload = document.createElement("button");
    reload.type = "button";
    reload.className = "primary";
    reload.textContent = "Reload";
    reload.addEventListener("click", function handleReload() {
      root.location.reload();
    });

    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "Close";
    close.addEventListener("click", function handleClose() {
      panel.classList.remove("open");
      if (immersive) {
        revealBadge();
      }
    });

    const actions = document.createElement("div");
    actions.className = "ba-actions";
    actions.appendChild(reload);
    actions.appendChild(close);

    panel.appendChild(head);
    panel.appendChild(stats);
    panel.appendChild(enabledRow);
    panel.appendChild(createField("Mode", mode));
    panel.appendChild(createField("Target host", hostInput));
    panel.appendChild(hostList);
    panel.appendChild(createField("MCDN", mcdn));
    panel.appendChild(akamaiRow);
    panel.appendChild(note);
    panel.appendChild(actions);

    toggle.addEventListener("click", function handleToggle() {
      panel.classList.toggle("open");
      renderStatus();
      if (immersive && !panel.classList.contains("open")) {
        revealBadge();
      }
    });

    shadow.appendChild(style);
    shadow.appendChild(panel);
    shadow.appendChild(toggle);
    document.documentElement.appendChild(host);
    renderStatus();
  }

  root.BiliAccelerator = {
    getConfig: function getConfig() {
      return Object.assign({}, config);
    },
    setConfig: function setConfig(nextConfig) {
      saveConfig(Object.assign({}, config, nextConfig || {}));
      return this.getConfig();
    },
    getStats: function getStats() {
      return JSON.parse(JSON.stringify(state));
    },
    rewriteUrl: function rewritePublicUrl(url) {
      return core.rewriteUrl(url, config);
    }
  };

  patchJsonParse();
  patchFetch();
  patchGlobalPlayInfo("__playinfo__");
  patchGlobalPlayInfo("__INITIAL_STATE__");

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

