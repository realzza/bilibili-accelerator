(function initBiliAcceleratorLiveStability(root, factory) {
  const core = typeof module === "object" && module.exports
    ? require("./rewrite")
    : root.BiliAcceleratorCore;
  const liveStability = factory(core);

  if (typeof module === "object" && module.exports) {
    module.exports = liveStability;
  }

  root.BiliAcceleratorLiveStability = liveStability;
})(typeof globalThis !== "undefined" ? globalThis : window, function createLiveStability(core) {
  "use strict";

  const FORMAT_ORDER = Object.freeze({ fmp4: 0, flv: 1, ts: 2 });
  const UNSUPPORTED_TAGS = Object.freeze({
    "#EXT-X-BYTERANGE": "byterange",
    "#EXT-X-PART": "part",
    "#EXT-X-PRELOAD-HINT": "preload-hint",
    "#EXT-X-GAP": "gap",
    "#EXT-X-SKIP": "skip"
  });

  function normalizePolicy(rawConfig) {
    const config = core.normalizeConfig(rawConfig);
    return {
      active: rawConfig && typeof rawConfig.active === "boolean"
        ? rawConfig.active
        : config.enabled && config.mode !== "off",
      liveProtocolPreference: config.liveProtocolPreference,
      livePrefetchEnabled: config.livePrefetchEnabled,
      livePrefetchTargetSeconds: config.livePrefetchTargetSeconds,
      livePrefetchMaxSegments: config.livePrefetchMaxSegments,
      livePrefetchConcurrency: config.livePrefetchConcurrency,
      livePrefetchCacheMiB: config.livePrefetchCacheMiB
    };
  }

  function getPlayurl(payload) {
    if (!payload || typeof payload !== "object") {
      return null;
    }
    if (payload.data && payload.data.playurl_info && payload.data.playurl_info.playurl) {
      return payload.data.playurl_info.playurl;
    }
    if (payload.playurl_info && payload.playurl_info.playurl) {
      return payload.playurl_info.playurl;
    }
    return Array.isArray(payload.stream) ? payload : null;
  }

  function addExtra(url, extra) {
    if (typeof extra !== "string" || !extra) {
      return url.toString();
    }
    const query = extra.replace(/^[?&]/, "");
    if (!query) {
      return url.toString();
    }
    const resolved = url.toString();
    const hashIndex = resolved.indexOf("#");
    const beforeHash = hashIndex === -1 ? resolved : resolved.slice(0, hashIndex);
    const hash = hashIndex === -1 ? "" : resolved.slice(hashIndex);
    const tail = beforeHash.charAt(beforeHash.length - 1);
    const separator = beforeHash.indexOf("?") === -1 ? "?" :
      (tail === "?" || tail === "&" ? "" : "&");
    return beforeHash + separator + query + hash;
  }

  function completeUrl(host, baseUrl, extra) {
    if (typeof baseUrl !== "string" || !baseUrl) {
      return null;
    }
    try {
      const base = typeof host === "string" && host
        ? new URL(baseUrl, host.indexOf("://") === -1 ? "https://" + host : host)
        : new URL(baseUrl);
      return addExtra(base, extra);
    } catch (_) {
      return null;
    }
  }

  function isPlaylistUrl(value) {
    try {
      return new URL(value).pathname.toLowerCase().endsWith(".m3u8");
    } catch (_) {
      return false;
    }
  }

  function hlsPlan(playurl) {
    const plan = [];
    const streams = Array.isArray(playurl.stream) ? playurl.stream : [];
    streams.forEach(function eachStream(stream, streamIndex) {
      const formats = stream && Array.isArray(stream.format) ? stream.format : [];
      formats.forEach(function eachFormat(format, formatIndex) {
        const codecs = format && Array.isArray(format.codec) ? format.codec : [];
        codecs.forEach(function eachCodec(codec, codecIndex) {
          const urls = codec && Array.isArray(codec.url_info) ? codec.url_info : [];
          if (urls.length === 0) {
            const complete = completeUrl("", codec && codec.base_url, "");
            if (complete && isPlaylistUrl(complete)) {
              plan.push({
                url: complete,
                identity: { streamIndex, formatIndex, codecIndex, urlInfoIndex: -1 }
              });
            }
            return;
          }
          urls.forEach(function eachUrlInfo(urlInfo, urlInfoIndex) {
            const complete = completeUrl(urlInfo && urlInfo.host, codec && codec.base_url, urlInfo && urlInfo.extra);
            if (complete && isPlaylistUrl(complete)) {
              plan.push({
                url: complete,
                identity: { streamIndex, formatIndex, codecIndex, urlInfoIndex }
              });
            }
          });
        });
      });
    });
    return plan;
  }

  // This only reorders the format array. Codec entries and their host candidates
  // are deliberately retained verbatim so player failover remains intact.
  function transformPlayInfo(payload, rawConfig) {
    const policy = normalizePolicy(rawConfig);
    const playurl = getPlayurl(payload);
    const rewrites = [];
    let changed = false;
    if (!policy.active || !playurl) {
      return { changed, rewrites, plan: [], matched: Boolean(playurl) };
    }

    if (policy.liveProtocolPreference === "stable") {
      const streams = Array.isArray(playurl.stream) ? playurl.stream : [];
      streams.forEach(function eachStream(stream, streamIndex) {
        if (!stream || !Array.isArray(stream.format)) {
          return;
        }
        const original = stream.format.slice();
        const ordered = original.map(function withIndex(format, index) {
          const formatName = String(format && format.format_name || "").toLowerCase();
          return { format, index, rank: Object.prototype.hasOwnProperty.call(FORMAT_ORDER, formatName) ? FORMAT_ORDER[formatName] : 3 };
        }).sort(function stableFormatOrder(a, b) {
          return a.rank - b.rank || a.index - b.index;
        });
        if (ordered.some(function moved(item, index) { return item.index !== index; })) {
          stream.format.length = 0;
          ordered.forEach(function insert(item, index) {
            stream.format.push(item.format);
            rewrites.push({
              changed: true,
              reason: "live-format-order",
              streamIndex,
              originalIndex: item.index,
              formatIndex: index,
              formatName: String(item.format && item.format.format_name || "")
            });
          });
          changed = true;
        }
      });
      const orderedStreams = streams.map(function withStreamIndex(stream, index) {
        const formats = stream && Array.isArray(stream.format) ? stream.format : [];
        let rank = 3;
        formats.forEach(function findBestFormat(format) {
          const name = String(format && format.format_name || "").toLowerCase();
          if (Object.prototype.hasOwnProperty.call(FORMAT_ORDER, name)) {
            rank = Math.min(rank, FORMAT_ORDER[name]);
          }
        });
        return { stream, index, rank };
      }).sort(function stableStreamOrder(a, b) {
        return a.rank - b.rank || a.index - b.index;
      });
      if (orderedStreams.some(function moved(item, index) { return item.index !== index; })) {
        playurl.stream.length = 0;
        orderedStreams.forEach(function insertStream(item, streamIndex) {
          playurl.stream.push(item.stream);
          rewrites.push({
            changed: true,
            reason: "live-stream-order",
            originalIndex: item.index,
            streamIndex
          });
        });
        changed = true;
      }
    }

    return { changed, rewrites, plan: hlsPlan(playurl), matched: true };
  }

  function resolveUrl(value, baseUrl) {
    try {
      return new URL(value, baseUrl).toString();
    } catch (_) {
      return value;
    }
  }

  function resolveSegmentUrl(value, baseUrl) {
    const resolved = resolveUrl(value, baseUrl);
    const reference = String(value || "");
    const withoutHash = reference.split("#")[0];
    if (!resolved || withoutHash.indexOf("?") !== -1 ||
        /^[a-z][a-z0-9+.-]*:|^\/\//i.test(reference)) {
      return resolved;
    }
    try {
      const base = new URL(baseUrl);
      if (!base.search) {
        return resolved;
      }
      const segment = new URL(resolved);
      segment.search = base.search;
      return segment.toString();
    } catch (_) {
      return resolved;
    }
  }

  function attributeUri(line) {
    const match = /(?:^|[:,])URI=(?:"([^"]*)"|([^,]*))/i.exec(line);
    return match ? (match[1] === undefined ? match[2] : match[1]) : null;
  }

  function parsePlaylist(baseUrl, text) {
    const lines = String(text || "").replace(/^\uFEFF/, "").split(/\r?\n/);
    const variants = [];
    const media = [];
    const maps = [];
    const segments = [];
    const unsupported = [];
    let sequence = 0;
    let pendingDuration = null;
    let expectsVariant = false;
    let discontinuityBefore = false;
    let currentMapUrl = null;
    let master = false;

    function markUnsupported(value) {
      if (unsupported.indexOf(value) === -1) {
        unsupported.push(value);
      }
    }

    lines.forEach(function parseLine(rawLine) {
      const line = rawLine.trim();
      if (!line) {
        return;
      }
      if (line.indexOf("#EXT-X-STREAM-INF:") === 0) {
        master = true;
        expectsVariant = true;
        return;
      }
      if (line.indexOf("#EXT-X-I-FRAME-STREAM-INF:") === 0) {
        master = true;
        const iframeUri = attributeUri(line);
        if (iframeUri) {
          variants.push(resolveUrl(iframeUri, baseUrl));
        }
        return;
      }
      if (line.indexOf("#EXT-X-MEDIA:") === 0) {
        master = true;
        const mediaUri = attributeUri(line);
        if (mediaUri) {
          media.push(resolveUrl(mediaUri, baseUrl));
        }
        return;
      }
      if (line.indexOf("#EXT-X-MEDIA-SEQUENCE:") === 0) {
        const value = Number(line.slice("#EXT-X-MEDIA-SEQUENCE:".length));
        sequence = Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
        return;
      }
      if (line.indexOf("#EXTINF:") === 0) {
        const value = Number(line.slice("#EXTINF:".length).split(",")[0]);
        pendingDuration = Number.isFinite(value) && value >= 0 ? value : 0;
        return;
      }
      if (line === "#EXT-X-DISCONTINUITY") {
        discontinuityBefore = true;
        return;
      }
      if (line.indexOf("#EXT-X-KEY:") === 0 && !/METHOD=NONE(?:,|$)/i.test(line)) {
        markUnsupported("encryption");
        return;
      }
      if (line.indexOf("#EXT-X-MAP:") === 0) {
        const mapUri = attributeUri(line);
        if (mapUri) {
          currentMapUrl = resolveUrl(mapUri, baseUrl);
          maps.push(currentMapUrl);
        }
        return;
      }
      Object.keys(UNSUPPORTED_TAGS).some(function checkTag(tag) {
        if (line.indexOf(tag) === 0) {
          markUnsupported(UNSUPPORTED_TAGS[tag]);
          return true;
        }
        return false;
      });
      if (line.charAt(0) === "#") {
        return;
      }
      if (expectsVariant) {
        variants.push(resolveUrl(line, baseUrl));
        expectsVariant = false;
        return;
      }
      segments.push({
        url: resolveSegmentUrl(line, baseUrl),
        duration: pendingDuration === null ? 0 : pendingDuration,
        sequence,
        discontinuityBefore,
        mapUrl: currentMapUrl
      });
      sequence += 1;
      pendingDuration = null;
      discontinuityBefore = false;
    });

    return {
      type: master ? "master" : "media",
      mediaSequence: segments.length ? segments[0].sequence : sequence,
      variants,
      media,
      maps,
      segments,
      unsupported
    };
  }

  function cursorSequence(cursor) {
    if (typeof cursor === "number" && Number.isFinite(cursor)) {
      return cursor;
    }
    if (cursor && typeof cursor.sequence === "number" && Number.isFinite(cursor.sequence)) {
      return cursor.sequence;
    }
    return null;
  }

  function collectionHas(collection, value) {
    if (!collection) {
      return false;
    }
    if (typeof collection.has === "function") {
      return collection.has(value);
    }
    return Array.isArray(collection) && collection.indexOf(value) !== -1;
  }

  function planPrefetch(playlist, cursor, bufferedSeconds, cacheState, rawPolicy) {
    const policy = normalizePolicy(rawPolicy);
    const observed = cursorSequence(cursor);
    if (!policy.livePrefetchEnabled || observed === null || !playlist ||
        playlist.type !== "media" || (playlist.unsupported && playlist.unsupported.length)) {
      return [];
    }
    const state = cacheState || {};
    const cacheBytes = (Number(state.cachedBytes) || 0) + (Number(state.inFlightBytes) || 0);
    if (cacheBytes >= policy.livePrefetchCacheMiB * 1024 * 1024) {
      return [];
    }
    const buffered = Math.max(0, Number(bufferedSeconds) || 0);
    const reserved = Math.max(0, Number(state.reservedDuration) || 0);
    let remaining = policy.livePrefetchTargetSeconds - buffered - reserved;
    if (!(remaining > 0)) {
      return [];
    }
    const planned = [];
    const segments = Array.isArray(playlist.segments) ? playlist.segments : [];
    let cursorMapUrl = null;
    let cursorMapKnown = Boolean(cursor && typeof cursor === "object" &&
      Object.prototype.hasOwnProperty.call(cursor, "mapUrl"));
    if (cursorMapKnown) {
      cursorMapUrl = cursor.mapUrl || null;
    } else {
      for (let index = 0; index < segments.length; index += 1) {
        if (segments[index] && segments[index].sequence === observed) {
          cursorMapUrl = segments[index].mapUrl || null;
          cursorMapKnown = true;
          break;
        }
      }
    }
    for (let i = 0; i < segments.length && planned.length < policy.livePrefetchMaxSegments; i += 1) {
      const segment = segments[i];
      if (!segment || !(segment.sequence > observed)) {
        continue;
      }
      if (segment.discontinuityBefore) {
        break;
      }
      const segmentMapUrl = segment.mapUrl || null;
      if (cursorMapKnown && segmentMapUrl !== cursorMapUrl) {
        break;
      }
      if (!cursorMapKnown) {
        cursorMapUrl = segmentMapUrl;
        cursorMapKnown = true;
      }
      if (collectionHas(state.reservedUrls, segment.url)) {
        continue;
      }
      const duration = Number(segment.duration) || 0;
      planned.push(segment);
      remaining -= duration;
      if (!(remaining > 0)) {
        break;
      }
    }
    return planned;
  }

  function headersToObject(headers) {
    const values = {};
    if (!headers) {
      return values;
    }
    function copy(value, key) {
      const normalizedKey = String(key).trim().toLowerCase();
      const normalizedValue = String(value).trim();
      if (!normalizedKey) {
        return;
      }
      values[normalizedKey] = Object.prototype.hasOwnProperty.call(values, normalizedKey)
        ? values[normalizedKey] + ", " + normalizedValue
        : normalizedValue;
    }
    if (Array.isArray(headers)) {
      headers.forEach(function copyTuple(tuple) {
        if (Array.isArray(tuple) && tuple.length >= 2) {
          copy(tuple[1], tuple[0]);
        }
      });
    } else if (typeof headers.forEach === "function") {
      headers.forEach(copy);
    } else {
      Object.keys(headers).forEach(function copyKey(key) { copy(headers[key], key); });
    }
    return values;
  }

  function classifyRequest(input, init) {
    const requestLike = input && typeof input === "object" && typeof input.url === "string" && input.headers;
    const source = requestLike ? input : null;
    const rawUrl = source ? source.url : input instanceof URL ? input.toString() : String(input || "");
    let url = rawUrl;
    try { url = new URL(rawUrl).toString(); } catch (_) { /* keep the caller value for observability */ }
    const overrides = init && typeof init === "object" ? init : {};
    const hasOwn = Object.prototype.hasOwnProperty;
    function overridesWithValue(key) {
      return hasOwn.call(overrides, key) && overrides[key] !== undefined;
    }
    const headers = overridesWithValue("headers") ? headersToObject(overrides.headers) : headersToObject(source && source.headers);
    const method = String(overridesWithValue("method") ? overrides.method : source && source.method || "GET").toUpperCase();
    let inheritedBody = null;
    if (source) {
      try { inheritedBody = source.body === null || source.body === undefined ? null : true; } catch (_) { inheritedBody = true; }
    }
    const body = overridesWithValue("body") ? overrides.body : inheritedBody;
    const credentials = overridesWithValue("credentials") ? overrides.credentials : source && source.credentials || "same-origin";
    const mode = overridesWithValue("mode") ? overrides.mode : source && source.mode || "cors";
    const cache = overridesWithValue("cache") ? overrides.cache : source && source.cache || "default";
    const redirect = overridesWithValue("redirect") ? overrides.redirect : source && source.redirect || "follow";
    const integrity = String(overridesWithValue("integrity") ? overrides.integrity : source && source.integrity || "");
    const referrer = String(overridesWithValue("referrer")
      ? overrides.referrer
      : source && typeof source.referrer === "string" ? source.referrer : "about:client");
    const referrerPolicy = String(overridesWithValue("referrerPolicy") ? overrides.referrerPolicy : source && source.referrerPolicy || "");
    const keepalive = Boolean(overridesWithValue("keepalive") ? overrides.keepalive : source && source.keepalive || false);
    let pathname = "";
    try { pathname = new URL(url).pathname.toLowerCase(); } catch (_) { pathname = String(url).split(/[?#]/)[0].toLowerCase(); }
    const kind = /\.m3u8$/.test(pathname) ? "playlist" : /\.flv$/.test(pathname) ? "flv" :
      /\.(?:m4s|ts|mp4|m4a|aac)$/.test(pathname) ? "segment" : "other";
    const range = headers.range || null;
    const auth = Boolean(headers.authorization);
    const standardHeaders = { accept: true, "accept-language": true, "content-language": true, "content-type": true, range: true, authorization: true };
    const customHeader = Object.keys(headers).some(function isCustom(key) { return !standardHeaders[key]; });
    const fingerprintHeaders = Object.keys(headers).sort().map(function fingerprintHeader(key) {
      const sensitive = key === "authorization" || key === "proxy-authorization" || key === "cookie";
      return [key, sensitive ? "<present>" : headers[key]];
    });
    return {
      url,
      kind,
      method,
      body,
      headers,
      range,
      auth,
      customHeader,
      credentials,
      mode,
      cache,
      redirect,
      integrity,
      referrer,
      referrerPolicy,
      keepalive,
      fingerprint: JSON.stringify({
        url, kind, method, headers: fingerprintHeaders, range, auth, customHeader,
        credentials, mode, cache, redirect, integrity, referrer, referrerPolicy,
        keepalive, hasBody: body !== null && body !== undefined
      })
    };
  }

  return { normalizePolicy, transformPlayInfo, parsePlaylist, planPrefetch, classifyRequest };
});
