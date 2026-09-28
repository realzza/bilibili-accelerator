const test = require("node:test");
const assert = require("node:assert/strict");
const routing = require("../src/core/routing");

const COSOV = "upos-sz-mirrorcosov.bilivideo.com";
const AKAM = "upos-hz-mirrorakam.akamaized.net";
const HW = "upos-sz-mirrorhw.bilivideo.com";
const ALI = "upos-sz-mirrorali.bilivideo.com";
const TFHW = "upos-tf-all-hw.bilivideo.com";
const PATH = "/upgcxcode/05/16/42231991605/42231991605-1-30102.m4s";
const AUDIO_PATH = "/upgcxcode/05/16/42231991605/42231991605-1-30280.m4s";

function playurl(extra) {
  return {
    code: 0,
    data: {
      dash: Object.assign({
        video: [{
          id: 112, bandwidth: 3753786, codecs: "hvc1.1.6.L150.90",
          baseUrl: "https://" + COSOV + PATH + "?os=cosovbv&upsig=a",
          backupUrl: ["https://" + AKAM + PATH + "?os=akam&hdnts=b"]
        }],
        audio: [{
          id: 30280, bandwidth: 319173, codecs: "mp4a.40.2",
          base_url: "https://" + AKAM + AUDIO_PATH + "?os=akam&hdnts=c",
          backup_url: ["https://" + COSOV + AUDIO_PATH + "?os=cosovbv&upsig=d"]
        }]
      }, extra || {})
    }
  };
}

test("fileKey names the file, the same on every host", () => {
  assert.equal(routing.fileKey("https://" + COSOV + PATH + "?x=1"), "42231991605-1-30102.m4s");
  assert.equal(routing.fileKey("https://" + AKAM + PATH + "?hdnts=1"), "42231991605-1-30102.m4s");
  assert.equal(routing.fileKey("https://api.bilibili.com/x/player/playurl?x=1"), null);
  assert.equal(routing.cidOf("42242147914_qe1-1-30032.m4s"), "42242147914");
  assert.equal(routing.repIdOf("42231991605-1-100027.m4s"), "100027");
});

test("parseRange reads the player's byte range", () => {
  assert.deepEqual(routing.parseRange("bytes=100-199"), { start: 100, end: 199, length: 100 });
  assert.equal(routing.parseRange("bytes=100-").length, NaN);
  assert.equal(routing.parseRange(null), null);
});

test("the session table keeps every issued URL, signature included", () => {
  const table = routing.buildTable(playurl());
  assert.equal(table.cid, "42231991605");
  const video = table.reps["42231991605-1-30102.m4s"];
  assert.equal(video.kind, "video");
  assert.equal(video.bandwidth, 3753786);
  assert.deepEqual(video.issued, [COSOV, AKAM]);
  assert.ok(video.urls[AKAM].includes("hdnts=b"), "Akamai keeps its own token");
  const audio = table.reps["42231991605-1-30280.m4s"];
  assert.equal(audio.kind, "audio");
  assert.deepEqual(audio.issued, [AKAM, COSOV], "snake_case entries are read too, in issued order");
});

test("the session table reads bangumi and bare dash shapes and skips unusable URLs", () => {
  const bangumi = { result: { video_info: playurl().data } };
  assert.ok(routing.buildTable(bangumi).reps["42231991605-1-30102.m4s"]);
  const bare = playurl().data;
  assert.ok(routing.buildTable(bare).reps["42231991605-1-30102.m4s"]);

  const table = routing.buildTable(playurl(), (u) => !u.includes("akamaized"));
  assert.deepEqual(table.reps["42231991605-1-30102.m4s"].issued, [COSOV]);
  assert.equal(routing.buildTable({ data: { durl: [] } }), null, "non-DASH payloads build nothing");
  assert.equal(routing.buildTable({ uid: 0, play_url: "https://x/live-bvc/1/index.m3u8" }), null);
});

