# Bilibili Accelerator

Cold Bilibili videos should not buffer every few seconds just because you are overseas.

This Safari-friendly userscript rewrites slow Bilibili playback CDN URLs before the player touches them. It targets the usual culprits: weak overseas `upos-*ov` mirrors, MCDN/PCDN hosts, and bad route picks that make niche videos feel broken while popular ones play fine.

## Install In Safari

1. Install the Safari extension [Userscripts](https://apps.apple.com/us/app/userscripts/id1463298887).
2. Download or use this file:

   ```text
   dist/bilibili-accelerator.user.js
   ```

3. Add it to Userscripts and allow it on `bilibili.com`.
4. Open any Bilibili video. A small `BA` button appears at bottom-right.

That is it. Reload the video page and the slow CDN links are rewritten automatically.

## What It Fixes

Bilibili often returns multiple signed media URLs for the same video. For overseas viewers, cold videos may get routed to hosts like:

```text
upos-sz-mirrorcosov.bilivideo.com
xy153x35x231x78xy.mcdn.bilivideo.cn:8082
```

The accelerator changes those bad picks into faster playback paths, by default:

```text
upos-sz-mirrorcos.bilivideo.com
proxy-tf-all-ws.bilivideo.com
```

Healthy CDN URLs are left alone unless you enable force mode.

## Tested Example

This video was reported as especially stuttery:

```text
https://www.bilibili.com/video/BV1NnVK6cEXs
```

It returned `upos-sz-mirrorcosov.bilivideo.com` URLs in page playback data. The accelerator rewrites those to `upos-sz-mirrorcos.bilivideo.com`.

## Build

```sh
npm test
npm run build
```

Outputs:

```text
dist/bilibili-accelerator.user.js
dist/extension/
```

## Why Star This

Because overseas Bilibili should feel like video, not interval training.

