const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../src/core/rewrite");

// ---- new PCDN family detection ----------------------------------------------

test("upos-*302* redirect hosts are classified as PCDN", () => {
  const url = new URL("https://upos-sz-302ppio.bilivideo.com/upgcxcode/12/34/567/567-1-30280.m4s?e=sig");
  const v = core.classify(url, {});
  assert.equal(v.isPcdn, true);
  assert.equal(v.isSlow, true);
  assert.equal(v.kind, "pcdn");
});

test("known residential P2P suffixes are PCDN even on default ports", () => {
  ["https://node.nexusedgeio.com/upgcxcode/v.m4s?x=1",
    "https://node.ahdohpiechei.com/upgcxcode/v.m4s?x=1",
    "https://node-7.edge.mountaintoys.cn/upgcxcode/v.m4s?x=1"
  ].forEach((raw) => {
    const detail = core.rewriteUrlDetail(raw, {});
    assert.equal(detail.changed, true, `${raw} should be rewritten`);
    assert.equal(detail.reason, "pcdn-host");
  });
});

test("mirror14b (PCDN with a mirror name) is rewritten", () => {
  const detail = core.rewriteUrlDetail("https://upos-sz-mirror14b.bilivideo.com/upgcxcode/v.m4s?x=1");
  assert.equal(detail.changed, true);
});

test("healthy gotcha-numbered hosts are not tripped by the 302 rule", () => {
  const url = new URL("https://d1--cn-gotcha208.bilivideo.com/live-bvc/x/index.m3u8?x=1");
  const v = core.classify(url, {});
  assert.equal(v.isPcdn, false);
});

// ---- protocol-relative URLs ---------------------------------------------------

test("protocol-relative media URLs are parsed and rewritten", () => {
  const detail = core.rewriteUrlDetail("//node-7.edge.mountaintoys.cn:4830/upgcxcode/v.m4s?os=mcdn");
  assert.equal(detail.changed, true);
  assert.equal(new URL(detail.url).protocol, "https:");
  assert.equal(new URL(detail.url).hostname, "upos-sz-mirrorcos.bilivideo.com");
});

// ---- live-stream safety -------------------------------------------------------

test("live /live-bvc/ URLs are never host-swapped or proxied", () => {
  // Even an unmistakable PCDN live URL must be left alone: VOD upos mirrors and
  // the MCDN proxy cannot serve live-bvc paths, so a rewrite hard-breaks live.
  const pcdnLive = "https://xy1x2x3x4xy.mcdn.bilivideo.cn:486/live-bvc/123/live_1234.flv?os=mcdn&x=1";
  const detail = core.rewriteUrlDetail(pcdnLive, {});
  assert.equal(detail.changed, false);
  assert.equal(detail.reason, "live-skip");
});

test("alternativesFor never fans out live URLs to VOD hosts", () => {
  const alts = core.alternativesFor(
    "https://cn-hk-eq-01-11.bilivideo.com/live-bvc/123/live_1234.m3u8?x=1", {});
  assert.deepEqual(alts, []);
});

// ---- live url_info filtering --------------------------------------------------

function livePayload() {
  return {
    code: 0,
    data: {
      playurl_info: {
        playurl: {
          stream: [{
            format: [{
              codec: [{
                base_url: "/live-bvc/123/live_1234.flv?sig=abc",
                url_info: [
                  { host: "https://xy36x110x213x230xy.mcdn.bilivideo.cn:486", extra: "?os=mcdn" },
                  { host: "https://d1--cn-gotcha208.bilivideo.com", extra: "?sig=1" },
                  { host: "https://cn-hk-eq-01-11.bilivideo.com", extra: "?sig=2" }
                ]
              }]
            }]
          }]
        }
      }
    }
  };
}

test("filterLiveUrlInfo drops PCDN/MCDN hosts and keeps official CDN entries", () => {
  const payload = livePayload();
  const result = core.filterLiveUrlInfo(payload, {});
  assert.equal(result.changed, true);
  assert.equal(result.rewrites.length, 1);
  assert.equal(result.rewrites[0].reason, "live-pcdn-filter");
  const urlInfo = payload.data.playurl_info.playurl.stream[0].format[0].codec[0].url_info;
  assert.equal(urlInfo.length, 2);
  assert.ok(urlInfo.every((u) => !u.host.includes("mcdn")));
});

test("filterLiveUrlInfo never removes the last usable host", () => {
  const payload = {
    url_info: [
      { host: "https://xy1x2x3x4xy.mcdn.bilivideo.cn:486", extra: "?os=mcdn" },
      { host: "https://5.6.7.8:9000", extra: "" }
    ]
  };
  const result = core.filterLiveUrlInfo(payload, {});
  assert.equal(result.changed, false);
  assert.equal(payload.url_info.length, 2);
});

test("isSlowLiveHost flags mcdn/port/os=mcdn hosts and passes official CDN", () => {
  assert.equal(core.isSlowLiveHost("https://xy1x2x3x4xy.mcdn.bilivideo.cn:486", "", {}), true);
  assert.equal(core.isSlowLiveHost("https://cn-gd-ct-01-01.bilivideo.com:9000", "", {}), true);
  assert.equal(core.isSlowLiveHost("https://d1--cn-gotcha208.bilivideo.com", "?os=mcdn", {}), true);
  assert.equal(core.isSlowLiveHost("https://d1--cn-gotcha208.bilivideo.com", "?sig=1", {}), false);
  assert.equal(core.isSlowLiveHost("https://cn-hk-eq-01-11.bilivideo.com", "", {}), false);
});

test("filterLiveUrlInfo is disabled when the accelerator is off", () => {
  const payload = livePayload();
  const result = core.filterLiveUrlInfo(payload, { mode: "off" });
  assert.equal(result.changed, false);
  assert.equal(payload.data.playurl_info.playurl.stream[0].format[0].codec[0].url_info.length, 3);
});
