const test = require("node:test");
const assert = require("node:assert/strict");
const routing = require("../src/core/routing");

// Host history kept per Beijing time band, so the evening peak in China and
// the small hours are judged on their own samples.

const ALI = "upos-sz-mirrorali.bilivideo.com";
const HW = "upos-sz-mirrorhw.bilivideo.com";
const COSOV = "upos-sz-mirrorcosov.bilivideo.com";

const HOUR = 60 * 60 * 1000;
// A UTC day, so Beijing hour = UTC hour + 8.
const DAY0 = Date.UTC(2026, 10, 20);
const beijing = (hour, minute) => DAY0 + (hour - 8) * HOUR + (minute || 0) * 60000;

test("Beijing time bands split at 08:00 and 18:00", () => {
  assert.equal(routing.beijingBand(beijing(7, 59)), "night");
  assert.equal(routing.beijingBand(beijing(8)), "day");
  assert.equal(routing.beijingBand(beijing(17, 59)), "day");
  assert.equal(routing.beijingBand(beijing(18)), "peak");
  assert.equal(routing.beijingBand(beijing(23, 59)), "peak");
  assert.equal(routing.beijingBand(beijing(24)), "night");
  assert.equal(routing.beijingBand(undefined), null);
});

test("a sample goes into the all-hours record and its band's", () => {
  let h = routing.recordSample({}, ALI, 40, beijing(3));
  h = routing.recordSample(h, ALI, 4, beijing(20));
  const rec = h.hosts[ALI];
  assert.ok(rec.n > 1.8 && rec.n <= 2, "the all-hours record holds both: " + rec.n);
  assert.ok(rec.mbps > 4 && rec.mbps < 40);
  assert.equal(rec.bands.night.mbps, 40);
  assert.equal(rec.bands.peak.mbps, 4);
  assert.equal(rec.bands.day, undefined);
});

test("a band's record pulls the score toward it as it gathers samples", () => {
  const history = { hosts: { [ALI]: { mbps: 20, n: 10, at: 0, bands: { peak: { mbps: 2, n: 4, at: 0 } } } } };
  // (2 × 4 + 20 × 1) / (4 + 1)
  assert.equal(routing.historyScore(history, ALI, "peak"), 5.6);
  assert.equal(routing.historyScore(history, ALI, "night"), 20, "a band with no samples uses all hours");
  assert.equal(routing.historyScore(history, ALI), 20, "no band asked for: all hours");
});

test("history saved before bands existed still scores", () => {
  const history = { hosts: { [HW]: { mbps: 15, n: 3, at: 0 } } };
  assert.equal(routing.historyScore(history, HW, "peak"), 15);
});

test("challengers are ordered by the record for the current hour in Beijing", () => {
  // ali is fast at night and slow at peak; hw holds 12 Mbps around the clock.
  let history = {};
  for (let d = 0; d < 3; d += 1) {
    history = routing.recordSample(history, ALI, 60, beijing(3) + d * 24 * HOUR);
    history = routing.recordSample(history, ALI, 3, beijing(20) + d * 24 * HOUR);
    history = routing.recordSample(history, HW, 12, beijing(3) + d * 24 * HOUR);
    history = routing.recordSample(history, HW, 12, beijing(20) + d * 24 * HOUR);
  }
  const pick = (now) => routing.pickChallengers({
    candidates: [COSOV, ALI, HW], current: COSOV, issued: [COSOV],
    measured: {}, failed: {}, lost: {}, history, now, random: () => 0.99
  });
  const later = 3 * 24 * HOUR;
  assert.equal(pick(beijing(20) + later)[0], HW, "evening peak: the host that holds up");
  assert.equal(pick(beijing(3) + later)[0], ALI, "small hours: the host that is fast then");
});
