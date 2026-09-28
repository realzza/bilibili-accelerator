const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// End-to-end behavior of the VOD routing engine inside the page script, with
// a fake clock, an XHR that behaves like the player's XHRLoader (handlers as
// properties, a retry on the next URL when it times out), a fetch for races,
// and a <video> with a buffer. docs/vod-routing.md describes the rules.

const COSOV = "upos-sz-mirrorcosov.bilivideo.com";
const AKAM = "upos-hz-mirrorakam.akamaized.net";
const ALI = "upos-sz-mirrorali.bilivideo.com";
const HW = "upos-sz-mirrorhw.bilivideo.com";
const FILE = "/upgcxcode/05/16/42231991605/42231991605-1-30102.m4s";
const AUDIO = "/upgcxcode/05/16/42231991605/42231991605-1-30280.m4s";
const cosovUrl = (p) => "https://" + COSOV + p + "?os=cosovbv&upsig=aa&mid=12345&buvid=DEV";
const akamUrl = (p) => "https://" + AKAM + p + "?os=akam&hdnts=bb&mid=12345";
const MB = 1000000;

function playurl() {
  return {
    code: 0,
    data: {
      quality: 112,
      dash: {
        video: [{ id: 112, bandwidth: 3750000, codecs: "hvc1.1.6.L150.90", baseUrl: cosovUrl(FILE), backupUrl: [akamUrl(FILE)] }],
        audio: [{ id: 30280, bandwidth: 320000, codecs: "mp4a.40.2", baseUrl: cosovUrl(AUDIO), backupUrl: [akamUrl(AUDIO)] }]
      }
    }
  };
}

