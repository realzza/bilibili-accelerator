# VOD host selection and switching

> Status: implemented on this branch (0.5.0), 2026-09-27. The maintainer delegated the open decisions; they are recorded under [Decisions](#decisions). Awaiting code review and testing in Safari.
>
> Measured from the maintainer's network (US West, Ziply Fiber, no iCloud Private Relay) with Safari 27 running v0.4.1, and with Chromium logged in as 大会员 at the highest quality each video offers. Host speed changes with the hour in China, so times are given in PDT with Beijing time next to them. A measurement loop is running through Beijing's evening peak; its results will be added here before the design is final.

## Short answer

The extension picks a host once per six hours from a probe that measures the wrong thing, applies the pick to every video, and on each stall walks one step down its list without checking whether the next host is any better. On the maintainer's machine it started on a host that couldn't carry the stream, reached the end of the list after six switches, and along the way overrode the one good decision the player had made on its own.

Three findings drive the redesign.

1. **Which host is fast depends on the video.** Bilibili's overseas edge `mirrorcosov` moved a popular 4K file at 94 Mbps and a new upload at 4–8 Mbps in the same minute. It is fast when other overseas viewers have already pulled the file and slow when it has to relay from origin. No ranking computed once and reused across videos can be right for both.
2. **The shipped probe ranks round-trip time, not throughput.** It reads the first 768 KB of a file. That window is TCP slow start plus whatever the edge already holds of the file's head. Mainland mirrors look slow in it (6–10 Mbps) and then sustain 38–84 Mbps; a cold overseas edge looks fast (17.6 Mbps) and then drops to 3.1.
3. **The player already fails over, but only on errors and timeouts.** Bilibili's player is a dash.js fork. It keeps a sticky URL index per representation and moves to the next URL when a request errors, gets no first byte within about two seconds, or runs past its total timeout. It can't see a host that answers at once and then delivers below the stream's bitrate. That is where the stutter comes from, and it is the case the extension has to handle.

The design starts every video on the host Bilibili assigned. It measures what the player actually receives, fragment by fragment. When the host can't keep up, it races two alternatives on the bytes the player needs next, routes the rest of the session to the winner, and ends the stuck request through the player's own retry path so the switch takes effect at once. After a successful switch it stays put. The six-hour ranking, the page-load probe of the whole pool, the rotation cursor and the backup-URL fan-out are removed.

## What goes wrong today

### A field report

The maintainer's Safari, 2026-09-27 03:17 PDT (18:17 Beijing), on a 1,987-view video at 1080P+ HEVC (3.75 Mbps):

```
mode: force   rewriteAkamai: true   selection: auto
ranking (probed 02:52 PDT): mirroraliov, mirrorcosov, mirrorali, mirrorhw, tf-all-tx, tf-all-hw, mirrorcos
counters: stalls 4, recoveries 6        pcdnHost now: mirrorcos (7th of 7)
saved config pcdnHost: tf-all-tx        last 50 rewrites: mirrorali → mirrorcos
```

Resource Timing for that page shows segments from `mirroraliov` for the first 45 s after page load, `mirrorcosov` from 49 to 61 s and mainland `mirrorhw` from 75 s. After six recoveries the target was the last entry in the ranking. A reload of the same page logged three more stalls and three more recoveries.

The rewrite log holds the most telling detail. The player had worked its own way down its backup list to `mirrorali`, one of the two fastest hosts for this file at that hour. Force mode rewrote every one of those requests to `mirrorcos`, the slowest of the mainland mirrors.

In the same hour, 4 MB of that file from each host, at offsets nobody had requested:

| host | rank in the cached list | delivered |
| --- | --- | --- |
| `mirroraliov` | 1 | 1.4 Mbps |
| `mirrorcosov` (Bilibili's assignment) | 2 | 1.1 Mbps |
| `mirrorali` | 3 | 17.9 Mbps |
| `mirrorhw` | 4 | 20.0 Mbps |
| `tf-all-tx` | 5 | 10.7 Mbps |
| `tf-all-hw` | 6 | 12.5 Mbps |
| `mirrorcos` | 7 | 6.0 Mbps |

The stream needs 3.75 Mbps. The top two entries couldn't deliver it, and every mainland mirror could.

### The probe measures the wrong thing

`probeHost` fetches the file with no `Range`, reads 768 KB, and divides by the time since the response headers arrived. All eight hosts are probed in parallel on fresh connections. Two effects fill that window.

The first is slow start. A new connection across the Pacific needs several round trips before its window covers a fragment. The second is the head of the file. The first bytes are what every viewer, and every earlier probe, has requested, so they are the part an edge is most likely to hold even when it holds nothing else.

Reading on past the probe window, same kind of request (03:40 PDT, 18:40 Beijing, two cold 480P files, no `Range`, timed from the headers):

| host | first 768 KB | 768 KB → 2 MB | 2 → 4 MB |
| --- | --- | --- | --- |
| `mirrorali` | 10.0 Mbps | 38.4 | 84.5 |
| `mirrorhw` | 6.1 | 37.1 | 80.6 |
| `mirrorcosov` | 17.6 | 15.8 | 3.1 |
| `mirroraliov` | 1.7 | 2.7 | 1.4 |

The probe stops where the mainland mirrors come out of slow start and where the cold overseas edge runs out of cached bytes. It never measures `mirrorakam` at all, because a host swap onto Akamai is refused (below). Run again right after, it returned 300–850 Mbps: those connections were warm and the bytes were already buffered, so the number says nothing about the network.

### One ranking for every video

The result is cached for six hours per time zone and applied to every video. Host speed doesn't carry over between videos. Logged in, highest quality, in the same minute (12:22 PDT, 03:22 Beijing), three 768 KB requests per host at a random offset:

| host | popular video, 4.6M views, 4K HEVC 5.38 Mbps | new upload, 0 views, 1080P+ AVC 5.10 Mbps |
| --- | --- | --- |
| `mirrorcosov` | 93–94 Mbps | 4–8 Mbps |
| `mirrorakam` (issued URL) | 4–5 | 0.6, then 2, then 27 Mbps |
| `mirrorhw` | 20–23 | 6–16 |
| `mirrorali` | 11–17 | 6–8 |
| `tf-all-hw` | 4–23 | 4–18 |
| `tf-all-tx` | 3–10 | 3–8 |
| `mirrorcos` | 3–10 | 5–9 |
| `mirroraliov` | 1–3 | 2–4 |

It changes with the hour too. On the maintainer's cold file, `mirrorcosov` delivered 1.1 Mbps at 18:40 Beijing and 10–19 Mbps at 03:50 Beijing.

### Rotation without evidence

`handleStall` rotates once the video has been waiting for 2.5 s, and again every 5 s while it still waits. `rotateTarget` advances a cursor through the ranking. Replaying the shipped page script in the unit-test harness, with the ranking above and Bilibili's assignment (`mirrorcosov`):

| step | force: requests go to | bad-only: requests go to |
| --- | --- | --- |
| before any stall | `mirroraliov` | `mirrorcosov` |
| stall, +2.5 s | `mirrorcosov` | `mirrorali` |
| still waiting, +7.5 s | `mirrorali` | `mirrorcosov`, the stalling host |
| +12.5 s | `mirrorhw` | `tf-all-tx` |
| +17.5 s | `tf-all-tx` | `mirrorcosov` |
| recovered, 15 s later | `tf-all-tx` | `mirrorcosov` |
| next stall | `tf-all-hw` | `mirrorcos` |
| +5 s | `mirrorcos` | `mirrorcosov` |

In force mode the cursor never resets, so each stall continues from wherever the last one stopped, and the tail of the ranking is where the slow hosts are. In bad-only mode the second step sets `recovery.avoidHost` to the host just moved to; the player's requests for `mirrorcosov` stop matching it, and traffic returns to the host that stalled. Every other "switch" is a return, and the 15 s timer undoes the rest.

The 5 s re-check also judges too early. A rewrite applies to the player's next request, and the request in flight stays on the old host. A new transpacific connection takes 0.4–3.6 s to set up, and about one mainland connection in ten took longer than 5 s or timed out. At +5 s the new host has usually served nothing.

Two more things make it stick. Any change in the panel calls `saveConfig` with the in-memory config, which by then holds a rotated `pcdnHost`; that is how `tf-all-tx` came to be saved. And 还在卡？再加把劲 appears after a single stall and saves `mode: "force"` for good.

### The extension overrides the player's own failover

`enrichBackups` puts host-swapped URLs in front of Bilibili's own backup. In bad-only mode, with the ranking above, a US viewer's backup list became `mirroraliov, mirrorali, mirrorhw, tf-all-tx, tf-all-hw, mirrorcos, mirrorakam`: the player's one real alternative moved from first to last, behind a host that is almost always cold. With `rewriteAkamai` on, as in the field report, the Akamai URL disappears entirely. In force mode none of this matters, because every URL in the list is rewritten to the same host at request time and the player's failover has nowhere to go.

## How VOD delivery works

### Hosts and what they accept

On this network every playurl seen in these tests assigned `mirrorcosov` and `mirrorakam` (`upos-hz-mirrorakam.akamaized.net`), one as `baseUrl` and the other as the only `backupUrl`. The split is per representation, not per video. On one 1080P+ title, AVC and HEVC had `mirrorcosov` as base while AV1 had `mirrorakam`, and Safari picked AV1. Logged-out and logged-in viewers got the same two hosts.

The two issued URLs share a path but not a signature. The Akamai URL carries `os=akam` and an `hdnts` token, and a host swap onto Akamai is refused with 403. The `mirrorcosov` URL (`os=cosovbv`) is accepted by every UPOS mirror in the pool, overseas and mainland. `mirrorhwov` fails at TCP from this network. `mirroraliov` accepts the path but is almost always cold, since Bilibili doesn't assign it to US viewers.

Every UPOS host answers 403 to a request without a `Referer`. `mirrorcosov` also answers 403 to a CORS preflight for `Range`, and its 403s carry no CORS headers. Neither Chromium nor Safari 27 sends that preflight for a single byte range, so playback isn't affected. Measurement can be: requests from an `about:blank` frame carry no `Referer`, and fail with a bare network error on `mirrorcosov` and a 403 elsewhere.

### Where the time goes

Once an edge holds the bytes, the last mile is fast. `mirrorcosov` and `mirrorakam` answer a warm request in 30–60 ms. Mainland mirrors can't go below one round trip, 0.18–0.26 s, which holds a single 768 KB request to 10–25 Mbps even on a clean path; past slow start the same mirrors sustain 38–84 Mbps. The cost on an overseas edge is the first request for bytes it doesn't have: 1.4–11.5 s to the first byte, then 1–8 Mbps while it relays from origin.

At the highest quality the player's video fragments are large, 0.5–3 MB each for 1080P+ HEVC, and that amortizes the mainland round trip: a 2.5 MB fragment on a warm mainland connection arrives at 20–40 Mbps. Audio fragments are about 40 KB and their time is almost all first byte.

### The player

The VOD player (`core.ba67b466.js`) builds a DASH manifest from the playurl, and each representation's `BaseURL` becomes `urls = [baseUrl, ...backupUrl]`. Read from its source, then checked against its behavior in Chromium:

- **Sticky URL index.** The HTTP loader keeps `D[representationId]`, an index into `urls`, and every fragment of that representation uses it. A failure moves the index, and it stays moved. A quality switch starts the new representation at its own index, which is 0 unless it has failed before.
- **What counts as failure.** No first byte within about 2 s (2.05 s plus 1 s per retry, capped at 20% of the buffer but never under 2 s). No completion within the total timeout, which the loader sets as `xhr.timeout` before `send()`: 10 s plus 3 s per retry, capped at 60% of the buffer, never under 5 s. Any 4xx, 5xx or network error.
- **Retry.** Up to 3 retries per fragment, the dash.js default, not overridden. The retry goes out immediately unless the failure came within 50 ms of the request, which the loader reads as being offline and answers with a delay.
- **Buffer.** It fills to 70–80 s ahead (`bufferAheadToKeep`), which takes seconds on a warm host.
- **Requests.** One `XMLHttpRequest` per fragment, `Range` in a header, and every handler (`onload`, `onloadend`, `ontimeout`, `onerror`, `onabort`, `onprogress`) assigned as a property before `send()`.

A host that answers quickly and then trickles trips none of these. A cold `mirroraliov` answers a warm connection in 30 ms and then sends the body at 1–2 Mbps. With auto quality, dash.js lowers the quality. With a fixed quality, the buffer drains until the video stops.

### Two ways to end a request early

A switch only helps if the fragment the player is waiting for moves too. Two ways of ending that request were tested.

- **Lowering `xhr.timeout` mid-flight.** In Chromium, setting it to 1 fires `timeout` at once. In Safari 27 it does nothing: the request completed normally whether the change came before the response headers or after. Not usable.
- **A synthetic timeout.** Detach the player's handlers from that request, abort it natively, then call the player's own `ontimeout` and `onloadend`. To the loader this is a timeout like any other: status 0, the retry path, the next URL. On the real player in Chromium (logged in, 1080P+ HEVC, a 2.96 MB fragment on `mirrorcosov`) the retry went out 1 ms later, playback resumed, and no error was shown. In that run the retry went to the player's next URL, `mirrorakam`, which then missed the player's own first-byte deadline; under this design it would have gone to the winner of a race. The technique uses no browser feature beyond `abort()`, so it should behave the same in Safari, but that isn't verified yet. The document-start iframe harness used for live rooms can't run the player in WebKit, where the frame's media requests go out without a `Referer`. Phase 3 has to confirm it with the build installed.

A native `abort()` alone won't do. The loader treats an abort as intentional, and would run both its abort path and, through `onloadend`, its retry path.

## Design

### Principles

- **Start from Bilibili's assignment and the player's own failover.** They are right for popular videos, and popular videos are most of what gets watched. Take over only on evidence.
- **Measure what the player receives, for this video, now.** Its own fragment downloads are the measurement.
- **Switch to a host that measured better, then stay.** No rotation, no timer that undoes a switch.
- **Make a switch take effect through the player's own retry path.**
- **Keep routing state per page session.** Never write it into the saved config.
- **No decisions from a hidden tab.**
- **The panel claims only what the code measured or did.**

### The session

A session is one video on one page: a playurl payload for one `cid`, plus any later refresh of it when the signed URLs expire. For each representation in the payload the session records its bitrate and its issued URLs by host. That table answers the routing question for any request: given a fragment URL from the player, which representation is it, and what is the URL of the same bytes on host H?

- H is an issued host: use that issued URL unchanged. It is the only way to reach `mirrorakam`.
- H is a pool mirror: take an issued UPOS URL (here, `mirrorcosov`'s) and swap the host.

**Candidates** are the issued hosts plus the pool mirrors `mirrorali`, `mirrorhw`, `tf-all-hw`, `tf-all-tx`, `mirrorcos`, `mirroraliov` and `mirrorhwov`. The pool keeps both tiers; a dead or slow host sinks through history, not through the order of a list.

**The required rate** is the bitrate of the highest-quality video representation the player has requested in this session. Using the highest keeps auto quality from hiding a slow host: if a host pushes dash.js down to 720P, the session still judges it against 1080P+.

### Measurement

**Passive.** The XHR hook already sees every media request. With `setRequestHeader` (to read `Range`) and a `progress` listener added, it records for each request the host, representation, range, bytes, time to first byte and time to completion. Goodput per host and session comes from video fragments only: bytes over the union of their transfer intervals, using the existing `aggregateThroughput`. Audio fragments are about 40 KB and mostly first-byte time, so they would read as a slow host; they count toward errors but not goodput. The estimate follows Shaka Player's rules: a fragment under 16 KB doesn't count on its own, nothing is trusted before 128 KB in total, and a fast and a slow average (2 s and 5 s half-lives) are kept and the lower one used, so the estimate falls quickly and recovers slowly.

**In flight.** For the video fragment currently loading, `progress` events give the bytes so far and the rate over the last second, and from those a predicted finish.

**Buffer.** `video.buffered` ahead of `currentTime`.

**Race**, only when a trigger fires. Fetch the first 768 KB of the fragment in flight (all of it if shorter), or of the bytes right after the last completed fragment if nothing is in flight, from two challengers in parallel, with the page's native `fetch` so the request carries the page's `Referer`. The race is decided as soon as its outcome is known: when the first challenger finishes. Contenders still running get another second so their numbers reach history, then are cancelled; one that finishes in that second becomes the fallback. Each race costs at most 1.5 MB. The requests use `credentials: "omit"`, like the player's own, which should let the browser reuse the connection for the player's retry; the winner's edge will also hold the start of the range by then. The race is timed from request start to completion, which is what the player pays, not from the headers.

### Initial selection

A session starts native: requests go wherever the player sends them, with nothing rewritten. The one exception is a PCDN or MCDN base URL: if Bilibili issued a proper CDN URL as its backup, that URL is used as issued; otherwise `classify()` rewrites it as before (PCDN to the default target, MCDN by `mcdnStrategy`).
The first real fragment decides. A race starts if it has no first byte after 1 s, or if after 0.5 s of transfer it is arriving at less than 1.3× the required rate with more than a second still to go. On a popular video the assigned edge answers within 30–150 ms and nothing happens. On a cold one the race starts after about a second and takes 0.3–1.5 s, close to when the player's own 2 s deadline would fire, and it picks a measured host instead of simply the next URL. If the player's deadline fires first, its retry goes out as it does today, and the race result applies from the next request.

There is no probe at page load and no stored ranking.

### When to switch

| trigger | condition | why |
| --- | --- | --- |
| stuck fragment | the video fragment in flight will finish after the buffer runs out, with 2 s to spare, and has run for at least 0.5 s or 128 KB | a stall is about to happen or already has |
| sustained shortfall | goodput over the last 4 MB or 8 s of transfer is under 1.2× the required rate, and less than 30 s is buffered | the buffer can't grow on this host |
| errors | two failed requests on the active host within 30 s | the host is failing, not slow |

Seeks, startup and `waiting` events are not triggers by themselves. Stalls are recorded, not acted on.

### Choosing the next host

The challengers are the two best candidates by history that haven't failed twice in this session or lost a race in the last minute. The other issued host (`mirrorakam` or `mirrorcosov`) is always one of them until it has carried at least 128 KB in this session, since it is the player's own alternative and is sometimes the best. A host with no history counts as the lower median of the measured ones, so it never outranks a host already measured as good, and hosts that failed within the hour go last. One challenger in five is drawn at random from the rest, so history keeps learning.

Before any history exists every host ties, and ties go to mainland mirrors. Bilibili assigns one overseas edge per region, so the overseas mirrors it did not issue see little of that region's traffic and are cold, while a mainland mirror sits next to origin and holds every file. That is a statement about Bilibili's assignment, not about where the viewer is.

The winner becomes the active host if it delivered the race bytes in at most two-thirds of the time the current host needs for the same bytes at its present rate. Otherwise nothing changes and the result goes into history. The race runs on a fresh connection and understates a mainland mirror's warm speed, so it isn't asked to prove the new host keeps up; the new host's own traffic answers that afterwards. The host being left rests for a minute like any loser, and the rate it was delivering goes into history.

A manual test before anything has been measured races the current host as well. It is then decided when the current host finishes, or when it has taken 1.5 times the winner's time without finishing, which is exactly the margin a switch needs.

### Making a switch take effect

From the moment of a switch, every media request of the session, audio and video in every representation, is routed to the active host through the session table.

If the trigger was a stuck fragment, and that request is a first attempt (a range not requested before in this session), it gets a synthetic timeout. The player retries at once, the retry is routed to the winner, and the winner's edge already holds the start of the range. Only first attempts are ended this way: the player allows three retries per fragment, and the extension uses at most one of them.

If `ontimeout` isn't a function on the request, as with a future player that uses `fetch` or `addEventListener`, no request is ended early. The switch then takes effect when the player's own timeout fires or the fragment completes.

A request that fails on the active host is routed away from it on retry, to the runner-up of the last race or else the next candidate by history. Without this, taking over routing would disable the player's failover the same way force mode does now.

### Staying put

- A new host is judged on its own traffic after 10 s of transfer or 4 MB. Before that, only errors count against it.
- After a switch there is no new race for 10 s, and each further switch in the session doubles the wait (10, 20, 40 s).
- At most four switches per session. After that the session keeps the best host it has measured.
- A quality change keeps the active host, and its traffic is measured like any other.
- If every candidate has failed, routing stops for the session and the player's own URLs go out as issued.

### The field report, replayed

Expected behavior, not a measurement, using the numbers above. The session starts on `mirrorcosov`, which Bilibili assigned. The first 1080P+ fragment arrives at about 1.1 Mbps, under 1.3× the required 3.75, so a race starts after half a second. The challengers are `mirrorakam`, the other issued host, and the best mainland mirror by history, say `mirrorhw`. `mirrorhw` delivers its 768 KB in one to two seconds including the new connection, against more than five seconds for `mirrorcosov` at its present rate, so it wins. The stuck fragment gets a synthetic timeout, the player retries it on `mirrorhw`, and the buffer fills at 20 Mbps. One switch, and no rotation afterwards.

On the popular 4K video in the same table nothing happens at all: `mirrorcosov` answers in 60 ms at 94 Mbps and the session never leaves it.

### History

Per region (time zone, as today), in `localStorage` under a new key:

- per host, an average of race and session goodput with a three-day half-life, a sample count, and the time of the last failure;
- over the last 10 sessions, how often the assigned host was replaced.

History only orders challengers and decides whether to race the first fragment. It never picks the active host without a race. A host with no history counts as average, so new or long-unused hosts still get tried.

### Settings

- **Selection: auto** runs the engine above. `mode` has no effect in auto and its 何时 row is hidden, the same treatment PR #35 gave the fixed-host picker. A saved `mode: "force"` stays in storage and applies again if the viewer picks fixed.
- **Selection: fixed** is unchanged: bad-only replaces only PCDN with the fixed host, force sends everything to it, and there is no engine.
- **自动切换线路 / Auto-switch servers** (was 自动恢复 / Auto-recover) turns switching on and off. Off, auto keeps the PCDN handling and keeps measuring, but races only when the viewer presses 测试其他线路.
- **改写 Akamai** applies to fixed selection only. In auto, the issued Akamai URL is a candidate like any other and is measured.
- **还在卡？再加把劲** goes. It saved force mode for good after one stall and reloaded the page. In its place, 测试其他线路 starts one race and saves nothing (see [Decisions](#decisions)).

Removed from the auto path: `scheduleProbe` and `probeHost`, the `biliAccelerator.rank.*` cache, `rotateTarget` and `rotateCursor`, `recovery.avoidHost`, `enrichBackups`, and the use of `config.pcdnHost` as a runtime target. A schema bump deletes the old rank keys. `rankHosts` stays in core for the live-room work, which plans to rank race results with it.

### Diagnostics and panel

The report gains a `session` block that carries no URL beyond a bare host: the issued hosts per representation, the required rate, per host the requests, bytes, goodput and median first-byte time, every race (challengers, bytes, times, winner), every switch (from, to, trigger, rates before and after), synthetic timeouts, and whether routing was released.

The panel says what was measured and what was done:

| state | 中文 | English |
| --- | --- | --- |
| on the assigned host | 播放流畅 · B 站分配的线路 · 海外 · 腾讯云 · 32.4 Mbps | Playing smoothly · Bilibili's assigned server · Overseas · Tencent Cloud · 32.4 Mbps |
| switched | 播放流畅 · 已切换到 大陆 · 阿里云 · 0.9 → 16.5 Mbps | Playing smoothly · Switched to Mainland · Alibaba Cloud · 0.9 → 16.5 Mbps |
| racing | 正在测试其他线路… · 当前片段下载过慢 | Testing other servers… · This part of the video is downloading too slowly |
| nothing better | 网络较慢 · 已比较 3 条线路，当前线路最快 · 2.1 Mbps | Slow network · Compared 3 servers; this one is fastest · 2.1 Mbps |
| stalled, host fine | 缓冲中 · 线路速度正常，等待播放器缓冲 | Buffering · The server is keeping up; waiting for the player |

Hosts are named by region and cloud, not by hostname. The counter under the status counts switches on this video (本视频切换了 1 次线路), or failing that the P2P nodes kept out of playback; the field report's page had shown 已修复 1594 个慢连接, which counted rewritten URLs.

### What the viewer sees

- **Popular videos behave as if the extension were off.** Nothing is probed at page load and nothing is rewritten, so startup is exactly the player's own. The first fragment from the assigned edge shows it is fast and the engine never races.
- **A cold video recovers in about two seconds instead of stalling.** On a real player with a slow assigned host: the stuck fragment was noticed 0.9 s after it started, the race took 0.7 s, and the player's retry finished on the winner half a second later. Left alone, that fragment needed about 15 s.
- **No flapping.** A host that works is kept for the rest of the video. A race that finds nothing clearly faster changes nothing and waits longer before the next one, so a slow network produces one clear message, not a stream of switches.
- **Nothing reloads and nothing is saved behind the viewer's back.** Switching happens between two fragment requests. Settings change only when the viewer changes them.
- **One button, only when it can help.** 测试其他线路 appears after a stall or when the server measures short. Its result replaces the status line for a few seconds, including "this one is already fastest".
- **Fewer settings to misread.** In auto mode the rows that no longer apply (适用范围, 改写 Akamai) are hidden. 自动恢复 is renamed 自动切换线路 and says what it does.

### Failure modes

| failure | handling |
| --- | --- |
| the player changes its loader | synthetic timeouts are skipped unless `ontimeout` is a function property; routing and measurement don't depend on it |
| a synthetic timeout confuses the player | at most one per range and four per session; Phase 3 watches for player error toasts and `downloadError` |
| mainland connection setup fails | the race filters it out; two failures mark the host failed for the session |
| signed URLs expire | the player fetches a new playurl, and the session table is rebuilt from it |
| every path is congested | the race finds nothing clearly faster, and nothing changes |
| background tab | no races or switches while hidden; samples that overlap a hidden period are dropped |

## Not doing

- **Racing every fragment on two hosts.** It would follow the fastest host fragment by fragment, and double both the viewer's traffic and Bilibili's origin pulls.
- **Reordering `backupUrl` instead of routing.** The player only moves on errors and timeouts, so a better order doesn't help with a slow host.
- **A standing preference for either tier.** In the tables above each tier wins, depending on the video and the hour.
- **Warming edges or prefetching.** Only the race range is fetched twice.
- **Live rooms.** They have their own design in progress. The session table and the race could be shared later.

## Plan

### Phase 1: design review (this PR)

Done: the open decisions were delegated and are recorded above.

### Phase 2: implementation, on this PR (done)

- core: the session table (representations, issued URLs, the mapping), the goodput and in-flight estimates, trigger evaluation, race selection with hysteresis, history decay. All pure and unit-tested, as `rankHosts` is today.
- page: `setRequestHeader` and `progress` in the XHR hook, routing by session, the race, the synthetic timeout, the settings and panel changes, the diagnostics block, the schema bump.
- tests, in the vm harness (`test/v2-page.test.js`): native until a trigger; one race per trigger; Akamai reached through its issued URL and mirrors through host swaps; a retry routed away from a failing host; at most one synthetic timeout per range and four switches per session; nothing while hidden; nothing written to the saved config; fixed selection unchanged; PCDN and MCDN unchanged; live pages untouched; no URL in the diagnostics.

### Phase 3: validation (in progress)

Chromium through the iframe harness (two runs above), and Safari with the build installed. Logged in, highest quality. Two popular and two cold videos, five minutes each, off-peak and between 20:00 and 23:00 Beijing (05:00–08:00 PDT), against the extension turned off and against v0.4.1 on default settings.

Acceptance:

- cold videos: total stall time and stall count no worse than with the extension off, and at least halved relative to v0.4.1;
- popular videos: no switches and no change in startup time relative to the extension off;
- at most two switches per video in 95% of sessions;
- no player error toast caused by a synthetic timeout, in either browser;
- no switch while the tab is hidden.

Then 0.5.0.

## Decisions

The maintainer delegated these on 2026-09-27. Each follows from the measurements above.

1. **`mode` is ignored under auto and its row hidden; fixed selection keeps it.** Force plus auto was the configuration that did the most damage in the field report, and its purpose, getting off a mediocre assigned host, is what the engine now does with evidence. A saved `force` stays in storage and applies again under fixed selection, where "send everything to this server" is a meaningful request. The row is renamed 适用范围 with options 仅 P2P/PCDN 节点 and 所有视频请求, which is what it means there.
2. **The boost button is replaced by 测试其他线路.** A viewer who sees stutter should have something to press that acts now and shows a result. The old button silently saved a permanent setting and reloaded the page, losing the playback position. The new one runs one race under the same rule as an automatic race, saves nothing, and appears only after a stall or when the server measures short. Manual tests are spaced ten seconds apart.
3. **Synthetic timeouts are on, with a self-check.** They are verified on the real player in Chromium, and nothing in them is browser-specific beyond `abort()`. Because Safari is unverified, the page watches for the player's retry of the same range within 3 s after each one; if it doesn't come, synthetic timeouts are switched off for the page and the report records it. The worst case is one missed retry per page, after which switches apply to later requests only. Only a first attempt of a range is ever ended this way.
4. **No history-driven race on the first fragment, for now.** The first-fragment check already catches a cold host within about a second, so the gain would be about a second on some starts, paid for with a race before there is any evidence. It can be added once field reports show startup is where time is lost. Host history is still kept; it orders challengers.
5. **`rewriteAkamai` has no effect under auto and its row is hidden there.** The Akamai URL Bilibili issues is one of the two assigned hosts and was the fastest host for one cold video; rewriting it away, as the field report's config did, removed a good candidate. It keeps its meaning under fixed selection.

## Implementation notes

Where the code refines the proposal, and why:

- **Races are decided at the first finisher**, not after a grace period. In the first real-page run the 300 ms grace was half the time between detecting a stuck fragment and the player's retry completing.
- **Unknown hosts score as the lower median and ties go to mainland mirrors** (see [Choosing](#choosing-the-next-host)). The pool's order would otherwise have made `mirroraliov`, the worst host for US viewers, every new viewer's first choice.
- **A host counts as measured only after 128 KB.** The player fetches init and index segments of a few KB from both issued hosts; counting those as measurements kept Akamai out of the first challenger slot.
- **The engine ticks only after a video fragment has been requested, only on player pages, and never in a hidden tab.** Home-page hover previews load playurls too.
- **The required rate only goes up within a video.** It is the highest video bitrate the player has requested, so auto quality can't hide a slow host by stepping down. A viewer who lowers the quality by hand is still judged against the higher one, which can cost an extra race; bounded by the cooldowns.
- **Routing state lives in the page.** A schema bump (4) resets an auto config's saved `pcdnHost`, which 0.4.x rotation could leave pointing at any host, and the 0.4.x ranking caches are deleted at boot.

## Validation so far

- `src/core/routing.js` holds the decisions as pure functions (19 tests in `test/routing.test.js`). `test/v5-engine.test.js` drives the page script end to end with an XHR shaped like the player's loader, a fake clock, a `<video>` with a buffer, and races (17 tests). The suite runs 113 tests.
- **Chromium, real player, logged in, highest quality**, with the assigned host made slow by pointing the page's playurl at `mirroraliov` (1–2 Mbps for any file from this network). Two runs on two cold videos:

| | run 1 (1080P, 1.6–2 MB fragments) | run 2 (720P, 1–1.7 MB fragments) |
| --- | --- | --- |
| stuck fragment noticed after | ~1.9 s | 0.9 s |
| race | `mirrorali` 768 KB in 272 ms, `tf-all-hw` cut | `mirrorali` 768 KB in 717 ms, Akamai still running |
| player's retry on the winner | 1.66 MB in 282 ms | 1.65 MB in 529 ms |
| after the switch | 22–47 Mbps per fragment, buffer 8.6 → 70 s in 8 s | 16.5 Mbps estimate, buffer 4 → 70 s in 24 s |
| stalls after startup | none | none |
| synthetic timeouts / retries seen | 1 / 1 | 1 / 1 |

- Control: the first attempt at run 1 happened in a background tab, where the engine stands aside by design. With the same slow host, the player sat at a startup stall for about 13 s, fetching a 2 MB fragment at 2.1 Mbps.
- On the same cold video with the real assignment (`mirrorcosov`, 4.6 Mbps against 3.2 needed, around 08:00 Beijing), the engine did not race, as intended.
- Not yet: Safari with the build installed, and Beijing's evening peak.

## Reproducing

- `scripts/research/vod-hosts.mjs` runs one measurement round from a terminal, logged out, at the qualities a logged-out viewer gets (480P and below). For a popular, a moderately watched and a freshly uploaded video it records Bilibili's assignment, replicates the shipped probe, and makes three sequential 512 KB range requests per host at a random offset, over one connection per host. With `--harvest-cold 40` it prints a list of fresh uploads instead.
- `scripts/research/vod-hosts.page.js` does the same inside a logged-in `bilibili.com` tab at the highest quality the account can play, with 768 KB requests, and repeats every three hours, or every 30 minutes during Beijing's evening peak. Set `window.__measConfig.cold` to the harvested list first, paste the script into the console, and read `window.__meas` later.
- The iframe harness runs a build, or a test hook, at document start on a real video page: fetch the page's HTML with credentials, insert the script at the top of `<head>`, and `document.write` the result into a full-viewport same-origin iframe. It works in Chromium. In WebKit the frame's media requests go out without a `Referer` and fail, so Safari needs the build installed.
- The player facts come from `s1.hdslb.com/bfs/static/player/main/core.ba67b466.js`: the fragment loader and its timeouts are in the `HTTPLoader` and `XHRLoader` factories, and the retry defaults in `MediaPlayerModel`.

Neither script writes a URL or query string into its results.

## Limits

- One network, US West. Viewers in Japan, Southeast Asia or Europe may get other hosts assigned; history is what adapts to that.
- Peak hours in China aren't in these tables yet. The loop that covers them is running.
- The synthetic timeout is verified in Chromium only; in Safari it is guarded by the retry self-check.
- Several per-host numbers are single samples. They show large gaps, not calibrated thresholds. The 1.2×, 1.3× and two-thirds factors are starting points for Phase 3 to tune.
