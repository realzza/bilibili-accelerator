(function initBiliAcceleratorLiveRuntime(root, factory) {
  const LiveCore = typeof module === "object" && module.exports
    ? require("../core/live-stability")
    : root.BiliAcceleratorLiveStability;
  const runtime = factory(LiveCore);

  if (typeof module === "object" && module.exports) {
    module.exports = runtime;
  }

  root.BiliAcceleratorLiveRuntime = runtime;
})(typeof globalThis !== "undefined" ? globalThis : window, function createRuntimeModule(defaultLiveCore) {
  "use strict";

  const hasOwn = Object.prototype.hasOwnProperty;
  const SAFE_REQUEST_HEADERS = Object.freeze({
    accept: true,
    "accept-language": true,
    "content-language": true,
    "content-type": true
  });
  const UNSAFE_RESPONSE_HEADERS = Object.freeze({
    "content-encoding": true,
    "content-length": true,
    "set-cookie": true,
    "set-cookie2": true,
    "transfer-encoding": true
  });

  function isHlsUrl(value) {
    try {
      const url = new URL(value);
      return (url.protocol === "http:" || url.protocol === "https:") &&
        url.pathname.toLowerCase().endsWith(".m3u8");
    } catch (_) {
      return false;
    }
  }

  function isBilibiliLiveFmp4Url(value) {
    try {
      const url = new URL(value);
      return /(?:^|\.)bilivideo\.com$/i.test(url.hostname) &&
        url.pathname.includes("/live-bvc/") && url.pathname.toLowerCase().endsWith(".m4s");
    } catch (_) {
      return false;
    }
  }

  function responseHeader(response, name) {
    try {
      return response && response.headers && typeof response.headers.get === "function"
        ? response.headers.get(name)
        : null;
    } catch (_) {
      return null;
    }
  }

  function safeResponseInit(response) {
    const headers = {};
    try {
      if (response.headers && typeof response.headers.forEach === "function") {
        response.headers.forEach(function copy(value, name) {
          const key = String(name).toLowerCase();
          if (!UNSAFE_RESPONSE_HEADERS[key]) {
            headers[key] = String(value);
          }
        });
      }
    } catch (_) {
      // A response with inaccessible headers can still be represented safely.
    }
    return { status: 200, statusText: String(response.statusText || "OK"), headers };
  }

  function createLivePrefetchRuntime(adapter) {
    const dependencies = adapter || {};
    const LiveCore = dependencies.LiveCore || defaultLiveCore;
    const nativeFetch = dependencies.nativeFetch || dependencies.fetch;
    const createController = typeof dependencies.createAbortController === "function"
      ? dependencies.createAbortController
      : typeof dependencies.AbortController === "function"
        ? function newController() { return new dependencies.AbortController(); }
        : null;
    const createResponse = typeof dependencies.createResponse === "function"
      ? dependencies.createResponse
      : null;
    const ReadableStreamImpl = hasOwn.call(dependencies, "ReadableStream")
      ? dependencies.ReadableStream
      : null;
    const TextDecoderImpl = hasOwn.call(dependencies, "TextDecoder")
      ? dependencies.TextDecoder
      : null;
    const onMetric = typeof dependencies.onMetric === "function" ? dependencies.onMetric : function noop() {};

    let generation = 0;
    let enabled = false;
    let disposed = false;
    let policy = LiveCore.normalizePolicy({});
    let configurationKey = "";
    let roots = new Set();
    let activeRoot = null;
    let trustedPlaylists = new Set();
    let playlistReferences = new Map();
    let playlistVariantReferences = new Map();
    let playlistMediaReferences = new Map();
    let activeVariants = new Map();
    let activeVariantOrders = new Map();
    let variantRequestCounter = 0;
    let playlistRevisions = new Map();
    let playlistRevisionCounter = 0;
    let activePlaylistReads = new Set();
    let activePlaylistBytes = 0;
    let snapshots = new Map();
    let knownSegments = new Map();
    let failedUrls = new Set();
    let queue = [];
    let inFlight = new Map();
    let cache = new Map();
    let cachedBytes = 0;
    let delivered = new Set();
    let deliveredBytes = 0;
    const requestBindings = new WeakMap();
    let rootRequestCounter = 0;
    let latestRootRequestOrder = 0;

    function metric(entry, reason, bytes) {
      let host = "";
      try { host = new URL(entry.url).host; } catch (_) { /* omit malformed hosts */ }
      try {
        onMetric({
          type: "live-prefetch",
          host,
          sequence: entry.sequence,
          bytes: Math.max(0, Number(bytes) || 0),
          reason
        });
      } catch (_) {
        // Telemetry cannot affect playback or prefetch state.
      }
    }

    function abortEntry(entry, reason) {
      if (!entry) {
        return;
      }
      entry.abortReason = reason;
      try { entry.controller.abort(); } catch (_) { /* already aborted */ }
    }

    function clearRuntimeState(reason) {
      generation += 1;
      latestRootRequestOrder = 0;
      queue.forEach(function abortQueued(entry) { abortEntry(entry, reason); });
      inFlight.forEach(function abortActive(entry) { abortEntry(entry, reason); });
      queue = [];
      cache.clear();
      cachedBytes = 0;
      trustedPlaylists.clear();
      playlistReferences.clear();
      playlistVariantReferences.clear();
      playlistMediaReferences.clear();
      activeVariants.clear();
      activeVariantOrders.clear();
      playlistRevisions.clear();
      activePlaylistReads.forEach(cancelPlaylistRead);
      snapshots.clear();
      knownSegments.clear();
      failedUrls.clear();
    }

    function normalizeMeta(meta) {
      try {
        if (!meta) {
          return null;
        }
        if (typeof meta === "string" || meta instanceof URL) {
          return LiveCore.classifyRequest(meta);
        }
        if (typeof meta.url !== "string") {
          return null;
        }
        if (meta.fingerprint && meta.kind && meta.headers) {
          return Object.assign({}, meta);
        }
        const classified = LiveCore.classifyRequest(meta.url, {
          method: meta.method,
          headers: meta.headers,
          body: meta.body,
          credentials: meta.credentials,
          mode: meta.mode,
          cache: meta.cache,
          redirect: meta.redirect,
          integrity: meta.integrity,
          referrer: meta.referrer,
          referrerPolicy: meta.referrerPolicy,
          keepalive: meta.keepalive
        });
        ["transport", "source", "bufferedSeconds"].forEach(function preserve(key) {
          if (hasOwn.call(meta, key)) {
            classified[key] = meta[key];
          }
        });
        return classified;
      } catch (_) {
        return null;
      }
    }

    function bindRequest(rawMeta, meta) {
      let rootOrder = latestRootRequestOrder;
      if (roots.has(meta.url)) {
        rootOrder = ++rootRequestCounter;
        latestRootRequestOrder = rootOrder;
        if (enabled && !disposed) {
          activateRoot(meta.url);
        }
      }
      const variantOrders = enabled && !disposed ? activateVariantRequest(meta.url) : [];
      const binding = { generation, enabled, rootOrder, variantOrders };
      if (rawMeta && typeof rawMeta === "object") {
        requestBindings.set(rawMeta, binding);
      }
      return binding;
    }

    function responseBinding(rawMeta) {
      if (!rawMeta || typeof rawMeta !== "object") {
        return null;
      }
      return requestBindings.get(rawMeta) || null;
    }

    function bindingIsCurrent(binding) {
      return Boolean(binding && binding.enabled && binding.generation === generation &&
        (!binding.rootOrder || binding.rootOrder === latestRootRequestOrder) &&
        binding.variantOrders.every(function currentVariant(item) {
          return activeVariants.get(item.parent) === item.url &&
            activeVariantOrders.get(item.parent) === item.order;
        }));
    }

    function isFetchMeta(meta) {
      return !(meta && ((meta.transport && meta.transport !== "fetch") ||
        (meta.source && meta.source !== "fetch")));
    }

    function isSafeGet(meta) {
      return Boolean(meta && meta.method === "GET" &&
        (meta.body === null || meta.body === undefined) && !meta.range &&
        !meta.auth && !meta.customHeader && !meta.integrity && meta.redirect === "follow");
    }

    function safeRequestHeaders(meta) {
      const headers = {};
      Object.keys(meta.headers || {}).forEach(function copy(key) {
        const normalized = String(key).toLowerCase();
        if (SAFE_REQUEST_HEADERS[normalized]) {
          headers[normalized] = String(meta.headers[key]);
        }
      });
      return headers;
    }

    function requestForSegment(segment, sourceMeta) {
      return LiveCore.classifyRequest(segment.url, {
        method: "GET",
        headers: safeRequestHeaders(sourceMeta),
        credentials: sourceMeta.credentials,
        mode: sourceMeta.mode,
        cache: sourceMeta.cache,
        redirect: sourceMeta.redirect,
        integrity: sourceMeta.integrity,
        referrer: sourceMeta.referrer,
        referrerPolicy: sourceMeta.referrerPolicy,
        keepalive: sourceMeta.keepalive
      });
    }

    function bufferedSeconds(meta) {
      if (meta && hasOwn.call(meta, "bufferedSeconds") && meta.bufferedSeconds !== null &&
          meta.bufferedSeconds !== "" && Number.isFinite(Number(meta.bufferedSeconds))) {
        return Math.max(0, Number(meta.bufferedSeconds));
      }
      if (typeof dependencies.getBufferedSeconds === "function") {
        try {
          const raw = dependencies.getBufferedSeconds(meta);
          const value = Number(raw);
          return raw !== null && raw !== "" && Number.isFinite(value) ? Math.max(0, value) : null;
        } catch (_) {
          return null;
        }
      }
      return null;
    }

    function reservedBytes() {
      let bytes = activePlaylistBytes + deliveredBytes;
      inFlight.forEach(function add(entry) { bytes += entry.accountedBytes || 0; });
      return bytes;
    }

    function ownedUrls() {
      const values = new Set();
      queue.forEach(function add(entry) { values.add(entry.url); });
      inFlight.forEach(function add(entry) { values.add(entry.url); });
      cache.forEach(function add(entry) { values.add(entry.url); });
      delivered.forEach(function add(entry) { values.add(entry.url); });
      return values;
    }

    function ownedDuration() {
      let duration = 0;
      queue.forEach(function add(entry) { duration += entry.duration || 0; });
      inFlight.forEach(function add(entry) { duration += entry.duration || 0; });
      cache.forEach(function add(entry) { duration += entry.duration || 0; });
      delivered.forEach(function add(entry) { duration += entry.duration || 0; });
      return duration;
    }

    function entryCount() {
      return queue.length + inFlight.size + cache.size + delivered.size;
    }

    function responseIsUsable(response) {
      if (!response || response.status !== 200 || response.ok !== true ||
          response.type === "opaque" || response.redirected === true ||
          responseHeader(response, "content-range")) {
        return false;
      }
      const mime = String(responseHeader(response, "content-type") || "").split(";", 1)[0].trim().toLowerCase();
      return !(/^text\//.test(mime) || /^application\/(?:json|problem\+json|xml)$/.test(mime) ||
        /\+(?:json|xml)$/.test(mime) || mime === "application/xhtml+xml");
    }

    function urlIsInCurrentWindow(url) {
      let present = false;
      snapshots.forEach(function check(snapshot, playlistUrl) {
        if (!present && trustedPlaylists.has(playlistUrl) && snapshot.playlist.segments.some(function matches(segment) {
          return segment.url === url;
        })) {
          present = true;
        }
      });
      return present;
    }

    function pruneFailedUrls() {
      failedUrls.forEach(function remove(url) {
        if (!urlIsInCurrentWindow(url)) {
          failedUrls.delete(url);
        }
      });
    }

    async function readOwnedResponse(response, entry, byteLimit) {
      const lengthHeader = responseHeader(response, "content-length");
      const declared = lengthHeader !== null && /^\d+$/.test(String(lengthHeader).trim())
        ? Number(lengthHeader)
        : null;
      if (declared !== null) {
        if (!Number.isSafeInteger(declared) || declared < 0) {
          throw Object.assign(new Error("byte limit"), { code: "BYTE_LIMIT" });
        }
        if (declared === 0) {
          throw Object.assign(new Error("empty body"), { code: "EMPTY_BODY" });
        }
        entry.accountedBytes = declared;
        if (cachedBytes + reservedBytes() > byteLimit) {
          entry.accountedBytes = 0;
          throw Object.assign(new Error("byte limit"), { code: "BYTE_LIMIT" });
        }
      }

      const chunks = [];
      let total = 0;
      const reader = response.body && typeof response.body.getReader === "function"
        ? response.body.getReader()
        : null;
      if (!reader) {
        if (declared === null) {
          throw Object.assign(new Error("stream required"), { code: "BODY_STREAM_REQUIRED" });
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        total = bytes.byteLength;
        entry.accountedBytes = total;
        if (cachedBytes + reservedBytes() > byteLimit) {
          entry.accountedBytes = 0;
          throw Object.assign(new Error("byte limit"), { code: "BYTE_LIMIT" });
        }
        if (total === 0) {
          throw Object.assign(new Error("empty body"), { code: "EMPTY_BODY" });
        }
        return { chunks: [bytes], byteLength: total };
      }

      try {
        while (true) {
          const part = await reader.read();
          if (part.done) {
            break;
          }
          const chunk = part.value instanceof Uint8Array ? part.value : new Uint8Array(part.value);
          total += chunk.byteLength;
          entry.accountedBytes = Math.max(declared || 0, total);
          if (cachedBytes + reservedBytes() > byteLimit) {
            abortEntry(entry, "byte-limit");
            try { await reader.cancel(); } catch (_) { /* cancellation is best effort */ }
            throw Object.assign(new Error("byte limit"), { code: "BYTE_LIMIT" });
          }
          chunks.push(chunk);
        }
      } finally {
        try { reader.releaseLock(); } catch (_) { /* not all readers expose it */ }
      }
      if (total === 0) {
        throw Object.assign(new Error("empty body"), { code: "EMPTY_BODY" });
      }
      return { chunks, byteLength: total };
    }

    async function download(entry) {
      const ownGeneration = entry.generation;
      const byteLimit = policy.livePrefetchCacheMiB * 1024 * 1024;
      try {
        const response = await nativeFetch(entry.url, {
          method: "GET",
          headers: entry.headers,
          credentials: entry.credentials,
          mode: entry.mode,
          cache: entry.cache,
          redirect: entry.redirect,
          integrity: entry.integrity,
          referrer: entry.referrer,
          referrerPolicy: entry.referrerPolicy,
          keepalive: entry.keepalive,
          signal: entry.controller.signal
        });
        if (ownGeneration !== generation || entry.controller.signal.aborted) {
          return;
        }
        if (!responseIsUsable(response)) {
          if (urlIsInCurrentWindow(entry.url)) {
            failedUrls.add(entry.url);
          }
          metric(entry, "response-rejected", 0);
          return;
        }
        const init = safeResponseInit(response);
        const body = await readOwnedResponse(response, entry, byteLimit);
        if (ownGeneration !== generation || entry.controller.signal.aborted) {
          return;
        }
        const otherBytes = reservedBytes() - entry.accountedBytes;
        if (cachedBytes + otherBytes + body.byteLength > byteLimit) {
          throw Object.assign(new Error("byte limit"), { code: "BYTE_LIMIT" });
        }
        entry.accountedBytes = 0;
        const previous = cache.get(entry.key);
        if (previous) {
          cachedBytes -= previous.byteLength;
        }
        cache.set(entry.key, {
          key: entry.key,
          url: entry.url,
          sequence: entry.sequence,
          duration: entry.duration,
          playlistUrl: entry.playlistUrl,
          chunks: body.chunks,
          byteLength: body.byteLength,
          init
        });
        cachedBytes += body.byteLength;
        metric(entry, "stored", body.byteLength);
      } catch (error) {
        if (ownGeneration === generation) {
          const byteLimitFailure = error && error.code === "BYTE_LIMIT";
          const activelyCancelled = entry.controller.signal.aborted && !byteLimitFailure;
          if (!activelyCancelled && urlIsInCurrentWindow(entry.url)) {
            failedUrls.add(entry.url);
          }
          metric(entry, byteLimitFailure ? "byte-limit" :
            entry.abortReason || (error && error.name === "AbortError" ? "aborted" : "fetch-failed"), entry.accountedBytes);
          if (byteLimitFailure) {
            abortEntry(entry, "byte-limit");
          }
        }
      } finally {
        if (inFlight.get(entry.key) === entry) {
          inFlight.delete(entry.key);
        }
        entry.accountedBytes = 0;
        pump();
      }
    }

    function pump() {
      if (!enabled || disposed) {
        return;
      }
      while (queue.length && inFlight.size < policy.livePrefetchConcurrency) {
        const entry = queue.shift();
        if (entry.generation !== generation || entry.controller.signal.aborted) {
          continue;
        }
        inFlight.set(entry.key, entry);
        void download(entry);
      }
    }

    function enqueue(snapshot, segment, sourceMeta) {
      if (entryCount() >= policy.livePrefetchMaxSegments || failedUrls.has(segment.url) ||
          ownedUrls().has(segment.url)) {
        return;
      }
      const request = requestForSegment(segment, sourceMeta);
      if (!isSafeGet(request)) {
        return;
      }
      const controller = createController();
      queue.push({
        key: request.fingerprint,
        url: request.url,
        headers: safeRequestHeaders(request),
        credentials: request.credentials,
        mode: request.mode,
        cache: request.cache,
        redirect: request.redirect,
        integrity: request.integrity,
        referrer: request.referrer,
        referrerPolicy: request.referrerPolicy,
        keepalive: request.keepalive,
        sequence: segment.sequence,
        duration: segment.duration,
        playlistUrl: snapshot.url,
        generation,
        controller,
        accountedBytes: 0,
        abortReason: ""
      });
    }

    function evictOldSnapshot(playlistUrl, parsed) {
      const current = new Set(parsed.segments.map(function key(segment) {
        return segment.sequence + "\n" + segment.url;
      }));
      queue = queue.filter(function keep(entry) {
        if (entry.playlistUrl !== playlistUrl || current.has(entry.sequence + "\n" + entry.url)) {
          return true;
        }
        abortEntry(entry, "playlist-window");
        return false;
      });
      inFlight.forEach(function evict(entry) {
        if (entry.playlistUrl === playlistUrl && !current.has(entry.sequence + "\n" + entry.url)) {
          abortEntry(entry, "playlist-window");
        }
      });
      cache.forEach(function evict(entry, key) {
        if (entry.playlistUrl === playlistUrl && !current.has(entry.sequence + "\n" + entry.url)) {
          cache.delete(key);
          cachedBytes -= entry.byteLength;
        }
      });
      Array.from(knownSegments.entries()).forEach(function evict(pair) {
        if (pair[1].playlistUrl === playlistUrl) {
          knownSegments.delete(pair[0]);
        }
      });
    }

    function rebuildKnownSegments() {
      knownSegments.clear();
      snapshots.forEach(function addSnapshot(snapshot, playlistUrl) {
        if (!trustedPlaylists.has(playlistUrl)) {
          return;
        }
        snapshot.playlist.segments.forEach(function remember(segment) {
          knownSegments.set(segment.url, { playlistUrl, segment, snapshot });
        });
      });
    }

    function clearPlaylistMediaState(playlistUrl) {
      evictOldSnapshot(playlistUrl, { segments: [] });
      snapshots.delete(playlistUrl);
      rebuildKnownSegments();
      pruneFailedUrls();
    }

    function recomputeTrustedPlaylists() {
      const previous = trustedPlaylists;
      const seeds = activeRoot && roots.has(activeRoot) ? [activeRoot] : Array.from(roots);
      const reachable = new Set(seeds);
      const pending = seeds.slice();
      while (pending.length) {
        const parent = pending.shift();
        const children = playlistReferences.get(parent);
        if (!children) {
          continue;
        }
        children.forEach(function visit(child) {
          const variants = playlistVariantReferences.get(parent);
          const auxiliaries = playlistMediaReferences.get(parent);
          const selected = activeVariants.get(parent);
          if (selected && variants && variants.has(child) &&
              !(auxiliaries && auxiliaries.has(child)) && child !== selected) {
            return;
          }
          if (!reachable.has(child)) {
            reachable.add(child);
            pending.push(child);
          }
        });
      }
      trustedPlaylists = reachable;

      previous.forEach(function removeRevision(url) {
        if (!reachable.has(url)) {
          playlistRevisions.delete(url);
        }
      });

      playlistReferences.forEach(function remove(_, url) {
        if (!reachable.has(url)) {
          playlistReferences.delete(url);
          playlistVariantReferences.delete(url);
          playlistMediaReferences.delete(url);
          activeVariants.delete(url);
          activeVariantOrders.delete(url);
        }
      });
      snapshots.forEach(function remove(_, url) {
        if (!reachable.has(url)) {
          snapshots.delete(url);
        }
      });
      queue = queue.filter(function keep(entry) {
        if (reachable.has(entry.playlistUrl)) {
          return true;
        }
        abortEntry(entry, "playlist-untrusted");
        return false;
      });
      inFlight.forEach(function abortUntrusted(entry) {
        if (entry.generation === generation && !reachable.has(entry.playlistUrl)) {
          abortEntry(entry, "playlist-untrusted");
        }
      });
      activePlaylistReads.forEach(function cancelUntrusted(observation) {
        if (observation.generation === generation && !reachable.has(observation.meta.url)) {
          cancelPlaylistRead(observation);
        }
      });
      cache.forEach(function remove(entry, key) {
        if (!reachable.has(entry.playlistUrl)) {
          cache.delete(key);
          cachedBytes -= entry.byteLength;
        }
      });
      rebuildKnownSegments();
      pruneFailedUrls();
    }

    function activateVariantRequest(url) {
      const orders = [];
      let changed = false;
      playlistVariantReferences.forEach(function inspect(variants, parent) {
        const auxiliaries = playlistMediaReferences.get(parent);
        if (!trustedPlaylists.has(parent) || !variants.has(url) ||
            (auxiliaries && auxiliaries.has(url))) {
          return;
        }
        if (activeVariants.get(parent) !== url) {
          activeVariants.set(parent, url);
          changed = true;
        }
        const order = ++variantRequestCounter;
        activeVariantOrders.set(parent, order);
        orders.push({ parent, url, order });
      });
      if (changed) {
        recomputeTrustedPlaylists();
      }
      return orders;
    }

    function activateRoot(url) {
      if (!roots.has(url) || activeRoot === url) {
        return;
      }
      activeRoot = url;
      recomputeTrustedPlaylists();
    }

    function clearForProtocolSwitch(reason) {
      clearRuntimeState(reason);
      activeRoot = null;
      trustedPlaylists = new Set(roots);
    }

    function beginPlaylistObservation(meta, response) {
      if (!roots.has(meta.url) && !trustedPlaylists.has(meta.url)) {
        return;
      }
      if (roots.has(meta.url)) {
        activateRoot(meta.url);
      }
      const observation = {
        meta,
        generation,
        revision: ++playlistRevisionCounter,
        reader: null,
        accountedBytes: 0,
        cancelRequested: false,
        cancelPromise: null
      };
      playlistRevisions.set(meta.url, observation.revision);
      activePlaylistReads.forEach(function cancelOlder(active) {
        if (active.meta.url === meta.url && active.revision < observation.revision) {
          cancelPlaylistRead(active);
        }
      });
      if (!response || response.status !== 200 || response.ok !== true || typeof response.clone !== "function") {
        return;
      }
      let clone;
      try {
        clone = response.clone();
      } catch (_) {
        return;
      }
      const body = clone && clone.body;
      if (!body || typeof body.getReader !== "function") {
        discardPlaylistClone(clone);
        return;
      }
      try {
        observation.reader = body.getReader();
      } catch (_) {
        discardPlaylistClone(clone);
        return;
      }
      if (!observation.reader || typeof observation.reader.read !== "function" ||
          typeof observation.reader.cancel !== "function") {
        try { observation.reader && observation.reader.releaseLock(); } catch (_) { /* unusable reader */ }
        return;
      }
      startPlaylistRead(observation);
    }

    function startPlaylistRead(observation) {
      const meta = observation.meta;
      if (observation.generation !== generation ||
          observation.revision !== playlistRevisions.get(meta.url) ||
          (!roots.has(meta.url) && !trustedPlaylists.has(meta.url))) {
        cancelPlaylistRead(observation);
        return;
      }
      activePlaylistReads.add(observation);
      void (async function readPlaylist() {
        let text = "";
        try {
          const decoder = new TextDecoderImpl("utf-8");
          const byteLimit = policy.livePrefetchCacheMiB * 1024 * 1024;
          while (true) {
            const part = await observation.reader.read();
            if (part.done) {
              text += decoder.decode();
              break;
            }
            const chunk = part.value instanceof Uint8Array ? part.value : new Uint8Array(part.value);
            observation.accountedBytes += chunk.byteLength;
            activePlaylistBytes += chunk.byteLength;
            if (cachedBytes + reservedBytes() > byteLimit) {
              await cancelPlaylistRead(observation);
              throw Object.assign(new Error("byte limit"), { code: "BYTE_LIMIT" });
            }
            text += decoder.decode(chunk, { stream: true });
          }
          const normalized = String(text).replace(/^\uFEFF/, "");
          if (!/^#EXTM3U(?:\r?\n|$)/.test(normalized)) {
            return;
          }
          const parsed = LiveCore.parsePlaylist(meta.url, normalized);
          if (observation.generation !== generation ||
              observation.revision !== playlistRevisions.get(meta.url) ||
              !enabled || disposed || (!roots.has(meta.url) && !trustedPlaylists.has(meta.url))) {
            return;
          }
          const variants = new Set();
          parsed.variants.forEach(function trustVariant(url) {
            if (isHlsUrl(url)) {
              variants.add(url);
            }
          });
          const auxiliaries = new Set();
          parsed.media.forEach(function trustAuxiliary(url) {
            if (isHlsUrl(url)) {
              auxiliaries.add(url);
            }
          });
          const selected = activeVariants.get(meta.url);
          if (selected && !variants.has(selected)) {
            activeVariants.delete(meta.url);
            activeVariantOrders.delete(meta.url);
          }
          const children = new Set(variants);
          auxiliaries.forEach(function addAuxiliary(url) { children.add(url); });
          playlistReferences.set(meta.url, children);
          playlistVariantReferences.set(meta.url, variants);
          playlistMediaReferences.set(meta.url, auxiliaries);
          recomputeTrustedPlaylists();
          if (parsed.type !== "media") {
            clearPlaylistMediaState(meta.url);
            return;
          }
          evictOldSnapshot(meta.url, parsed);
          const snapshot = { url: meta.url, playlist: parsed };
          snapshots.set(meta.url, snapshot);
          rebuildKnownSegments();
          pruneFailedUrls();
        } catch (_) {
          // Playlist observation never affects the player's response path.
        } finally {
          if (observation.cancelPromise) {
            await observation.cancelPromise;
          }
          try { observation.reader.releaseLock(); } catch (_) { /* not all readers expose it */ }
          activePlaylistReads.delete(observation);
          activePlaylistBytes = Math.max(0, activePlaylistBytes - observation.accountedBytes);
          observation.accountedBytes = 0;
          pump();
        }
      })();
    }

    function cancelPlaylistRead(observation) {
      if (!observation || !observation.reader) {
        return null;
      }
      if (observation.cancelRequested) {
        return observation.cancelPromise;
      }
      observation.cancelRequested = true;
      try {
        observation.cancelPromise = Promise.resolve(observation.reader.cancel()).catch(function ignoreCancelFailure() {});
      } catch (_) {
        observation.cancelPromise = Promise.resolve();
      }
      return observation.cancelPromise;
    }

    function discardPlaylistClone(clone) {
      try {
        const body = clone && clone.body;
        if (body && typeof body.cancel === "function") {
          const cancelled = body.cancel();
          if (cancelled && typeof cancelled.catch === "function") {
            cancelled.catch(function ignoreCancelFailure() {});
          }
        }
      } catch (_) {
        // Releasing an unreadable clone is best effort only.
      }
    }

    function configure(next) {
      if (disposed) {
        return false;
      }
      const value = next || {};
      const nextPolicy = LiveCore.normalizePolicy(value.policy || {});
      const nextPlan = Array.isArray(value.plan) ? value.plan : [];
      const nextRoots = nextPlan.map(function planUrl(item) {
        return typeof item === "string" ? item : item && item.url;
      }).filter(isHlsUrl).map(function normalize(url) { return new URL(url).toString(); });
      const nextKey = JSON.stringify({ policy: nextPolicy, plan: nextPlan });
      const changed = nextKey !== configurationKey;
      if (changed) {
        clearRuntimeState("configure");
        configurationKey = nextKey;
        activeRoot = null;
      }
      policy = nextPolicy;
      roots = new Set(nextRoots);
      if (changed || !enabled) {
        activeRoot = null;
        trustedPlaylists = new Set(nextRoots);
      }
      enabled = Boolean(nextPolicy.active && nextPolicy.livePrefetchEnabled && roots.size &&
        typeof nativeFetch === "function" && typeof createController === "function" &&
        typeof createResponse === "function" && typeof ReadableStreamImpl === "function" &&
        typeof TextDecoderImpl === "function");
      if (!enabled) {
        clearRuntimeState("disabled");
      }
      return enabled;
    }

    function scheduleAfterCursor(meta, known) {
      const snapshot = snapshots.get(known.playlistUrl);
      if (!snapshot || snapshot !== known.snapshot) {
        return;
      }
      const buffered = bufferedSeconds(meta);
      if (buffered === null) {
        return;
      }
      const reservedUrls = ownedUrls();
      let cursor = known.segment;
      if (hasOwn.call(meta, "bufferedSeconds") && isBilibiliLiveFmp4Url(known.segment.url)) {
        const segments = snapshot.playlist.segments;
        let index = segments.findIndex(function current(segment) {
          return segment.sequence === cursor.sequence && segment.url === cursor.url;
        });
        const futureCount = index >= 0 ? segments.length - index - 1 : 0;
        if (futureCount < 2) {
          return;
        }
        const leadCount = Math.min(2, futureCount - 1);
        for (let lead = 0; lead < leadCount; lead += 1) {
          const next = index >= 0 ? segments[index + 1] : null;
          if (!next || next.discontinuityBefore || next.mapUrl !== cursor.mapUrl) {
            break;
          }
          cursor = next;
          index += 1;
        }
      }
      const planned = LiveCore.planPrefetch(snapshot.playlist, cursor, buffered, {
        reservedUrls,
        reservedDuration: ownedDuration(),
        cachedBytes,
        inFlightBytes: reservedBytes()
      }, policy);
      planned.forEach(function schedule(segment) { enqueue(snapshot, segment, meta); });
      pump();
    }

    function releaseDelivery(delivery) {
      if (!delivery || delivery.released) {
        return;
      }
      delivery.released = true;
      delivered.delete(delivery);
      deliveredBytes = Math.max(0, deliveredBytes - delivery.remainingBytes);
      delivery.remainingBytes = 0;
      delivery.chunks.length = 0;
      if (delivery.onRelease) {
        try { delivery.onRelease(); } catch (_) { /* playback consumption cannot affect the player */ }
      }
      pump();
    }

    function responseBody(delivery) {
      if (typeof ReadableStreamImpl !== "function") {
        throw new Error("ReadableStream is unavailable");
      }
      return new ReadableStreamImpl({
        pull(controller) {
          if (delivery.pendingBytes) {
            delivery.remainingBytes = Math.max(0, delivery.remainingBytes - delivery.pendingBytes);
            deliveredBytes = Math.max(0, deliveredBytes - delivery.pendingBytes);
            delivery.pendingBytes = 0;
          }
          if (delivery.index >= delivery.chunks.length) {
            controller.close();
            releaseDelivery(delivery);
            return;
          }
          const chunk = delivery.chunks[delivery.index];
          delivery.chunks[delivery.index] = null;
          delivery.index += 1;
          delivery.pendingBytes = chunk.byteLength;
          controller.enqueue(chunk);
        },
        cancel() {
          releaseDelivery(delivery);
        }
      }, { highWaterMark: 0 });
    }

    function beforeFetch(rawMeta) {
      const meta = normalizeMeta(rawMeta);
      if (!meta || !isFetchMeta(meta)) {
        return null;
      }
      bindRequest(rawMeta, meta);
      if (!enabled || disposed) {
        return null;
      }
      if (meta.kind === "flv") {
        clearForProtocolSwitch("flv");
        return null;
      }
      if (!isSafeGet(meta) || meta.kind !== "segment") {
        return null;
      }
      inFlight.forEach(function collide(entry) {
        if (entry.url === meta.url) {
          abortEntry(entry, "player-collision");
        }
      });
      queue = queue.filter(function cancelQueued(entry) {
        if (entry.url !== meta.url) {
          return true;
        }
        abortEntry(entry, "player-collision");
        return false;
      });
      const entry = cache.get(meta.fingerprint);
      if (!entry || entry.url !== meta.url) {
        return null;
      }
      cache.delete(meta.fingerprint);
      cachedBytes -= entry.byteLength;
      metric(entry, "hit", entry.byteLength);
      const known = knownSegments.get(meta.url);
      const delivery = {
        url: entry.url,
        duration: entry.duration,
        chunks: entry.chunks,
        byteLength: entry.byteLength,
        remainingBytes: entry.byteLength,
        pendingBytes: 0,
        index: 0,
        released: false,
        onRelease: known ? function replenishAfterConsumption() {
          if (enabled && !disposed) {
            scheduleAfterCursor(meta, known);
          }
        } : null
      };
      delivered.add(delivery);
      deliveredBytes += delivery.byteLength;
      try {
        const response = createResponse(responseBody(delivery), entry.init);
        if (known) {
          void scheduleAfterCursor(meta, known);
        }
        return response;
      } catch (_) {
        releaseDelivery(delivery);
        return null;
      }
    }

    function observeResponse(rawMeta, response) {
      const meta = normalizeMeta(rawMeta);
      const binding = responseBinding(rawMeta);
      if (!enabled || disposed || !meta || !isFetchMeta(meta) || meta.kind === "flv" ||
          !bindingIsCurrent(binding)) {
        return response;
      }
      if (meta.kind === "playlist") {
        beginPlaylistObservation(meta, response);
        return response;
      }
      if (meta.kind !== "segment" || !isSafeGet(meta)) {
        return response;
      }
      const known = knownSegments.get(meta.url);
      if (!known || !response || response.status !== 200 || response.ok !== true) {
        return response;
      }
      try { scheduleAfterCursor(meta, known); } catch (_) { /* playback must continue */ }
      return response;
    }

    function reset(reason) {
      clearRuntimeState(reason || "reset");
      enabled = false;
      activeRoot = null;
    }

    function dispose() {
      if (disposed) {
        return;
      }
      clearRuntimeState("dispose");
      disposed = true;
      enabled = false;
      roots.clear();
    }

    return { configure, beforeFetch, observeResponse, reset, dispose };
  }

  return { createLivePrefetchRuntime };
});
