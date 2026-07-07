const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadPage() {
  const core = fs.readFileSync(path.join(__dirname, "../src/core/rewrite.js"), "utf8");
  const page = fs.readFileSync(path.join(__dirname, "../src/page/bili-accelerator.page.js"), "utf8");

  class FakeXHR {
    open(method, url) { this._method = method; this._url = url; }
    send() {}
    addEventListener() {}
    getResponseHeader() { return "application/json"; }
  }

  const store = new Map();
  const sandbox = {
    URL, Date, JSON, WeakSet, Headers, Response, Request, Promise, Math,
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
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  sandbox.addEventListener = () => {};
  vm.runInNewContext(`${core}\n${page}`, sandbox);
  return sandbox;
}

test("XHR open() rewrites a renamed PCDN segment URL (mountaintoys)", () => {
  const sandbox = loadPage();
  const xhr = new sandbox.XMLHttpRequest();
  const bad = "https://node-7.edge.mountaintoys.cn:4830/upgcxcode/12/34/567-1-30280.m4s?os=mcdn&abc=1";
  xhr.open("GET", bad);
  assert.equal(new URL(xhr._url).hostname, "upos-sz-mirrorcos.bilivideo.com");
  assert.equal(new URL(xhr._url).port, "");
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
  assert.equal(diag.version, "0.2.2");
  assert.ok(diag.counters && typeof diag.counters.rewrites === "number");
});
