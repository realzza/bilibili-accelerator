# Bilibili Accelerator

[中文](./README.md)

Bilibili Accelerator is a userscript for Bilibili's web player. It handles a common overseas failure mode: a video lands on a slow CDN, MCDN/PCDN node, or poor route and buffers even though the connection itself is fine. Only suspicious playback URLs are rewritten; healthy CDN traffic is left alone by default.

| ☀️ Light | 🌙 Dark |
| :---: | :---: |
| <img src="docs/assets/panel-light.jpg" alt="Bilibili Accelerator light panel" width="360"> | <img src="docs/assets/panel-dark.jpg" alt="Bilibili Accelerator dark panel" width="360"> |

## Install

The recommended install path is Greasy Fork:

- [Greasy Fork script page](https://greasyfork.org/en/scripts/582026-bilibili-accelerator)
- [Direct `.user.js` install](https://update.greasyfork.org/scripts/582026/Bilibili%20Accelerator.user.js)
- [GitHub Raw fallback](https://raw.githubusercontent.com/realzza/bilibili-accelerator/main/dist/bilibili-accelerator.user.js)
- [GitHub Releases](https://github.com/realzza/bilibili-accelerator/releases/latest)

On Chrome, Edge, or Firefox, install [Tampermonkey](https://www.tampermonkey.net/) or [Violentmonkey](https://violentmonkey.github.io/), then install the script from Greasy Fork. Reload the Bilibili tab after installation. The ⚡ button in the lower-right corner confirms that the script is running.

### Safari

1. Install the Safari extension [Userscripts](https://apps.apple.com/us/app/userscripts/id1463298887).
2. Enable Userscripts in Safari Settings and allow access to `bilibili.com`.
3. Install the script from Greasy Fork or the GitHub Raw URL.
4. Reload any Bilibili tabs that were already open.

### Load the unpacked extension

The repository also builds a Manifest V3 extension for Chrome and Edge:

```sh
npm run build
```

Open `chrome://extensions`, enable Developer mode, and load `dist/extension`.

## How it works

Bilibili normally returns several signed media URLs for each video. Overseas viewers often run into slow routes such as:

```text
upos-sz-mirrorcosov.bilivideo.com
xy153x35x231x78xy.mcdn.bilivideo.cn:8082
```

Before the player requests a segment, the script classifies the URL and, when needed, switches it to a healthier official CDN or proxy route, for example:

```text
upos-sz-mirrorcos.bilivideo.com
proxy-tf-all-ws.bilivideo.com
```

By default, it:

- rewrites known slow mirrors, MCDN/PCDN hosts, odd-port nodes, and playback URLs marked with `os=mcdn`;
- probes a small CDN candidate pool and caches the working order for the current region, with a fixed-server option available under Advanced settings;
- rotates routes when playback keeps stalling, without reloading the page or losing the current position;
- never rewrites live (`/live-bvc/`) URLs to VOD servers; it filters obvious PCDN/MCDN entries from the live route list while keeping at least one usable URL; and
- applies the same rules to `fetch`, `XMLHttpRequest`, page play data, and quality changes.

## Panel and settings

- The panel shows playback status, rewrite count, and live download speed. It falls back to buffer-ahead time when byte counts are unavailable.
- Appearance follows the system theme by default. Choosing the sun or moon in the header saves an explicit light or dark preference.
- Advanced settings include seven accents: Bilibili Blue, Teal, Emerald, Violet, Pink, Sunset, and Graphite.
- **Still buffering? Boost harder** switches to the more aggressive rewrite mode and reloads the current page.
- The optional bandwidth guard blocks Bilibili's P2P SDK and WebRTC upload entry points. Reload the page after enabling it.
- In web fullscreen, the ⚡ button fades out. Move the pointer to the lower-right corner to reveal it again.

## Troubleshooting

First check that the ⚡ button is present. Tabs that were open during installation or an update need to be reloaded.

If playback still stalls, open Advanced settings, select **Copy report**, and attach the report to a [GitHub issue](https://github.com/realzza/bilibili-accelerator/issues) along with the video URL, your region, and what you observed. Reports contain hostnames and rewrite reasons only; signed media URLs and query tokens are not included.

## Limits

- This project targets Bilibili's browser player. It does not directly support Apple TV or the native mobile apps.
- CDN health varies by region and ISP. The script can route around known slow nodes, but it cannot fix regional licensing, a broken source file, or a local network problem.
- See [docs/router-proxy.md](docs/router-proxy.md) for router-level options and the certificate constraints on native apps.

## Development

```sh
npm test
npm run build
```

Build outputs:

```text
dist/bilibili-accelerator.user.js
dist/extension/
```

`package.json` is the single source of truth for the version. The build stamps it into the userscript header and extension manifest. Before committing, rebuild and make sure `dist/` has no uncommitted changes.

## License

[MIT](./LICENSE)
