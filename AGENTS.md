# MusicFreeDesktop

插件化音乐播放器。已从 Electron（electron-forge + webpack）移植到 Tauri v2（2026-10 起，master 原地推进）：`src-tauri/` + Vite 多入口为唯一构建链路，Electron 旧链路（`config/`、`forge.config.ts` 等）已全量移除（bdf504b）。

## 动手前必读

- `.zcode/plans/20261020-tauri移植工作记录.md` — 决策 D1-D41、各阶段实现细节、遗留优化（CSP null、chunk 分割等）
- `.zcode/plans/20261020-tauri移植人工回归清单.md` — ~30 项 OS 级/真实网络人工回归
- 移植涉及敏感区（plugin-bridge、thumbbar、tray、启动时序）时先查以上两份。

## 命令

- 开发：`npm run tauri dev`（beforeDevCommand 自动起 vite:5173）
- 构建：**只走 `npm run tauri build`**。直接 `cargo build --release` 不带 `custom-protocol` feature 会做成 dev 版连 localhost:5173 报错。后台跑要 `set -o pipefail`（防管道 tail 吞非零退出码）
- 仅前端：`npm run build:vite`；类型检查：`npx tsc --noEmit`；lint：`npm run lint`
- **禁止 pnpm/yarn**（2026-11-01 事故：`pnpm tauri build` 触发自动 install 拆坏 npm 布局的 node_modules）。以 package-lock.json 为准；带 postinstall 二进制的包用 `npm i --ignore-scripts`
- 本机 Rust：默认工具链 1.98.1（stable 的 rustc 损坏）；cargo 走 rsproxy 镜像

## 架构边界

- renderer 组件**不直接调 Tauri API**：统一经 `shared/<模块>/renderer.ts` → `window` 命名空间（`@shared` 别名），Tauri 实现在 `src/shared/tauri/`
- 插件在隐藏 iframe `plugin-runtime.html` 中执行，主 frame 与 iframe 通过 `plugin-bridge.ts` 通信；WebView2 会丢弃/重载隐藏 iframe，`isConnected` 恒真不可作存活判断——改此处注意自愈重载逻辑（commit 04d2397）
- `callPluginMethod` 插件方法返回 null 必须有分页兜底（`fallbackPluginResult`），原版 Electron 主进程有、透传会崩
- Rust 侧模块在 `src-tauri/src/`：lib.rs（窗口/生命周期）、mediahub（音频流）、thumbbar/tray/smtc（OS 集成）、plugin_http、paths（数据/资源目录）
- 前端 `PlayerState` 是**数字枚举**（None=0/Playing=1/Paused=2），跨 IPC 传给 Rust 后禁止字符串比较（用 `player_state_name` 解析）
- 别名：`@`→src、`@renderer`、`@renderer-lrc`、`@renderer-minimode`、`@shared`（vite.config.ts 与 tsconfig 同步维护）；入口四页 index/lrc/minimode/plugin-runtime 增删须两处对齐

## 已知坑

- 用户实际部署形态是**单 exe 拷贝**（如 `D:\Tools\musicfree-desktop.exe`）：Tauri v2 Windows 的 `resource_dir()` = exe 所在目录，exe 旁缺 `res/` 会静默丢 thumbar/托盘图标——OS 集成图标已改 `include_bytes!` 内嵌，新增外部资源文件时沿用此法
- 主窗口尺寸持久化在 `%APPDATA%/fun.upup.musicfree/config.json` 的 `private.mainWindowSize`；Resized 事件必须带 minimized/maximized 门禁+防抖，否则最小化写脏值致下次启动"胶囊窗口"
- Electron 引擎普通页面右键本无菜单，Tauri/WebView2 有——contextmenu 拦截在 bootstrap.ts（捕获阶段 preventDefault，可编辑元素放行）
- 首帧渲染不得被插件加载阻塞（清单缓存 plugin-manifest.json + 懒加载）；restoreCurrentMusicIfNeeded/useBootstrap 对插件就绪时序敏感
- 诊断脚本 `scripts/cdp-*.mjs`：需 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=922x` 启动应用后连接，留作启动性能/播放回归工具

## 约定

- 4 空格缩进，`@stylistic` 管风格，提交前 husky+lint-staged 跑 `npm run lint`
- commit message 用中文，不加 Co-Authored-By；未经许可不建分支、不 push
