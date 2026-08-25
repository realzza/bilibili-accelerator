# Investigation

## What appears to be happening

Bilibili playback pages receive signed media URLs from several families of hosts:

- normal UPOS mirror hosts, such as `upos-sz-mirrorcos.bilivideo.com`;
- overseas or regional mirror hosts, such as `upos-hz-mirrorakam.akamaized.net` and `upos-sz-mirroraliov.bilivideo.com`;
- MCDN/PCDN style hosts, such as `xy153x35x231x78xy.mcdn.bilivideo.cn:8082`.

Cold or low-popularity videos are more likely to miss nearby CDN cache. When Bilibili returns a weak MCDN/PCDN endpoint or a CDN host that routes poorly from the viewer's ISP, Safari has no useful fallback: it keeps reading the selected DASH audio/video URLs and the player buffers.

## Sources checked

- Greasy Fork's "Bilibili Video CDN Switcher" documents existing practice of switching Bilibili video CDN hosts and lists common UPOS mirrors: https://greasyfork.org/en/scripts/500213-bilibili-video-cdn-switcher
- `bilibili-helper-o` issue #713 discusses locking/replacing UPOS hosts and points at Bilibili's own video diagnostics page: https://github.com/bilibili-helper/bilibili-helper-o/issues/713
- `yt-dlp` issue #12421 shows Bilibili returning many `mcdn.bilivideo.cn` playback URLs for a video and asks for host replacement because the returned MCDN links are problematic: https://github.com/yt-dlp/yt-dlp/issues/12421
- `Cats-Team/AdRules` issue #217 shows repeated read timeouts against `mcdn.bilivideo.cn:8082`: https://github.com/Cats-Team/AdRules/issues/217
- BiliUniverse redirect module documents the practical split between PCDN, MCDN, Akamai, and UPOS host choices, including `proxy-tf-all-ws.bilivideo.com` for MCDN: https://raw.githubusercontent.com/QingRex/LoonKissSurge/refs/heads/main/Surge/Official/%F0%9F%8D%9F%20BiliRedirect.official.sgmodule

## Implemented strategy

This repo ships a page-level script that runs before the Bilibili player initializes. It intercepts play URL payloads from `fetch`, `JSON.parse`, `window.__playinfo__`, and `window.__INITIAL_STATE__`, then rewrites only media URL strings.

Default behavior:

- proxy all `*.mcdn.bilivideo.*` media URLs through `https://proxy-tf-all-ws.bilivideo.com/?url=...`;
- replace obvious PCDN/IP/slow overseas mirror URLs with `upos-sz-mirrorcos.bilivideo.com`;
- leave healthy CDN URLs alone unless the user enables force mode;
- expose a small `BA` panel on Bilibili pages to change target host, MCDN strategy, Akamai rewriting, and force mode.


## Live rooms

Live playback runs on a separate CDN tier (`/live-bvc/` FLV and HLS) with URLs signed per host, so the VOD levers do not apply: swapping the host of a live URL, or wrapping it in the MCDN proxy, produces a 403 rather than a faster stream. `rewriteUrlDetail` refuses live URLs for that reason, and `alternativesFor` refuses to fan them out.

That left the accelerator with nothing to do on a live page — but the machinery around it did not know that, and each piece failed in its own way:

- **The probe measured nothing, permanently.** Live play info reaches the page in two shapes. `getRoomPlayInfo` splits it into `url_info: [{host, extra}]` beside a path-only `base_url`; the legacy `/room/v1/Room/playUrl` returns `durl: [{url}]` with complete signed live URLs. A URL from the second shape looks exactly like a media URL to `findMediaUrl`, so it became the probe's sample — and `probeHost` re-requested that `/live-bvc/` path on all eight UPOS mirrors, which serve VOD only. Every candidate failed, the ranking came back empty, and nothing reset `probed`: the panel sat on "Finding the fastest server…" with zero fixed connections for the life of the page. This is the reported symptom, and it reproduces from that payload alone.
- **A failed round latched on VOD pages too.** Any round where every candidate fails — offline, an origin the mirrors will not answer with CORS headers — left the same dead state, with no ranking auto-selection could ever learn.
- **The legacy `durl` shape got no filtering at all.** `filterLiveUrlInfo` only walked `url_info`, so a viewer served that shape kept whatever residential PCDN node Bilibili picked. Dropping the slow entries from the list the player chooses from is the only lever live has.
- **Stall recovery pretended.** A live stall rotated the VOD target, counted a recovery, and told the viewer servers were being switched, while the live player saw nothing change.
- **The status never moved.** Live acceleration produces no VOD rewrite for `record()` to notice and no probe to finish, so the panel reported "Ready" through an entire stream.

The fix keeps live on its own rails: live URLs are never used as probe samples, live payloads are filtered in both shapes, live stalls are reported rather than "recovered", and probe rounds that measure nothing are retried instead of latched.

Still open: the panel's speed meter reads 0.0 Mbps on live pages. Live segments arrive over `fetch` with a streaming body, which the interceptor deliberately never touches (teeing it can interfere with MSE on Safari), so no bytes are ever counted and the graph is supposed to fall back to buffer-ahead seconds. That fallback needs a `<video>` that is actually advancing; `watchVideo` now picks the playing element rather than the first in DOM order, which covers a paused hover-preview winning the lookup, but the fallback has not been confirmed against a real live room.