test("urlFor uses an issued URL as is and swaps hosts only onto UPOS mirrors", () => {
  const rep = routing.buildTable(playurl()).reps["42231991605-1-30102.m4s"];
  assert.equal(routing.urlFor(rep, AKAM), rep.urls[AKAM], "Akamai only through its issued URL");
  const hw = routing.urlFor(rep, HW);
  assert.equal(new URL(hw).host, HW);
  assert.ok(hw.includes("os=cosovbv"), "a swap carries the UPOS signature, never Akamai's");
  assert.equal(routing.urlFor(rep, "upos-sz-mirrorakam.akamaized.net"), null,
    "an Akamai host that was not issued cannot be synthesized");

  const akamOnly = routing.buildTable(playurl(), (u) => u.includes("akamaized"))
    .reps["42231991605-1-30102.m4s"];
  assert.equal(routing.urlFor(akamOnly, HW), null, "no UPOS source, no swap");
});

test("candidatesFor lists the issued hosts first, then reachable pool mirrors", () => {
  const rep = routing.buildTable(playurl()).reps["42231991605-1-30102.m4s"];
  assert.deepEqual(routing.candidatesFor(rep, [COSOV, HW, AKAM.toUpperCase(), ALI]),
    [COSOV, AKAM, HW, ALI]);
});

test("the estimator ignores tiny samples and needs 128 KB before it answers", () => {
  const est = routing.createEstimator();
  assert.equal(est.sample(50, 8000), false, "an 8 KB audio-sized sample is dropped");
  assert.equal(est.estimate(), null);
  est.sample(1000, 100000);
  assert.equal(est.estimate(), null, "100 KB is not enough to trust");
  est.sample(1000, 100000);
  assert.ok(Math.abs(est.estimate() - 800000) < 1, "800 kbps from two 100 KB/s samples");
});

test("the estimate falls fast and recovers slowly", () => {
  const est = routing.createEstimator();
  for (let i = 0; i < 10; i += 1) est.sample(250, 1250000); // 40 Mbps
  const high = est.estimate();
  est.sample(4000, 500000); // one 4 s fragment at 1 Mbps
  const afterDrop = est.estimate();
  assert.ok(afterDrop < high * 0.5, "one slow fragment pulls the estimate well down");
  est.sample(250, 1250000);
  assert.ok(est.estimate() < high * 0.6, "a single fast fragment does not undo it");
});

test("recentRate reads the last second of progress, not the whole transfer", () => {
  const samples = [[0, 0], [500, 500000], [1500, 525000], [2000, 537500]];
  // 537.5 KB - 525 KB... the window holds [1500, 2000]: 12.5 KB in 0.5 s = 200 kbps.
  assert.equal(Math.round(routing.recentRate(samples, 2000, 1000)), 200000);
  assert.equal(Math.round(routing.recentRate([[0, 0], [1000, 125000]], 1000, 100)), 1000000,
    "a single sample in the window falls back to the whole transfer");
});

test("a fragment with no first byte is stuck only when the buffer is nearly empty", () => {
  const req = { total: 1500000, loaded: 0, startedAt: 0, firstByteAt: null };
  assert.equal(routing.stuckVerdict(req, 900, 3.75e6, 0), null, "not before a second");
  assert.equal(routing.stuckVerdict(req, 1000, 3.75e6, 0).reason, "no-first-byte");
  assert.equal(routing.stuckVerdict(req, 1000, 3.75e6, 20), null,
    "with 20 s buffered the player's own 2 s deadline handles it");
});

test("a slow fragment is stuck when it will outlast the buffer", () => {
  // 1.1 Mbps on a 3.75 Mbps stream, 1.5 MB fragment, 600 ms into the transfer.
  const req = { total: 1500000, loaded: 82500, startedAt: 0, firstByteAt: 100, rateBps: 1.1e6 };
  const atStart = routing.stuckVerdict(req, 700, 3.75e6, 0);
  assert.equal(atStart.reason, "slow-fragment");
  assert.ok(atStart.remainingMs > 10000);
  assert.equal(routing.stuckVerdict(req, 700, 3.75e6, 60), null,
    "a minute of buffer outlasts it; the shortfall rule covers slow hosts then");
  const fast = Object.assign({}, req, { rateBps: 40e6 });
  assert.equal(routing.stuckVerdict(fast, 700, 3.75e6, 0), null, "a fast host is never stuck");
  const early = Object.assign({}, req, { loaded: 20000 });
  assert.equal(routing.stuckVerdict(early, 300, 3.75e6, 0), null, "too early to judge");
  const init = { total: 5000, loaded: 0, startedAt: 0, firstByteAt: null };
  assert.equal(routing.stuckVerdict(init, 5000, 3.75e6, 0), null, "init and index requests are ignored");
});

