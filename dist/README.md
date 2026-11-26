# <img src="docs/assets/logo.svg" alt="" width="40" align="top">&nbsp;Bilibili Accelerator

[English](./README.en.md) · [Greasy Fork](https://greasyfork.org/en/scripts/582026-bilibili-accelerator) · 当前版本 v0.5.2

海外看 B 站，热门视频一般没什么问题，冷门视频经常一会儿流畅、一会儿卡死。

这个用户脚本用来改善这种情况：它在浏览器里观察播放过程，遇到明显不稳的连接时自动调整，并把实时下载速度显示在面板上。播放正常时不会介入。

| ☀️ 浅色 | 🌙 深色 |
| :---: | :---: |
| <img src="docs/assets/panel-light.jpg" alt="Bilibili Accelerator 浅色面板" width="360"> | <img src="docs/assets/panel-dark.jpg" alt="Bilibili Accelerator 深色面板" width="360"> |

## 安装

Chrome / Edge / Firefox 先装 [Tampermonkey](https://www.tampermonkey.net/) 或 [Violentmonkey](https://violentmonkey.github.io/)，然后从下面任意一个地址装脚本：

- [Greasy Fork 脚本页](https://greasyfork.org/en/scripts/582026-bilibili-accelerator)（推荐，能自动更新）
- [直接安装 `.user.js`](https://update.greasyfork.org/scripts/582026/Bilibili%20Accelerator.user.js)
- [GitHub Raw 备用地址](https://raw.githubusercontent.com/realzza/bilibili-accelerator/main/dist/bilibili-accelerator.user.js)
- [GitHub Releases](https://github.com/realzza/bilibili-accelerator/releases/latest)

装完刷新一下已经打开的 B 站页面。右下角出现 ⚡ 就说明脚本跑起来了。

### Safari

Safari 上没有 Tampermonkey，用 [Userscripts](https://apps.apple.com/us/app/userscripts/id1463298887) 这个扩展：

1. 从 App Store 装 Userscripts。
2. 在 Safari 设置里启用它，并允许访问 `bilibili.com`。
3. 打开上面的 Greasy Fork 或 GitHub Raw 地址完成安装。
4. 刷新已经打开的 B 站页面。

### 本地扩展（Chrome / Edge）

不想用脚本管理器的话，仓库也能直接构建成 Manifest V3 扩展：

```sh
npm run build
```

然后打开 `chrome://extensions`，开启「开发者模式」，选择 `dist/extension`。

扩展版比用户脚本多一项能力：B 站的视频服务器会在响应里注明数据是否来自节点缓存，但不让网页脚本读取，扩展可以读到。节点没有缓存、需要从源站转发时，扩展版能更早判断这条线路是否够快。为此扩展需要访问 `bilivideo.com` 和 `akamaized.net` 的权限，读到的信息只在本机页面里使用，不会保存或上传。

## 面板与设置

- 面板顶部是当前状态，下面是实时下载速度曲线。拿不到速度数据时，会退回显示前方缓冲了多少秒。
- 明暗跟随系统。点顶部的日 / 月开关之后，就变成你手动指定的浅色或深色。
- 高级设置里有 7 套主题色：哔哩蓝、青碧、翠绿、星紫、少女粉、落日橙、石墨灰。
- 状态栏注明当前使用的线路：原生线路（B 站为该视频分配的线路）或切换后的线路。实时速度只在下方的下载速度卡片中显示。
- 本视频卡过或线路速度不足时，面板提供「测试其他线路」：立即比较几条线路，只在明显更快时切换，不保存设置，也不刷新页面。
- 带宽保护默认关闭，开启后会限制页面占用你的上传带宽，需要刷新页面生效。
- 高级设置里的「多线路并行下载」是实验功能，默认关闭。开启后每段视频先照常从当前线路下载，这条线路跟不上时，再让另外一两条线路分担剩下的部分。实测平均速度和单线路差不多，但单线路卡死的请求能被其他线路救回来。
- 网页全屏时 ⚡ 会淡出，鼠标移到 ⚡ 附近就能重新唤出。
- 按住 ⚡ 可以拖到任意位置，松手后记住位置；拖到屏幕左右边缘会贴边半隐藏，鼠标移过去再滑出来。高级设置里「悬浮球」一栏的「复位」可以放回右下角。
- 高级设置里点「隐藏 · Alt+B」可以完全隐藏 ⚡，按 Alt+B（Mac 上是 Option+B）切换显示 / 隐藏。忘了快捷键的话，在控制台运行 `BiliAccelerator.showBadge()` 也行。

## 版本

完整说明见 [Releases](https://github.com/realzza/bilibili-accelerator/releases)。

| 版本 | 主要变化 |
| --- | --- |
| v0.5.2 | ⚡ 按钮可以拖动：按住拖到任意位置，拖到左右边缘贴边半隐藏，高级设置里可复位或隐藏，Alt+B 切换显示。新增实验功能「多线路并行下载」，默认关闭。扩展版能读到视频服务器的缓存状态，节点需要从源站转发时更早判断线路够不够快。比较备选线路时按北京时间的时段（夜间、白天、晚高峰）参考历史速度。修复 B 站把页面跳转到 /zh-Hans/video/ 这类带语言前缀的地址后，线路选择完全不工作的问题。面板修复：展开高级设置后最后一个主题色不再折到第二行；滚动条改为细的、跟随面板明暗的样式；「复制诊断报告」只有真正写入剪贴板后才提示已复制；用 `BiliAccelerator.setConfig()` 切换语言后面板完整重新翻译 |
| [v0.5.1](https://github.com/realzza/bilibili-accelerator/releases/tag/v0.5.1) | 面板加入状态动效：状态点、速度曲线和 ⚡ 按钮随播放状态变化，速度曲线逐帧平滑推进 |
| [v0.5.0](https://github.com/realzza/bilibili-accelerator/releases/tag/v0.5.0) | 线路改为按实测决定：每个视频先使用原生线路，速度不足时比较备选线路并切换到明显更快的一条；取消加载时测速、排序缓存和逐个轮换；「测试其他线路」取代「还在卡？再加把劲」 |
| [v0.4.1](https://github.com/realzza/bilibili-accelerator/releases/tag/v0.4.1) | 固定服务器改为下拉选择，可填写自定义地址，不再提供 Akamai |
| [v0.4.0](https://github.com/realzza/bilibili-accelerator/releases/tag/v0.4.0) | 修复后台播放卡住；候选服务器覆盖境内外两档并按实测吞吐排序；直播页 ⚡ 自动隐藏 |
| [v0.3.0](https://github.com/realzza/bilibili-accelerator/releases/tag/v0.3.0) | 面板深浅色 + 7 套主题色；顶部主题 / 语言改成同一套滑动控件。核心逻辑没动 |
| [v0.2.3](https://github.com/realzza/bilibili-accelerator/releases/tag/v0.2.3) | 直播场景的稳定性修复；探测逻辑更准确；卡顿恢复会持续重试 |
| [v0.2.2](https://github.com/realzza/bilibili-accelerator/releases/tag/v0.2.2) | 速度曲线按「数据真正在传输的时段」算，缓冲填满时不再假装掉到 0 |
| [v0.2.1](https://github.com/realzza/bilibili-accelerator/releases/tag/v0.2.1) | 面板加上实时下载速度曲线，拿不到速度数据时退回显示缓冲时长 |
| [v0.2.0](https://github.com/realzza/bilibili-accelerator/releases/tag/v0.2.0) | 大改版：自动优化播放连接、卡顿自动恢复、中英文面板、可选带宽保护 |
| [v0.1.3](https://github.com/realzza/bilibili-accelerator/releases/tag/v0.1.3) | 悬浮图标改成纯 ⚡，网页全屏自动淡出，不再压住全屏按钮 |
| [v0.1.2](https://github.com/realzza/bilibili-accelerator/releases/tag/v0.1.2) | 悬浮控件和设置面板重做 |
| [v0.1.1](https://github.com/realzza/bilibili-accelerator/releases/tag/v0.1.1) | 首个可直接安装的用户脚本版本 |

## 遇到问题

先看右下角有没有 ⚡。刚装完或刚更新的话，已经开着的 B 站页面必须刷新一次。

Chrome / Edge 上一直没有 ⚡，Tampermonkey 还提示「script hasn't run yet」或让你打开「allow user scripts」——这是新版 Tampermonkey（Manifest V3）的规矩，浏览器要你手动放行一次才让它注入脚本，跟本脚本无关。开一下就好：

- **Chrome**：进 `chrome://extensions`，点开 Tampermonkey 的「详细信息」，把「允许用户脚本」打开。老版本没这个开关的话，把右上角「开发者模式」打开就行。
- **Edge**：进 `edge://extensions/`，先开左下角「开发人员模式」，再点开 Tampermonkey 的「详细信息」，把「允许用户脚本」打开。找不到这个开关的话是 Edge 太旧了，更新一下再看。

还是卡的话，打开「高级设置」→「复制诊断报告」，然后带上视频地址、你所在的地区和具体现象发到 [Issues](https://github.com/realzza/bilibili-accelerator/issues)。报告只包含必要的诊断信息，不含带签名参数的完整媒体地址。

## 限制

- 只管浏览器里的 B 站网页播放器，Apple TV 和手机 App 不在范围内。
- 网络状况本身就随地区和运营商变。脚本能改善一部分情况，但解决不了版权地区限制、源文件本身有问题，或者你本地网络的锅。
- 软路由方案为什么基本不管用（以及原生 App 的证书固定问题），见 [docs/router-proxy.md](docs/router-proxy.md)。

## 开发

```sh
npm test
npm run build
```

`npm test` 是单元测试，不用装任何依赖。面板和页面钩子另有一组浏览器测试：把构建好的用户脚本注入一个本地伪造的视频页，在 Chromium 和 WebKit 里跑，不访问 B 站。

```sh
npm install
npx playwright install chromium webkit
npm run test:browser
```

构建产物：

```text
dist/bilibili-accelerator.user.js
dist/extension/
```

版本号只在 `package.json` 里改，构建脚本会同步用户脚本头和扩展 manifest。`dist/` 是提交进仓库的，CI 会检查它和 `src/` 是否一致，所以提交前记得重新构建。

## License

[MIT](./LICENSE)
