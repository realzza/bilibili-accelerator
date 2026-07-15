# Bilibili Accelerator

[English](./README.en.md)

Bilibili Accelerator 是一个面向 B 站网页端的用户脚本，主要处理海外网络下冷门视频命中慢速 CDN、MCDN/PCDN 节点后反复缓冲的问题。脚本只改写可疑的播放地址，正常 CDN 默认不动。

| ☀️ 浅色 | 🌙 深色 |
| :---: | :---: |
| <img src="docs/assets/panel-light.jpg" alt="Bilibili Accelerator 浅色面板" width="360"> | <img src="docs/assets/panel-dark.jpg" alt="Bilibili Accelerator 深色面板" width="360"> |

## 安装

推荐通过 Greasy Fork 安装用户脚本：

- [Greasy Fork 脚本页](https://greasyfork.org/en/scripts/582026-bilibili-accelerator)
- [直接安装 `.user.js`](https://update.greasyfork.org/scripts/582026/Bilibili%20Accelerator.user.js)
- [GitHub Raw 备用地址](https://raw.githubusercontent.com/realzza/bilibili-accelerator/main/dist/bilibili-accelerator.user.js)
- [GitHub Releases](https://github.com/realzza/bilibili-accelerator/releases/latest)

Chrome、Edge 和 Firefox 安装 [Tampermonkey](https://www.tampermonkey.net/) 或 [Violentmonkey](https://violentmonkey.github.io/) 后，打开 Greasy Fork 页面安装即可。装好后刷新 B 站视频页，右下角出现 ⚡ 图标就说明脚本已经加载。

### Safari

1. 安装 Safari 扩展 [Userscripts](https://apps.apple.com/us/app/userscripts/id1463298887)。
2. 在 Safari 设置中启用 Userscripts，并允许访问 `bilibili.com`。
3. 打开 Greasy Fork 脚本页或 GitHub Raw 地址完成安装。
4. 刷新已经打开的 B 站页面。

### 加载本地扩展

仓库同时提供 Chrome / Edge 可加载的 Manifest V3 扩展：

```sh
npm run build
```

然后打开 `chrome://extensions`，开启「开发者模式」，选择 `dist/extension`。

## 工作方式

B 站通常会为同一段视频返回多条带签名的媒体地址。海外网络下，问题地址常见于：

```text
upos-sz-mirrorcosov.bilivideo.com
xy153x35x231x78xy.mcdn.bilivideo.cn:8082
```

脚本会在播放器发起分片请求前识别这些地址，并按当前配置切到更稳的官方 CDN 或代理线路，例如：

```text
upos-sz-mirrorcos.bilivideo.com
proxy-tf-all-ws.bilivideo.com
```

默认行为：

- 只处理已知慢镜像、MCDN/PCDN、异常端口和带 `os=mcdn` 的播放节点。
- 自动探测候选 CDN，按当前地区缓存可用线路；也可以在高级设置中固定服务器。
- 播放持续缓冲时自动轮换线路，不需要刷新页面或重新找进度。
- 直播地址（`/live-bvc/`）不会被改写到点播服务器；脚本只从直播线路列表中过滤明显的 PCDN/MCDN 节点，并保留最后一个可用地址。
- `fetch`、`XMLHttpRequest`、页面播放数据和清晰度切换都走同一套改写逻辑。

## 面板与设置

- 面板显示当前状态、已处理连接数和实时下载速度；拿不到字节数时会显示前方缓冲时长。
- 明暗模式默认跟随系统。点击顶部的日 / 月按钮后，会保存为明确的浅色或深色设置。
- 高级设置提供 7 套主题色：哔哩蓝、青碧、翠绿、星紫、少女粉、落日橙和石墨灰。
- 「还在卡？再加把劲」会切到更积极的改写策略，并刷新当前页面。
- 可选的带宽保护会阻止 B 站 P2P SDK 和 WebRTC 上传入口，开启后需要刷新页面。
- 网页全屏时 ⚡ 图标会淡出；把鼠标移到右下角即可重新唤出。

## 遇到问题

先确认页面右下角有 ⚡ 图标。刚安装或更新后，需要刷新已经打开的 B 站页面。

如果仍然卡顿，打开「高级设置」，点击「复制诊断报告」，然后在 [Issues](https://github.com/realzza/bilibili-accelerator/issues) 中附上视频地址、所在地区和具体现象。诊断报告只保留域名与改写原因，不包含带签名参数的完整媒体 URL。

## 限制

- 这个项目只处理浏览器中的 B 站网页播放器，不直接支持 Apple TV 或手机 App。
- CDN 状态会随地区和运营商变化；脚本能绕开已知慢线路，但不能解决版权区域限制、源文件异常或本地网络故障。
- 软路由方案及原生 App 的证书限制见 [docs/router-proxy.md](docs/router-proxy.md)。

## 开发

```sh
npm test
npm run build
```

构建产物：

```text
dist/bilibili-accelerator.user.js
dist/extension/
```

`package.json` 是版本号的唯一来源；构建脚本会同步用户脚本头和扩展 manifest。提交前请确保重新构建后的 `dist/` 没有未提交差异。

## License

[MIT](./LICENSE)
