const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../src/core/rewrite");

test("proxies mcdn /v1/resource URLs by default", () => {
  const original = "https://xy153x35x231x78xy.mcdn.bilivideo.cn:8082/v1/resource/28472577642-1-30280.m4s?abc=1";
  const detail = core.rewriteUrlDetail(original);

  assert.equal(detail.changed, true);
  assert.equal(detail.reason, "mcdn-proxy");
  assert.equal(new URL(detail.url).hostname, "proxy-tf-all-ws.bilivideo.com");
  assert.equal(new URL(detail.url).searchParams.get("url"), original);
});

test("proxies mcdn upgcxcode URLs by default", () => {
  const original = "https://xy58x221x77x134xy.mcdn.bilivideo.cn:4483/upgcxcode/42/76/28472577642/28472577642-1-100050.m4s?abc=1";
  const detail = core.rewriteUrlDetail(original);

  assert.equal(detail.changed, true);
  assert.equal(detail.reason, "mcdn-proxy");
});

test("can replace mcdn instead of proxying", () => {
  const original = "https://xy58x221x77x134xy.mcdn.bilivideo.cn:4483/upgcxcode/42/76/file.m4s?abc=1";
  const detail = core.rewriteUrlDetail(original, {
    mcdnStrategy: "replace",
    pcdnHost: "upos-sz-mirrorali.bilivideo.com"
  });

  assert.equal(detail.changed, true);
  assert.equal(new URL(detail.url).hostname, "upos-sz-mirrorali.bilivideo.com");
  assert.equal(new URL(detail.url).port, "");
});

test("rewrites szbdyd URLs to xy_usource", () => {
  const original = "https://foo.szbdyd.com/upgcxcode/file.m4s?xy_usource=upos-sz-mirrorcos.bilivideo.com&abc=1";
  const detail = core.rewriteUrlDetail(original);

  assert.equal(detail.changed, true);
  assert.equal(detail.reason, "szbdyd-source");
  assert.equal(new URL(detail.url).hostname, "upos-sz-mirrorcos.bilivideo.com");
});

test("leaves Bilibili's overseas mirrors alone — they are the fast host overseas", () => {
  // upos-*mirror*ov* are Bilibili's overseas mirrors. For this tool's overseas
  // audience they are the correct, fast host; rewriting them to a mainland host
  // starved the buffer and stalled backgrounded tabs.
  ["upos-sz-mirrorcosov.bilivideo.com",
    "upos-sz-mirroraliov.bilivideo.com",
    "upos-sz-mirrorhwov.bilivideo.com"
  ].forEach((host) => {
    const original = "https://" + host + "/upgcxcode/file.m4s?abc=1";
    const detail = core.rewriteUrlDetail(original, { pcdnHost: "upos-sz-mirrorhw.bilivideo.com" });
    assert.equal(detail.changed, false, host + " should be left alone");
    assert.equal(detail.url, original);
  });
});

test("leaves Akamai alone by default, rewrites it only when opted in", () => {
  const akamai = "https://upos-hz-mirrorakam.akamaized.net/upgcxcode/file.m4s?abc=1";

  const off = core.rewriteUrlDetail(akamai, { pcdnHost: "upos-sz-mirrorcos.bilivideo.com" });
  assert.equal(off.changed, false, "Akamai must not be rewritten with the default rewriteAkamai:false");

  const on = core.rewriteUrlDetail(akamai, {
    rewriteAkamai: true,
    pcdnHost: "upos-sz-mirrorcos.bilivideo.com"
  });
  assert.equal(on.changed, true, "the rewriteAkamai opt-in still works for users who want it");
  assert.equal(new URL(on.url).hostname, "upos-sz-mirrorcos.bilivideo.com");
});

test("does not rewrite healthy CDN hosts in bad-only mode", () => {
  const original = "https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/file.m4s?abc=1";
  const detail = core.rewriteUrlDetail(original);

  assert.equal(detail.changed, false);
  assert.equal(detail.url, original);
});

test("force mode rewrites all known video CDN hosts", () => {
  const original = "https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/file.m4s?abc=1";
  const detail = core.rewriteUrlDetail(original, {
    mode: "force",
    pcdnHost: "upos-sz-mirrorali.bilivideo.com"
  });

  assert.equal(detail.changed, true);
  assert.equal(new URL(detail.url).hostname, "upos-sz-mirrorali.bilivideo.com");
});

test("rewrites nested playurl payloads and records changes", () => {
  const state = { changed: false, rewrites: [] };
  const payload = {
    data: {
      dash: {
        video: [
          {
            baseUrl: "https://xy153x35x231x78xy.mcdn.bilivideo.cn:8082/v1/resource/video.m4s?abc=1",
            backupUrl: [
              "https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/video.m4s?abc=1"
            ]
          }
        ]
      }
    }
  };

  core.rewriteObject(payload, undefined, state);

  assert.equal(state.changed, true);
  assert.equal(state.rewrites.length, 1);
  assert.equal(new URL(payload.data.dash.video[0].baseUrl).hostname, "proxy-tf-all-ws.bilivideo.com");
  assert.equal(payload.data.dash.video[0].backupUrl[0], "https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/video.m4s?abc=1");
});