function loadEngine(opts) {
  const o = opts || {};
  const src = ["../src/core/rewrite.js", "../src/core/routing.js", "../src/page/bili-accelerator.page.js"]
    .map((f) => fs.readFileSync(path.join(__dirname, f), "utf8")).join("\n");
  let now = 1000;
  let seq = 1;
  const timers = [];
  const setTimeoutF = (cb, ms) => { const id = seq++; timers.push({ id, cb, at: now + (ms || 0), every: 0 }); return id; };
  const setIntervalF = (cb, ms) => { const id = seq++; timers.push({ id, cb, at: now + ms, every: ms }); return id; };
  const clearF = (id) => { const i = timers.findIndex((t) => t.id === id); if (i !== -1) timers.splice(i, 1); };

  const xhrs = [];
  class FakeXHR {
    constructor() {
      this.readyState = 0;
      this.status = 0;
      this.listeners = {};
      this.headers = {};
      this.timeout = 0;
      xhrs.push(this);
    }
    open(method, url) { this.method = method; this.url = String(url); this.readyState = 1; }
    setRequestHeader(k, v) { this.headers[String(k).toLowerCase()] = v; }
    send() { this.sentAt = now; }
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
    getResponseHeader() { return "video/mp4"; }
    emit(type, loaded) {
      const ev = { type, loaded: loaded || 0 };
      (this.listeners[type] || []).slice().forEach((fn) => fn.call(this, ev));
      const handler = this["on" + type];
      if (typeof handler === "function") handler.call(this, ev);
    }
    progress(loaded) { this.readyState = 3; this.emit("progress", loaded); }
    finish(status, loaded) { this.readyState = 4; this.status = status; this.emit("load", loaded); this.emit("loadend", loaded); }
    fail() { this.readyState = 4; this.status = 0; this.emit("error", 0); this.emit("loadend", 0); }
    abort() {
      this.nativeAborts = (this.nativeAborts || 0) + 1;
      this.readyState = 4;
      this.status = 0;
      this.emit("abort", 0);
      this.emit("loadend", 0);
      this.readyState = 0;
    }
  }

  const fetches = [];
  const race = o.race || {};
  function fakeFetch(url, init) {
    const host = new URL(url).host;
    const spec = race[host] || { ms: 3500, status: 206 };
    const range = /bytes=(\d+)-(\d+)/.exec((init && init.headers && init.headers.Range) || "");
    const bytes = range ? Number(range[2]) - Number(range[1]) + 1 : 0;
    const call = { url, host, init, aborted: false };
    fetches.push(call);
    return new Promise((resolve, reject) => {
      const id = setTimeoutF(() => {
        let sent = false;
        resolve({
          status: spec.status,
          headers: { get: () => "video/mp4" },
          body: {
            getReader: () => ({
              read: () => Promise.resolve(sent ? { done: true } : (sent = true, { done: false, value: new Uint8Array(spec.status === 206 ? bytes : 200) })),
              cancel() {}
            })
          }
        });
      }, spec.ms);
      if (init && init.signal) {
        init.signal.addEventListener("abort", () => { call.aborted = true; clearF(id); reject(new Error("aborted")); });
      }
    });
  }

  const videoListeners = {};
  const video = {
    paused: false,
    ended: false,
    readyState: 1,
    currentTime: 0,
    ahead: 0,
    get buffered() {
      const v = this;
      return { length: v.ahead > 0 ? 1 : 0, start: () => v.currentTime, end: () => v.currentTime + v.ahead };
    },
    addEventListener(type, fn) { videoListeners[type] = fn; },
    dispatch(type) { if (videoListeners[type]) videoListeners[type](); }
  };
  const docListeners = {};
  const store = new Map(Object.entries(o.storage || {}));
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
    key: (i) => Array.from(store.keys())[i] || null,
    get length() { return store.size; }
  };
  const pathName = o.path || "/video/BV1jNat6xESz/";
  const document = {
    readyState: "complete",
    hidden: false,
    documentElement: null,
    head: null,
    addEventListener(type, fn) { docListeners[type] = fn; },
    dispatch(type) { if (docListeners[type]) docListeners[type](); },
    getElementById: () => null,
    querySelector: (sel) => (sel === "video" ? video : null),
    createElement: () => ({})
  };
  // Exploration draws a random challenger one time in five; keep tests exact.
  const math = Object.create(Math);
  math.random = () => 0.99;
  const sandbox = {
    JSON: { parse: JSON.parse, stringify: JSON.stringify },
    URL, Date, WeakSet, Map, Headers, Response, Request, Promise, Intl, Uint8Array, AbortController,
    Math: math,
    performance: { now: () => now },
    XMLHttpRequest: FakeXHR,
    fetch: fakeFetch,
    navigator: { language: "en-US", clipboard: { writeText() {} } },
    console: { info() {}, warn() {}, error() {} },
    localStorage,
    location: { href: "https://www.bilibili.com" + pathName, pathname: pathName, hostname: "www.bilibili.com", reload() {} },
    document,
    setTimeout: setTimeoutF,
    clearTimeout: clearF,
    setInterval: setIntervalF,
    clearInterval: clearF
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  sandbox.addEventListener = () => {};
  vm.runInNewContext(src, sandbox);
  if (o.config) {
    sandbox.BiliAccelerator.setConfig(o.config);
  }

  async function flush() {
    for (let i = 0; i < 8; i += 1) {
      await new Promise((r) => setImmediate(r));
    }
  }
  async function advance(ms) {
    const until = now + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const t = timers[0];
      if (!t || t.at > until) break;
      now = t.at;
      if (t.every) {
        t.at += t.every;
      } else {
        timers.shift();
      }
      t.cb();
      await flush();
    }
    now = until;
    await flush();
  }

  // What the player's XHRLoader does for one fragment.
  function playerRequest(url, range, onTimeout) {
    const x = new sandbox.XMLHttpRequest();
    x.open("GET", url, true);
    x.responseType = "arraybuffer";
    x.setRequestHeader("Range", "bytes=" + range);
    x.withCredentials = false;
    x.onload = () => { x.loadCalls = (x.loadCalls || 0) + 1; };
    x.onloadend = () => { x.endCalls = (x.endCalls || 0) + 1; };
    x.onerror = () => {};
    x.timeout = 10000;
    x.ontimeout = () => { x.timeoutCalls = (x.timeoutCalls || 0) + 1; if (onTimeout) onTimeout(x); };
    x.onprogress = () => {};
    x.onabort = () => { x.abortHandlerCalls = (x.abortHandlerCalls || 0) + 1; };
    x.send();
    return x;
  }

  return {
    sandbox, api: sandbox.BiliAccelerator, xhrs, fetches, video, document, store, advance, playerRequest,
    parse: (payload) => sandbox.JSON.parse(JSON.stringify(payload))
  };
}

