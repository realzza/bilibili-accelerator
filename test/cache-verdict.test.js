const test = require("node:test");
const assert = require("node:assert/strict");
const routing = require("../src/core/routing");

// Cache status as each of Bilibili's CDN vendors reports it. The header sets
// below are trimmed from real responses (2026-11-26) to the fields that matter.

test("EdgeOne (mirrorcosov) reports eo-cache-status", () => {
  assert.equal(routing.cacheVerdict([{ name: "EO-Cache-Status", value: "HIT" }, { name: "Age", value: "17575" }]), "hit");
  assert.equal(routing.cacheVerdict({ "eo-cache-status": "MISS" }), "miss");
  assert.equal(routing.cacheVerdict({ "eo-cache-status": "EXPIRED" }), "miss");
});

test("Alibaba (mirrorali, mirroraliov) reports x-cache", () => {
  assert.equal(routing.cacheVerdict({ "x-cache": "HIT TCP_MEM_HIT dirn:-2:-2 mlen:524288" }), "hit");
  assert.equal(routing.cacheVerdict({ "x-cache": "MISS TCP_MISS dirn:-2:-2" }), "miss");
  assert.equal(routing.cacheVerdict({ "x-cache": "TCP_HIT from a23-1-2-3.deploy.akamaitechnologies.com" }), "hit");
});

test("Huawei (mirrorhw) marks each cache hop in via", () => {
  assert.equal(routing.cacheVerdict({
    via: "CHN-GDshenzhen-CMCCZJ4-CACHE24[4],CHN-GDshenzhen-CMCCZJ4-CACHE20[0,TCP_HIT,3],CHN-GDfoshan-GLOBALZJ3",
    "nginx-hit": "1"
  }), "hit");
  assert.equal(routing.cacheVerdict({
    via: "CHN-GDshenzhen-CMCCZJ4-CACHE24[89],CHN-GDshenzhen-CMCCZJ4-CACHE20[33,TCP_MISS,37],CHN-GDfoshan-GLOBA",
    age: "1"
  }), "miss");
});

test("a response that doesn't say gets no verdict", () => {
  assert.equal(routing.cacheVerdict([{ name: "Content-Range", value: "bytes 0-1023/78081346" }]), null);
  assert.equal(routing.cacheVerdict(null), null);
  assert.equal(routing.cacheVerdict({ "x-cache": "something-else" }), null);
});

test("a cache miss shortens the wait before a slow fragment is judged, not the bar it must clear", () => {
  const required = 3.75e6;
  const slow = { total: 1500000, loaded: 20000, startedAt: 0, firstByteAt: 100, rateBps: 0.4e6 };
  assert.equal(routing.stuckVerdict(slow, 400, required, 0), null, "300 ms of transfer is too early without a miss");
  assert.equal(routing.stuckVerdict(Object.assign({ cache: "miss" }, slow), 400, required, 0).reason, "slow-fragment");
  assert.equal(routing.stuckVerdict(Object.assign({ cache: "miss" }, slow), 250, required, 0), null, "but not before 200 ms");
  const keepingUp = Object.assign({ cache: "miss" }, slow, { rateBps: 13e6 });
  assert.equal(routing.stuckVerdict(keepingUp, 400, required, 0), null, "a miss that keeps up is fine");

  const waiting = { total: 1500000, loaded: 0, startedAt: 0, firstByteAt: null, cache: "miss" };
  assert.equal(routing.stuckVerdict(waiting, 600, required, 0).reason, "no-first-byte");
  assert.equal(routing.stuckVerdict(Object.assign({}, waiting, { cache: null }), 600, required, 0), null);
});
