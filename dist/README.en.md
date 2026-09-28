# <img src="docs/assets/logo.svg" alt="" width="40" align="top">&nbsp;Bilibili Accelerator

[中文](./README.md) · [Greasy Fork](https://greasyfork.org/en/scripts/582026-bilibili-accelerator) · v0.5.0

Watching Bilibili from outside mainland China, popular videos are usually fine. Everything else tends to stutter — smooth one moment, buffering the next.

This userscript is meant to smooth that out. It watches playback in the browser, adjusts automatically when a connection is clearly unstable, and shows your live download speed in a panel. When playback is fine, it stays out of the way.

| ☀️ Light | 🌙 Dark |
| :---: | :---: |
| <img src="docs/assets/panel-light.jpg" alt="Bilibili Accelerator light panel" width="360"> | <img src="docs/assets/panel-dark.jpg" alt="Bilibili Accelerator dark panel" width="360"> |

## Install

On Chrome, Edge, or Firefox, install [Tampermonkey](https://www.tampermonkey.net/) or [Violentmonkey](https://violentmonkey.github.io/) first, then grab the script from any of these:

- [Greasy Fork](https://greasyfork.org/en/scripts/582026-bilibili-accelerator) — recommended, auto-updates
- [Direct `.user.js`](https://update.greasyfork.org/scripts/582026/Bilibili%20Accelerator.user.js)
- [GitHub Raw fallback](https://raw.githubusercontent.com/realzza/bilibili-accelerator/main/dist/bilibili-accelerator.user.js)
- [GitHub Releases](https://github.com/realzza/bilibili-accelerator/releases/latest)

Reload any Bilibili tab you already had open. The ⚡ badge in the lower-right corner means it's running.

### Safari

Safari has no Tampermonkey, so use the [Userscripts](https://apps.apple.com/us/app/userscripts/id1463298887) extension:

1. Install Userscripts from the App Store.
2. Enable it in Safari Settings and allow access to `bilibili.com`.
3. Install the script from Greasy Fork or the GitHub Raw URL above.
4. Reload any open Bilibili tabs.

### Unpacked extension (Chrome / Edge)

If you'd rather not use a script manager, the repo also builds a Manifest V3 extension:

```sh
npm run build
```

Open `chrome://extensions`, turn on Developer mode, and load `dist/extension`.

## Panel and settings

- The top of the panel shows current status; below it is a live download-speed graph. When speed data isn't available, it falls back to how many seconds are buffered ahead.
- Appearance follows the system theme. Once you pick the sun or moon in the header, that choice sticks.
- Advanced settings has seven accents: Bilibili Blue, Teal, Emerald, Violet, Pink, Sunset, and Graphite.
- The status line names the server in use: the native server (the one Bilibili assigned to this video) or the one it switched to. The live rate appears only in the download-speed card below it.
- If the video has stalled or the server is short, **Test other servers** compares a few servers right away and switches only to one that is clearly faster. It saves nothing and doesn't reload the page.
- The bandwidth guard is off by default. Turning it on limits the page's use of your upload bandwidth; reload the page afterwards.
- In web fullscreen the ⚡ badge fades out. Move the pointer to the lower-right corner to bring it back.

## Releases

Full notes live in [Releases](https://github.com/realzza/bilibili-accelerator/releases).

| Version | What changed |
| --- | --- |
| v0.5.0 | Servers are now chosen by measurement. Each video starts on its native server, the one Bilibili assigned, and the extension measures how fast the player actually downloads each fragment. When that falls below the video's bitrate while the buffer is low, two alternatives race for the bytes the player needs next, and the video moves to the winner if it is clearly faster, then stays there. A stuck fragment is retried on the new server at once, through the player's own timeout path. Gone: the probe at page load, the six-hour ranking and the step-by-step rotation on stalls. The probe read only the start of a file and so measured round-trip time; the ranking applied to every video, though one server can be ten times faster on a popular video than on a rarely watched one; and the rotation drifted to the bottom of the list. Akamai is used only through the address Bilibili issues. **Still buffering? Boost harder** is replaced by **Test other servers**, which saves no setting, and auto mode no longer shows Apply to or Rewrite Akamai |
| [v0.4.1](https://github.com/realzza/bilibili-accelerator/releases/tag/v0.4.1) | Fixed server is now a dropdown: the old text box only suggested hosts matching its current value, so the other servers stayed hidden until it was cleared. The list is the eight servers auto mode measures and no longer offers Akamai, which returns 403 for rewritten video requests. Other hosts can still be entered through the Custom… option. The setting only shows once "Use a fixed server" is selected, since auto mode picks the server from its own measurements. Dropdowns and text fields in advanced settings now line up |
| [v0.4.0](https://github.com/realzza/bilibili-accelerator/releases/tag/v0.4.0) | Fixes background playback for overseas viewers: switching tabs no longer stalls the video after a few seconds (worst on Safari). The accelerator had been rewriting Bilibili's own overseas mirrors onto mainland CDNs. Candidate servers now span both tiers and are all measured, ranking is by measured throughput instead of response time, and stall switching walks the full list. The ⚡ badge also auto-hides on live pages instead of covering the chat column |
| [v0.3.0](https://github.com/realzza/bilibili-accelerator/releases/tag/v0.3.0) | Light/dark panel and seven accent themes; header theme and language share one sliding control. Core behavior untouched |
| [v0.2.3](https://github.com/realzza/bilibili-accelerator/releases/tag/v0.2.3) | Stability fixes for live playback, more accurate probing, and stall recovery that keeps retrying |
| [v0.2.2](https://github.com/realzza/bilibili-accelerator/releases/tag/v0.2.2) | Speed measured over the time data is actually flowing, so a full buffer no longer reads as 0 Mbps |
| [v0.2.1](https://github.com/realzza/bilibili-accelerator/releases/tag/v0.2.1) | Live download-speed graph in the panel, with a buffer-health fallback |
| [v0.2.0](https://github.com/realzza/bilibili-accelerator/releases/tag/v0.2.0) | Big one: automatic connection tuning, stall recovery, EN/中 panel, optional bandwidth guard |
| [v0.1.3](https://github.com/realzza/bilibili-accelerator/releases/tag/v0.1.3) | Lightning-only badge, auto-hide in web fullscreen, stops covering the fullscreen button |
| [v0.1.2](https://github.com/realzza/bilibili-accelerator/releases/tag/v0.1.2) | Rebuilt the floating control and settings panel |
| [v0.1.1](https://github.com/realzza/bilibili-accelerator/releases/tag/v0.1.1) | First installable userscript release |

## Troubleshooting

Check for the ⚡ badge first. Tabs that were open during install or an update have to be reloaded.

No ⚡ on Chrome or Edge, and Tampermonkey says "script hasn't run yet" or asks you to allow user scripts? That's a newer-Tampermonkey (Manifest V3) rule — the browser makes you allow script injection once before any userscript can run, and it has nothing to do with this script. Flip it on:

- **Chrome**: go to `chrome://extensions`, open Tampermonkey's **Details**, and turn on **Allow user scripts**. Older builds don't have that toggle — turn on **Developer mode** (top right) instead.
- **Edge**: go to `edge://extensions/`, turn on **Developer mode** (bottom left), then open Tampermonkey's **Details** and turn on **Allow user scripts**. If the toggle isn't there, your Edge is too old — update it.

If it still stalls, open Advanced settings, hit **Copy report**, and file an [issue](https://github.com/realzza/bilibili-accelerator/issues) with the video URL, your region, and what you saw. The report contains only what's needed to diagnose the problem — no signed media addresses or query tokens.

## Limits

- Browser player only. Apple TV and the native mobile apps are out of scope.
- Network conditions vary by region and ISP. This helps in some situations, but it can't fix regional licensing, a broken source file, or your local network.
- For why router-level proxying mostly doesn't help (and the certificate pinning problem on native apps), see [docs/router-proxy.md](docs/router-proxy.md).

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

The version lives in `package.json` and nowhere else; the build stamps it into the userscript header and the extension manifest. `dist/` is committed, and CI checks it against `src/`, so rebuild before you commit.

## License

[MIT](./LICENSE)
