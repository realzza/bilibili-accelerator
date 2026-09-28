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

// ---- v3: overseas-first candidate pool ----------------------------------------

test("the candidate pool spans both the overseas and mainland tiers", () => {
  // Auto-selection can only ever pick a host that is in this pool, so both
  // tiers have to be present: overseas viewers measured the *ov mirrors 4-9x
  // faster, while a viewer in Tokyo (issue #26) probed upos-sz-mirrorcos as
  // their fastest host. Neither tier may be assumed away — the probe decides.
  ["upos-sz-mirrorcosov.bilivideo.com",
   "upos-sz-mirroraliov.bilivideo.com",
   "upos-sz-mirrorhwov.bilivideo.com",
   "upos-sz-mirrorcos.bilivideo.com",
   "upos-sz-mirrorali.bilivideo.com",
   "upos-sz-mirrorhw.bilivideo.com",
   "upos-tf-all-hw.bilivideo.com",
   "upos-tf-all-tx.bilivideo.com"].forEach((host) => {
    assert.ok(core.CANDIDATE_POOL.includes(host), host + " must be a candidate");
  });
});

test("akamai stays out of the candidate pool", () => {
  // Akamai answers a upos-signed path with 403, so it can never pass the
  // probe's response.ok check — listing it would just burn a probe slot.
  assert.ok(!core.CANDIDATE_POOL.some((h) => h.includes("akamaized.net")));
});

test("a stored v2 config is migrated onto the widened candidate pool", () => {
  const v2 = {
    schemaVersion: 2,
    selection: "auto",
    pcdnHost: "upos-sz-mirrorcos.bilivideo.com",
    candidatePool: [
      "upos-sz-mirrorcos.bilivideo.com",
      "upos-sz-mirrorali.bilivideo.com",
      "upos-sz-mirrorhw.bilivideo.com",
      "upos-tf-all-hw.bilivideo.com",
      "upos-tf-all-tx.bilivideo.com"
    ]
  };
  const cfg = core.normalizeConfig(v2);

  assert.deepEqual(cfg.candidatePool, core.CANDIDATE_POOL.slice(),
    "the stale mainland-only pool is replaced, not preserved");
  assert.equal(cfg.pcdnHost, core.DEFAULT_CONFIG.pcdnHost,
    "the retired default target is moved off the mainland mirror");
  assert.equal(cfg.schemaVersion, core.SCHEMA_VERSION);
});

test("migration keeps a host the user pinned in fixed mode", () => {
  const cfg = core.normalizeConfig({
    schemaVersion: 2,
    selection: "fixed",
    pcdnHost: "upos-sz-mirrorcos.bilivideo.com"
  });
  assert.equal(cfg.pcdnHost, "upos-sz-mirrorcos.bilivideo.com");
  assert.deepEqual(cfg.candidatePool, core.CANDIDATE_POOL.slice());
});

test("a saved auto config drops the host 0.4.x rotation left in it", () => {
  // 0.4.x moved pcdnHost along the ranking on every stall and saved it with
  // the next unrelated setting. A real report came back with tf-all-tx saved,
  // a host the viewer never chose.
  const cfg = core.normalizeConfig({
    schemaVersion: 3,
    selection: "auto",
    mode: "force",
    pcdnHost: "upos-tf-all-tx.bilivideo.com"
  });
  assert.equal(cfg.pcdnHost, core.DEFAULT_CONFIG.pcdnHost);
  assert.equal(cfg.mode, "force", "the saved mode stays; it applies again under fixed selection");
  assert.equal(cfg.schemaVersion, 4);
});

test("a partial config without a version keeps the host it names", () => {
  const cfg = core.normalizeConfig({ selection: "auto", pcdnHost: "upos-tf-all-hw.bilivideo.com" });
  assert.equal(cfg.pcdnHost, "upos-tf-all-hw.bilivideo.com");
});

test("an already-current config is not re-migrated", () => {
  const cfg = core.normalizeConfig({
    schemaVersion: core.SCHEMA_VERSION,
    selection: "auto",
    pcdnHost: "upos-sz-mirrorcos.bilivideo.com",
    candidatePool: ["upos-sz-mirrorhw.bilivideo.com"]
  });
  assert.equal(cfg.pcdnHost, "upos-sz-mirrorcos.bilivideo.com");
  assert.deepEqual(cfg.candidatePool, ["upos-sz-mirrorhw.bilivideo.com"]);
});

