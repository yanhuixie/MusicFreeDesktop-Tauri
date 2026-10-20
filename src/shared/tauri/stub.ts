/**
 * Tauri 迁移过渡层（阶段0）
 *
 * Electron 版由 preload 脚本向渲染进程注入 window["@shared/*"] 命名空间；
 * Tauri 无 preload 机制，本文件在各窗口入口最先 import，注入等价的安全桩，
 * 使纯 Web 前端在无 Electron 环境下可完成渲染（计划阶段0 验收标准）。
 *
 * 阶段1起，shared 各模块的 renderer.ts 内部将逐模块改为直接调用 @tauri-apps/api，
 * 对应命名空间的桩随之删除；全部替换完成后本文件整体移除。
 */
import EventEmitter from "eventemitter3";
import defaultAppConfig from "@shared/app-config/default-app-config";

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

/**************************** @shared/app-config ****************************/
win["@shared/app-config"] = {
    async syncConfig() {
        return JSON.parse(JSON.stringify(defaultAppConfig));
    },
    setConfig(_config: any) {
        /* 阶段1：Rust command */
    },
    reset() {
        /* 阶段1：Rust command */
    },
    onConfigUpdate(_callback: (patch: any) => void) {
        /* 阶段1：Tauri 事件 */
    },
};

/**************************** @shared/global-context ****************************/
// workersPath 置空 → renderer 侧 `if (workerPath)` 守卫跳过 Node worker 创建
win["@shared/global-context"] = {
    getGlobalContext() {
        return {
            appVersion: "0.0.8-tauri",
            workersPath: {
                downloader: "",
                localFileWatcher: "",
                db: "",
            },
            appPath: {
                userData: "",
                temp: "",
                downloads: "",
                res: "",
            },
            platform: "win32",
        };
    },
};

/**************************** @shared/i18n ****************************/
// 语言包直接打包进前端（计划 §2：主进程 fs 读 res/lang → 前端打包）
const langModules = import.meta.glob("../../../res/lang/*.json", {
    eager: true,
    import: "default",
}) as Record<string, any>;

const langContents: Record<string, any> = {};
for (const [filePath, content] of Object.entries(langModules)) {
    const langName = filePath.match(/([^/]+)\.json$/)?.[1];
    if (langName) {
        langContents[langName] = content;
    }
}
const allLangs = Object.keys(langContents);

function readLangContent(langCode: string): any | null {
    const content = langContents[langCode];
    if (!content) return null;
    // 对齐主进程版 $alias 重定向逻辑
    if (content["$alias"] && langContents[content["$alias"]]) {
        return langContents[content["$alias"]];
    }
    return content;
}

function pickDefaultLang(): string {
    const nav = navigator.language;
    if (allLangs.includes(nav)) return nav;
    if (nav.includes("zh") && allLangs.includes("zh-CN")) return "zh-CN";
    if (allLangs.includes("en-US")) return "en-US";
    return allLangs[0];
}

win["@shared/i18n"] = {
    async setupLang() {
        const lang = pickDefaultLang();
        return {
            allLangs,
            lang,
            content: readLangContent(lang) || {},
        };
    },
    async changeLang(lang: string) {
        const content = readLangContent(lang);
        if (!content) return null;
        return { content };
    },
};

/**************************** @shared/themepack ****************************/
win["@shared/themepack"] = {
    async selectTheme(_themePack: any) {
        /* 阶段4：Rust zip + web 注入 */
    },
    async initCurrentTheme(): Promise<any | null> {
        return null;
    },
    async loadThemePacks(): Promise<any[]> {
        return [];
    },
    async installThemePack(_path: string): Promise<any | null> {
        return null;
    },
    async installRemoteThemePack(_url: string) {
        throw new Error("not implemented before stage 4");
    },
    async uninstallThemePack(_themePack: any) {
        /* 阶段4 */
    },
    replaceAlias(rawText: string) {
        return rawText;
    },
};

