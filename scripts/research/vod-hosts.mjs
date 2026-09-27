#!/usr/bin/env node
// One round of VOD CDN host measurements, appended to a JSONL file. Research
// tooling for docs/vod-routing.md; not part of the build.
//
// For a popular, a moderately watched and a freshly uploaded video it fetches a
// logged-out playurl, records which hosts Bilibili assigned, then measures each
// host two ways:
//
//   probe  what v0.4.1 does: eight parallel GETs of the file head, no Range,
//          768 KB read, rate timed from the response headers.
//   seq    what the player does: three contiguous 512 KB Range requests at a
//          random offset nobody has asked for, over one connection per host
//          (curl reuses it), so request 1 carries the setup and 2-3 are warm.
//
// The results hold host names, public video ids and timings only, never a URL
// or query string. The state file keeps an anonymous buvid between runs.
//
// usage:
//   node scripts/research/vod-hosts.mjs --out hosts.jsonl [--state state.json]
//        [--classes hot,warm,cold]
//   node scripts/research/vod-hosts.mjs --harvest-cold 40 > cold.json
//
// Needs Node 18+ and curl. Logged out, Bilibili serves 480P and below; the
// page script next to this one measures at the account's highest quality.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";

const run = promisify(execFile);
const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf("--" + name);
  return i === -1 ? fallback : argv[i + 1];
};

const OUT = opt("out", "hosts.jsonl");
const STATE = opt("state", "vod-hosts-state.json");
const CLASSES = opt("classes", "hot,warm,cold").split(",");
const HARVEST = Number(opt("harvest-cold", 0));

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/18.6 Safari/605.1.15";
// Every UPOS host answers 403 without a Referer.
const REFERER = "https://www.bilibili.com/";
const POOL = [
  "upos-sz-mirrorcosov.bilivideo.com",
  "upos-sz-mirroraliov.bilivideo.com",
  "upos-sz-mirrorhwov.bilivideo.com",
  "upos-sz-mirrorali.bilivideo.com",
  "upos-tf-all-hw.bilivideo.com",
  "upos-sz-mirrorhw.bilivideo.com",
  "upos-sz-mirrorcos.bilivideo.com",
  "upos-tf-all-tx.bilivideo.com"
];
const PROBE_BYTES = 768 * 1024;
const PROBE_TIMEOUT_MS = 4000;
const SEQ_CHUNK = 512 * 1024;
const SEQ_COUNT = 3;
const KEYWORDS = ["日常", "vlog", "游戏", "教程", "生活", "记录", "测评", "美食", "旅行", "音乐"];

let cookie = "";

function hostOf(u) {
  try {
    return new URL(u).host;
  } catch (_) {
    return "";
  }
}

async function api(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA, Referer: REFERER, Cookie: cookie } });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch (_) {
    throw new Error("non-JSON answer from " + url.split("?")[0]);
  }
}

// An anonymous buvid is enough for the playurl, popular and search endpoints;
// without one, some of them answer with a risk-control page.
async function ensureCookie(state) {
  if (state.cookie && Date.now() - state.cookieAt < 12 * 3600e3) {
    cookie = state.cookie;
    return;
  }
  const j = await api("https://api.bilibili.com/x/frontend/finger/spi");
  cookie = "buvid3=" + j.data.b_3 + "; buvid4=" + encodeURIComponent(j.data.b_4);
  state.cookie = cookie;
  state.cookieAt = Date.now();
}

// WBI signing, as documented in SocialSisterYi/bilibili-API-collect.
const MIXIN = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1,
  60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52];

