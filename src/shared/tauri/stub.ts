/**
 * Tauri 迁移过渡层（阶段1 后剩余部分）
 *
 * Electron 版由 preload 向渲染进程注入 window["@shared/*"] 命名空间。
 * 阶段1 已将 app-config / global-context / i18n / utils / window-drag /
 * message-bus / logger 的 renderer.ts 内部改为直接调用 @tauri-apps/api，
 * 本文件现在仅注入仍走 window 命名空间的模块：
 * - path polyfill（node path 的 web 等价物，local-music/downloader 等使用）
 * - @shared/service-manager（阶段3）
 * - @shared/short-cut（阶段5 tauri-plugin-global-shortcut）
 */

const win = window as any;

/**************************** path polyfill ****************************/
// Electron 版注入了 node path；渲染层实际用到的方法如下（grep 确认）
win.path = {
    sep: "/",
    isAbsolute(p: string) {
        return /^([a-zA-Z]:)?[\\/]/.test(p);
    },
    resolve(...parts: string[]) {
        let result = "";
        for (const part of parts) {
            if (!part) continue;
            if (win.path.isAbsolute(part)) {
                result = part;
            } else {
                result = result ? `${result.replace(/[\\/]+$/, "")}/${part}` : part;
            }
        }
        return result.replace(/\//g, "\\");
    },
    relative(from: string, to: string) {
        const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
        const f = norm(from).split("/");
        const t = norm(to).split("/");
        let i = 0;
        while (i < f.length && i < t.length && f[i] === t[i]) i++;
        const up = f.slice(i).map(() => "..");
        return [...up, ...t.slice(i)].join("/");
    },
    dirname(p: string) {
        const idx = p.replace(/\\/g, "/").lastIndexOf("/");
        return idx === -1 ? "." : p.slice(0, idx) || "/";
    },
    extname(p: string) {
        const base = p.replace(/\\/g, "/").split("/").pop() || "";
        const idx = base.lastIndexOf(".");
        return idx > 0 ? base.slice(idx) : "";
    },
};

/**************************** @shared/service-manager ****************************/
win["@shared/service-manager"] = {
    async setup() {
        /* 阶段3 */
    },
    getServiceHost(_serviceName: string): any {
        return undefined;
    },
};

/**************************** @shared/short-cut ****************************/
win["@shared/short-cut"] = {
    registerGlobalShortCut(_key: string, _shortCut: string[]) {
        /* 阶段5：tauri-plugin-global-shortcut */
    },
    unregisterGlobalShortCut(_key: string) {
        /* 阶段5 */
    },
};

export {};
