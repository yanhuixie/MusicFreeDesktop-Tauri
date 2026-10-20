/**
 * 插件运行时入口（阶段3 实装）
 *
 * 计划 §2：插件 JS 在主窗口隐藏 iframe 中执行，本页面即 iframe 载荷：
 * - require shim（白名单依赖打包浏览器版）
 * - Function() 执行插件源码
 * - axios polyfill → postMessage 请求代理（Rust 转发，无 CORS）
 * 阶段0 仅保留空壳占位。
 */

console.log("[plugin-runtime] stage-0 placeholder");
