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

test("public API exposes diagnostics and config control", () => {
  const sandbox = loadPage();
  const cfg = sandbox.BiliAccelerator.setConfig({ p2pGuard: true });
  assert.equal(cfg.p2pGuard, true);
  const diag = sandbox.BiliAccelerator.getDiagnostics();
  assert.equal(diag.version, "0.2.0");
  assert.ok(diag.counters && typeof diag.counters.rewrites === "number");
});