async function wbiSign(params) {
  const nav = await api("https://api.bilibili.com/x/web-interface/nav");
  const key = (u) => u.slice(u.lastIndexOf("/") + 1).split(".")[0];
  const raw = key(nav.data.wbi_img.img_url) + key(nav.data.wbi_img.sub_url);
  const mixin = MIXIN.map((i) => raw[i]).join("").slice(0, 32);
  const all = Object.assign({}, params, { wts: Math.floor(Date.now() / 1000) });
  const query = Object.keys(all).sort().map((k) =>
    encodeURIComponent(k) + "=" + encodeURIComponent(String(all[k]).replace(/[!'()*]/g, ""))).join("&");
  return query + "&w_rid=" + createHash("md5").update(query + mixin).digest("hex");
}

const seconds = (s) => String(s).split(":").reduce((acc, p) => acc * 60 + Number(p), 0);

// Freshly uploaded, barely watched videos: a keyword search ordered by upload
// time. Nothing overseas has pulled them yet, which is the case that matters.
async function searchFresh(keyword, used) {
  const q = await wbiSign({ search_type: "video", keyword, order: "pubdate", page: 1 });
  const j = await api("https://api.bilibili.com/x/web-interface/wbi/search/type?" + q);
  const items = (j.data && j.data.result) || [];
  return items.filter((a) => a.play < 3000 && seconds(a.duration) >= 240 && used.indexOf(a.bvid) === -1);
}

async function cidOf(bvid) {
  const j = await api("https://api.bilibili.com/x/player/pagelist?bvid=" + bvid);
  return j.data && j.data[0] && j.data[0].cid;
}

async function pickHot(state) {
  const j = await api("https://api.bilibili.com/x/web-interface/popular?ps=20&pn=1");
  const list = j.data.list.filter((v) => v.duration >= 150).sort((a, b) => b.stat.view - a.stat.view);
  state.hotIndex = ((state.hotIndex || 0) + 1) % Math.min(5, list.length);
  const v = list[state.hotIndex];
  return { bvid: v.bvid, cid: v.cid, views: v.stat.view };
}

async function pickWarm(state) {
  const j = await api("https://api.bilibili.com/x/web-interface/archive/related?bvid=" +
    (state.lastHot || "BV1Deht6rEpZ"));
  state.usedWarm = state.usedWarm || [];
  const v = (j.data || []).find((a) => a.stat.view >= 20000 && a.stat.view <= 300000 &&
    a.duration >= 180 && state.usedWarm.indexOf(a.bvid) === -1);
  if (!v) {
    return null;
  }
  state.usedWarm.push(v.bvid);
  return { bvid: v.bvid, cid: v.cid, views: v.stat.view };
}

async function pickCold(state) {
  state.usedCold = state.usedCold || [];
  state.kwIndex = ((state.kwIndex || 0) + 1) % KEYWORDS.length;
  const hit = (await searchFresh(KEYWORDS[state.kwIndex], state.usedCold))[0];
  if (!hit) {
    return null;
  }
  const cid = await cidOf(hit.bvid);
  if (!cid) {
    return null;
  }
  state.usedCold.push(hit.bvid);
  return { bvid: hit.bvid, cid, views: hit.play };
}

async function playurl(v) {
  const j = await api("https://api.bilibili.com/x/player/playurl?bvid=" + v.bvid + "&cid=" + v.cid +
    "&qn=80&fnval=4048&fourk=1");
  if (j.code !== 0 || !j.data || !j.data.dash) {
    throw new Error("playurl " + j.code);
  }
  const video = j.data.dash.video.slice().sort((a, b) => b.bandwidth - a.bandwidth);
  const pick = video.find((x) => /avc1/.test(x.codecs)) || video[0];
  const audio = j.data.dash.audio && j.data.dash.audio[0];
  return {
    url: pick.baseUrl,
    backups: pick.backupUrl || [],
    rep: { id: pick.id, codecs: pick.codecs, bandwidth: pick.bandwidth },
    assigned: {
      video: { base: hostOf(pick.baseUrl), backups: (pick.backupUrl || []).map(hostOf) },
      audio: audio ? { base: hostOf(audio.baseUrl), backups: (audio.backupUrl || []).map(hostOf) } : null
    }
  };
}

function swap(u, host) {
  const x = new URL(u);
  x.host = host;
  return x.toString();
}

const CURL_FMT = "%{http_code} %{num_connects} %{time_connect} %{time_appconnect} " +
  "%{time_starttransfer} %{time_total} %{size_download}\\n";

// One curl invocation per host, one URL per range, so curl keeps the
// connection between them the way the player's browser would.
async function curlRanges(url, ranges) {
  const args = [];
  ranges.forEach(([a, b], i) => {
    if (i > 0) {
      args.push("--next");
    }
    args.push("-s", "-o", "/dev/null", "-m", "20", "-A", UA, "-e", REFERER, "-w", CURL_FMT,
      "-H", "Range: bytes=" + a + "-" + b, url);
  });
  let stdout = "";
  try {
    ({ stdout } = await run("curl", args, { timeout: 90e3 }));
  } catch (e) {
    stdout = e.stdout || "";
  }
  return stdout.trim().split("\n").filter(Boolean).map((line) => {
    const [code, conns, connect, tls, ttfb, total, size] = line.split(" ");
    return {
      code: Number(code), newConn: Number(conns) > 0, connect: +connect, tls: +tls,
      ttfb: +ttfb, total: +total, bytes: Number(size)
    };
  });
}

async function fileSize(url) {
  try {
    const { stdout } = await run("curl", ["-s", "-D", "-", "-o", "/dev/null", "-m", "15", "-A", UA,
      "-e", REFERER, "-H", "Range: bytes=0-0", url], { timeout: 30e3 });
    const m = /content-range:\s*bytes\s+\d+-\d+\/(\d+)/i.exec(stdout);
    return m ? Number(m[1]) : 0;
  } catch (_) {
    return 0;
  }
}

// Same measurement as probeHost() in the v0.4.1 page script.
async function shippedProbe(host, sample) {
  const started = performance.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), PROBE_TIMEOUT_MS);
  let ttfb = null;
  let first = 0;
  let bytes = 0;
  try {
    const res = await fetch(swap(sample, host), {
      signal: ctl.signal,
      headers: { "User-Agent": UA, Referer: REFERER, Origin: "https://www.bilibili.com" }
    });
    ttfb = performance.now() - started;
    if (!res.ok) {
      try { await res.body.cancel(); } catch (_) {}
      return { host, ok: false, status: res.status };
    }
    const reader = res.body.getReader();
    first = performance.now();
    for (;;) {
      const chunk = await reader.read();
      if (chunk.value) {
        bytes += chunk.value.length;
      }
      if (chunk.done || bytes >= PROBE_BYTES) {
        break;
      }
    }
    try { await reader.cancel(); } catch (_) {}
    const mbps = (bytes * 8 / 1e6) / ((performance.now() - first) / 1000);
    return { host, ok: true, ttfb: Math.round(ttfb), mbps: +mbps.toFixed(2) };
  } catch (_) {
    if (ttfb !== null && bytes > 0) {
      const mbps = (bytes * 8 / 1e6) / ((performance.now() - first) / 1000);
      return { host, ok: true, timedOut: true, ttfb: Math.round(ttfb), mbps: +mbps.toFixed(2) };
    }
    return { host, ok: false };
  } finally {
    clearTimeout(timer);
  }
}

function shuffle(list) {
  const x = list.slice();
  for (let i = x.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [x[i], x[j]] = [x[j], x[i]];
  }
  return x;
}

async function measure(cls, v) {
  const p = await playurl(v);
  const size = await fileSize(p.url);
  const record = {
    at: new Date().toISOString(), cls, bvid: v.bvid, views: v.views,
    rep: p.rep, size, assigned: p.assigned, probe: [], seq: []
  };
  // The shipped probe reads the file head, so it runs before anything else in
  // the round could warm that head on any host.
  record.probe = await Promise.all(POOL.map((h) => shippedProbe(h, p.url)));

  const targets = POOL.map((h) => ({ host: h, url: swap(p.url, h), via: "pool" }));
  // Akamai refuses a host swap; it is reachable only through the URL Bilibili
  // issued for it, with its own signature, in whichever slot that URL is.
  [p.url].concat(p.backups).filter((u) => /akamaized\.net$/.test(hostOf(u))).slice(0, 1)
    .forEach((u) => targets.push({ host: hostOf(u), url: u, via: "issued" }));
  const span = SEQ_CHUNK * SEQ_COUNT;
  for (const t of shuffle(targets)) {
    const lo = Math.floor(size * 0.15);
    const hi = Math.max(lo + 1, Math.floor(size * 0.85) - span);
    const offset = size > span * 4 ? lo + Math.floor(Math.random() * (hi - lo)) : 0;
    const ranges = [];
    for (let i = 0; i < SEQ_COUNT; i += 1) {
      ranges.push([offset + i * SEQ_CHUNK, offset + (i + 1) * SEQ_CHUNK - 1]);
    }
    record.seq.push({ host: t.host, via: t.via, offset, reqs: await curlRanges(t.url, ranges) });
  }
  return record;
}

async function harvest(state, count) {
  const out = [];
  const used = [];
  for (const keyword of KEYWORDS) {
    for (const hit of await searchFresh(keyword, used)) {
      used.push(hit.bvid);
      const cid = await cidOf(hit.bvid);
      if (cid) {
        out.push({ bvid: hit.bvid, cid, views: hit.play });
      }
      if (out.length >= count) {
        return out;
      }
    }
  }
  return out;
}

async function main() {
  let state = {};
  try {
    state = JSON.parse(await readFile(STATE, "utf8"));
  } catch (_) {}
  await ensureCookie(state);

  if (HARVEST > 0) {
    process.stdout.write(JSON.stringify(await harvest(state, HARVEST)) + "\n");
    await writeFile(STATE, JSON.stringify(state));
    return;
  }

  for (const cls of CLASSES) {
    try {
      const v = cls === "hot" ? await pickHot(state)
        : cls === "warm" ? await pickWarm(state)
          : await pickCold(state);
      if (!v) {
        await appendFile(OUT, JSON.stringify({ at: new Date().toISOString(), cls, error: "no candidate" }) + "\n");
        continue;
      }
      if (cls === "hot") {
        state.lastHot = v.bvid;
      }
      const record = await measure(cls, v);
      await appendFile(OUT, JSON.stringify(record) + "\n");
      process.stdout.write(cls + " " + v.bvid + " views=" + v.views + " assigned=" +
        record.assigned.video.base + "\n");
    } catch (e) {
      await appendFile(OUT, JSON.stringify({ at: new Date().toISOString(), cls, error: String(e.message || e) }) + "\n");
      process.stdout.write(cls + " error " + (e.message || e) + "\n");
    }
  }
  await writeFile(STATE, JSON.stringify(state));
}

main();
