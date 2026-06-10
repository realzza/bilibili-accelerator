# Bilibili Accelerator：海外 B 站加速

[English](./README.en.md)

海外看 B 站，热门视频通常还行，冷门视频却经常一会儿流畅、一会儿卡死。

**Bilibili Accelerator** 是一个用户脚本。它会在播放器开始缓冲前，自动改写 Bilibili 返回的慢 CDN 播放地址，专治海外网络下常见的 `upos-*ov` 海外镜像、MCDN/PCDN 节点和糟糕路由。

## 立即安装

推荐从 Greasy Fork 安装，Chrome、Safari、Firefox、Edge 都可以用。

- [Greasy Fork 官方脚本页](https://greasyfork.org/en/scripts/582026-bilibili-accelerator)
- [直接安装 `.user.js`](https://update.greasyfork.org/scripts/582026/Bilibili%20Accelerator.user.js)
- [GitHub Raw 备用源](https://raw.githubusercontent.com/realzza/bilibili-accelerator/main/dist/bilibili-accelerator.user.js)
- [GitHub Release v0.1.1](https://github.com/realzza/bilibili-accelerator/releases/tag/v0.1.1)

装好后打开任意 B 站视频。右下角出现 `BA` 按钮，就说明脚本已经生效。

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

正常 CDN 默认不动。遇到特别顽固的视频，可以点右下角 `BA`，开启 `Force all video CDN` 后刷新。

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

## 为什么值得 Star

如果你也在海外看 B 站，这个项目能把很多“玄学卡顿”变成一个可控开关。