const hostOf = (u) => new URL(u).host;

// A fragment that answers in 100 ms and then trickles at ~1.1 Mbps, with an
// empty buffer: the cold-edge case from the field report.
async function slowStart(env, onTimeout) {
  const x = env.playerRequest(cosovUrl(FILE), "5000000-6499999", onTimeout);
  await env.advance(100);
  x.progress(10000);
  await env.advance(600);
  x.progress(95000);
  await env.advance(300);   // the 2000 ms tick sees it stuck and starts the race
  return x;
}

test("a video starts on Bilibili's assigned host, and nothing changes while it keeps up", async () => {
  const env = loadEngine();
  env.parse(playurl());
  const x = env.playerRequest(cosovUrl(FILE), "5000000-6499999");
  assert.equal(hostOf(x.url), COSOV, "the first request goes where the player sent it");
  await env.advance(40);
  x.progress(300000);
  await env.advance(100);
  x.finish(206, 1500000);
  env.video.ahead = 20;
  await env.advance(3000);
  assert.equal(env.fetches.length, 0, "no race");
  const diag = env.api.getDiagnostics();
  assert.equal(diag.session.assignedHost, COSOV);
  assert.equal(diag.session.activeHost, null);
  assert.equal(diag.status, "smooth");
  assert.ok(diag.session.hosts[COSOV].mbps > 50);
});

test("a slow first fragment races the same bytes, and the winner takes the rest of the video", async () => {
  const env = loadEngine({ race: { [ALI]: { ms: 900, status: 206 }, [AKAM]: { ms: 1000, status: 206 } } });
  env.parse(playurl());
  let retry = null;
  const x = await slowStart(env, () => {
    // The loader's timeout path: next URL in its list, same range.
    retry = env.playerRequest(akamUrl(FILE), "5000000-6499999");
  });

  assert.deepEqual(env.fetches.map((f) => f.host), [AKAM, ALI],
    "the player's own alternative, then a mainland mirror since nothing is known yet");
  env.fetches.forEach((f) => {
    assert.equal(f.init.headers.Range, "bytes=5000000-5786431", "the first 768 KB of the stuck fragment");
    assert.equal(f.init.credentials, "omit");
  });
  assert.equal(env.api.getDiagnostics().status, "testing");

  await env.advance(1000);
  const diag = env.api.getDiagnostics();
  assert.equal(diag.session.activeHost, ALI);
  assert.equal(diag.counters.switches, 1);

  // The stuck request ended through the player's own timeout path.
  assert.equal(x.nativeAborts, 1);
  assert.equal(x.timeoutCalls, 1);
  assert.equal(x.endCalls, 1);
  assert.equal(x.abortHandlerCalls, undefined, "the player never saw an abort");
  assert.ok(retry, "the player retried the range");
  assert.equal(hostOf(retry.url), ALI, "and the retry went to the winner");
  assert.ok(retry.url.includes("os=cosovbv"), "through a swap of the UPOS-signed URL");
  assert.equal(diag.synthetic.used, 1);

  const audio = env.playerRequest(akamUrl(AUDIO), "0-40000");
  assert.equal(hostOf(audio.url), ALI, "audio follows the video");
});

// Three fragments at 40 Mbps from the assigned host, then a nearly empty
// buffer and a fragment that gets no first byte.
async function hangAfterKeepingUp(env, range, onTimeout) {
  let start = 0;
  for (let i = 0; i < 3; i += 1) {
    const x = env.playerRequest(cosovUrl(FILE), start + "-" + (start + 1499999));
    await env.advance(300);
    x.finish(206, 1500000);
    start += 1500000;
  }
  env.video.ahead = 1;
  const x = env.playerRequest(cosovUrl(FILE), range, onTimeout);
  await env.advance(1500);   // no first byte after a second: stuck, and a race starts
  return x;
}

