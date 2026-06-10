import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const dist = path.join(root, "dist");
const extensionDist = path.join(dist, "extension");

const core = await readFile(path.join(root, "src/core/rewrite.js"), "utf8");
const page = await readFile(path.join(root, "src/page/bili-accelerator.page.js"), "utf8");
const content = await readFile(path.join(root, "src/extension/content.js"), "utf8");
const manifest = await readFile(path.join(root, "src/extension/manifest.json"), "utf8");

const userscriptHeader = `// ==UserScript==
// @name         Bilibili Accelerator
// @name:zh-CN   Bilibili Accelerator - B站海外播放加速
// @namespace    https://github.com/realzza/bilibili-accelerator
// @version      0.1.2
// @description  Rewrite slow Bilibili playback CDN URLs for smoother overseas playback.
// @description:zh-CN 自动改写 B 站慢 CDN 播放地址，缓解海外用户看冷门视频时的卡顿。
// @author       realzza
// @license      MIT
// @homepageURL  https://github.com/realzza/bilibili-accelerator
// @supportURL   https://github.com/realzza/bilibili-accelerator/issues
// @match        https://*.bilibili.com/*
// @match        https://*.bilibili.tv/*
// @run-at       document-start
// @grant        none
// ==/UserScript==
`;

await rm(dist, { recursive: true, force: true });
await mkdir(extensionDist, { recursive: true });

await writeFile(path.join(dist, "bilibili-accelerator.user.js"), `${userscriptHeader}\n${core}\n${page}\n`);
await writeFile(path.join(extensionDist, "bili-accelerator.page.js"), `${core}\n${page}\n`);
await writeFile(path.join(extensionDist, "content.js"), content);
await writeFile(path.join(extensionDist, "manifest.json"), manifest);
await copyFile(path.join(root, "README.md"), path.join(dist, "README.md")).catch(() => {});
await copyFile(path.join(root, "README.en.md"), path.join(dist, "README.en.md")).catch(() => {});

console.log("Built dist/bilibili-accelerator.user.js and dist/extension");