/**************************** @shared/utils ****************************/
win["@shared/utils"] = {
    fs: {
        async readFile() {
            return "";
        },
        async writeFile() {
            /* 阶段1：plugin-fs */
        },
        async isFile(_path: string) {
            return false;
        },
        async isFolder(_path: string) {
            return false;
        },
        async rimraf() {
            /* 阶段1 */
        },
        addFileScheme(filePath: string) {
            return filePath;
        },
    },
    app: {
        exitApp() {
            /* 阶段1 */
        },
        async getPath(_pathName: string) {
            return "";
        },
        async checkUpdate(): Promise<any | null> {
            return null;
        },
        async getCacheSize() {
            return 0;
        },
        clearCache() {
            /* 阶段6 */
        },
    },
    appWindow: {
        minMainWindow(_skipTaskBar: boolean) {
            /* 阶段1：WebviewWindow API */
        },
        showMainWindow() {
            /* 阶段1 */
        },
        setLyricWindow(_enabled: boolean) {
            /* 阶段1：Rust command */
        },
        setMinimodeWindow(_enabled: boolean) {
            /* 阶段1 */
        },
        ignoreMouseEvent(_ignore: boolean) {
            /* 阶段6 */
        },
        toggleMainWindowVisible() {
            /* 阶段1 */
        },
        toggleMainWindowMaximize() {
            /* 阶段1 */
        },
    },
    shell: {
        openExternal(_url: string) {
            /* 阶段1：plugin-opener */
        },
        openPath(_path: string) {
            /* 阶段1 */
        },
        async showItemInFolder(_path: string) {
            return false;
        },
    },
    dialog: {
        async showOpenDialog(_options: any): Promise<{ canceled: boolean; filePaths: string[] }> {
            return { canceled: true, filePaths: [] };
        },
        async showSaveDialog(_options: any): Promise<{ canceled: boolean; filePath: string }> {
            return { canceled: true, filePath: "" };
        },
    },
};

/**************************** @shared/window-drag ****************************/
win["@shared/window-drag"] = {
    dragWindow(_position: ICommon.IPoint) {
        /* 阶段1：data-tauri-drag-region / Rust */
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

/**************************** @shared/plugin-manager ****************************/
let pluginUpdatedCallback: ((plugins: any[]) => void) | null = null;
win["@shared/plugin-manager"] = {
    onPluginUpdated(callback: (plugins: any[]) => void) {
        pluginUpdatedCallback = callback;
    },
    async callPluginMethod(
        _pluginDelegate: any,
        _method: string,
        ..._args: any[]
    ): Promise<any> {
        // 阶段3：iframe 运行时桥接
        return null;
    },
    async reloadPlugins() {
        const result: any[] = [];
        pluginUpdatedCallback?.(result);
        return result;
    },
    async uninstallPlugin(_hash: string) {
        /* 阶段3 */
    },
    updateAllPlugins() {
        /* 阶段3 */
    },
    async installPluginFromLocal(_url: string): Promise<any | null> {
        return null;
    },
    async installPluginFromRemote(_url: string): Promise<any | null> {
        return null;
    },
};

/**************************** @shared/message-bus/main ****************************/
// 阶段0：仅本地回环（onCommand/sendCommand 在窗口内自洽），跨窗口同步为空实现
const commandEE = new EventEmitter();
win["@shared/message-bus/main"] = {
    onCommand(command: string, cb: (data: any, from: any) => void) {
        commandEE.on("command", (payload: any, from: any) => {
            if (payload?.command === command) {
                cb(payload.data, from);
            }
        });
    },
    sendCommand(command: string, data?: any) {
        commandEE.emit("command", { command, data }, -1);
    },
    syncAppState(_appState: any, _to?: any) {
        /* 阶段1：Tauri emit_to 定向事件 */
    },
};

/**************************** @shared/message-bus/extension ****************************/
let extAppState: any = {};
const extEE = new EventEmitter();
win["@shared/message-bus/extension"] = {
    getAppState() {
        return extAppState;
    },
    subscribeAppState(_keys: string[]) {
        /* 阶段1 */
    },
    sendCommand(_command: string, _data?: any) {
        /* 阶段1 */
    },
    onStateChange(cb: (appState: any, changed: any) => void) {
        extEE.on("stateChanged", cb);
    },
    offStateChange(cb: (appState: any, changed: any) => void) {
        extEE.off("stateChanged", cb);
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