test("one hung fragment on a host that keeps up is retried on the winner, and the video stays", async () => {
  const env = loadEngine({ race: { [ALI]: { ms: 900, status: 206 }, [AKAM]: { ms: 1000, status: 206 } } });
  env.parse(playurl());
  let retry = null;
  const x = await hangAfterKeepingUp(env, "4500000-5999999", () => {
    retry = env.playerRequest(akamUrl(FILE), "4500000-5999999");
  });
  assert.deepEqual(env.fetches.map((f) => f.host), [AKAM, ALI]);
  await env.advance(1000);

  let diag = env.api.getDiagnostics();
  assert.equal(diag.counters.switches, 0, "0.9 s for 768 KB is no match for 40 Mbps");
  assert.equal(diag.session.races[0].switchTo, null);
  assert.equal(diag.session.races[0].retryOn, ALI);
  assert.equal(diag.session.races[0].stuckMbps, 0);
  assert.equal(x.timeoutCalls, 1, "the stuck request still ended through the player's timeout path");
  assert.equal(diag.synthetic.used, 1);
  assert.ok(retry, "the player retried the range");
  assert.equal(hostOf(retry.url), ALI, "on the winner, not the next URL in its own list");

  await env.advance(3100);
  const next = env.playerRequest(akamUrl(FILE), "6000000-7499999");
  assert.equal(hostOf(next.url), COSOV, "the player moved on to its backup URL; the video stays on its host");
  assert.ok(next.url.includes("os=cosovbv"), "through the URL Bilibili issued for it");
  diag = env.api.getDiagnostics();
  assert.equal(diag.session.activeHost, COSOV);
  assert.equal(diag.counters.switches, 0);
});

test("a second hang within the error window moves the video", async () => {
  const env = loadEngine({ race: { [ALI]: { ms: 900, status: 206 }, [AKAM]: { ms: 1000, status: 206 } } });
  env.parse(playurl());
  await hangAfterKeepingUp(env, "4500000-5999999", () => env.playerRequest(akamUrl(FILE), "4500000-5999999"));
  await env.advance(1000);
  assert.equal(env.api.getDiagnostics().counters.switches, 0);

  await env.advance(3100);
  let retry = null;
  env.playerRequest(akamUrl(FILE), "6000000-7499999", () => {
    retry = env.playerRequest(akamUrl(FILE), "6000000-7499999");
  });
  await env.advance(1500);
  await env.advance(1000);
  const diag = env.api.getDiagnostics();
  assert.equal(diag.counters.switches, 1, "the host hung twice in 30 s");
  assert.equal(diag.session.activeHost, ALI);
  assert.equal(diag.session.switches[0].trigger, "stuck");
  assert.equal(diag.session.switches[0].beforeMbps, 0, "with no credit for its earlier rate");
  assert.equal(hostOf(retry.url), ALI);
});

test("a race that outlasts the player's own timeout never times the request out twice", async () => {
  const env = loadEngine({ race: { [ALI]: { ms: 1800, status: 206 }, [AKAM]: { ms: 2500, status: 206 } } });
  env.parse(playurl());
  const x = await hangAfterKeepingUp(env, "4500000-5999999");
  await env.advance(550);
  // The player's no-first-byte deadline passes first: it aborts the request
  // (readyState ends at 0, not 4) and retries on the next URL in its list.
  x.abort();
  const own = env.playerRequest(akamUrl(FILE), "4500000-5999999");
  assert.equal(hostOf(own.url), AKAM);
  await env.advance(2000);

  const diag = env.api.getDiagnostics();
  assert.equal(diag.session.races[0].retryOn, ALI, "the hang the player timed out is not an earlier failure");
  assert.equal(diag.counters.switches, 0);
  assert.equal(x.timeoutCalls, undefined, "no second timeout for a request the player already ended");
  assert.equal(diag.synthetic.used, 0);
  assert.equal(diag.session.activeHost, COSOV, "the video stays on its host");

  const next = env.playerRequest(akamUrl(FILE), "6000000-7499999");
  assert.equal(hostOf(next.url), COSOV);
  await env.advance(50);
  next.fail();
  const retry = env.playerRequest(akamUrl(FILE), "6000000-7499999");
  assert.equal(hostOf(retry.url), ALI, "a failure there retries on the race winner");
});

