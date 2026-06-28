# Bilibili Accelerator

[中文](./README.md)

Bilibili should not buffer every few seconds just because you are watching from overseas.

**Bilibili Accelerator** is a userscript that rewrites slow Bilibili playback CDN URLs before the player starts buffering. It targets the usual overseas pain points: `upos-*ov` mirror hosts, MCDN/PCDN nodes, and route choices that make niche videos stutter while popular videos play fine.

## Install

Greasy Fork is the recommended install path. It works with Chrome, Safari, Firefox, and Edge through a userscript manager.

- [Greasy Fork script page](https://greasyfork.org/en/scripts/582026-bilibili-accelerator)
- [Direct `.user.js` install](https://update.greasyfork.org/scripts/582026/Bilibili%20Accelerator.user.js)
- [GitHub Raw fallback](https://raw.githubusercontent.com/realzza/bilibili-accelerator/main/dist/bilibili-accelerator.user.js)
- [GitHub Release v0.1.3](https://github.com/realzza/bilibili-accelerator/releases/tag/v0.1.3)

After installation, open any Bilibili video. A small ⚡ icon in the lower-right corner means the script is active.

## Chrome / Edge

1. Install [Tampermonkey](https://www.tampermonkey.net/) or [Violentmonkey](https://violentmonkey.github.io/).
2. Open the [Greasy Fork script page](https://greasyfork.org/en/scripts/582026-bilibili-accelerator).
3. Click Install.
4. Reload the Bilibili video page.

You can also load the unpacked extension:

```sh
npm run build
```

Then open `chrome://extensions`, enable Developer mode, and select `dist/extension`.

## Safari

1. Install the Safari extension [Userscripts](https://apps.apple.com/us/app/userscripts/id1463298887).
2. Enable Userscripts in Safari Settings and allow it on `bilibili.com`.
3. Open the [Greasy Fork script page](https://greasyfork.org/en/scripts/582026-bilibili-accelerator) or the [GitHub Raw fallback](https://raw.githubusercontent.com/realzza/bilibili-accelerator/main/dist/bilibili-accelerator.user.js).
4. Install when prompted, then reload the Bilibili video page.

## What It Changes

Bilibili often returns multiple signed media URLs for the same video. Overseas viewers may get routed to hosts like:

```text
upos-sz-mirrorcosov.bilivideo.com
xy153x35x231x78xy.mcdn.bilivideo.cn:8082
```

The script rewrites those slow paths to steadier playback routes, by default:

```text
upos-sz-mirrorcos.bilivideo.com
proxy-tf-all-ws.bilivideo.com
```

Healthy CDN URLs are left alone by default. For stubborn videos, open the ⚡ panel, enable `Force all video CDN`, and reload.

In web fullscreen the ⚡ icon fades out so it never covers the video; move the cursor to the lower-right corner to bring it back.

## Tested Case

This reported stuttery video:

```text
https://www.bilibili.com/video/BV1NnVK6cEXs
```

returned `upos-sz-mirrorcosov.bilivideo.com` playback URLs. The script rewrites them to `upos-sz-mirrorcos.bilivideo.com`.

## Development

```sh
npm test
npm run build
```

Outputs:

```text
dist/bilibili-accelerator.user.js
dist/extension/
```

## Router / Apple TV / Mobile App?

A common request is router-level acceleration so native apps benefit too. See [docs/router-proxy.md](docs/router-proxy.md) for the feasibility and limits: the browser case works, but Apple TV / mobile apps are blocked by custom-CA installation and certificate pinning.

## Why Star This

If you watch Bilibili overseas, this turns a lot of mysterious buffering into one small, controllable switch.
