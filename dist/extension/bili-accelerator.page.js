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
  const nativeJsonParse = JSON.parse;
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
    const status = document.getElementById("ba-status");
    if (!status) {
      return;
    }

    const last = state.rewrites[state.rewrites.length - 1];
    status.textContent = last
      ? "Rewrites: " + state.rewriteCount + " | Last: " + last.reason + " -> " + last.targetHost
      : "Rewrites: " + state.rewriteCount;
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
      ":host{position:fixed;right:16px;bottom:16px;z-index:2147483647;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;color:#17202a}",
      "button,input,select{font:inherit}",
      ".ba-toggle{width:42px;height:34px;border:1px solid #8aa0b4;border-radius:8px;background:#ffffff;color:#17202a;box-shadow:0 4px 16px rgba(0,0,0,.18);cursor:pointer;font-weight:700}",
      ".ba-panel{display:none;position:absolute;right:0;bottom:44px;width:min(320px,calc(100vw - 32px));padding:12px;border:1px solid #8aa0b4;border-radius:8px;background:#ffffff;box-shadow:0 10px 28px rgba(0,0,0,.24)}",
      ".ba-panel.open{display:block}",
      ".ba-title{font-size:14px;font-weight:700;margin:0 0 10px}",
      ".ba-field{display:grid;grid-template-columns:92px 1fr;align-items:center;gap:8px;margin:8px 0;font-size:12px}",
      ".ba-field input[type=text],.ba-field select{min-width:0;border:1px solid #aab7c2;border-radius:6px;padding:6px;background:#fff;color:#17202a}",
      ".ba-row{display:flex;align-items:center;gap:8px;margin:8px 0;font-size:12px}",
      ".ba-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:10px}",
      ".ba-actions button{border:1px solid #8aa0b4;border-radius:6px;background:#f7f9fb;color:#17202a;padding:6px 9px;cursor:pointer}",
      ".ba-note{font-size:11px;line-height:1.4;color:#52606d;margin-top:8px}",
      "#ba-status{font-size:11px;line-height:1.4;color:#34495e;margin-top:8px;word-break:break-word}"
    ].join("");

    const toggle = document.createElement("button");
    toggle.className = "ba-toggle";
    toggle.type = "button";
    toggle.textContent = "BA";
    toggle.title = "Bilibili Accelerator";

    const panel = document.createElement("section");
    panel.className = "ba-panel";
    panel.id = PANEL_ID;

    const title = document.createElement("p");
    title.className = "ba-title";
    title.textContent = "Bilibili Accelerator";

    const enabled = document.createElement("input");
    enabled.type = "checkbox";
    enabled.checked = config.enabled;
    enabled.addEventListener("change", function handleEnabled() {
      saveConfig(Object.assign({}, config, { enabled: enabled.checked }));
    });
    const enabledRow = document.createElement("label");
    enabledRow.className = "ba-row";
    enabledRow.appendChild(enabled);
    enabledRow.appendChild(document.createTextNode("Enabled"));

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
    const akamaiRow = document.createElement("label");
    akamaiRow.className = "ba-row";
    akamaiRow.appendChild(akamai);
    akamaiRow.appendChild(document.createTextNode("Also rewrite Akamai"));

    const status = document.createElement("div");
    status.id = "ba-status";

    const note = document.createElement("p");
    note.className = "ba-note";
    note.textContent = "Change settings, then reload the video page.";

    const reload = document.createElement("button");
    reload.type = "button";
    reload.textContent = "Reload";
    reload.addEventListener("click", function handleReload() {
      root.location.reload();
    });

    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "Close";
    close.addEventListener("click", function handleClose() {
      panel.classList.remove("open");
    });

    const actions = document.createElement("div");
    actions.className = "ba-actions";
    actions.appendChild(reload);
    actions.appendChild(close);

    panel.appendChild(title);
    panel.appendChild(enabledRow);
    panel.appendChild(createField("Mode", mode));
    panel.appendChild(createField("PCDN host", hostInput));
    panel.appendChild(hostList);
    panel.appendChild(createField("MCDN", mcdn));
    panel.appendChild(akamaiRow);
    panel.appendChild(status);
    panel.appendChild(note);
    panel.appendChild(actions);

    toggle.addEventListener("click", function handleToggle() {
      panel.classList.toggle("open");
      renderStatus();
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

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", installUi, { once: true });
  } else {
    installUi();
  }

  console.info("[BiliAccelerator] installed", root.BiliAccelerator.getConfig());
})(typeof globalThis !== "undefined" ? globalThis : window);

