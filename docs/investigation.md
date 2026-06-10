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

