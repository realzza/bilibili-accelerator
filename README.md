# 海外b站，为什么这么慢

海外看 B 站，冷门视频不该像抽卡一样一会儿流畅、一会儿卡死。

这个小插件会在播放器开始缓冲前，自动改写 Bilibili 返回的慢 CDN 播放地址。它主要处理海外用户常见的卡顿源：`upos-*ov` 海外镜像、MCDN/PCDN 节点，以及某些对你所在网络路由很差的播放 host。

## 一句话安装

装一个用户脚本管理器，然后点安装：

- Tampermonkey / Violentmonkey / Userscripts：
  [安装 GitHub 版](https://raw.githubusercontent.com/realzza/bilibili-accelerator/main/dist/bilibili-accelerator.user.js)
- GitHub Release：
  [下载 v0.1.1](https://github.com/realzza/bilibili-accelerator/releases/tag/v0.1.1)
- Greasy Fork：
  已准备发布，等 Greasy Fork 账号登录完成后补官方页面链接

装好后打开任意 B 站视频，右下角出现 `BA` 按钮，就说明生效了。

## Safari 安装

1. 安装 Safari 扩展 [Userscripts](https://apps.apple.com/us/app/userscripts/id1463298887)。
2. 在 Safari 设置里启用 Userscripts，并允许访问 `bilibili.com`。
3. 打开：

```text
https://raw.githubusercontent.com/realzza/bilibili-accelerator/main/dist/bilibili-accelerator.user.js
```

4. Userscripts 会提示安装。安装后刷新 B 站视频页。

## Chrome 安装

推荐用 Tampermonkey：

1. 安装 [Tampermonkey](https://www.tampermonkey.net/) 或 [Violentmonkey](https://violentmonkey.github.io/)。
2. 打开：

   ```text
   https://raw.githubusercontent.com/realzza/bilibili-accelerator/main/dist/bilibili-accelerator.user.js
   ```

3. Tampermonkey 会弹出安装页，点 Install。
4. 打开 B 站视频页。

也可以用解压扩展方式：

1. 运行：

   ```sh
   npm run build
   ```

2. 打开 Chrome 扩展管理页：

   ```text
   chrome://extensions
   ```

3. 开启「开发者模式」。
4. 点击「加载已解压的扩展程序」。
5. 选择：

   ```text
   dist/extension
   ```

## 它到底改了什么

Bilibili 会给同一个视频返回多条带签名的媒体 URL。海外网络下，冷门视频常被分到这种地址：

```text
upos-sz-mirrorcosov.bilivideo.com
xy153x35x231x78xy.mcdn.bilivideo.cn:8082
```

插件会把这些慢路径换成更稳的播放路径，默认类似这样：

```text
upos-sz-mirrorcos.bilivideo.com
proxy-tf-all-ws.bilivideo.com
```

正常 CDN 不会乱动。除非你在 `BA` 面板里打开 `Force all video CDN`。

## 已测卡顿样本

这个视频曾被反馈特别卡：

```text
https://www.bilibili.com/video/BV1NnVK6cEXs
```

页面播放数据里返回了 `upos-sz-mirrorcosov.bilivideo.com`。插件会自动改成 `upos-sz-mirrorcos.bilivideo.com`。

## 开发

```sh
npm test
npm run build
```

输出文件：

```text
dist/bilibili-accelerator.user.js
dist/extension/
```

## 发布

- GitHub raw 安装源：
  `https://raw.githubusercontent.com/realzza/bilibili-accelerator/main/dist/bilibili-accelerator.user.js`
- GitHub Release：
  `https://github.com/realzza/bilibili-accelerator/releases/tag/v0.1.1`
- Tampermonkey：
  打开 GitHub raw 安装源即可触发安装页。
- Greasy Fork：
  发布包已准备好；Greasy Fork 当前需要账号登录/OAuth 后才能创建脚本页面。

## 为什么值得 Star

因为人在海外，看 B 站也应该是在看视频，不是在修网络。