test("Akamai is reached only through the URL Bilibili issued for it", async () => {
  const env = loadEngine({ race: { [AKAM]: { ms: 500, status: 206 }, [ALI]: { ms: 2500, status: 206 } } });
  env.parse(playurl());
  await slowStart(env);
  await env.advance(1000);
  assert.equal(env.api.getDiagnostics().session.activeHost, AKAM);
  const next = env.playerRequest(cosovUrl(FILE), "6500000-7999999");
  assert.equal(hostOf(next.url), AKAM);
  assert.ok(next.url.includes("hdnts=bb"), "Akamai's own token, not a swapped UPOS signature");
});

test("a race that finds nothing clearly faster changes nothing, and waits longer each time", async () => {
  const env = loadEngine({ race: { [AKAM]: { ms: 1500, status: 206 }, [ALI]: { ms: 1400, status: 206 } } });
  env.parse(playurl());
  env.video.ahead = 10;
  // Three 1.5 MB fragments at ~4.2 Mbps: under 1.2x the 3.75 Mbps stream.
  let start = 1000000;
  for (let i = 0; i < 3; i += 1) {
    const x = env.playerRequest(cosovUrl(FILE), start + "-" + (start + 1499999));
    await env.advance(2860);
    x.finish(206, 1500000);
    start += 1500000;
  }
  await env.advance(500);
  assert.equal(env.fetches.length, 2, "a shortfall race");
  assert.equal(env.fetches[0].init.headers.Range, "bytes=5500000-6286431", "the bytes after the last fragment");
  await env.advance(2000);
  let diag = env.api.getDiagnostics();
  assert.equal(diag.session.activeHost, null, "1.4 s for 768 KB is not 1.5x better than 4.2 Mbps");
  assert.equal(diag.session.races[0].switchTo, null);
  assert.equal(diag.status, "slow");

  await env.advance(10000);
  assert.equal(env.fetches.length, 2, "no second race inside the 15 s cooldown");
  await env.advance(6000);
  assert.equal(env.fetches.length, 4, "after it, two hosts not yet tried");
  assert.equal(env.fetches.slice(2).some((f) => f.host === AKAM || f.host === ALI), false,
    "the hosts that just lost rest for a minute");
  await env.advance(5000);
  assert.equal(env.api.getDiagnostics().session.activeHost, null, "3.5 s for 768 KB is no better either");
  await env.advance(20000);
  assert.equal(env.fetches.length, 4, "and the next wait is 30 s");
});

test("a failed request on the active host sends its retry to the runner-up", async () => {
  const env = loadEngine({ race: { [ALI]: { ms: 900, status: 206 }, [AKAM]: { ms: 1000, status: 206 } } });
  env.parse(playurl());
  await slowStart(env);
  await env.advance(1000);
  assert.equal(env.api.getDiagnostics().session.activeHost, ALI);

  const x = env.playerRequest(cosovUrl(FILE), "6500000-7999999");
  assert.equal(hostOf(x.url), ALI);
  await env.advance(50);
  x.fail();
  const retry = env.playerRequest(akamUrl(FILE), "6500000-7999999");
  assert.equal(hostOf(retry.url), AKAM, "the runner-up of the last race, as issued");
  await env.advance(3100);
  const later = env.playerRequest(cosovUrl(FILE), "8000000-9499999");
  assert.equal(hostOf(later.url), ALI, "the active host is back once the moment passes");
});

