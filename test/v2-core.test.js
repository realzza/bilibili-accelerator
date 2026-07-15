const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../src/core/rewrite");

test("config migrates v1 shape forward to v2 defaults", () => {
  const v1 = {
    enabled: true,
    mode: "bad-only",
    pcdnHost: "upos-sz-mirrorali.bilivideo.com",
    mcdnStrategy: "proxy-v1",
    proxyHost: "proxy-tf-all-ws.bilivideo.com",
    rewriteAkamai: true,
    maxDepth: 20
  };
  const cfg = core.normalizeConfig(v1);

  assert.equal(cfg.schemaVersion, core.SCHEMA_VERSION);
  assert.equal(cfg.pcdnHost, "upos-sz-mirrorali.bilivideo.com");
  assert.equal(cfg.mcdnStrategy, "proxy-v1");
  assert.equal(cfg.rewriteAkamai, true);
  assert.equal(cfg.selection, "auto");
  assert.equal(cfg.portHeuristic, true);
  assert.equal(cfg.stallRecovery, true);
  assert.equal(cfg.p2pGuard, false);
  assert.ok(Array.isArray(cfg.candidatePool) && cfg.candidatePool.length > 0);
});

test("normalizeConfig rejects invalid enum values", () => {
  const cfg = core.normalizeConfig({ mode: "nonsense", selection: "weird", lang: "fr" });
  assert.equal(cfg.mode, "bad-only");
  assert.equal(cfg.selection, "auto");
  assert.equal(cfg.lang, "en");
});

test("language defaults to English and accepts zh", () => {
  assert.equal(core.normalizeConfig().lang, "en");
  assert.equal(core.normalizeConfig({ lang: "zh" }).lang, "zh");
});

test("appearance defaults to Bilibili blue on the system theme", () => {
  const cfg = core.normalizeConfig();
  assert.equal(cfg.accent, "bili");
  assert.equal(cfg.theme, "system");
});

test("normalizeConfig accepts known accents and theme modes", () => {
  core.ACCENT_KEYS.forEach((key) => {
    assert.equal(core.normalizeConfig({ accent: key }).accent, key);
  });
  core.THEME_MODES.forEach((mode) => {
    assert.equal(core.normalizeConfig({ theme: mode }).theme, mode);
  });
});

test("normalizeConfig rejects unknown accent and theme values", () => {
  const cfg = core.normalizeConfig({ accent: "chartreuse", theme: "sepia" });
  assert.equal(cfg.accent, "bili");
  assert.equal(cfg.theme, "system");
});

test("classify flags non-default ports as PCDN", () => {
  const url = new URL("https://1.2.3.4:8082/upgcxcode/x.m4s?abc=1");
  const v = core.classify(url, {});
  assert.equal(v.isPcdn, true);
  assert.equal(v.isSlow, true);
});

test("classify catches renamed PCDN families via port + os=mcdn", () => {
  const url = new URL("https://node-7.edge.mountaintoys.cn:4830/upgcxcode/v.m4s?os=mcdn&abc=1");
  const v = core.classify(url, {});
  assert.equal(v.isPcdn, true);
  assert.equal(v.isSlow, true);
});

test("mountaintoys-style PCDN URL is rewritten to the target host", () => {
  const original = "https://node-7.edge.mountaintoys.cn:4830/upgcxcode/12/34/567/567-1-30280.m4s?os=mcdn&abc=1";
  const detail = core.rewriteUrlDetail(original, { pcdnHost: "upos-sz-mirrorcos.bilivideo.com" });
  assert.equal(detail.changed, true);
  assert.equal(detail.reason, "pcdn-host");
  const out = new URL(detail.url);
  assert.equal(out.hostname, "upos-sz-mirrorcos.bilivideo.com");
  assert.equal(out.port, "");
});

test("port heuristic can be disabled", () => {
  // A bcache-style host on an odd port: with the heuristic off it must pass.
  // (mountaintoys can no longer serve here — it is a known P2P family and is
  // flagged regardless of port; see the known-suffix tests.)
  const url = new URL("https://cn-sccd-cu-01-01.bilivideo.com:4830/upgcxcode/v.m4s?abc=1");
  const v = core.classify(url, { portHeuristic: false });
  assert.equal(v.isPcdn, false);
});

test("known P2P families are flagged even with the port heuristic off", () => {
  const url = new URL("https://node-7.edge.mountaintoys.cn:4830/upgcxcode/v.m4s?abc=1");
  const v = core.classify(url, { portHeuristic: false });
  assert.equal(v.isPcdn, true);
});

test("os=mcdn alone (no weird port) is treated as PCDN", () => {
  const url = new URL("https://example.bilivideo.com/upgcxcode/v.m4s?os=mcdn&x=1");
  const v = core.classify(url, {});
  assert.equal(v.isPcdn, true);
});

test("healthy default-port UPOS host is left alone", () => {
  const original = "https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/v.m4s?abc=1";
  const detail = core.rewriteUrlDetail(original);
  assert.equal(detail.changed, false);
});

