const fs = require("node:fs");
const path = require("node:path");
const { test: base, expect } = require("@playwright/test");

// A stand-in for bilibili.com, so the built userscript can run in a real
// browser without the real site. The script is injected the way a userscript
// manager does it, at document-start, into a page served from a Bilibili URL.
// Nothing reaches the network: every request is answered from this file, and
// one the fixture doesn't know is refused and fails the test.

const USERSCRIPT = path.join(__dirname, "../dist/bilibili-accelerator.user.js");
const PAGE_URL = "https://www.bilibili.com/video/BV1xx411c7mD/";
const PLAYURL = "https://api.bilibili.com/x/player/wbi/playurl?bvid=BV1xx411c7mD&cid=42231991605&fnval=4048";

const COSOV = "upos-sz-mirrorcosov.bilivideo.com";
const AKAM = "upos-hz-mirrorakam.akamaized.net";
const PCDN = "xy203x0x113x7xy.mcdn.bilivideo.cn:4483";
const VIDEO = "/upgcxcode/05/16/42231991605/42231991605-1-100026.m4s";
const AUDIO = "/upgcxcode/05/16/42231991605/42231991605-1-30280.m4s";
const PCDN_VIDEO = "https://" + PCDN + VIDEO + "?os=mcdn&upsig=aa";
const ISSUED_VIDEO = "https://" + COSOV + VIDEO + "?os=cosovbv&upsig=bb";
const SEGMENT_BYTES = 256 * 1024;

// A playurl as a viewer gets it when Bilibili assigns a PCDN node: the node
// as the base URL, the proper CDN URLs as backups.
function playurl() {
  return {
    code: 0,
    data: {
      dash: {
        video: [{
          id: 80, bandwidth: 2400000, codecs: "avc1.640032",
          baseUrl: PCDN_VIDEO,
          backupUrl: [ISSUED_VIDEO, "https://" + AKAM + VIDEO + "?os=akam&hdnts=cc"]
        }],
        audio: [{
          id: 30280, bandwidth: 319173, codecs: "mp4a.40.2",
          baseUrl: "https://" + COSOV + AUDIO + "?os=cosovbv&upsig=dd",
          backupUrl: ["https://" + AKAM + AUDIO + "?os=akam&hdnts=ee"]
        }]
      }
    }
  };
}

function pageHtml() {
  const values = {
    playinfo: JSON.stringify(playurl()).replace(/</g, "\\u003c"),
    playurl: PLAYURL,
    lastByte: SEGMENT_BYTES - 1
  };
  return fs.readFileSync(path.join(__dirname, "video.html"), "utf8")
    .replace(/\{\{(\w+)\}\}/g, (_, name) => values[name]);
}

function isCdnHost(hostname) {
  return hostname.endsWith(".bilivideo.com") || hostname.endsWith(".akamaized.net");
}

function answer(route, site) {
  const request = route.request();
  const url = new URL(request.url());
  const cors = { "access-control-allow-origin": "*" };

  if (request.url() === PAGE_URL) {
    return route.fulfill({ contentType: "text/html; charset=utf-8", body: pageHtml() });
  }
  if (request.url() === PLAYURL) {
    return route.fulfill({ contentType: "application/json", headers: cors, body: JSON.stringify(playurl()) });
  }
  if (isCdnHost(url.hostname)) {
    if (request.method() === "OPTIONS") {
      return route.fulfill({
        status: 204,
        headers: Object.assign({ "access-control-allow-headers": "range" }, cors)
      });
    }
    site.segments.push(request.url());
    return route.fulfill({
      status: 206,
      contentType: "video/mp4",
      headers: Object.assign({ "content-range": "bytes 0-" + (SEGMENT_BYTES - 1) + "/4194304" }, cors),
      body: Buffer.alloc(SEGMENT_BYTES)
    });
  }
  site.stray.push(request.method() + " " + request.url());
  return route.abort();
}

// Every test starts on the video page with the userscript installed, and
// fails if the page logged an error or asked for something outside the
// fixture, whatever else it checked.
const test = base.extend({
  site: [async ({ context, page }, use) => {
    const site = { segments: [], stray: [], errors: [] };
    await context.addInitScript({ path: USERSCRIPT });
    await context.route("**/*", (route) => answer(route, site));
    page.on("pageerror", (error) => site.errors.push(String(error)));
    page.on("console", (message) => {
      const ours = message.type() === "warning" && message.text().includes("[BiliAccelerator]");
      if (message.type() === "error" || ours) {
        site.errors.push(message.text());
      }
    });
    await page.goto(PAGE_URL);
    await use(site);
    expect(site.stray, "requests outside the fixture").toEqual([]);
    expect(site.errors, "errors on the page").toEqual([]);
  }, { auto: true }]
});

module.exports = { test, expect, PCDN, PCDN_VIDEO, ISSUED_VIDEO, SEGMENT_BYTES };