test("a synthetic timeout that brings no retry turns them off for the page", async () => {
  const env = loadEngine({ race: { [ALI]: { ms: 900, status: 206 }, [AKAM]: { ms: 1000, status: 206 } } });
  env.parse(playurl());
  await slowStart(env, () => {});   // a player that does not retry
  await env.advance(1000);
  assert.equal(env.api.getDiagnostics().synthetic.used, 1);
  await env.advance(3500);
  const synthetic = env.api.getDiagnostics().synthetic;
  assert.equal(synthetic.disabled, true);
  assert.equal(synthetic.noRetry, 1);
});

test("a retry is never ended early, so the player keeps its own retries", async () => {
  const env = loadEngine({ race: { [ALI]: { ms: 900, status: 206 }, [AKAM]: { ms: 1000, status: 206 }, [HW]: { ms: 700, status: 206 } } });
  env.parse(playurl());
  let retry = null;
  await slowStart(env, () => { retry = env.playerRequest(akamUrl(FILE), "5000000-6499999"); });
  await env.advance(1000);
  assert.equal(hostOf(retry.url), ALI);
  // The retry on the winner is slow too.
  await env.advance(100);
  retry.progress(10000);
  await env.advance(10500);   // past the 10 s backoff after the first switch
  retry.progress(60000);
  await env.advance(1000);
  await env.advance(1500);
  const diag = env.api.getDiagnostics();
  assert.equal(diag.counters.switches, 2, "the engine still moves on");
  assert.equal(diag.synthetic.used, 1, "but only first attempts are ever ended early");
  assert.equal(retry.timeoutCalls, undefined);
});

test("no race while the tab is hidden", async () => {
  const env = loadEngine({ race: { [ALI]: { ms: 900, status: 206 } } });
  env.parse(playurl());
  env.document.hidden = true;
  env.document.dispatch("visibilitychange");
  await slowStart(env);
  await env.advance(3000);
  assert.equal(env.fetches.length, 0);
});

test("no race off a player page, where playurls come from hover previews", async () => {
  const env = loadEngine({ path: "/", race: { [ALI]: { ms: 900, status: 206 } } });
  env.parse(playurl());
  await slowStart(env);
  await env.advance(3000);
  assert.equal(env.fetches.length, 0);
});

test("fixed selection keeps its own rewrite and never races", async () => {
  const env = loadEngine({ config: { selection: "fixed", mode: "force", pcdnHost: HW }, race: { [ALI]: { ms: 500, status: 206 } } });
  env.parse(playurl());
  const x = await slowStart(env);
  assert.equal(hostOf(x.url), HW);
  await env.advance(3000);
  assert.equal(env.fetches.length, 0);
});

test("routing state never reaches the saved config", async () => {
  const env = loadEngine({ race: { [ALI]: { ms: 900, status: 206 }, [AKAM]: { ms: 1000, status: 206 } } });
  env.parse(playurl());
  await slowStart(env);
  await env.advance(1000);
  assert.equal(env.api.getDiagnostics().session.activeHost, ALI);
  assert.equal(env.store.get("biliAccelerator.config.v2"), undefined, "nothing saved the config");
  assert.equal(env.api.getConfig().pcdnHost, env.sandbox.BiliAcceleratorCore.DEFAULT_CONFIG.pcdnHost);
  const history = JSON.parse(env.store.get("biliAccelerator.hosts.v1.America/Los_Angeles|en-US") ||
    Array.from(env.store.entries()).find(([k]) => k.startsWith("biliAccelerator.hosts.v1."))[1]);
  assert.ok(history.hosts[ALI].mbps > 0, "race results go into host history instead");
});