// ---- v3: ranking signal and force-mode scope ----------------------------------

test("rankHosts ranks on throughput, not time to first byte", () => {
  // The failure this encodes: a mainland mirror answered headers fastest and so
  // won a TTFB-only ranking, while actually moving a third of the bytes. Force
  // mode then routed every segment onto it.
  const ranked = core.rankHosts([
    { host: "mainland.bilivideo.com", ttfb: 200, mbps: 19.9, ok: true },
    { host: "overseas.bilivideo.com", ttfb: 430, mbps: 74.5, ok: true },
    { host: "dead.bilivideo.com", ttfb: null, mbps: 0, ok: false }
  ]);
  assert.deepEqual(ranked, [
    "overseas.bilivideo.com",
    "mainland.bilivideo.com",
    "dead.bilivideo.com"
  ]);
});

test("rankHosts falls back to TTFB when no rate was measured", () => {
  const ranked = core.rankHosts([
    { host: "slow.bilivideo.com", ttfb: 800, mbps: 0, ok: true },
    { host: "fast.bilivideo.com", ttfb: 120, mbps: 0, ok: true }
  ]);
  assert.deepEqual(ranked, ["fast.bilivideo.com", "slow.bilivideo.com"]);
});

test("force mode reaches the overseas mirrors too", () => {
  // These were carved out of force mode for a while, because force mode had been
  // seen rewriting mirrorcosov onto a mainland mirror the probe mis-ranked first.
  // Throughput ranking over a two-tier pool fixed the mis-ranking, and the
  // carve-out cost more than it saved: stall recovery drives force mode through
  // recovery.avoidHost, so a stalling *ov host became unroutable — recovery
  // counted a rotation and rewrote nothing. In force mode the selected target is
  // the measured-fastest host, which is what the mode exists to apply.
  const cfg = { mode: "force", pcdnHost: "upos-sz-mirrorali.bilivideo.com" };
  ["upos-sz-mirrorcosov.bilivideo.com",
   "upos-sz-mirroraliov.bilivideo.com",
   "upos-sz-mirrorhwov.bilivideo.com"].forEach((host) => {
    const detail = core.rewriteUrlDetail("https://" + host + "/upgcxcode/v.m4s?a=1", cfg);
    assert.equal(detail.changed, true, host + " must be reachable by force mode");
    assert.equal(new URL(detail.url).hostname, "upos-sz-mirrorali.bilivideo.com");
  });
});

test("bad-only mode still never rewrites the overseas mirrors", () => {
  // The carve-out above is gone, so this is the only thing standing between the
  // default configuration and the transpacific reroute that caused the stalls.
  ["upos-sz-mirrorcosov.bilivideo.com",
   "upos-sz-mirroraliov.bilivideo.com",
   "upos-sz-mirrorhwov.bilivideo.com"].forEach((host) => {
    const detail = core.rewriteUrlDetail("https://" + host + "/upgcxcode/v.m4s?a=1",
      { mode: "bad-only", pcdnHost: "upos-sz-mirrorali.bilivideo.com" });
    assert.equal(detail.changed, false, host + " must survive the default mode");
    assert.equal(detail.reason, "ok");
  });
});

test("force mode still rewrites mainland and unknown CDN hosts", () => {
  const cfg = { mode: "force", pcdnHost: "upos-sz-mirrorcosov.bilivideo.com" };
  ["upos-sz-mirrorcos.bilivideo.com", "upos-tf-all-tx.bilivideo.com"].forEach((host) => {
    const detail = core.rewriteUrlDetail("https://" + host + "/upgcxcode/v.m4s?a=1", cfg);
    assert.equal(detail.changed, true, host + " should still be forced");
    assert.equal(new URL(detail.url).hostname, "upos-sz-mirrorcosov.bilivideo.com");
  });
});

test("an overseas mirror on a PCDN-ish port is still caught", () => {
  // The force-mode exemption must not become a way to smuggle a bad host past
  // the port heuristic.
  const detail = core.rewriteUrlDetail(
    "https://upos-sz-mirrorcosov.bilivideo.com:8082/upgcxcode/v.m4s?a=1",
    { mode: "bad-only", pcdnHost: "upos-sz-mirrorali.bilivideo.com" });
  assert.equal(detail.changed, true);
  assert.equal(detail.reason, "pcdn-host");
});