test("evaluate: errors first, then a stuck fragment, then a sustained shortfall", () => {
  const base = { now: 10000, requiredBps: 3.75e6, bufferAheadS: 10, inflight: [],
    estimateBps: 20e6, measuredBytes: 8e6, measuredMs: 10000, recentErrors: 0 };
  assert.equal(routing.evaluate(base), null, "a host at 5x the bitrate is left alone");
  assert.equal(routing.evaluate(Object.assign({}, base, { recentErrors: 2 })).trigger, "errors");
  assert.equal(routing.evaluate(Object.assign({}, base, { estimateBps: 4e6 })).trigger, "shortfall");
  assert.equal(routing.evaluate(Object.assign({}, base, { estimateBps: 4e6, bufferAheadS: 45 })), null,
    "with 45 s buffered a marginal host is not worth a race yet");
  assert.equal(routing.evaluate(Object.assign({}, base, { estimateBps: 4e6, measuredBytes: 1e6, measuredMs: 3000 })), null,
    "a shortfall needs 4 MB or 8 s of evidence");
  assert.equal(routing.evaluate(Object.assign({}, base, { requiredBps: 0, recentErrors: 5 })), null,
    "nothing is judged before the stream's bitrate is known");
});

test("pickChallengers tries the other issued host first, then history", () => {
  const history = { hosts: {
    [HW]: { mbps: 20, n: 5, at: 0 },
    [ALI]: { mbps: 9, n: 5, at: 0 },
    [TFHW]: { mbps: 14, n: 5, at: 0 }
  } };
  const picks = routing.pickChallengers({
    candidates: [COSOV, AKAM, HW, ALI, TFHW], current: COSOV, issued: [COSOV, AKAM],
    measured: {}, failed: {}, lost: {}, history, now: 1000, random: () => 0.99
  });
  assert.deepEqual(picks, [AKAM, HW]);

  const later = routing.pickChallengers({
    candidates: [COSOV, AKAM, HW, ALI, TFHW], current: COSOV, issued: [COSOV, AKAM],
    measured: { [AKAM]: true }, failed: {}, lost: { [HW]: 900 }, history, now: 1000, random: () => 0.99
  });
  assert.deepEqual(later, [TFHW, ALI],
    "a host that just lost a race rests; once measured, the issued alternative competes on history");
});

test("pickChallengers skips failed hosts, rates recent failures low and explores", () => {
  const history = { hosts: {
    [HW]: { mbps: 30, n: 5, at: 0, lastFailAt: 500 },
    [ALI]: { mbps: 9, n: 5, at: 0 }
  } };
  // HW measured fast once but failed a minute ago; it goes behind hosts that
  // have not failed, known or not.
  const picks = routing.pickChallengers({
    candidates: [COSOV, AKAM, HW, ALI, TFHW], current: COSOV, issued: [COSOV],
    measured: {}, failed: { [AKAM]: 2 }, lost: {}, history, now: 1000, random: () => 0.99
  });
  assert.equal(picks.includes(AKAM), false, "a host that failed twice this session is out");
  assert.deepEqual(picks.slice().sort(), [ALI, TFHW].sort(),
    "an unknown host scores as typical, and a host that just failed drops below both");

  let calls = 0;
  const explored = routing.pickChallengers({
    candidates: [COSOV, HW, ALI, TFHW], current: COSOV, issued: [COSOV],
    measured: {}, failed: {}, lost: {}, history: {}, now: 1000,
    random: () => (calls++ === 0 ? 0.1 : 0.99)
  });
  assert.equal(explored.length, 2);
  assert.equal(new Set(explored).size, 2);
});

