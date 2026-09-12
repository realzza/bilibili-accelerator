const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadPage(extra) {
  const core = fs.readFileSync(path.join(__dirname, "../src/core/rewrite.js"), "utf8");
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
  vm.runInNewContext(`${core}\n${page}`, sandbox);
  return sandbox;
}

function loadPageWithVideo() {
  const core = fs.readFileSync(path.join(__dirname, "../src/core/rewrite.js"), "utf8");
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

  vm.runInNewContext(`${core}\n${page}`, sandbox);
  return { sandbox, document, video };
}

function loadPageWithLiveHost(initialConfig) {
  const core = fs.readFileSync(path.join(__dirname, "../src/core/rewrite.js"), "utf8");
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
      attachShadow() {
        const shadow = {
          appendChild() {},
          querySelector() { return null; },
          getElementById() { return null; },
          querySelectorAll(selector) {
            return selector === "[data-i18n]" ? elements.filter(el => el.dataset.i18n) : [];
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

  vm.runInNewContext(`${core}\n${page}`, sandbox);
  return { sandbox, document, elements, storage };
}

test("fixed server picker lists every host and restores built-in and custom settings", () => {
  const defaults = loadPageWithLiveHost();
  const core = defaults.sandbox.BiliAcceleratorCore;
  for (const host of [core.DEFAULT_CONFIG.pcdnHost, core.CDN_HOSTS[1], "custom.example.com"]) {
    const { sandbox, document, elements } = loadPageWithLiveHost({
      schemaVersion: core.DEFAULT_CONFIG.schemaVersion, pcdnHost: host, selection: "fixed"
    });
    const select = document.getElementById("ba-fixed-host");
    const input = document.getElementById("ba-custom-host");
    const field = elements.find(el => el.__children.includes(input));
    assert.equal(select.tagName, "SELECT");
    assert.deepEqual(select.__children.map(option => option.value), [...core.CDN_HOSTS, "custom"]);
    assert.equal(select.value, core.CDN_HOSTS.includes(host) ? host : "custom");
    assert.equal(field.hidden, core.CDN_HOSTS.includes(host));
    assert.equal(input.value, host);
    assert.equal(input.getAttribute("list"), null);
    assert.equal(sandbox.BiliAccelerator.getConfig().pcdnHost, host);
  }
});

test("fixed server edits persist without changing selection mode or saving empty values", () => {
  for (const selection of ["auto", "fixed"]) {
    const { sandbox, document, elements, storage } = loadPageWithLiveHost({ selection });
    const select = document.getElementById("ba-fixed-host");
    const input = document.getElementById("ba-custom-host");
    const error = document.getElementById("ba-host-error");
    const field = elements.find(el => el.__children.includes(input));
    const original = sandbox.BiliAccelerator.getConfig().pcdnHost;
    select.value = "custom";
    select.dispatch("change");
    assert.equal(field.hidden, false);
    assert.equal(input.focused, true);
    assert.equal(input.value, original);
    assert.equal(sandbox.BiliAccelerator.getConfig().pcdnHost, original);
    input.value = "   ";
    input.dispatch("change");
    assert.equal(error.hidden, false);
    assert.equal(input.getAttribute("aria-invalid"), "true");
    assert.equal(sandbox.BiliAccelerator.getConfig().pcdnHost, original);
    const languageButtons = document.getElementById("ba-lang-seg").__children;
    languageButtons[2].dispatch("click");
    assert.equal(error.textContent, "请输入服务器地址");
    assert.equal(select.__children.at(-1).textContent, "自定义…");
    languageButtons[1].dispatch("click");
    assert.equal(error.textContent, "Enter a server address");
    input.value = "  custom.example.com  ";
    input.dispatch("input");
    input.dispatch("change");
    assert.equal(error.hidden, true);
    assert.equal(input.value, "custom.example.com");
    assert.equal(sandbox.BiliAccelerator.getConfig().pcdnHost, "custom.example.com");
    const saved = JSON.parse(storage.get("biliAccelerator.config.v2"));
    const restored = loadPageWithLiveHost(saved);
    assert.equal(restored.document.getElementById("ba-fixed-host").value, "custom");
    assert.equal(restored.document.getElementById("ba-custom-host").value, "custom.example.com");
    select.value = sandbox.BiliAcceleratorCore.CDN_HOSTS[1];
    select.dispatch("change");
    assert.equal(field.hidden, true);
    assert.equal(sandbox.BiliAccelerator.getConfig().pcdnHost, select.value);
    assert.equal(sandbox.BiliAccelerator.getConfig().selection, selection);
    const restoredBuiltin = loadPageWithLiveHost(JSON.parse(storage.get("biliAccelerator.config.v2")));
    assert.equal(restoredBuiltin.document.getElementById("ba-fixed-host").value, select.value);
    select.value = "custom";
    select.dispatch("change");
    assert.equal(input.value, sandbox.BiliAcceleratorCore.CDN_HOSTS[1]);
  }
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

test("a hidden tab defers stall recovery; returning re-checks it", () => {
  // Backgrounding must not rotate hosts — throttling alone makes the player emit
  // waiting/stalled, and rotating on that turns a harmless suspension into a real
  // interruption. But deferring is not the same as ignoring: 'waiting' does not
  // re-fire for an element that is already waiting, so a stall that began hidden
  // has no second event to recover from. The visibility re-check is the only
  // thing covering that case.
  const { sandbox, document, video } = loadPageWithVideo();

  video.dispatch("waiting");
  document.hidden = true;
  document.dispatch("visibilitychange");
  video.dispatch("waiting");
  sandbox.runTimeouts(2500);
  assert.equal(sandbox.BiliAccelerator.getStats().recoveries, 0,
    "does not rotate CDN hosts while the tab is hidden");

  // readyState stays < 3: the stall outlived the tab switch.
  document.hidden = false;
  document.dispatch("visibilitychange");
  sandbox.runTimeouts(2500);
  assert.equal(sandbox.BiliAccelerator.getStats().recoveries, 1,
    "re-checks an unresolved stall once the tab is visible again");
});

test("returning to a tab that recovered on its own does not rotate", () => {
  // The re-check above must not fire on the brief dip a tab switch itself causes.
  const { sandbox, document, video } = loadPageWithVideo();

  video.dispatch("waiting");
  document.hidden = true;
  document.dispatch("visibilitychange");

  video.readyState = 4;
  document.hidden = false;
  document.dispatch("visibilitychange");
  sandbox.runTimeouts(2500);
  assert.equal(sandbox.BiliAccelerator.getStats().recoveries, 0,
    "a player that resumed on its own must not be rotated off its host");
});

test("playinfo rewrite also adds DASH backupUrl fan-out in auto mode", () => {
  const sandbox = loadPage();
  const parsed = sandbox.JSON.parse(JSON.stringify({
    data: { dash: { video: [
      { baseUrl: "https://node-7.edge.mountaintoys.cn:4830/upgcxcode/v.m4s?os=mcdn", backupUrl: [] }
    ] } }
  }));
  const v0 = parsed.data.dash.video[0];
  assert.equal(new URL(v0.baseUrl).hostname, sandbox.BiliAcceleratorCore.DEFAULT_CONFIG.pcdnHost);
  assert.ok(v0.backupUrl.length > 0);
  assert.ok(v0.backupUrl.every((u) => u.includes("/upgcxcode/v.m4s")));
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

test("bangumi video_info.dash gets backup fan-out; durl gets backup_url fan-out", () => {
  const sandbox = loadPage();
  const bangumi = sandbox.JSON.parse(JSON.stringify({
    result: { video_info: { dash: { video: [{
      baseUrl: "https://node-7.edge.mountaintoys.cn:4830/upgcxcode/v.m4s?os=mcdn",
      backupUrl: []
    }] } } }
  }));
  const entry = bangumi.result.video_info.dash.video[0];
  assert.equal(new URL(entry.baseUrl).hostname, sandbox.BiliAcceleratorCore.DEFAULT_CONFIG.pcdnHost);
  assert.ok(entry.backupUrl.length > 0);

  const durl = sandbox.JSON.parse(JSON.stringify({
    data: { durl: [{ url: "https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/v.mp4?x=1" }] }
  }));
  const durlEntry = durl.data.durl[0];
  assert.ok(Array.isArray(durlEntry.backup_url) && durlEntry.backup_url.length > 0);
  assert.ok(durlEntry.backup_url.every((u) => u.includes("/upgcxcode/v.mp4")));
});

test("repeated stalls walk the whole pool instead of ping-ponging two hosts", () => {
  // The reported symptom was "keeps switching servers, still buffering": the old
  // rotation took the first pool entry that wasn't the current host, so rank[0]
  // rotated to rank[1] and rank[1] rotated straight back to rank[0]. Everything
  // past the second entry was unreachable no matter how long the stall ran.
  const { sandbox, video } = loadPageWithVideo();
  const pool = sandbox.BiliAccelerator.getConfig().candidatePool;
  const visited = [];

  video.dispatch("waiting");
  sandbox.runTimeouts(2500);
  visited.push(sandbox.BiliAccelerator.getConfig().pcdnHost);
  for (let i = 0; i < pool.length; i += 1) {
    sandbox.runTimeouts(5000);           // the persistent-stall recheck
    visited.push(sandbox.BiliAccelerator.getConfig().pcdnHost);
  }

  const distinct = new Set(visited);
  assert.ok(distinct.size >= pool.length - 1,
    "expected to reach nearly every host, saw " + distinct.size + " of " +
    pool.length + ": " + JSON.stringify(visited));
  assert.ok(!visited.every((h) => h === visited[0] || h === visited[1]),
    "rotation must not alternate between just two hosts: " + JSON.stringify(visited));
  visited.forEach((host) => {
    assert.ok(pool.includes(host), host + " is not in the candidate pool");
  });
});

test("stall rotation stays on hosts the probe ranked, in rank order", () => {
  // With no probe result the pool order stands in for the ranking; either way a
  // rotation must never land on a host outside the pool.
  const { sandbox, video } = loadPageWithVideo();
  const before = sandbox.BiliAccelerator.getConfig().pcdnHost;

  video.dispatch("waiting");
  sandbox.runTimeouts(2500);
  const after = sandbox.BiliAccelerator.getConfig().pcdnHost;

  assert.notEqual(after, before, "a foreground stall moves off the stalling host");
  assert.equal(sandbox.BiliAccelerator.getStats().recoveries, 1);
});

test("every candidate host is probed, not just the first few", () => {
  // Truncating the probe set makes pool *order* decide what auto-selection is
  // allowed to pick. Issue #26 came from a viewer whose fastest host was a
  // mainland mirror; if the pool grows past the cap, they can never rank onto it.
  const src = fs.readFileSync(path.join(__dirname, "../src/page/bili-accelerator.page.js"), "utf8");
  const cap = Number(/PROBE_MAX_HOSTS = (\d+)/.exec(src)[1]);
  const core = require("../src/core/rewrite");

  assert.ok(/slice\(0, PROBE_MAX_HOSTS\)/.test(src),
    "scheduleProbe must bound its probe set by PROBE_MAX_HOSTS");
  assert.ok(cap >= core.CANDIDATE_POOL.length,
    "PROBE_MAX_HOSTS (" + cap + ") must cover the whole " +
    core.CANDIDATE_POOL.length + "-host pool");
});

test("the probe reads segment bytes instead of scoring on headers alone", () => {
  // probeHost used to cancel the body the moment headers landed and rank purely
  // on TTFB. On these hosts TTFB swings ~10x between back-to-back samples of the
  // SAME host, so one unlucky draw — cached for RANK_TTL_MS — pinned a viewer to
  // a mainland mirror that moved a third of the bytes. Ranking now needs a real
  // rate, which means the probe has to actually pull bytes. Ordering semantics
  // are covered by the rankHosts tests in v2-core; what matters here is that the
  // body is consumed at all, which the old implementation never did.
  const core = require("../src/core/rewrite");
  let readCalls = 0;
  let bytesServed = 0;
  let cancelledAtHeaders = 0;

  const sandbox = loadPage({
    Uint8Array,
    fetch: () => Promise.resolve({
      ok: true,
      headers: { get: () => "video/mp4" },
      body: {
        cancel() { cancelledAtHeaders += 1; },
        getReader: () => ({
          read() {
            readCalls += 1;
            bytesServed += 64 * 1024;
            return Promise.resolve({ done: false, value: new Uint8Array(64 * 1024) });
          },
          cancel() {}
        })
      }
    })
  });

  // A playinfo payload hands rememberSample() a signed URL to probe with.
  sandbox.JSON.parse(JSON.stringify({
    data: { dash: { video: [
      { baseUrl: "https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/v.m4s?x=1" }
    ] } }
  }));

  return new Promise((resolve) => setTimeout(resolve, 50)).then(() => {
    assert.ok(readCalls > 0,
      "probe must consume the body; the old code cancelled at headers");
    assert.equal(cancelledAtHeaders, 0,
      "a healthy response must not be discarded before any bytes are read");
    // Each probe stops at PROBE_BYTES, so the pool moves that much per host.
    const src = fs.readFileSync(path.join(__dirname, "../src/page/bili-accelerator.page.js"), "utf8");
    const probeBytes = eval(/PROBE_BYTES = ([^;]+);/.exec(src)[1]);
    assert.ok(bytesServed >= probeBytes,
      "expected at least " + probeBytes + " bytes read, got " + bytesServed);
    assert.ok(bytesServed <= probeBytes * core.CANDIDATE_POOL.length + 64 * 1024,
      "probe must stop at PROBE_BYTES per host, read " + bytesServed);
  });
});

test("a host aborted mid-transfer is ranked as slow, not dropped", () => {
  // PROBE_TIMEOUT_MS aborts a host too slow to deliver PROBE_BYTES in time. It
  // is slow, not broken: discarding it shrank one real ranking to four of eight
  // hosts, leaving rotation with nothing to fall back on once the fast hosts
  // were exhausted. The bytes it did move are a valid (low) measurement.
  const slowHost = "upos-tf-all-tx.bilivideo.com";
  const sandbox = loadPage({
    Uint8Array,
    fetch: (url) => {
      const host = new URL(url).hostname;
      let served = 0;
      return Promise.resolve({
        ok: true,
        headers: { get: () => "video/mp4" },
        body: {
          getReader: () => ({
            read() {
              served += 64 * 1024;
              // The slow host gets aborted partway through, like a real timeout.
              if (host === slowHost && served > 128 * 1024) {
                return Promise.reject(new Error("aborted"));
              }
              return Promise.resolve({
                done: served > 768 * 1024,
                value: new Uint8Array(64 * 1024)
              });
            },
            cancel() {}
          })
        }
      });
    }
  });

  sandbox.JSON.parse(JSON.stringify({
    data: { dash: { video: [
      { baseUrl: "https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/v.m4s?x=1" }
    ] } }
  }));

  return new Promise((resolve) => setTimeout(resolve, 50)).then(() => {
    const ranking = sandbox.BiliAccelerator.getStats().ranking;
    assert.ok(ranking.includes(slowHost),
      "the aborted host must stay rankable: " + JSON.stringify(ranking));
    assert.notEqual(ranking[0], slowHost, "but it must not win");
  });
});

test("a ranking cache with a corrupt timestamp is discarded, not trusted", () => {
  // loadRanking only checked that `at` was truthy. A non-numeric one survives
  // the TTL check (NaN compares false either way), so the entry came back as a
  // fresh cache hit — and scheduleProbe then formats `at` for diagnostics, where
  // an Invalid Date throws. That took the probe down after `probed` was already
  // latched, so the viewer was left pinned to whatever stale order the entry
  // carried, with no probe to correct it.
  const stale = "upos-sz-mirrorali.bilivideo.com";
  let probes = 0;

  const sandbox = loadPage({
    localStorage: {
      getItem: (key) => key.indexOf("biliAccelerator.rank.") === 0
        ? JSON.stringify({ ranking: [stale], at: "2026-08-01T00:00:00Z" })
        : null,
      setItem() {}
    },
    fetch: () => {
      probes += 1;
      return Promise.resolve({ ok: true, headers: { get: () => "video/mp4" }, body: null });
    }
  });

  sandbox.JSON.parse(JSON.stringify({
    data: { dash: { video: [
      { baseUrl: "https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/v.m4s?x=1" }
    ] } }
  }));

  return new Promise((resolve) => setTimeout(resolve, 50)).then(() => {
    assert.ok(probes > 0,
      "an unreadable cache must fall through to a fresh probe, not abort it");
    assert.notEqual(sandbox.BiliAccelerator.getConfig().pcdnHost, stale,
      "and its ranking must never be applied");
  });
});