test("a manual test with nothing to fix reports that the current server is fastest", async () => {
  const env = loadEngine({ race: { [AKAM]: { ms: 1500, status: 206 }, [ALI]: { ms: 1400, status: 206 } } });
  env.parse(playurl());
  env.video.ahead = 40;
  const x = env.playerRequest(cosovUrl(FILE), "1000000-2499999");
  await env.advance(300);
  x.finish(206, 1500000);   // 40 Mbps
  assert.equal(env.api.retest(), true);
  await env.advance(2000);
  const diag = env.api.getDiagnostics();
  assert.equal(diag.session.races[0].trigger, "manual");
  assert.equal(diag.session.races[0].switchTo, null);
  assert.equal(diag.session.activeHost, null);
  assert.equal(env.api.retest(), false, "manual tests are spaced ten seconds apart");
});

test("the report carries hosts and timings, never a URL, token or video id", async () => {
  const env = loadEngine({ race: { [ALI]: { ms: 900, status: 206 }, [AKAM]: { ms: 1000, status: 206 } } });
  env.parse(playurl());
  await slowStart(env, () => env.playerRequest(akamUrl(FILE), "5000000-6499999"));
  await env.advance(1000);
  const blob = JSON.stringify(env.api.getDiagnostics());
  ["?", "upsig", "hdnts", "mid=", "buvid", "DEV", "42231991605", "upgcxcode"].forEach((needle) => {
    assert.equal(blob.includes(needle), false, "report leaks " + needle);
  });
  assert.ok(blob.includes(ALI) && blob.includes(COSOV));
});

test("rankings cached by 0.4.x are removed at boot", () => {
  const env = loadEngine({ storage: {
    "biliAccelerator.rank.v3.America/Los_Angeles|en-US": "{\"ranking\":[],\"at\":1}",
    "biliAccelerator.rank.America/Los_Angeles|en-US": "{}",
    "other": "kept"
  } });
  assert.deepEqual(Array.from(env.store.keys()), ["other"]);
});

test("live segments are never measured or routed", async () => {
  const env = loadEngine({ race: { [ALI]: { ms: 900, status: 206 } } });
  const live = "https://d1--ov-gotcha207.bilivideo.com/live-bvc/114099/live_1/1234-1-30102.m4s?x=1";
  const x = env.playerRequest(live, "0-1500000");
  assert.equal(x.url, live);
  await env.advance(3000);
  assert.equal(env.fetches.length, 0);
  assert.equal(env.api.getDiagnostics().session, null);
});

// A manual test before anything is measured races the current host too, and
// compares every host on the same bytes.
async function manualWithoutEstimate(race) {
  const env = loadEngine({ race });
  env.parse(playurl());
  env.video.ahead = 40;
  const x = env.playerRequest(cosovUrl(FILE), "1000000-1099999");   // 100 KB: too little to estimate from
  await env.advance(100);
  x.finish(206, 100000);
  assert.equal(env.api.retest(), true);
  return env;
}

test("a manual test keeps the current host when it finishes first", async () => {
  const env = await manualWithoutEstimate({ [COSOV]: { ms: 400, status: 206 }, [AKAM]: { ms: 900, status: 206 }, [ALI]: { ms: 800, status: 206 } });
  assert.deepEqual(env.fetches.map((f) => f.host).sort(), [AKAM, ALI, COSOV].sort());
  await env.advance(2000);
  const race = env.api.getDiagnostics().session.races[0];
  assert.equal(race.switchTo, null);
  assert.equal(env.api.getDiagnostics().session.activeHost, null);
});

test("a manual test switches when the current host is 1.5x slower on the same bytes", async () => {
  const env = await manualWithoutEstimate({ [COSOV]: { ms: 3000, status: 206 }, [AKAM]: { ms: 900, status: 206 }, [ALI]: { ms: 400, status: 206 } });
  // ALI finishes at 400 ms; the current host has until 600 ms to match it.
  await env.advance(700);
  assert.equal(env.api.getDiagnostics().session.activeHost, ALI, "decided at 1.5x the winner's time");
  const race = env.api.getDiagnostics().session.races[0];
  const incumbent = race.contenders.find((c) => c.incumbent);
  assert.equal(incumbent.host, COSOV);
  assert.ok(incumbent.ms >= 600 && incumbent.ms < 1000, "its time is the margin it failed to beat: " + incumbent.ms);
});
