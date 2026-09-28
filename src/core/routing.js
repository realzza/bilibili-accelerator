(function initBiliAcceleratorRouting(root, factory) {
  const routing = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = routing;
  }

  root.BiliAcceleratorRouting = routing;
})(typeof globalThis !== "undefined" ? globalThis : window, function createRouting() {
  "use strict";

  // The decisions behind VOD host routing, kept free of DOM and network so
  // they can be unit-tested. docs/vod-routing.md explains the numbers; the
  // page script feeds these functions what the player actually downloads.

  // How much of a fragment a race fetches from each contender. Big enough to
  // show a relaying edge for what it is, small enough that a race costs well
  // under a second of 1080P+ video per host.
  const RACE_BYTES = 768 * 1024;
  const RACE_TIMEOUT_MS = 4000;

  // Shaka Player's estimator settings: a sample needs 16 KB to count, the
  // estimate needs 128 KB in total, and the lower of a 2 s and a 5 s average
  // is used so it falls fast and recovers slowly.
  const EWMA_FAST_HALF_LIFE_S = 2;
  const EWMA_SLOW_HALF_LIFE_S = 5;
  const MIN_SAMPLE_BYTES = 16000;
  const MIN_TOTAL_BYTES = 128000;

  // A fragment in flight is "stuck" when it will finish after the buffer runs
  // out. Judge it only after it has shown a rate, and never on init or index
  // requests, which are a few KB.
  const STUCK_MIN_FRAGMENT_BYTES = 128 * 1024;
  const STUCK_MIN_TRANSFER_MS = 500;
  const STUCK_NO_FIRST_BYTE_MS = 1000;
  const STUCK_URGENT_BUFFER_S = 3;
  const STUCK_RATE_FACTOR = 1.3;
  const STUCK_MIN_REMAINING_MS = 1000;
  const STUCK_MARGIN_MS = 2000;

  // Sustained shortfall: measured goodput can't grow the buffer, and the
  // buffer is low enough that it matters.
  const SHORTFALL_RATE_FACTOR = 1.2;
  const SHORTFALL_MIN_BYTES = 4 * 1024 * 1024;
  const SHORTFALL_MIN_MS = 8000;
  const SHORTFALL_BUFFER_S = 30;

  const ERROR_WINDOW_MS = 30000;
  const ERROR_LIMIT = 2;

  // A challenger has to deliver the race bytes in two-thirds of the time the
  // current host needs for them. Races run on fresh connections, which
  // understates a mainland mirror's warm speed, so the margin is kept modest
  // and the new host's own traffic decides whether it keeps up.
  const SWITCH_GAIN = 1.5;
  const MAX_SWITCHES = 4;
  const SWITCH_BACKOFF_MS = 10000;
  const NO_SWITCH_COOLDOWN_MS = 15000;
  const MAX_COOLDOWN_MS = 120000;
  const LOST_RACE_REST_MS = 60000;

  const HISTORY_HALF_LIFE_MS = 3 * 24 * 60 * 60 * 1000;
  const RECENT_FAILURE_MS = 60 * 60 * 1000;
  const EXPLORE_RATE = 0.2;
  const UNKNOWN_HOST_MBPS = 10;

  const AUDIO_ID_RE = /^30(2\d\d|25\d)$/;

  // ---- fragment identity ---------------------------------------------------

  // The file name identifies the same bytes on every host: issued URLs and
  // host swaps share the path, and only the query (the signature) differs.
  function fileKey(value) {
    let url;
    try {
      url = new URL(String(value || ""));
    } catch (_) {
      return null;
    }
    const name = url.pathname.slice(url.pathname.lastIndexOf("/") + 1);
    return /\.(m4s|mp4|flv)$/i.test(name) ? name : null;
  }

  // "42231991605-1-30102.m4s" and "42242147914_qe1-1-30032.m4s" -> the cid.
  function cidOf(key) {
    const m = /^(\d+)/.exec(String(key || ""));
    return m ? m[1] : null;
  }

  function repIdOf(key) {
    const m = /-(\d+)\.(?:m4s|mp4|flv)$/i.exec(String(key || ""));
    return m ? m[1] : null;
  }

  function parseRange(value) {
    const m = /bytes=(\d+)-(\d*)/i.exec(String(value || ""));
    if (!m) {
      return null;
    }
    const start = Number(m[1]);
    const end = m[2] === "" ? NaN : Number(m[2]);
    return { start, end, length: isNaN(end) ? NaN : end - start + 1 };
  }

  function hostOf(value) {
    try {
      return new URL(String(value)).host.toLowerCase();
    } catch (_) {
      return "";
    }
  }

  // ---- the session table ----------------------------------------------------

  function dashContainers(payload) {
    if (!payload || typeof payload !== "object") {
      return [];
    }
    return [payload.data, payload.result, payload.result && payload.result.video_info, payload]
      .filter(function (c) { return c && typeof c === "object" && c.dash && typeof c.dash === "object"; })
      .map(function (c) { return c.dash; });
  }

  // For every representation in a DASH playurl: its bitrate and the URL each
  // issued host was given for it, signature included. isUsable() lets the
  // caller keep PCDN and MCDN entries out; the table only ever routes toward
  // hosts Bilibili issued or UPOS mirrors that accept their signature.
  function buildTable(payload, isUsable) {
    const table = { cid: null, reps: {} };
    dashContainers(payload).forEach(function eachDash(dash) {
      const groups = [["video", dash.video], ["audio", dash.audio]];
      if (dash.dolby && Array.isArray(dash.dolby.audio)) {
        groups.push(["audio", dash.dolby.audio]);
      }
      if (dash.flac && dash.flac.audio) {
        groups.push(["audio", [dash.flac.audio]]);
      }
      groups.forEach(function eachGroup(group) {
        const kind = group[0];
        (Array.isArray(group[1]) ? group[1] : []).forEach(function eachRep(entry) {
          if (!entry || typeof entry !== "object") {
            return;
          }
          const base = entry.baseUrl || entry.base_url;
          const backups = entry.backupUrl || entry.backup_url || [];
          const urls = [base].concat(Array.isArray(backups) ? backups : []).filter(function (u) {
            return typeof u === "string";
          });
          const key = urls.map(fileKey).filter(Boolean)[0];
          if (!key) {
            return;
          }
          const rep = table.reps[key] || {
            key,
            id: entry.id,
            kind,
            bandwidth: Number(entry.bandwidth) || 0,
            codecs: entry.codecs || "",
            urls: {},
            issued: []
          };
          urls.forEach(function eachUrl(u) {
            const host = hostOf(u);
            if (!host || fileKey(u) !== key || (isUsable && !isUsable(u))) {
              return;
            }
            if (!rep.urls[host]) {
              rep.urls[host] = u;
              rep.issued.push(host);
            }
          });
          table.reps[key] = rep;
          table.cid = table.cid || cidOf(key);
        });
      });
    });
    return Object.keys(table.reps).length ? table : null;
  }

  function isAkamai(host) {
    return /\.akamaized\.net$/i.test(host || "");
  }

  // A UPOS mirror accepts any other UPOS host's signed path; Akamai accepts only
  // the URL issued for it.
  function isUposHost(host) {
    return /^upos-[a-z0-9-]+\.bilivideo\.com$/i.test(host || "");
  }

  // The URL of a representation's bytes on `host`: its own issued URL if it has
  // one, else a host swap of an issued UPOS URL. null when neither exists.
  function urlFor(rep, host) {
    if (!rep || !host) {
      return null;
    }
    if (rep.urls[host]) {
      return rep.urls[host];
    }
    if (!isUposHost(host)) {
      return null;
    }
    const source = rep.issued.filter(isUposHost).map(function (h) { return rep.urls[h]; })[0];
    if (!source) {
      return null;
    }
    try {
      const next = new URL(source);
      next.host = host;
      return next.toString();
    } catch (_) {
      return null;
    }
  }

  // Every host a representation can be fetched from: what Bilibili issued,
  // then the pool mirrors a swap can reach.
  function candidatesFor(rep, pool) {
    if (!rep) {
      return [];
    }
    const out = rep.issued.slice();
    (pool || []).forEach(function (h) {
      const host = String(h || "").toLowerCase();
      if (host && out.indexOf(host) === -1 && urlFor(rep, host)) {
        out.push(host);
      }
    });
    return out;
  }

  // ---- goodput --------------------------------------------------------------

  function createEwma(halfLifeS) {
    const alpha = Math.exp(Math.log(0.5) / halfLifeS);
    let estimate = 0;
    let totalWeight = 0;
    return {
      sample: function (weight, value) {
        const adjAlpha = Math.pow(alpha, weight);
        estimate = value * (1 - adjAlpha) + adjAlpha * estimate;
        totalWeight += weight;
      },
      get: function () {
        const zeroFactor = 1 - Math.pow(alpha, totalWeight);
        return zeroFactor > 0 ? estimate / zeroFactor : 0;
      }
    };
  }

  // Bits per second the player got from one host, from whole requests: bytes
  // over the time from send to the last byte, first-byte wait included, since
  // the player pays for that on every fragment.
  function createEstimator() {
    const fast = createEwma(EWMA_FAST_HALF_LIFE_S);
    const slow = createEwma(EWMA_SLOW_HALF_LIFE_S);
    let bytes = 0;
    let ms = 0;
    return {
      sample: function (durationMs, numBytes) {
        if (!(durationMs > 0) || !(numBytes >= MIN_SAMPLE_BYTES)) {
          return false;
        }
        const bps = 8000 * numBytes / durationMs;
        fast.sample(durationMs / 1000, bps);
        slow.sample(durationMs / 1000, bps);
        bytes += numBytes;
        ms += durationMs;
        return true;
      },
      estimate: function () {
        return bytes >= MIN_TOTAL_BYTES ? Math.min(fast.get(), slow.get()) : null;
      },
      bytes: function () { return bytes; },
      ms: function () { return ms; }
    };
  }

  // Rate over the recent part of an in-flight transfer, from progress samples
  // [[timeMs, loadedBytes], ...]. Falls back to the whole transfer when the
  // window holds a single sample.
  function recentRate(samples, now, windowMs) {
    if (!samples || !samples.length) {
      return 0;
    }
    const last = samples[samples.length - 1];
    let first = samples[0];
    for (let i = samples.length - 1; i >= 0; i -= 1) {
      if (now - samples[i][0] <= windowMs) {
        first = samples[i];
      } else {
        break;
      }
    }
    if (first === last) {
      first = samples[0];
    }
    const dt = last[0] - first[0];
    return dt > 0 ? 8000 * (last[1] - first[1]) / dt : 0;
  }

  // ---- when to act ----------------------------------------------------------

  // A fragment request in flight, judged against the buffer it has to beat.
  //   req: { total, loaded, startedAt, firstByteAt, rateBps }
  function stuckVerdict(req, now, requiredBps, bufferAheadS) {
    if (!req || !(req.total >= STUCK_MIN_FRAGMENT_BYTES) || !(requiredBps > 0)) {
      return null;
    }
    const bufferMs = Math.max(0, bufferAheadS || 0) * 1000;
    if (!req.firstByteAt) {
      const waited = now - req.startedAt;
      if (waited >= STUCK_NO_FIRST_BYTE_MS && bufferAheadS < STUCK_URGENT_BUFFER_S) {
        return { reason: "no-first-byte", waitedMs: waited };
      }
      return null;
    }
    const transferMs = now - req.firstByteAt;
    if (transferMs < STUCK_MIN_TRANSFER_MS && req.loaded < STUCK_MIN_FRAGMENT_BYTES) {
      return null;
    }
    const rate = req.rateBps > 0 ? req.rateBps : (transferMs > 0 ? 8000 * req.loaded / transferMs : 0);
    const remainingMs = rate > 0 ? (req.total - req.loaded) * 8000 / rate : Infinity;
    if (rate < STUCK_RATE_FACTOR * requiredBps && remainingMs > STUCK_MIN_REMAINING_MS &&
        remainingMs > bufferMs - STUCK_MARGIN_MS) {
      return { reason: "slow-fragment", rateBps: rate, remainingMs };
    }
    return null;
  }

  // What, if anything, should start a race now.
  //   input: { now, requiredBps, bufferAheadS, inflight: [req], estimateBps,
  //            measuredBytes, measuredMs, recentErrors }
  function evaluate(input) {
    const i = input || {};
    if (!(i.requiredBps > 0)) {
      return null;
    }
    if (i.recentErrors >= ERROR_LIMIT) {
      return { trigger: "errors" };
    }
    const inflight = i.inflight || [];
    for (let k = 0; k < inflight.length; k += 1) {
      const verdict = stuckVerdict(inflight[k], i.now, i.requiredBps, i.bufferAheadS);
      if (verdict) {
        return { trigger: "stuck", req: inflight[k], detail: verdict };
      }
    }
    const enough = i.measuredBytes >= SHORTFALL_MIN_BYTES || i.measuredMs >= SHORTFALL_MIN_MS;
    if (enough && i.estimateBps != null && i.estimateBps < SHORTFALL_RATE_FACTOR * i.requiredBps &&
        i.bufferAheadS < SHORTFALL_BUFFER_S) {
      return { trigger: "shortfall" };
    }
    return null;
  }

  // ---- choosing -------------------------------------------------------------

  function historyScore(history, host) {
    const rec = history && history.hosts && history.hosts[host];
    return rec && rec.n > 0 ? rec.mbps : null;
  }

  function recentlyFailed(history, host, now) {
    const rec = history && history.hosts && history.hosts[host];
    return !!(rec && rec.lastFailAt && now - rec.lastFailAt < RECENT_FAILURE_MS);
  }

  // Two hosts to race against the current one. The other issued host comes
  // first until it has been measured this session: it is the player's own
  // alternative and sometimes the best. The rest go by history, with unknown
  // hosts scored as ordinary so they still get tried, and one pick in five
  // drawn at random so history keeps learning.
  //
  // Ties, which is every host before any history exists, go to mainland
  // mirrors. Bilibili assigns one overseas edge per region, so the overseas
  // mirrors it did not issue see little of that region's traffic and are cold,
  // while a mainland mirror sits next to origin and holds every file.
  //   input: { candidates, current, issued, measured, failed, lost, history,
  //            now, random }
  function pickChallengers(input) {
    const i = input || {};
    const now = i.now || 0;
    const rand = typeof i.random === "function" ? i.random : Math.random;
    const failed = i.failed || {};
    const lost = i.lost || {};
    const measured = i.measured || {};
    const pool = (i.candidates || []).filter(function (h) {
      return h && h !== i.current && !(failed[h] >= ERROR_LIMIT) &&
        !(lost[h] && now - lost[h] < LOST_RACE_REST_MS);
    });
    if (!pool.length) {
      return [];
    }
    const failedLately = function (h) { return recentlyFailed(i.history, h, now) ? 1 : 0; };
    // An unknown host counts as the lower median of the measured ones, so it
    // never outranks a host already measured as good.
    const known = pool.filter(function (h) { return !failedLately(h); })
      .map(function (h) { return historyScore(i.history, h); })
      .filter(function (s) { return s != null; }).sort(function (a, b) { return a - b; });
    const typical = known.length ? known[Math.floor((known.length - 1) / 2)] : UNKNOWN_HOST_MBPS;
    const score = function (h) {
      const s = historyScore(i.history, h);
      return s == null ? typical : s;
    };
    const overseas = function (h) { return describeHost(h).region === "overseas" ? 1 : 0; };
    // Hosts that failed within the hour go last, whatever they scored before.
    const ordered = pool.slice().sort(function (a, b) {
      return (failedLately(a) - failedLately(b)) || (score(b) - score(a)) || (overseas(a) - overseas(b));
    });
    const picks = [];
    (i.issued || []).forEach(function (h) {
      if (picks.length < 1 && pool.indexOf(h) !== -1 && !measured[h]) {
        picks.push(h);
      }
    });
    ordered.forEach(function (h) {
      if (picks.length < 2 && picks.indexOf(h) === -1) {
        picks.push(h);
      }
    });
    if (picks.length === 2 && rand() < EXPLORE_RATE) {
      const rest = pool.filter(function (h) { return picks.indexOf(h) === -1; });
      if (rest.length) {
        picks[1] = rest[Math.floor(rand() * rest.length) % rest.length];
      }
    }
    return picks;
  }

  // results: [{ host, ok, ms, bytes }]. The winner is the fastest complete
  // result; it replaces the current host only if it beat the time the current
  // host needs for the same bytes by SWITCH_GAIN.
  function raceVerdict(results, currentRateBps, raceBytes) {
    const done = (results || []).filter(function (r) { return r && r.ok && r.ms > 0; })
      .sort(function (a, b) { return a.ms - b.ms; });
    const bytes = raceBytes || RACE_BYTES;
    const currentMs = currentRateBps > 0 ? bytes * 8000 / currentRateBps : Infinity;
    if (!done.length) {
      return { winner: null, runnerUp: null, switchTo: null, currentMs };
    }
    const winner = done[0];
    const better = winner.ms * SWITCH_GAIN <= currentMs;
    return {
      winner: winner.host,
      runnerUp: done[1] ? done[1].host : null,
      switchTo: better ? winner.host : null,
      winnerMs: winner.ms,
      currentMs
    };
  }

  // Time before the next race: after a switch it doubles with each one; after
  // a race that changed nothing it doubles too, up to two minutes.
  function nextCooldown(kind, switches, previousMs) {
    if (kind === "switch") {
      return SWITCH_BACKOFF_MS * Math.pow(2, Math.max(0, switches - 1));
    }
    return Math.min(MAX_COOLDOWN_MS, previousMs ? previousMs * 2 : NO_SWITCH_COOLDOWN_MS);
  }

  // ---- history --------------------------------------------------------------

  function recordSample(history, host, mbps, now) {
    const h = history && typeof history === "object" ? history : {};
    h.hosts = h.hosts || {};
    const rec = h.hosts[host] || { mbps: 0, n: 0, at: now };
    const age = Math.max(0, now - (rec.at || now));
    const nEff = rec.n * Math.pow(0.5, age / HISTORY_HALF_LIFE_MS);
    rec.mbps = (rec.mbps * nEff + mbps) / (nEff + 1);
    rec.n = nEff + 1;
    rec.at = now;
    h.hosts[host] = rec;
    return h;
  }

  function recordFailure(history, host, now) {
    const h = history && typeof history === "object" ? history : {};
    h.hosts = h.hosts || {};
    const rec = h.hosts[host] || { mbps: 0, n: 0, at: now };
    rec.lastFailAt = now;
    h.hosts[host] = rec;
    return h;
  }

  // ---- labels ---------------------------------------------------------------

  const VENDORS = { cos: "tencent", ali: "alibaba", hw: "huawei", tx: "tencent", akam: "akamai" };

  // What a host is, for the panel: which side of the Pacific and whose cloud.
  function describeHost(host) {
    const h = String(host || "").toLowerCase();
    if (isAkamai(h)) {
      return { region: "overseas", vendor: "akamai", id: "akamai" };
    }
    let m = /^upos-[a-z]+-mirror([a-z0-9]+?)(ov)?\.bilivideo\.com$/.exec(h);
    if (m) {
      return { region: m[2] ? "overseas" : "mainland", vendor: VENDORS[m[1]] || null, id: m[1] + (m[2] || "") };
    }
    m = /^upos-tf-all-([a-z]+)\.bilivideo\.com$/.exec(h);
    if (m) {
      return { region: "mainland", vendor: VENDORS[m[1]] || null, id: "tf-" + m[1] };
    }
    return { region: null, vendor: null, id: h.split(".")[0] || h };
  }

  return {
    RACE_BYTES,
    RACE_TIMEOUT_MS,
    MAX_SWITCHES,
    ERROR_WINDOW_MS,
    ERROR_LIMIT,
    SWITCH_GAIN,
    AUDIO_ID_RE,
    fileKey,
    cidOf,
    repIdOf,
    parseRange,
    buildTable,
    isAkamai,
    isUposHost,
    urlFor,
    candidatesFor,
    createEstimator,
    recentRate,
    stuckVerdict,
    evaluate,
    pickChallengers,
    raceVerdict,
    nextCooldown,
    historyScore,
    recentlyFailed,
    recordSample,
    recordFailure,
    describeHost
  };
});