test("raceVerdict switches only to a host that is clearly faster", () => {
  const results = [
    { host: HW, ok: true, ms: 900, bytes: 786432 },
    { host: AKAM, ok: true, ms: 2500, bytes: 786432 }
  ];
  // Current host at 1.1 Mbps needs ~5.7 s for 768 KB.
  const v = routing.raceVerdict(results, 1.1e6, 786432);
  assert.equal(v.winner, HW);
  assert.equal(v.runnerUp, AKAM);
  assert.equal(v.switchTo, HW);

  // Current host at 8 Mbps needs ~0.79 s; a 0.9 s winner is not an improvement.
  assert.equal(routing.raceVerdict(results, 8e6, 786432).switchTo, null);
  // A failing current host (rate 0) yields to any finisher.
  assert.equal(routing.raceVerdict([{ host: AKAM, ok: true, ms: 3000 }], 0, 786432).switchTo, AKAM);
  assert.equal(routing.raceVerdict([{ host: AKAM, ok: false }], 0, 786432).switchTo, null);
});

test("cooldowns double after each switch and after each race that changed nothing", () => {
  assert.equal(routing.nextCooldown("switch", 1), 10000);
  assert.equal(routing.nextCooldown("switch", 3), 40000);
  assert.equal(routing.nextCooldown("none", 0, 0), 15000);
  assert.equal(routing.nextCooldown("none", 0, 15000), 30000);
  assert.equal(routing.nextCooldown("none", 0, 100000), 120000);
});

test("history decays with age, so old measurements lose to new ones", () => {
  const day = 24 * 60 * 60 * 1000;
  let h = routing.recordSample({}, HW, 40, 0);
  h = routing.recordSample(h, HW, 40, 1000);
  h = routing.recordSample(h, HW, 5, 9 * day); // three half-lives later
  assert.ok(h.hosts[HW].mbps < 15, "a fresh 5 Mbps outweighs two stale 40s: " + h.hosts[HW].mbps);
  h = routing.recordFailure(h, HW, 9 * day);
  assert.equal(routing.recentlyFailed(h, HW, 9 * day + 1000), true, "a failure counts against a host");
  assert.equal(routing.recentlyFailed(h, HW, 10 * day), false, "for an hour");
  assert.equal(routing.historyScore(h, HW), h.hosts[HW].mbps, "without touching its measured rate");
});

test("describeHost names the region and cloud for the panel", () => {
  assert.deepEqual(routing.describeHost(COSOV), { region: "overseas", vendor: "tencent", id: "cosov" });
  assert.deepEqual(routing.describeHost(AKAM), { region: "overseas", vendor: "akamai", id: "akamai" });
  assert.deepEqual(routing.describeHost(HW), { region: "mainland", vendor: "huawei", id: "hw" });
  assert.deepEqual(routing.describeHost(TFHW), { region: "mainland", vendor: "huawei", id: "tf-hw" });
  assert.deepEqual(routing.describeHost("upos-sz-mirroraliov.bilivideo.com"),
    { region: "overseas", vendor: "alibaba", id: "aliov" });
  assert.equal(routing.describeHost("example.com").region, null);
});

test("with no history, mainland mirrors come before overseas mirrors that were not issued", () => {
  const ALIOV = "upos-sz-mirroraliov.bilivideo.com";
  const HWOV = "upos-sz-mirrorhwov.bilivideo.com";
  const picks = routing.pickChallengers({
    candidates: [COSOV, AKAM, ALIOV, HWOV, ALI, TFHW, HW], current: COSOV, issued: [COSOV, AKAM],
    measured: { [AKAM]: true }, failed: {}, lost: {}, history: {}, now: 1000, random: () => 0.99
  });
  assert.deepEqual(picks, [ALI, TFHW],
    "an overseas mirror Bilibili did not assign to this viewer is almost always cold");
  const learned = routing.pickChallengers({
    candidates: [COSOV, ALIOV, ALI, TFHW], current: COSOV, issued: [COSOV],
    measured: {}, failed: {}, lost: {}, now: 1000, random: () => 0.99,
    history: { hosts: { [ALIOV]: { mbps: 60, n: 3, at: 1000 }, [ALI]: { mbps: 8, n: 3, at: 1000 } } }
  });
  assert.equal(learned[0], ALIOV, "history overrides the default once it has measured something");
});
