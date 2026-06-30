# Bilibili Accelerator v2 — Design Doc (Full Upgrade)

> Status: Proposal · Target: v0.2.0 → v1.0.0 · Author: design pass, 2026-06-30
> Supersedes the implicit design captured in [`investigation.md`](investigation.md).

This document does two things:

1. **Deep-dives the current system** (v0.1.3) — what it does, how, and where it breaks.
2. **Proposes a next-generation architecture** grounded in how Bilibili's CDN
   actually behaves in late-2025 / 2026, with a phased upgrade path.

---

## 1. Current system (v0.1.3) — how it works today

### 1.1 Shape of the codebase

```
src/core/rewrite.js      Pure, environment-free rewrite engine (the brain)
src/page/…page.js        Page-context installer: hooks + floating UI + persistence
src/extension/content.js MV3 content script that injects the page script
src/extension/manifest.json
scripts/build.mjs         Bundles → dist/*.user.js and dist/extension/
test/*.test.js            node:test unit + smoke tests
```

The build concatenates `core + page` into a single userscript, and `core + page`
+ a loader `content.js` into an MV3 unpacked extension. One source of truth,
two delivery channels (Greasy Fork userscript, unpacked WebExtension).

### 1.2 The rewrite engine (`core/rewrite.js`)

A pure function `rewriteUrlDetail(value, config)` classifies a single URL and
returns `{changed, url, reason, targetHost}`. `rewriteObject` walks an arbitrary
JSON payload (depth-limited, cycle-safe via `WeakSet`) and rewrites every media
URL string in place. Classification logic:

| Host family | Detection | Default action |
| --- | --- | --- |
| `*.szbdyd.com` (scheduler) | hostname suffix | rewrite to the `xy_usource` query param's host |
| `*.mcdn.bilivideo.*` | suffix | **proxy** through `proxy-tf-all-ws.bilivideo.com/?url=…` |
| Bare IP / `xyAxBxCxDxy.mcdn…` | regex | replace host → `upos-sz-mirrorcos.bilivideo.com` |
| Overseas mirrors `mirror{ali,cos,hw}ov` | substring | replace host → target |
| `*.akamaized.net` | suffix | replace **only if** `rewriteAkamai` is on |
| Healthy UPOS | — | left alone (unless `mode:"force"`) |

A media URL is anything matching `\.(m4s|mp4|flv|m3u8)` or under `/upgcxcode/`
or `/v1/resource/`. The signature lives in the path/query, not bound to host,
so host-swapping keeps signed URLs valid — this is the load-bearing assumption.

### 1.3 The page installer (`page/…page.js`)

Runs at `document_start` and hooks four ingress points where playback URLs
appear before the player buffers:

1. `JSON.parse` — wrapped; rewrites any parsed object whose source text
   contains `bilivideo`.
2. `window.fetch` — clones JSON/text responses to `/x/player`, `/pgc/player`,
   `playurl`, or `bilivideo` URLs and rebuilds a rewritten `Response`.
3. `window.__playinfo__` and `window.__INITIAL_STATE__` — replaced with
   accessor properties that rewrite on assignment.

Plus a Shadow-DOM floating ⚡ control: live rewrite counter, last-rewrite
status, enable toggle, mode (bad-only / force), target-host picker, MCDN
strategy, Akamai toggle. Config persists in `localStorage`. The badge
auto-hides in web/full-screen and lifts above the control bar in wide modes.

### 1.4 What v0.1.3 does well

- **Pre-buffer interception** is the right altitude — fix the URL before the
  player ever touches it, no stall/restart needed.
- **Pure core + thin shells** is clean and testable.
- **Host-swap preserves signatures** — cheap and correct.
- **Conservative default** (`bad-only`) avoids breaking healthy playback.

---

## 2. Why a v2 — gaps & external reality

### 2.1 Coverage gaps in interception

- **No `XMLHttpRequest` hook.** Only `fetch` + `JSON.parse` + two globals are
  covered. Bilibili code paths (and some quality-switch / segment-refresh flows)
  still use XHR; those payloads slip through untouched.
- **No `Response.json()` / `Request` body coverage** beyond the text clone path,
  and the `content-type` gate (`json`/`text` only) can skip mislabeled responses.
- **Service Worker / MSE blob paths** aren't considered. If the player resolves
  segments through a SW, page-context hooks don't see them.

