const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadPage(extra) {
  const core = fs.readFileSync(path.join(__dirname, "../src/core/rewrite.js"), "utf8");
  const routingSrc = fs.readFileSync(path.join(__dirname, "../src/core/routing.js"), "utf8");
  const page = fs.readFileSync(path.join(__dirname, "../src/page/bili-accelerator.page.js"), "utf8");

  class FakeXHR {
    open(method, url) { this._method = method; this._url = url; }
    send() {}
    addEventListener() {}
    getResponseHeader() { return "application/json"; }
  }

  const store = new Map();
  const sandbox = Object.assign({
    // Each sandbox gets its own JSON object: the page script patches JSON.parse
    // in place, and handing it the host realm's JSON would stack patches across
    // tests (and patch the test runner's own JSON).
    JSON: { parse: JSON.parse, stringify: JSON.stringify },
    URL, Date, WeakSet, Headers, Response, Request, Promise, Math,
    setTimeout, clearTimeout, setInterval, Intl,
    performance: { now: () => 1 },
    XMLHttpRequest: FakeXHR,
    navigator: { language: "en-US", clipboard: { writeText() {} } },
    console: { info() {}, warn() {}, error() {} },
    localStorage: { getItem: (k) => store.get(k) || null, setItem: (k, v) => store.set(k, v) },
    location: { href: "https://www.bilibili.com/video/x", reload() {} },
    document: {
      readyState: "loading", documentElement: null, head: null,
      addEventListener() {}, getElementById: () => null,
      querySelector: () => null, createElement: () => ({})
    }
  }, extra || {});
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  sandbox.addEventListener = () => {};
  vm.runInNewContext(`${core}\n${routingSrc}\n${page}`, sandbox);
  return sandbox;
}

