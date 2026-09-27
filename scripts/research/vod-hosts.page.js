// VOD CDN host measurements at the account's highest quality, repeated on a
// schedule. Research tooling for docs/vod-routing.md; not part of the build.
//
// Paste into the console of a logged-in https://www.bilibili.com/ page (any
// page on that origin, robots.txt included). Same measurements as
// vod-hosts.mjs, with 768 KB requests, since fragments at the top qualities
// run 0.5-3 MB. Results accumulate in window.__meas.records and in
// localStorage["vodHostsMeasurements"]; call window.__meas.stop() to end early.
//
// Optional, set before pasting:
//   window.__measConfig = {
//     cold: [{ bvid, cid, views }, ...],   // node vod-hosts.mjs --harvest-cold 40
//     until: "2026-09-28T16:30:00Z",       // default: 24 h from now
//     offPeakMinutes: 180,
//     peakMinutes: 30                      // 20:00-01:00 Beijing
//   };
//
// Nothing here reads or stores a cookie; the page's own session is used by the
// browser. Records carry hosts, public video ids and timings, never a URL.
(function measureVodHosts(root) {
  "use strict";

  if (root.__meas && root.__meas.running) {
    return "already running";
  }

  const cfg = root.__measConfig || {};
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
  const STORE = "vodHostsMeasurements";
  const CHUNK = 768 * 1024;
  const COUNT = 3;
  const UNTIL = cfg.until ? Date.parse(cfg.until) : Date.now() + 24 * 3600e3;
  const OFF_PEAK = (cfg.offPeakMinutes || 180) * 60e3;
  const PEAK = (cfg.peakMinutes || 30) * 60e3;
  const COLD = Array.isArray(cfg.cold) ? cfg.cold.slice() : [];

  const M = root.__meas = {
    running: true, records: [], log: [], rounds: 0, next: null,
    hotIndex: 0, coldIndex: 0, lastHot: null, usedWarm: [], usedCold: [],
    stop: function () { M.running = false; }
  };
  try {
    M.records = JSON.parse(root.localStorage.getItem(STORE) || "[]");
  } catch (_) {}

  const persist = () => {
    try {
      root.localStorage.setItem(STORE, JSON.stringify(M.records));
    } catch (e) {
      M.log.push("persist failed: " + e);
    }
  };
  const hostOf = (u) => {
    try {
      return new URL(u).host;
    } catch (_) {
      return "";
    }
  };
  const api = async (u) => (await fetch(u, { credentials: "include" })).json();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const swap = (u, h) => {
    const x = new URL(u);
    x.host = h;
    return x.toString();
  };

  async function pickHot() {
    const j = await api("https://api.bilibili.com/x/web-interface/popular?ps=20&pn=1");
    const list = j.data.list.filter((v) => v.duration >= 150)
      .sort((a, b) => b.stat.view - a.stat.view).slice(0, 5);
    const v = list[M.hotIndex++ % list.length];
    return { bvid: v.bvid, cid: v.cid, views: v.stat.view };
  }

  async function related(bvid) {
    const j = await api("https://api.bilibili.com/x/web-interface/archive/related?bvid=" + bvid);
    return j.data || [];
  }

  async function pickWarm() {
    const v = (await related(M.lastHot || "BV1Deht6rEpZ")).find((a) =>
      a.stat.view >= 20000 && a.stat.view <= 300000 && a.duration >= 180 &&
      M.usedWarm.indexOf(a.bvid) === -1);
    if (!v) {
      return null;
    }
    M.usedWarm.push(v.bvid);
    return { bvid: v.bvid, cid: v.cid, views: v.stat.view };
  }

  // Prefer the supplied list of fresh uploads. Without one, fall back to the
  // least watched related video, which is colder than nothing but not cold.
  async function pickCold() {
    if (M.coldIndex < COLD.length) {
      const c = COLD[M.coldIndex++];
      return { bvid: c.bvid, cid: c.cid, views: c.views };
    }
    const v = (await related(M.lastHot || "BV1Deht6rEpZ"))
      .filter((a) => a.duration >= 240 && M.usedCold.indexOf(a.bvid) === -1)
      .sort((a, b) => a.stat.view - b.stat.view)[0];
    if (!v) {
      return null;
    }
    M.usedCold.push(v.bvid);
    return { bvid: v.bvid, cid: v.cid, views: v.stat.view };
  }

  // The top quality the account can play, HEVC first since that is what Safari
  // picks most often, then AVC.
  async function playurl(v) {
    const j = await api("https://api.bilibili.com/x/player/playurl?bvid=" + v.bvid +
      "&cid=" + v.cid + "&qn=127&fnval=4048&fourk=1");
    if (j.code !== 0 || !j.data || !j.data.dash) {
      throw new Error("playurl " + j.code);
    }
    const q = j.data.quality;
    const reps = j.data.dash.video.filter((x) => x.id === q);
    const pick = reps.find((x) => /hvc1|hev1/.test(x.codecs)) ||
      reps.find((x) => /avc1/.test(x.codecs)) || reps[0] || j.data.dash.video[0];
    const audio = j.data.dash.audio && j.data.dash.audio[0];
    return {
      quality: q,
      rep: { id: pick.id, codecs: pick.codecs, bandwidth: pick.bandwidth },
      url: pick.baseUrl,
      backups: pick.backupUrl || [],
      assigned: {
        video: { base: hostOf(pick.baseUrl), backups: (pick.backupUrl || []).map(hostOf) },
        audio: audio ? { base: hostOf(audio.baseUrl), backups: (audio.backupUrl || []).map(hostOf) } : null
      }
    };
  }

  async function timedRange(url, a, b) {
    const t0 = performance.now();
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 20000);
    let ttfb = null;
    let bytes = 0;
    let status = 0;
    try {
      const r = await fetch(url, {
        mode: "cors", credentials: "omit", cache: "no-store",
        headers: { Range: "bytes=" + a + "-" + b }, signal: ctl.signal
      });
      ttfb = performance.now() - t0;
      status = r.status;
      const reader = r.body.getReader();
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) {
          break;
        }
        bytes += chunk.value.length;
      }
    } catch (_) {}
    clearTimeout(timer);
    return { status, ttfb: ttfb === null ? null : Math.round(ttfb), total: Math.round(performance.now() - t0), bytes };
  }

  async function fileSize(url) {
    try {
      const r = await fetch(url, {
        mode: "cors", credentials: "omit", cache: "no-store", headers: { Range: "bytes=0-0" }
      });
      const m = /\/(\d+)$/.exec(r.headers.get("content-range") || "");
      try { await r.arrayBuffer(); } catch (_) {}
      return m ? Number(m[1]) : 0;
    } catch (_) {
      return 0;
    }
  }

  // Same measurement as probeHost() in the v0.4.1 page script.
  async function shippedProbe(host, sample) {
    const started = performance.now();
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 4000);
    let ttfb = null;
    let first = 0;
    let bytes = 0;
    try {
      const r = await fetch(swap(sample, host), {
        method: "GET", mode: "cors", cache: "no-store", credentials: "omit", signal: ctl.signal
      });
      ttfb = performance.now() - started;
      if (!r.ok) {
        try { r.body.cancel(); } catch (_) {}
        return { host, ok: false, status: r.status };
      }
      const reader = r.body.getReader();
      first = performance.now();
      for (;;) {
        const chunk = await reader.read();
        if (chunk.value) {
          bytes += chunk.value.length;
        }
        if (chunk.done || bytes >= 786432) {
          break;
        }
      }
      try { reader.cancel(); } catch (_) {}
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
      at: new Date().toISOString(), cls, bvid: v.bvid, views: v.views, quality: p.quality,
      rep: p.rep, size, assigned: p.assigned, probe: [], seq: []
    };
    // First, before anything else this round could warm the file head.
    record.probe = await Promise.all(POOL.map((h) => shippedProbe(h, p.url)));

    const targets = POOL.map((h) => ({ host: h, url: swap(p.url, h), via: "pool" }));
    // Akamai only through the URL Bilibili issued for it, whichever slot it is in.
    [p.url].concat(p.backups).filter((u) => /akamaized\.net$/.test(hostOf(u))).slice(0, 1)
      .forEach((u) => targets.push({ host: hostOf(u), url: u, via: "issued" }));
    const span = CHUNK * COUNT;
    for (const t of shuffle(targets)) {
      const lo = Math.floor(size * 0.15);
      const hi = Math.max(lo + 1, Math.floor(size * 0.85) - span);
      const offset = size > span * 4 ? lo + Math.floor(Math.random() * (hi - lo)) : 0;
      const reqs = [];
      for (let i = 0; i < COUNT; i += 1) {
        const r = await timedRange(t.url, offset + i * CHUNK, offset + (i + 1) * CHUNK - 1);
        reqs.push(r);
        if (r.status !== 206 && r.status !== 200) {
          break;
        }
      }
      record.seq.push({ host: t.host, via: t.via, offset, reqs });
    }
    return record;
  }

  async function round() {
    M.rounds += 1;
    const classes = M.rounds % 2 === 1 ? ["hot", "warm", "cold"] : ["hot", "cold"];
    for (const cls of classes) {
      try {
        const v = cls === "hot" ? await pickHot() : cls === "warm" ? await pickWarm() : await pickCold();
        if (!v) {
          M.log.push(new Date().toISOString() + " " + cls + ": no candidate");
          continue;
        }
        if (cls === "hot") {
          M.lastHot = v.bvid;
        }
        const record = await measure(cls, v);
        M.records.push(record);
        persist();
        M.log.push(record.at + " " + cls + " " + v.bvid + " q" + record.quality);
      } catch (e) {
        M.log.push(new Date().toISOString() + " " + cls + ": " + (e.message || e));
      }
    }
  }

  // Beijing's evening peak, 20:00-01:00 UTC+8, is 12:00-17:00 UTC.
  function inPeak(t) {
    const h = new Date(t).getUTCHours();
    return h >= 12 && h < 17;
  }

  function nextRound(now) {
    let t = now + (inPeak(now) ? PEAK : OFF_PEAK);
    const peakStart = new Date(now);
    peakStart.setUTCHours(12, 0, 0, 0);
    if (peakStart.getTime() <= now) {
      peakStart.setUTCDate(peakStart.getUTCDate() + 1);
    }
    if (!inPeak(now) && t > peakStart.getTime()) {
      t = peakStart.getTime();
    }
    return t;
  }

  (async function loop() {
    while (M.running && Date.now() < UNTIL) {
      await round();
      M.next = new Date(nextRound(Date.now())).toISOString();
      while (M.running && Date.now() < Date.parse(M.next)) {
        await sleep(60e3);
      }
    }
    M.running = false;
    M.log.push("finished " + new Date().toISOString());
  })();

  return "started";
})(window);
