# Bilibili Accelerator：海外 B 站加速

[English](./README.en.md)

海外看 B 站，热门视频通常还行，冷门视频却经常一会儿流畅、一会儿卡死。

**Bilibili Accelerator** 是一个用户脚本。它会在播放器开始缓冲前，自动改写 Bilibili 返回的慢 CDN 播放地址，专治海外网络下常见的 `upos-*ov` 海外镜像、MCDN/PCDN 节点和糟糕路由。

## 立即安装

推荐从 Greasy Fork 安装，Chrome、Safari、Firefox、Edge 都可以用。

- [Greasy Fork 官方脚本页](https://greasyfork.org/en/scripts/582026-bilibili-accelerator)
- [直接安装 `.user.js`](https://update.greasyfork.org/scripts/582026/Bilibili%20Accelerator.user.js)
- [GitHub Raw 备用源](https://raw.githubusercontent.com/realzza/bilibili-accelerator/main/dist/bilibili-accelerator.user.js)
- [GitHub Release v0.2.1](https://github.com/realzza/bilibili-accelerator/releases/tag/v0.2.1)

装好后打开任意 B 站视频。右下角出现 ⚡ 小图标，就说明脚本已经生效。

## Chrome / Edge

1. 安装 [Tampermonkey](https://www.tampermonkey.net/) 或 [Violentmonkey](https://violentmonkey.github.io/)。
2. 打开 [Greasy Fork 脚本页](https://greasyfork.org/en/scripts/582026-bilibili-accelerator)。
3. 点击 Install。
4. 刷新 B 站视频页。

也可以加载解压扩展：

```sh
npm run build
```

然后打开 `chrome://extensions`，开启「开发者模式」，选择 `dist/extension`。

## Safari

1. 安装 Safari 扩展 [Userscripts](https://apps.apple.com/us/app/userscripts/id1463298887)。
2. 在 Safari 设置里启用 Userscripts，并允许访问 `bilibili.com`。
3. 打开 [Greasy Fork 脚本页](https://greasyfork.org/en/scripts/582026-bilibili-accelerator) 或 [GitHub Raw 备用源](https://raw.githubusercontent.com/realzza/bilibili-accelerator/main/dist/bilibili-accelerator.user.js)。
4. Userscripts 提示安装后，刷新 B 站视频页。

## 它改了什么

Bilibili 会给同一个视频返回多条带签名的媒体 URL。海外网络下，冷门视频常被分到这些地址：

```text
upos-sz-mirrorcosov.bilivideo.com
xy153x35x231x78xy.mcdn.bilivideo.cn:8082
```

脚本会把慢路径换成更稳的播放路径，默认类似：

```text
upos-sz-mirrorcos.bilivideo.com
proxy-tf-all-ws.bilivideo.com
```

正常 CDN 默认不动。遇到特别顽固的视频，可以点右下角 ⚡ 图标，按 **Still buffering? Boost harder（再加把劲）**。

网页全屏时 ⚡ 图标会自动淡出，不挡视频；把鼠标移到右下角即可重新唤出。

## 0.2 新功能

0.2 是一次大升级，重点是「自动识别更多慢节点」并且「尽量不打扰你」：

- **能抓 B 站新出的隐藏 PCDN**（例如 `*.edge.mountaintoys.cn`）：凡是用了奇怪端口或带 `os=mcdn` 的播放节点都按慢节点处理，不再依赖一份要不断更新的域名清单。
- **覆盖所有请求路径**：在 `fetch`、`JSON.parse`、页面全局变量之外，新增 `XMLHttpRequest` 拦截，切清晰度、看番剧不再漏网。
- **自动挑最快的服务器**：自动探测候选节点，按你所在区域记住最快的那个，而不是把所有人都钉死在一个固定地址。
- **卡顿自动恢复**：缓冲时实时切换服务器，无需刷新页面。
- **大白话面板**：一个状态（流畅播放 / 正在找更快的服务器）、一个开关、一个「再加把劲」按钮。所有老选项都收进 **Advanced settings（高级设置）**。
- **可选的带宽保护**：阻止 B 站通过 WebRTC P2P 占用你的上传带宽（默认关闭）。
- **浏览器扩展新增工具栏弹窗与设置同步。**
- **实时速度图** *(0.2.1)*：面板内置实时下载速度曲线，当 CDN 不暴露字节数时自动回退为缓冲时长。

## 已测样本

这个视频曾被反馈特别卡：

```text
https://www.bilibili.com/video/BV1NnVK6cEXs
```

页面播放数据返回了 `upos-sz-mirrorcosov.bilivideo.com`。脚本会自动改成 `upos-sz-mirrorcos.bilivideo.com`。

## 开发

```sh
npm test
npm run build
```

输出：

```text
dist/bilibili-accelerator.user.js
dist/extension/
```

## 软路由 / Apple TV / 手机 App？

经常有人问能不能放进软路由，让原生 App 也加速。结论和限制见 [docs/router-proxy.md](docs/router-proxy.md)：网页端可行，但 Apple TV / 手机 App 受证书安装与证书固定限制，基本做不到。

## 为什么值得 Star

如果你也在海外看 B 站，这个项目能把很多“玄学卡顿”变成一个可控开关。