function loadPageWithVideo() {
  const core = fs.readFileSync(path.join(__dirname, "../src/core/rewrite.js"), "utf8");
  const routingSrc = fs.readFileSync(path.join(__dirname, "../src/core/routing.js"), "utf8");
  const page = fs.readFileSync(path.join(__dirname, "../src/page/bili-accelerator.page.js"), "utf8");
  const documentListeners = new Map();
  const videoListeners = new Map();
  const timers = new Map();
  let nextTimer = 1;

  const video = {
    paused: false,
    ended: false,
    readyState: 1,
    currentTime: 10,
    currentSrc: "blob:https://www.bilibili.com/media-source",
    addEventListener(type, listener) {
      videoListeners.set(type, listener);
    },
    dispatch(type) {
      const listener = videoListeners.get(type);
      if (listener) listener();
    }
  };

  const document = {
    readyState: "complete",
    documentElement: null,
    head: null,
    hidden: false,
    addEventListener(type, listener) {
      documentListeners.set(type, listener);
    },
    dispatch(type) {
      const listener = documentListeners.get(type);
      if (listener) listener();
    },
    getElementById: () => null,
    querySelector(selector) {
      return selector === "video" ? video : null;
    },
    createElement: () => ({})
  };

  const sandbox = {
    JSON: { parse: JSON.parse, stringify: JSON.stringify },
    URL, Date, WeakSet, Headers, Response, Request, Promise, Math, Intl,
    performance: { now: () => 1 },
    XMLHttpRequest: class FakeXHR {
      open() {}
      send() {}
      addEventListener() {}
    },
    navigator: { language: "en-US", clipboard: { writeText() {} } },
    console: { info() {}, warn() {}, error() {} },
    localStorage: { getItem: () => null, setItem() {} },
    location: { href: "https://www.bilibili.com/video/x", reload() {} },
    document,
    setTimeout(callback, delay) {
      const id = nextTimer++;
      timers.set(id, { callback, delay, interval: false });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    setInterval(callback, delay) {
      const id = nextTimer++;
      timers.set(id, { callback, delay, interval: true });
      return id;
    },
    clearInterval(id) { timers.delete(id); }
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  sandbox.addEventListener = () => {};
  sandbox.runTimeouts = function runTimeouts(delay) {
    const due = Array.from(timers.entries()).filter(([, timer]) =>
      !timer.interval && (delay == null || timer.delay === delay));
    due.forEach(([id, timer]) => {
      timers.delete(id);
      timer.callback();
    });
  };

  vm.runInNewContext(`${core}\n${routingSrc}\n${page}`, sandbox);
  return { sandbox, document, video };
}

function loadPageWithLiveHost(initialConfig) {
  const core = fs.readFileSync(path.join(__dirname, "../src/core/rewrite.js"), "utf8");
  const routingSrc = fs.readFileSync(path.join(__dirname, "../src/core/routing.js"), "utf8");
  const page = fs.readFileSync(path.join(__dirname, "../src/page/bili-accelerator.page.js"), "utf8");
  const nodes = new Map();
  const elements = [];
  const storage = new Map();
  if (initialConfig) {
    storage.set("biliAccelerator.config.v2", JSON.stringify(initialConfig));
  }

  function makeElement(tagName) {
    const classes = new Set();
    const children = [];
    const listeners = new Map();
    const attributes = new Map();
    const element = {
      tagName: tagName.toUpperCase(),
      id: "",
      style: { setProperty() {} },
      dataset: {},
      shadowRoot: null,
      classList: {
        add(name) { classes.add(name); },
        remove(name) { classes.delete(name); },
        toggle(name, force) {
          if (force === true) {
            classes.add(name);
          } else if (force === false) {
            classes.delete(name);
          } else if (classes.has(name)) {
            classes.delete(name);
          } else {
            classes.add(name);
          }
          return classes.has(name);
        },
        contains(name) { return classes.has(name); }
      },
      appendChild(child) {
        children.push(child);
        if (child && child.id) {
          nodes.set(child.id, child);
        }
        return child;
      },
      addEventListener(type, callback) { listeners.set(type, callback); },
      dispatch(type) { if (listeners.has(type)) listeners.get(type)(); },
      focus() { element.focused = true; },
      select() { element.textSelected = true; },
      attachShadow() {
        const shadow = {
          appendChild() {},
          querySelector() { return null; },
          getElementById() { return null; },
          querySelectorAll(selector) {
            if (selector === "[data-i18n]") {
              return elements.filter(el => el.dataset.i18n);
            }
            if (selector === "[data-i18n-placeholder]") {
              return elements.filter(el => el.dataset.i18nPlaceholder);
            }
            return [];
          }
        };
        element.shadowRoot = shadow;
        return shadow;
      },
      setAttribute(name, value) { attributes.set(name, value); },
      getAttribute(name) { return attributes.get(name) ?? null; },
      remove() {},
      querySelector(selector) {
        if (selector === "input") {
          const stack = children.slice();
          while (stack.length) {
            const child = stack.shift();
            if (child && child.tagName === "INPUT") {
              return child;
            }
            if (child && typeof child.querySelector === "function" && Array.isArray(child.__children)) {
              stack.unshift(...child.__children);
            }
          }
          return null;
        }
        return null;
      },
      querySelectorAll() { return []; }
    };
    element.__children = children;
    elements.push(element);
    return element;
  }

  const document = {
    readyState: "complete",
    hidden: false,
    documentElement: makeElement("html"),
    head: makeElement("head"),
    addEventListener() {},
    getElementById(id) {
      return nodes.get(id) || null;
    },
    querySelector(selector) {
      return selector === "video" ? null : null;
    },
    createElement(tagName) {
      return makeElement(tagName);
    }
  };

  const sandbox = {
    JSON: { parse: JSON.parse, stringify: JSON.stringify },
    URL, Date, WeakSet, Headers, Response, Request, Promise, Math, Intl,
    performance: { now: () => 1 },
    XMLHttpRequest: class FakeXHR {
      open() {}
      send() {}
      addEventListener() {}
      getResponseHeader() { return "application/json"; }
    },
    navigator: { language: "en-US", clipboard: { writeText() {} } },
    console: { info() {}, warn() {}, error() {} },
    localStorage: {
      getItem(key) { return storage.get(key) || null; },
      setItem(key, value) { storage.set(key, value); }
    },
    location: { href: "https://live.bilibili.com/123", hostname: "live.bilibili.com", reload() {} },
    document,
    setTimeout(callback) { callback(); return 1; },
    clearTimeout() {},
    setInterval() { return 1; },
    clearInterval() {}
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  sandbox.addEventListener = () => {};

  vm.runInNewContext(`${core}\n${routingSrc}\n${page}`, sandbox);
  return { sandbox, document, elements, storage };
}

// The panel controls the fixed-server tests drive. Server's own <select> has
// no id, so it is found by its options.
function fixedServerPanel(initialConfig) {
  const page = loadPageWithLiveHost(initialConfig);
  const { document, elements } = page;
  const hostSelect = document.getElementById("ba-fixed-host");
  const hostInput = document.getElementById("ba-custom-host");
  const selection = elements.find(el => el.tagName === "SELECT" &&
    el.__children.some(option => option.value === "fixed"));
  const fieldOf = control => elements.find(el => el.__children.includes(control));
  return Object.assign(page, {
    core: page.sandbox.BiliAcceleratorCore,
    config: () => page.sandbox.BiliAccelerator.getConfig(),
    hostSelect,
    hostInput,
    selection,
    serverField: fieldOf(selection),
    fixedField: fieldOf(hostSelect),
    customField: fieldOf(hostInput),
    adv: elements.find(el => el.className === "ba-adv")
  });
}

test("fixed-server picker offers the candidate pool plus Custom, and no Akamai host", () => {
  const { core, hostSelect } = fixedServerPanel({ selection: "fixed" });
  const values = hostSelect.__children.map(option => option.value);
  assert.deepEqual(values, [...core.CANDIDATE_POOL, "custom"]);
  // Akamai answers upos-signed URLs with 403, so listing it offers a broken choice.
  assert.equal(values.some(value => value.endsWith(".akamaized.net")), false,
    "Akamai hosts must not be offered as fixed servers");
});

test("fixed-server rows are hidden in auto mode and follow Server in fixed mode", () => {
  const panel = fixedServerPanel({ selection: "auto", pcdnHost: "upos-sz-mirroraliov.bilivideo.com" });
  assert.equal(panel.fixedField.hidden, true,
    "auto mode overwrites pcdnHost from the ranking, so the picker has nothing to set");
  assert.equal(panel.customField.hidden, true);
  const rows = panel.adv.__children;
  assert.equal(rows.indexOf(panel.fixedField), rows.indexOf(panel.serverField) + 1,
    "the picker sits directly under Server");
  assert.equal(rows.indexOf(panel.customField), rows.indexOf(panel.serverField) + 2);

  panel.selection.value = "fixed";
  panel.selection.dispatch("change");
  assert.equal(panel.fixedField.hidden, false);
  assert.equal(panel.customField.hidden, true, "a listed host needs no address field");
  assert.equal(panel.hostSelect.value, "upos-sz-mirroraliov.bilivideo.com",
    "switching to fixed keeps the host auto mode was using");
  assert.equal(panel.config().pcdnHost, "upos-sz-mirroraliov.bilivideo.com");

  panel.selection.value = "auto";
  panel.selection.dispatch("change");
  assert.equal(panel.fixedField.hidden, true);
});

test("a saved host outside the pool is restored under Custom", () => {
  for (const host of ["upos-hz-mirrorakam.akamaized.net", "custom.example.com"]) {
    const panel = fixedServerPanel({ selection: "fixed", pcdnHost: host });
    assert.equal(panel.hostSelect.value, "custom", `${host} is not in the pool`);
    assert.equal(panel.customField.hidden, false);
    assert.equal(panel.hostInput.value, host);
    assert.equal(panel.config().pcdnHost, host, "restoring must not rewrite the saved host");
  }
});

test("choosing Custom opens the address field without saving anything", () => {
  const panel = fixedServerPanel({ selection: "fixed" });
  const stored = panel.storage.get("biliAccelerator.config.v2");
  const host = panel.config().pcdnHost;
  panel.hostSelect.value = "custom";
  panel.hostSelect.dispatch("change");
  assert.equal(panel.customField.hidden, false);
  assert.equal(panel.hostInput.focused, true);
  assert.equal(panel.hostInput.textSelected, true,
    "the prefilled host is selected so typing replaces it");
  assert.equal(panel.hostInput.value, host);
  assert.equal(panel.config().pcdnHost, host);
  assert.equal(panel.storage.get("biliAccelerator.config.v2"), stored,
    "the Custom sentinel is never saved");
});

test("an empty address is not saved and the host in use comes back", () => {
  const listed = fixedServerPanel({ selection: "fixed", pcdnHost: "upos-sz-mirrorali.bilivideo.com" });
  listed.hostSelect.value = "custom";
  listed.hostSelect.dispatch("change");
  listed.hostInput.value = "   ";
  listed.hostInput.dispatch("change");
  assert.equal(listed.config().pcdnHost, "upos-sz-mirrorali.bilivideo.com");
  assert.equal(listed.hostSelect.value, "upos-sz-mirrorali.bilivideo.com",
    "clearing the field falls back to the listed host still in use");
  assert.equal(listed.customField.hidden, true);

  const custom = fixedServerPanel({ selection: "fixed", pcdnHost: "custom.example.com" });
  custom.hostInput.value = "";
  custom.hostInput.dispatch("change");
  assert.equal(custom.config().pcdnHost, "custom.example.com");
  assert.equal(custom.hostInput.value, "custom.example.com", "the custom host in use is put back");
  assert.equal(custom.customField.hidden, false);
});

test("a typed address is trimmed, saved and restored; a pool host typed in moves the picker", () => {
  const panel = fixedServerPanel({ selection: "fixed" });
  panel.hostSelect.value = "custom";
  panel.hostSelect.dispatch("change");
  panel.hostInput.value = "  custom.example.com  ";
  panel.hostInput.dispatch("change");
  assert.equal(panel.config().pcdnHost, "custom.example.com");
  assert.equal(panel.hostInput.value, "custom.example.com");

  const restored = fixedServerPanel(JSON.parse(panel.storage.get("biliAccelerator.config.v2")));
  assert.equal(restored.hostSelect.value, "custom");
  assert.equal(restored.hostInput.value, "custom.example.com");

  panel.hostInput.value = "upos-sz-mirrorhw.bilivideo.com";
  panel.hostInput.dispatch("change");
  assert.equal(panel.hostSelect.value, "upos-sz-mirrorhw.bilivideo.com",
    "a pool host typed by hand shows as that option, as it would after a reload");
  assert.equal(panel.customField.hidden, true);
});

test("picking a listed host saves it and leaves the selection mode alone", () => {
  const panel = fixedServerPanel({ selection: "fixed" });
  const host = panel.core.CANDIDATE_POOL[3];
  panel.hostSelect.value = host;
  panel.hostSelect.dispatch("change");
  assert.equal(panel.config().pcdnHost, host);
  assert.equal(panel.config().selection, "fixed");
  assert.equal(JSON.parse(panel.storage.get("biliAccelerator.config.v2")).pcdnHost, host);
  assert.equal(panel.customField.hidden, true);
});

test("the address placeholder and the Custom label follow the panel language", () => {
  const panel = fixedServerPanel({ selection: "fixed" });
  const customOption = panel.hostSelect.__children.at(-1);
  const languageButtons = panel.document.getElementById("ba-lang-seg").__children;
  assert.equal(panel.hostInput.placeholder, "Enter a server address");
  languageButtons[2].dispatch("click");
  assert.equal(panel.hostInput.placeholder, "请输入服务器地址",
    "applyLang() must refresh placeholders, not only [data-i18n] text");
  assert.equal(customOption.textContent, "自定义…");
  languageButtons[1].dispatch("click");
  assert.equal(panel.hostInput.placeholder, "Enter a server address");
});

test("XHR open() rewrites a renamed PCDN segment URL (mountaintoys)", () => {
  const sandbox = loadPage();
  const xhr = new sandbox.XMLHttpRequest();
  const bad = "https://node-7.edge.mountaintoys.cn:4830/upgcxcode/12/34/567-1-30280.m4s?os=mcdn&abc=1";
  xhr.open("GET", bad);
  assert.equal(new URL(xhr._url).hostname, sandbox.BiliAcceleratorCore.DEFAULT_CONFIG.pcdnHost);
  assert.equal(new URL(xhr._url).port, "");
});

test("fetch media responses are returned without cloning or reading their bodies", async () => {
  let cloneCalls = 0;
  const response = {
    headers: { get: () => "video/mp4" },
    clone() {
      cloneCalls += 1;
      throw new Error("media response body must stay untouched");
    }
  };
  const sandbox = loadPage({ fetch: async () => response });

  const result = await sandbox.fetch(
    "https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/video.m4s?x=1"
  );

  assert.equal(result, response);
  assert.equal(cloneCalls, 0);
});

test("a hidden tab defers stall counting; returning re-checks it", () => {
  // Backgrounding makes the player emit waiting/stalled on its own, so nothing
  // is counted or acted on while hidden. Deferring is not ignoring, though:
  // 'waiting' does not re-fire for an element that is already waiting, so a
  // stall that began hidden has no second event. The visibility re-check is
  // the only thing covering that case.
  const { sandbox, document, video } = loadPageWithVideo();

  video.dispatch("waiting");
  document.hidden = true;
  document.dispatch("visibilitychange");
  video.dispatch("waiting");
  sandbox.runTimeouts(2500);
  assert.equal(sandbox.BiliAccelerator.getStats().stalls, 0,
    "nothing is counted while the tab is hidden");

  // readyState stays < 3: the stall outlived the tab switch.
  document.hidden = false;
  document.dispatch("visibilitychange");
  sandbox.runTimeouts(2500);
  assert.equal(sandbox.BiliAccelerator.getStats().stalls, 1,
    "an unresolved stall is counted once the tab is visible again");
});

test("returning to a tab that recovered on its own counts no stall", () => {
  // The re-check above must not fire on the brief dip a tab switch itself causes.
  const { sandbox, document, video } = loadPageWithVideo();

  video.dispatch("waiting");
  document.hidden = true;
  document.dispatch("visibilitychange");

  video.readyState = 4;
  document.hidden = false;
  document.dispatch("visibilitychange");
  sandbox.runTimeouts(2500);
  assert.equal(sandbox.BiliAccelerator.getStats().stalls, 0);
});

test("a PCDN base URL gives way to Bilibili's own backup, and backupUrl gains nothing", () => {
  // Bilibili sometimes issues a P2P node as the base URL with a proper CDN URL
  // as backup. The backup is signed for its own host, so it is used as issued
  // instead of host-swapping the PCDN URL. 0.4.x also prepended its ranked
  // hosts to backupUrl, which pushed the player's own alternative to the end.
  const sandbox = loadPage();
  const cdn = "https://upos-hz-mirrorakam.akamaized.net/upgcxcode/1/2/3-1-30080.m4s?os=akam&hdnts=x";
  const parsed = sandbox.JSON.parse(JSON.stringify({
    data: { dash: { video: [
      { baseUrl: "https://node-7.edge.mountaintoys.cn:4830/upgcxcode/1/2/3-1-30080.m4s?os=mcdn", backupUrl: [cdn] }
    ] } }
  }));
  const v0 = parsed.data.dash.video[0];
  assert.equal(v0.baseUrl, cdn);
  assert.deepEqual(Array.from(v0.backupUrl), []);
  const diag = sandbox.BiliAccelerator.getDiagnostics();
  assert.equal(diag.recentRewrites[0].reason, "pcdn-promote");
  assert.equal(diag.counters.p2pAvoided, 1);

  const healthy = sandbox.JSON.parse(JSON.stringify({
    data: { dash: { video: [
      { baseUrl: "https://upos-sz-mirrorcosov.bilivideo.com/upgcxcode/1/2/4-1-30080.m4s?x=1", backupUrl: [cdn] }
    ] } }
  }));
  assert.deepEqual(Array.from(healthy.data.dash.video[0].backupUrl), [cdn], "issued backups stay as issued");
});

test("advanced toggle is pinned as the panel footer (stays under cursor)", () => {
  const src = fs.readFileSync(path.join(__dirname, "../src/page/bili-accelerator.page.js"), "utf8");
  const bodyIdx = src.indexOf("panel.appendChild(body)");
  const toggleIdx = src.indexOf("panel.appendChild(advToggle)");
  assert.ok(bodyIdx !== -1 && toggleIdx !== -1, "panel appends body and advToggle");
  // The toggle must be appended last so expanding grows the panel upward
  // while the toggle stays put at the bottom.
  assert.ok(toggleIdx > bodyIdx, "advToggle is the bottom-most element");
});

test("diagnostics redacts media URLs to bare hosts (no tokens leak)", () => {
  const sandbox = loadPage();
  // A PCDN payload whose URL carries account/device/token params. Parsing it
  // triggers the rewrite + record() path.
  sandbox.JSON.parse(JSON.stringify({
    data: { dash: { video: [{
      baseUrl: "https://node-7.edge.mountaintoys.cn:4830/upgcxcode/v.m4s?os=mcdn&mid=404508679&buvid=SECRETDEVICE&upsig=TOKEN",
      backupUrl: []
    }] } }
  }));
  const diag = sandbox.BiliAccelerator.getDiagnostics();
  assert.ok(diag.recentRewrites.length > 0, "records the rewrite");
  const entry = diag.recentRewrites[0];
  assert.ok(entry.fromHost, "keeps a source host");
  assert.ok(entry.toHost, "keeps a target host");
  assert.equal(entry.from, undefined, "no raw from URL");
  assert.equal(entry.to, undefined, "no raw to URL");
  // The whole shared blob must not carry account/device/token material.
  const blob = JSON.stringify(diag);
  ["mid=404508679", "SECRETDEVICE", "buvid", "upsig", "TOKEN", "?"].forEach((needle) => {
    assert.ok(blob.indexOf(needle) === -1, `report leaks "${needle}"`);
  });
  // region is trimmed to a bare timezone (no locale).
  assert.ok(diag.region.indexOf("|") === -1, "region drops locale");
});

test("public API exposes diagnostics and config control", () => {
  const sandbox = loadPage();
  const cfg = sandbox.BiliAccelerator.setConfig({ p2pGuard: true });
  assert.equal(cfg.p2pGuard, true);
  const diag = sandbox.BiliAccelerator.getDiagnostics();
  assert.equal(diag.version, require("../package.json").version,
    "page VERSION constant must match package.json (single source of truth)");
  assert.ok(diag.counters && typeof diag.counters.rewrites === "number");
});

test("XHR open() accepts URL objects and still rewrites PCDN segments", () => {
  const sandbox = loadPage();
  const xhr = new sandbox.XMLHttpRequest();
  const bad = new URL("https://node-7.edge.mountaintoys.cn:4830/upgcxcode/12/34/567-1-30280.m4s?os=mcdn&abc=1");
  xhr.open("GET", bad);
  assert.equal(new URL(xhr._url).hostname, sandbox.BiliAcceleratorCore.DEFAULT_CONFIG.pcdnHost);
});

test("live getRoomPlayInfo parsed by the page gets its PCDN hosts filtered", () => {
  const sandbox = loadPage();
  const parsed = sandbox.JSON.parse(JSON.stringify({
    code: 0,
    data: { playurl_info: { playurl: { stream: [{ format: [{ codec: [{
      base_url: "/live-bvc/123/live_1234.flv?sig=abc",
      url_info: [
        { host: "https://xy36x110x213x230xy.mcdn.bilivideo.cn:486", extra: "?os=mcdn" },
        { host: "https://d1--cn-gotcha208.bilivideo.com", extra: "?sig=1" }
      ]
    }] }] }] } } }
  }));
  const urlInfo = parsed.data.playurl_info.playurl.stream[0].format[0].codec[0].url_info;
  assert.equal(urlInfo.length, 1);
  assert.equal(urlInfo[0].host, "https://d1--cn-gotcha208.bilivideo.com");
  assert.ok(sandbox.BiliAccelerator.getStats().rewriteCount >= 1);
});

test("live segment URLs pass through untouched (no VOD host swap)", () => {
  const sandbox = loadPage();
  const xhr = new sandbox.XMLHttpRequest();
  const liveUrl = "https://xy1x2x3x4xy.mcdn.bilivideo.cn:486/live-bvc/123/live_1234.flv?os=mcdn";
  xhr.open("GET", liveUrl);
  assert.equal(xhr._url, liveUrl);
});

test("live pages enter immersive mode so the badge can auto-hide", () => {
  const { document } = loadPageWithLiveHost();
  const host = document.getElementById("bili-accelerator-button");
  assert.ok(host, "installs the floating badge");
  assert.equal(host.classList.contains("ba-immersed"), true,
    "live pages should hide the badge the same way web fullscreen does");
  // isLivePage() is deliberately not routed through detectScreenMode(): a live
  // page reporting "web" there would also satisfy refreshImmersive's setLifted
  // test and shift the badge to bottom:84px, which nothing asked for.
  assert.equal(host.classList.contains("ba-lifted"), false,
    "hiding the badge on a live page must not also lift it");
});

test("bangumi video_info.dash has its PCDN rewritten; durl is left as issued", () => {
  const sandbox = loadPage();
  const bangumi = sandbox.JSON.parse(JSON.stringify({
    result: { video_info: { dash: { video: [{
      baseUrl: "https://node-7.edge.mountaintoys.cn:4830/upgcxcode/v.m4s?os=mcdn",
      backupUrl: []
    }] } } }
  }));
  const entry = bangumi.result.video_info.dash.video[0];
  assert.equal(new URL(entry.baseUrl).hostname, sandbox.BiliAcceleratorCore.DEFAULT_CONFIG.pcdnHost);
  assert.deepEqual(Array.from(entry.backupUrl), []);

  const durl = sandbox.JSON.parse(JSON.stringify({
    data: { durl: [{ url: "https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/v.mp4?x=1" }] }
  }));
  assert.equal(durl.data.durl[0].backup_url, undefined);
});

