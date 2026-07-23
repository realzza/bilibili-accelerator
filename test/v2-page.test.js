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

test("XHR open() rewrites a renamed PCDN segment URL (mountaintoys)", () => {
  const sandbox = loadPage();
  const xhr = new sandbox.XMLHttpRequest();
  const bad = "https://node-7.edge.mountaintoys.cn:4830/upgcxcode/12/34/567-1-30280.m4s?os=mcdn&abc=1";
  xhr.open("GET", bad);
  assert.equal(new URL(xhr._url).hostname, "upos-sz-mirrorcos.bilivideo.com");
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

test("tab visibility transitions never trigger stall recovery", () => {
  const { sandbox, document, video } = loadPageWithVideo();

  video.dispatch("waiting");
  document.hidden = true;
  document.dispatch("visibilitychange");
  video.dispatch("waiting");
  sandbox.runTimeouts(2500);
  assert.equal(sandbox.BiliAccelerator.getStats().recoveries, 0,
    "does not rotate CDN hosts after the tab becomes hidden");

  document.hidden = false;
  document.dispatch("visibilitychange");
  sandbox.runTimeouts(2500);
  assert.equal(sandbox.BiliAccelerator.getStats().recoveries, 0,
    "does not recheck playback merely because the tab became visible");

  video.dispatch("waiting");
  sandbox.runTimeouts(2500);
  assert.equal(sandbox.BiliAccelerator.getStats().recoveries, 1,
    "still recovers from a foreground waiting event");
});

test("playinfo rewrite also adds DASH backupUrl fan-out in auto mode", () => {
  const sandbox = loadPage();
  const parsed = sandbox.JSON.parse(JSON.stringify({
    data: { dash: { video: [
      { baseUrl: "https://node-7.edge.mountaintoys.cn:4830/upgcxcode/v.m4s?os=mcdn", backupUrl: [] }
    ] } }
  }));
  const v0 = parsed.data.dash.video[0];
  assert.equal(new URL(v0.baseUrl).hostname, "upos-sz-mirrorcos.bilivideo.com");
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
  assert.equal(new URL(xhr._url).hostname, "upos-sz-mirrorcos.bilivideo.com");
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

test("bangumi video_info.dash gets backup fan-out; durl gets backup_url fan-out", () => {
  const sandbox = loadPage();
  const bangumi = sandbox.JSON.parse(JSON.stringify({
    result: { video_info: { dash: { video: [{
      baseUrl: "https://node-7.edge.mountaintoys.cn:4830/upgcxcode/v.m4s?os=mcdn",
      backupUrl: []
    }] } } }
  }));
  const entry = bangumi.result.video_info.dash.video[0];
  assert.equal(new URL(entry.baseUrl).hostname, "upos-sz-mirrorcos.bilivideo.com");
  assert.ok(entry.backupUrl.length > 0);

  const durl = sandbox.JSON.parse(JSON.stringify({
    data: { durl: [{ url: "https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/v.mp4?x=1" }] }
  }));
  const durlEntry = durl.data.durl[0];
  assert.ok(Array.isArray(durlEntry.backup_url) && durlEntry.backup_url.length > 0);
  assert.ok(durlEntry.backup_url.every((u) => u.includes("/upgcxcode/v.mp4")));
});