### 2.2 The CDN landscape moved (research, 2025–2026)

- **New PCDN family `*.edge.mountaintoys.cn`** appeared on popular videos
  (Dec 2025, [Bilibili-Evolved #5438]). It is Bilibili-owned
  (registrant email `email@bilibili.com`), serves from **residential IPs on
  non-standard ports** with `os=mcdn` in the query. **v0.1.3 does not detect it**
  — it's not an IP literal, not `*.mcdn.bilivideo.*`, not `*.szbdyd.com`.
- **The robust heuristic the community converged on:** *any playback URL with a
  non-default port (not 80/443) is PCDN* — "PCDN 肯定是不能用默认端口的". v2 should
  adopt this as a primary signal, plus `os=mcdn` query detection.
- **Bilibili is moving off Akamai**, shifting overseas traffic onto
  cheaper/self-built CDN and P2P; overseas users report drops to tens of KB/s.
  Best-performing host varies by week and region (e.g. as of late 2025
  `mirrorcosov` tested well from US/UK/AU; `mirroralib` went unstable). A *single
  hard-coded target host is a fragile bet.*
- **WebRTC P2P upload**: Bilibili harvests viewer upload bandwidth for its P2P
  mesh ([Bilibili-Evolved #5404], SukkaW's MBGTEB). This both wastes the user's
  uplink and feeds the slow PCDN system we're fighting. v0.1.3 ignores it.

### 2.3 No feedback loop / it's "fire and forget"

- The target host is chosen **blindly**. If the rewrite target is *also* slow for
  this user/network, there's no measurement, no fallback, and no learning.
- Changing settings requires a **manual page reload**. There's no live re-arm.
- "Rewrites: N" counts substitutions, not **whether playback actually improved**
  (no buffering/stall telemetry). Users can't tell if it helped.

### 2.4 Product/distribution gaps

- Extension has **no popup/options UI**; config lives only in the in-page panel
  and only in `localStorage` (not synced, per-profile).
- No **bilibili.tv** payload-shape handling beyond the URL match.
- No structured **diagnostics export** for bug reports.

---

## 3. v2 design goals

1. **Catch every playback URL**, regardless of transport (fetch / XHR / globals /
   SW) — single choke point.
2. **Classify by behavior, not just a static host list** — port heuristic +
   `os=mcdn` + IP + scheduler unwrap + known-bad suffixes, future-proof against
   renamed hosts like `mountaintoys`.
3. **Pick the target intelligently** — measure candidate hosts, rank them,
   remember the winner per region; fall back automatically when a target stalls.
4. **Close the loop** — detect stalls, auto-retry the next candidate live (no
   manual reload), and report real improvement.
5. **Optionally stop the bleeding** — neutralize WebRTC P2P upload + PCDN at the
   source (opt-in, like MBGTEB).
6. **Keep the pure-core / thin-shell architecture** and stay Safari-friendly.

Non-goals (unchanged from v1): router/MITM for native apps, Apple TV, defeating
cert pinning. See [`router-proxy.md`](router-proxy.md).

---

## 4. v2 architecture

```
┌─────────────────────────────────────────────────────────────┐
│ core/                         (pure, no DOM, fully unit-tested)│
│  ├─ classify.js   host → {kind, isPcdn, isSlow, port, osMcdn} │
│  ├─ rewrite.js    classify + policy → rewritten URL + reason  │
│  ├─ policy.js     mode/strategy/candidate-ranking rules       │
│  └─ probe.js      pure scoring from latency/throughput samples │
├─────────────────────────────────────────────────────────────┤
│ runtime/                      (browser glue, page context)    │
│  ├─ intercept.js  fetch + XHR + JSON.parse + globals + SW     │
│  ├─ health.js     HEAD/range probes, stall detection (MSE)    │
│  ├─ store.js      config + learned host ranking (persisted)   │
│  └─ p2p-guard.js  optional WebRTC/PCDN neutralizer            │
├─────────────────────────────────────────────────────────────┤
│ ui/               Shadow-DOM panel (now shows health + log)   │
├─────────────────────────────────────────────────────────────┤
│ ext/              MV3 content script + popup/options + sync   │
└─────────────────────────────────────────────────────────────┘
```

### 4.1 Universal interception (`runtime/intercept.js`)

Add the missing transports so nothing escapes:

- **`XMLHttpRequest`**: wrap `open`/`send`; on `load`, if the response URL or body
  contains `bilivideo`/`playurl`, rewrite the parsed body and re-expose it via a
  `responseText`/`response` getter override on that instance.
- **`fetch`**: keep, but broaden the content-type gate (sniff body when the header
  is missing/ambiguous) and also handle the `Request` input object form.
- **Globals & `JSON.parse`**: keep.
- **Service Worker**: if a SW is registered on the player path, post the active
  policy to it (or, simplest, register a same-origin SW shim only when needed).
  *Phase 3 — most players still resolve DASH URLs in page context, so this is a
  guard, not a day-one requirement.*

All paths funnel through **one** `applyPolicy(payload, source)` so logging,
ranking, and stall-handling are centralized.

### 4.2 Behavioral classification (`core/classify.js`)

Replace scattered substring checks with one classifier returning a verdict:

```js
classify(url) → {
  host, port,
  kind: "upos" | "mcdn" | "pcdn" | "scheduler" | "akamai" | "unknown",
  isPcdn:  port is non-default OR query os=mcdn OR bare-IP OR xy…mcdn pattern,
  isSlow:  isPcdn OR overseas-mirror(*ov) OR (akamai && rewriteAkamai),
  schedulerSource: szbdyd xy_usource host if present,
}
```

Key additions over v1:

- **Port heuristic**: `port && port∉{80,443,""}` ⇒ PCDN. Catches `mountaintoys`
  and any future renamed PCDN host generically.
- **`os=mcdn` query flag** ⇒ MCDN/PCDN regardless of host.
- Keep the `szbdyd` scheduler unwrap and the IP/`xy…mcdn` regexes.

This makes detection **host-name-agnostic** — the thing that broke v1 when
Bilibili shipped `mountaintoys.cn`.

### 4.3 Smart target selection (`core/probe.js` + `runtime/health.js`)

Instead of one static `pcdnHost`:

1. Maintain a **candidate pool** of healthy UPOS hosts (the current
   `CDN_HOSTS` list becomes the seed).
2. On first use per session (and lazily refreshed), **probe** each candidate
   with a tiny ranged GET of a real signed segment (or a cheap HEAD): record TTFB
   + throughput. `probe.js` scores them purely from samples (no DOM).
3. Rewrite to the **top-ranked** candidate; persist the ranking per coarse region
   (timezone / Accept-Language as a cheap region proxy) in `store.js`.
4. **Adaptive fallback chain**: rewrite produces an ordered list; the player gets
   `baseUrl = best`, `backupUrl = [next, next, …]`. Bilibili's own DASH backup
   mechanism then fails over for free if `best` stalls.

This turns "guess a host" into "measure, rank, remember, and provide backups."

### 4.4 Closing the loop — stall detection (`runtime/health.js`)

- Attach to the `<video>` element: watch `waiting`/`stalled`/`progress` and
  `buffered` growth vs. `currentTime`.
- If buffering exceeds a threshold (e.g. >2s with no `buffered` growth), **live
  re-point** the active DASH URL to the next candidate and nudge the player
  (re-seek by a few ms / swap the MSE source URL) — **no full page reload**.
- Feed real outcomes back into the ranking: a host that stalled gets demoted.

This is the single biggest UX win: settings changes and bad-host recovery stop
requiring the user to reload.

### 4.5 Optional P2P / bandwidth guard (`runtime/p2p-guard.js`)

Opt-in toggle (default off to stay conservative), mirroring SukkaW's MBGTEB:

- Neutralize `RTCPeerConnection`/`webkitRTCPeerConnection` (and
  `RTCDataChannel`) used for the P2P upload mesh, via non-configurable
  `Object.defineProperty` stubs.
- Drop/short-circuit PCDN requests at the `fetch`/XHR layer so the player never
  tries the residential-IP nodes.
- Surface "uplink saved / PCDN requests blocked" counters in the panel.

Framed honestly in UI: this stops Bilibili from using *your* bandwidth for its
P2P CDN — distinct from playback acceleration but complementary.

### 4.6 UI & distribution upgrades

- **Panel**: add a live health table (candidate host → last TTFB → rank), a
  "re-probe now" button, a stall/recovery counter, and a one-click **diagnostics
  export** (recent rewrites + probe results, host-anonymized) for issue reports.
- **MV3 popup + options page** sharing the same config schema; use
  `chrome.storage.sync` so settings follow the profile, with `localStorage` as
  the userscript fallback.
- **Live re-arm**: applying settings updates the active policy in place — kill the
  "change settings, then reload" note where possible.
- **`bilibili.tv`**: verify payload shape and add a regression test.

---

## 5. Config schema (v2)

```jsonc
{
  "enabled": true,
  "mode": "bad-only",            // bad-only | force | off
  "selection": "auto",           // auto (probe+rank) | fixed
  "pcdnHost": "upos-sz-mirrorcos.bilivideo.com",  // used when selection=fixed
  "candidatePool": [ /* seeded from CDN_HOSTS, editable */ ],
  "mcdnStrategy": "proxy-all",   // proxy-all | proxy-v1 | replace
  "proxyHost": "proxy-tf-all-ws.bilivideo.com",
  "rewriteAkamai": false,
  "portHeuristic": true,         // NEW: non-default port ⇒ PCDN
  "stallRecovery": true,         // NEW: live failover on buffering
  "p2pGuard": false,             // NEW: opt-in WebRTC/PCDN neutralizer
  "maxDepth": 20,
  "schemaVersion": 2
}
```

Migration: `normalizeConfig` reads `schemaVersion`; v1 (`config.v1`) configs map
forward (old `pcdnHost`/`mode`/`mcdnStrategy` preserved, new fields defaulted).

---

## 6. Phased delivery

| Phase | Scope | Risk | Payoff |
| --- | --- | --- | --- |
| **2.0** | XHR hook; port + `os=mcdn` heuristics; classifier refactor; config v2 + migration | Low | Closes the biggest coverage holes (incl. `mountaintoys`) |
| **2.1** | Candidate probing + ranking; backupUrl fan-out; per-region memory | Med | Stops betting on one static host |
| **2.2** | Stall detection + live failover (no reload); health UI | Med-High | The headline UX win |
| **2.3** | Opt-in P2P/WebRTC guard; diagnostics export; MV3 popup + sync | Low-Med | Bandwidth savings + supportability |
| **2.4** | SW/MSE guard; bilibili.tv parity; perf hardening | Med | Long-tail coverage |

Each phase ships independently behind the existing build; the pure core keeps
100% unit coverage and gains tests for the port heuristic, ranking, and
migration.

---

## 7. Risks & open questions

- **Probing cost/correctness**: ranged GETs of signed segments must not trip
  anti-abuse or waste quota; cache results and probe sparingly.
- **Live MSE re-pointing** is player-internal and brittle across Bilibili player
  versions; relying on DASH `backupUrl` fan-out (4.3) is the safer primary
  mechanism, with active re-point as enhancement.
- **`os=mcdn` false positives**: confirm legitimate fast hosts never carry it
  before treating it as authoritative.
- **P2P guard** could in theory affect live-stream paths — keep it opt-in and
  scope it to playback, not the whole site.
- **Cert pinning / native apps** remain out of scope (unchanged).

---

## 7.5 Product mindset — what these changes mean for a real user

The engine work in §4 is invisible plumbing. Most users don't know what a "CDN",
"MCDN", "Akamai", or a "host" is — and they shouldn't have to. v2's product job is
to translate every capability into something a non-technical viewer feels, and to
hide the vocabulary behind plain outcomes.

### 7.5.1 Capability → user experience (before / after)

| v2 capability (§) | Today (v0.1.3) the user feels… | After v2 the user feels… |
| --- | --- | --- |
| **XHR + universal interception** (4.1) | "I installed it, but *some* videos still stutter — especially when I switch to 4K mid-video or watch bangumi." | Every video is covered; the stutter on those edge cases just goes away. No setting touched. |
| **Behavioral classifier / port heuristic** (4.2) | "It worked great, then last week a hot new video started freezing again." (Bilibili shipped `mountaintoys.cn`.) | It keeps working through Bilibili's new tricks. The user never notices Bilibili changed anything. |
| **Smart server selection** (4.3) | Everyone is force-pointed at the *same* server, which may be slow for *this* person's location. A viewer in Berlin gets the same target as one in California. | "It picked the fastest server for *me*." Berlin and California each land on their own best server, automatically. |
| **Stall detection + live failover** (4.4) | "It froze. I opened the panel, switched a dropdown I didn't understand, and reloaded the page — lost my spot." | The video dips for half a second and recovers itself, like Netflix dropping quality. No reload, no lost place, no panel. |
| **P2P / bandwidth guard** (4.5) | "When I watch Bilibili, video calls for everyone else in my house get choppy." (Bilibili is uploading via their connection.) | "My internet stopped getting hogged when I watch Bilibili." A clear, separate benefit. |
| **Diagnostics export** (4.6) | Bug reports are "it's slow," with nothing actionable. | One "Copy report" button gives maintainers real data — faster fixes for everyone. |

### 7.5.2 The language rewrite (jargon → plain outcomes)

Same features, human words. This is a relabel, not a feature cut.

| Internal / current label | What the user sees in v2 |
| --- | --- |
| "Rewrite slow playback hosts / CDN" | "Make videos load faster" |
| `mode: bad-only` vs `force` | A single button that only appears when needed: **"Still buffering? Boost harder"** |
| "Target host" + `upos-sz-mirrorcos.bilivideo.com` | (hidden) "Preferred server" under Advanced |
| "MCDN strategy: proxy-all / proxy-v1 / replace" | (hidden under Advanced — `auto` by default) |
| "Rewrite Akamai" toggle | (hidden under Advanced) |
| "Rewrites: 42 / Last rewrite: mcdn-proxy → proxy-tf-all-ws" | A status line: **"Playing smoothly · connected to the fastest server near you"** |
| `enabled` checkbox | **"Acceleration: On"** |

### 7.5.3 Redesigned panel — progressive disclosure

Three tiers so the 95% never meet a knob, and power users lose nothing:

1. **Hero status (everyone).** A colored dot + one phrase: green **"Playing
   smoothly"**, amber **"Finding a faster server…"**, gray **"Off"**. This replaces
   the meaningless "Rewrites: N" counter as the primary signal — it answers the
   only question a user actually has: *is it working right now?*
2. **One master switch + one contextual fix.** "Acceleration: On/Off", plus a
   **"Still buffering? Boost harder"** button that only surfaces when a stall is
   detected (this is `mode:force` in disguise, offered exactly when it's relevant).
3. **"Advanced settings ▸" (collapsed).** Everything from §5 lives here for power
   users: fixed preferred server, MCDN strategy, Akamai, candidate pool, port
   heuristic, P2P guard, diagnostics export.

Copy follows the house voice: sentence case, no jargon, outcome-first, no "!".
First-run shows a one-time hint — *"⚡ means it's working. You can leave it on."* —
then gets out of the way.

### 7.5.4 Product principles for v2

- **Invisible by default.** Success = the user forgets the extension exists.
- **Self-healing over self-service.** Recover automatically (4.4) instead of asking
  the user to fix it with controls they don't understand.
- **One decision, surfaced in context.** The only choice we ask of a normal user —
  "boost harder?" — appears only when buffering, not as a permanent dropdown.
- **Honesty about the bandwidth guard.** Frame P2P blocking as "stops Bilibili from
  using your upload," not as acceleration — it's a different promise.
- **Nothing removed, only relocated.** Every existing knob still exists under
  Advanced; we change the *default surface*, not the capability.

## 8. References (research)

- New PCDN `*.edge.mountaintoys.cn`, port-as-PCDN heuristic — Bilibili-Evolved Discussion #5438 (2025-12).
- Disable B站 live P2P/WebRTC upload — Bilibili-Evolved Discussion #5404.
- PCDN/WebRTC-bandwidth neutralizing techniques — SukkaW/Make-Bilibili-Great-Than-Ever-Before.
- PCDN domain blocking guidance — SukkaW/Make-Bilibili-Great-Than-Ever-Before #26; linux.do/t/topic/642419.
- CDN switching practice & host lists — Greasy Fork "Bilibili Video CDN Switcher" (500213), "Custom CDN of Bilibili (CCB)" (527498).
- MCDN read-timeout / replacement evidence — yt-dlp #12421; Cats-Team/AdRules #217.
- playurl API (qn/fnval/DASH backup_url) — socialsisteryi bilibili-API-collect; yt-dlp bilibili extractor.
- Host-choice split (PCDN/MCDN/Akamai/UPOS, `proxy-tf-all-ws`) — BiliUniverse / BiliRedirect Surge module.
