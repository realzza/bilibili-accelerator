# 软路由 / Apple TV / 手机 App 加速：可行性说明

> Router-level acceleration for native apps — feasibility notes.

很多用户问：能不能把这个加速能力放进软路由，让 **Apple TV、手机 B 站 App** 上看视频也受益？

简短回答：**网页端可以，原生 App 基本不行。** 下面说明原因，方便有动手能力的用户自己评估。

## 这个脚本是怎么工作的

脚本运行在 `bilibili.com` 网页里，劫持页面的 `JSON.parse` / `fetch`，在播放器开始缓冲**之前**把返回的慢 CDN 播放地址改掉（见 [`src/core/rewrite.js`](../src/core/rewrite.js)）。

关键点：它依赖「能在页面里注入 JavaScript」。Apple TV、手机原生 App 不跑我们的 JS，所以唯一能帮它们的办法是**在网络层改写**——也就是在路由器上做透明代理，拦截播放 API 的 HTTPS 响应，套用同样的改写逻辑。

## 难点

1. **HTTPS MITM（中间人）**
   播放接口是 HTTPS。要在路由器上读取并改写响应体，必须做 MITM，并在**每一台设备**上安装自签根证书。
   - Apple TV 安装并信任自定义根证书非常麻烦（没有简单入口）。
   - 手机端虽然能装证书，但仍有第 2 点。

2. **证书固定（Certificate Pinning）**
   B 站原生 App 很可能对自家域名做了证书固定。一旦固定，即使装了根证书，MITM 也会被 App 拒绝，改写**无法生效**。网页（浏览器）不做这种固定，所以网页端可行。

3. **这是另一个产品**
   路由器方案是一套 OpenWrt / sing-box / mitmproxy 插件，和用户脚本是两条独立的工程路线，维护成本完全不同。

## 现实的结论

| 场景 | 可行性 |
| --- | --- |
| 路由器后面用**浏览器**看 B 站（电脑 / 平板 Safari、Chrome） | ✅ 可行，但直接装本脚本更简单，无需路由器 |
| Apple TV B 站 App | ❌ 证书安装困难 + 大概率证书固定 |
| 手机 B 站 App | ⚠️ 需自装根证书；若 App 做了证书固定则无效 |

好消息是 [`src/core/rewrite.js`](../src/core/rewrite.js) 是**纯函数、可复用**的：如果有人想在 OpenWrt 上用 mitmproxy 给网页端做改写，可以直接复用这套规则。但因为上面的限制，我们不会把它做进用户脚本的发布里，也不承诺「Apple TV 开箱即用」。

如果你在这方面有实战经验（尤其是绕过/确认 B 站 App 证书固定的情况），欢迎来 [Issues](https://github.com/realzza/bilibili-accelerator/issues) 讨论。

---

## English summary

The script works by injecting JS into the `bilibili.com` page and rewriting the playback CDN URLs before buffering. Native apps (Apple TV, mobile B站 app) don't run our JS, so the only path is **router-level HTTPS MITM** that rewrites the playurl API response.

That runs into two hard walls:

1. **HTTPS MITM needs a custom root CA installed on every device** — painful on Apple TV.
2. **The native app likely uses certificate pinning**, which defeats MITM even with the CA installed. Browsers don't pin, which is why the web case works.

So: browser-behind-a-router is doable (but just installing the userscript is simpler), while the Apple TV / mobile-app case is not something we can ship reliably. The core rewrite logic in [`src/core/rewrite.js`](../src/core/rewrite.js) is pure and reusable for anyone who wants to build a mitmproxy rule set for the web case. Experiences with the app's pinning are welcome in the issue tracker.