test("mode off disables all rewriting", () => {
  const original = "https://1.2.3.4:8082/upgcxcode/v.m4s?abc=1";
  const detail = core.rewriteUrlDetail(original, { mode: "off" });
  assert.equal(detail.changed, false);
});

test("alternativesFor builds host-swapped backups excluding current host", () => {
  const original = "https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/v.m4s?abc=1";
  const alts = core.alternativesFor(original, {}, [
    "upos-sz-mirrorcos.bilivideo.com",
    "upos-sz-mirrorali.bilivideo.com",
    "upos-sz-mirrorhw.bilivideo.com"
  ]);
  assert.equal(alts.length, 2);
  assert.ok(alts.every((u) => u.includes("/upgcxcode/v.m4s")));
  assert.ok(!alts.some((u) => new URL(u).hostname === "upos-sz-mirrorcos.bilivideo.com"));
});

test("throughputMbps converts bytes over a window to megabits per second", () => {
  // 1,000,000 bytes in 1000 ms = 8 Mbps
  assert.equal(core.throughputMbps(1e6, 1000), 8);
  // 250,000 bytes in 500 ms = 4 Mbps
  assert.equal(core.throughputMbps(250000, 500), 4);
  // guards against zero/negative inputs
  assert.equal(core.throughputMbps(0, 1000), 0);
  assert.equal(core.throughputMbps(1000, 0), 0);
});

test("unionDurationMs merges overlapping intervals", () => {
  // two back-to-back non-overlapping intervals: 100 + 100 = 200
  assert.equal(core.unionDurationMs([[0, 100], [200, 300]]), 200);
  // fully overlapping parallel transfers count their shared time once
  assert.equal(core.unionDurationMs([[0, 100], [0, 100]]), 100);
  // partial overlap merges into a single span
  assert.equal(core.unionDurationMs([[0, 100], [50, 150]]), 150);
  assert.equal(core.unionDurationMs([]), 0);
});

test("aggregateThroughput measures active rate, not wall-clock", () => {
  // 1,000,000 bytes downloaded in a 100ms burst, then idle. Over a 3s window
  // this is the burst's real rate (80 Mbps), NOT smeared to ~2.7 Mbps.
  const burst = [{ start: 0, end: 100, bytes: 1e6 }];
  assert.equal(core.aggregateThroughput(burst, 3000, 3000), 80);

  // Parallel video+audio segments over the same 100ms move a combined
  // 1,000,000 bytes: union active time is 100ms, so the link reads 80 Mbps.
  const parallel = [
    { start: 0, end: 100, bytes: 6e5 },
    { start: 0, end: 100, bytes: 4e5 }
  ];
  assert.equal(core.aggregateThroughput(parallel, 3000, 3000), 80);

  // No transfers in the window ⇒ 0 (the idle-hold lives in the page layer).
  assert.equal(core.aggregateThroughput([{ start: 0, end: 100, bytes: 1e6 }], 5000, 3000), 0);
});

test("aggregateThroughput prorates a transfer straddling the window edge", () => {
  // A 200ms transfer of 2,000,000 bytes (2900→3100ms) with a 100ms window
  // (3000→3100): only the last half is inside, so half the bytes over 100ms of
  // active time = 80 Mbps.
  const straddling = [{ start: 2900, end: 3100, bytes: 2e6 }];
  assert.equal(core.aggregateThroughput(straddling, 3100, 100), 80);
});

test("hostOf returns bare host[:port] and drops the query string", () => {
  assert.equal(
    core.hostOf("https://upos-sz-mirrorcos.bilivideo.com/x.m4s?mid=1&buvid=SECRET&upsig=tok"),
    "upos-sz-mirrorcos.bilivideo.com"
  );
  // keeps a non-default port (useful PCDN signal), still no query
  assert.equal(
    core.hostOf("https://node-7.edge.mountaintoys.cn:4830/upgcxcode/v.m4s?os=mcdn&oi=123"),
    "node-7.edge.mountaintoys.cn:4830"
  );
  assert.equal(core.hostOf("not a url"), "");
});

test("rankHosts orders healthy hosts by TTFB and sinks failures", () => {
  const ranked = core.rankHosts([
    { host: "slow.bilivideo.com", ttfb: 800, ok: true },
    { host: "dead.bilivideo.com", ttfb: null, ok: false },
    { host: "fast.bilivideo.com", ttfb: 120, ok: true }
  ]);
  assert.deepEqual(ranked, [
    "fast.bilivideo.com",
    "slow.bilivideo.com",
    "dead.bilivideo.com"
  ]);
});

test("force mode still respects mcdn proxy ordering", () => {
  const original = "https://xy1x2x3x4xy.mcdn.bilivideo.cn:8082/v1/resource/v.m4s?abc=1";
  const detail = core.rewriteUrlDetail(original, { mode: "force" });
  assert.equal(detail.reason, "mcdn-proxy");
  assert.equal(new URL(detail.url).hostname, "proxy-tf-all-ws.bilivideo.com");
});
