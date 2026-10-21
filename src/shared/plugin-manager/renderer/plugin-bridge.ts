/**
 * 插件桥（阶段3）：主 frame 侧
 *
 * 管理 plugin-runtime iframe 生命周期与 postMessage RPC；
 * 插件文件管理（安装/卸载/更新，nanoid 命名，plugin-fs 读写）；
 * callPluginMethod 的包装逻辑平移自原主进程 PluginMethods
 * （search 结果 resetMediaItem、getMediaSource 重试与 headers 提取、
 *  getLyric 本地伴生 .lrc 读取）。
 */
import { nanoid } from "nanoid";
import { invoke } from "@tauri-apps/api/core";
import { compare } from "compare-versions";
import * as pluginFs from "@tauri-apps/plugin-fs";
import { appDataDir } from "@tauri-apps/api/path";
import AppConfig from "@shared/app-config/renderer";
import { getGlobalContext } from "@shared/global-context/renderer";
import { getInternalData, resetMediaItem } from "@/common/media-util";
import { delay } from "@/common/time-util";
import { localPluginHash, localPluginName } from "@/common/constant";
import logger from "@shared/logger/renderer";

type IpcMessage = {
    __musicfree_plugin?: boolean;
    type: string;
    id?: number;
    [key: string]: any;
};

interface ILoadedPluginMeta {
    hash: string;
    platform: string;
    stateCode?: string;
    error?: string;
    supportedMethod: string[];
    meta: any;
}

/**************************** iframe 管理 ****************************/
let pluginIframe: HTMLIFrameElement | null = null;
let runtimeReadyResolve: (() => void) | null = null;
let runtimeReadyPromise: Promise<void> = new Promise<void>((resolve) => {
    runtimeReadyResolve = resolve;
});

let rpcId = 0;
const pendingRpc = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void; timer: number }>();

let runtimeEverReady = false;
let runtimeSelfHealing = false;

window.addEventListener("message", (evt: MessageEvent) => {
    const data = evt.data as IpcMessage;
    if (!data?.__musicfree_plugin) {
        return;
    }
    if (data.type === "runtime-ready") {
        runtimeReadyResolve?.();
        // WebView2 丢弃/重载隐藏 iframe 后 DOM 元素不变（isConnected 恒真），
        // 二次 runtime-ready 是唯一重载信号：立即从磁盘全量重载插件自愈，
        // 否则 iframe 插件表为空而主 frame 缓存仍在，所有方法调用 not found
        if (runtimeEverReady && pluginMetas.length && !runtimeSelfHealing) {
            runtimeSelfHealing = true;
            void loadAllPlugins()
                .catch(() => {})
                .finally(() => {
                    runtimeSelfHealing = false;
                });
        }
        runtimeEverReady = true;
        return;
    }
    if (data.type === "rpc-response") {
        const pending = pendingRpc.get(data.id!);
        if (pending) {
            pendingRpc.delete(data.id!);
            clearTimeout(pending.timer);
            if (data.ok) {
                pending.resolve(data.result);
            } else {
                pending.reject(new Error(data.error || "plugin runtime error"));
            }
        }
    }
});

export function ensurePluginRuntime(): Promise<void> {
    if (pluginIframe?.isConnected) {
        return runtimeReadyPromise;
    }
    // 重建 iframe（页面 reload / HMR 后旧引用失效），ready promise 随之重置
    pluginIframe?.remove();
    pluginIframe = null;
    runtimeReadyPromise = new Promise<void>((resolve) => {
        runtimeReadyResolve = resolve;
    });
    pluginIframe = document.createElement("iframe");
    pluginIframe.src = "/plugin-runtime.html";
    pluginIframe.style.display = "none";
    pluginIframe.setAttribute("aria-hidden", "true");
    document.body.appendChild(pluginIframe);
    return runtimeReadyPromise;
}

async function callRuntime<T = any>(type: string, payload: any, timeoutMs = 120000): Promise<T> {
    await ensurePluginRuntime();
    return new Promise<T>((resolve, reject) => {
        const id = ++rpcId;
        const timer = window.setTimeout(() => {
            pendingRpc.delete(id);
            reject(new Error(`plugin bridge rpc timeout: ${type}`));
        }, timeoutMs);
        pendingRpc.set(id, { resolve, reject, timer });
        pluginIframe!.contentWindow!.postMessage({ __musicfree_plugin: true, type, id, payload } as IpcMessage, "*");
    });
}

/**************************** http / cookie 转发（iframe → Rust） ****************************/
window.addEventListener("message", async (evt: MessageEvent) => {
    const data = evt.data as IpcMessage;
    if (!data?.__musicfree_plugin || !data.id) {
        return;
    }
    const reply = (result: any) => {
        pluginIframe?.contentWindow?.postMessage({
            __musicfree_plugin: true,
            type: "rpc-response",
            id: data.id,
            ...result,
        } as IpcMessage, "*");
    };
    if (data.type === "http") {
        try {
            const result = await invoke<any>("plugin_http_request", {
                config: {
                    url: data.payload.url,
                    method: data.payload.method,
                    headers: data.payload.headers,
                    data: data.payload.data,
                    timeoutMs: data.payload.timeoutMs,
                },
                responseBinary: data.payload.responseType === "arraybuffer" || data.payload.responseType === "blob",
            });
            reply({ ok: true, result });
        } catch (e: any) {
            reply({ ok: false, error: e?.message || String(e) });
        }
    } else if (data.type === "cookie-get") {
        try {
            const result = await invoke<any[]>("plugin_cookie_get", { url: data.payload.url });
            reply({ ok: true, result: result || [] });
        } catch {
            reply({ ok: true, result: [] });
        }
    } else if (data.type === "cookie-set") {
        try {
            await invoke("plugin_cookie_set", data.payload);
            reply({ ok: true, result: true });
        } catch (e: any) {
            reply({ ok: false, error: e?.message });
        }
    }
});

/**************************** 插件目录与加载 ****************************/
let pluginDir: string | null = null;

async function getPluginDir(): Promise<string> {
    if (pluginDir) {
        return pluginDir;
    }
    // 便携版支持（阶段5）：exe 旁 portable/ 目录优先
    const userData = (await invoke<string>("get_data_dir")) || "";
    pluginDir = joinPath(userData, "musicfree-plugins");
    try {
        await pluginFs.mkdir(pluginDir, { recursive: true });
    } catch {
        /* 已存在 */
    }
    // Electron 版插件继承：旧版 %APPDATA%/MusicFree/musicfree-plugins
    try {
        const appDataRoot = userData.replace(/[\\/][^\\/]+$/, "");
        const electronDir = `${appDataRoot}\\MusicFree\\musicfree-plugins`;
        const entries = await pluginFs.readDir(electronDir).catch(() => [] as any[]);
        let hasLocal = false;
        for (const e of entries) {
            if (e.isFile && e.name.endsWith(".js")) {
                hasLocal = true;
                break;
            }
        }
        if (hasLocal) {
            const current = await pluginFs.readDir(pluginDir).catch(() => [] as any[]);
            if (current.length === 0) {
                for (const e of entries) {
                    if (e.isFile && e.name.endsWith(".js")) {
                        try {
                            const content = await pluginFs.readTextFile(`${electronDir}\\${e.name}`);
                            await pluginFs.writeTextFile(`${pluginDir}\\${e.name}`, content);
                        } catch {
                            /* 单个失败忽略 */
                        }
                    }
                }
            }
        }
    } catch {
        /* 无旧版目录 */
    }
    return pluginDir;
}

async function downloadPluginCode(url: string): Promise<string | null> {
    const result = await invoke<any>("plugin_http_request", {
        config: { url, method: "get", timeoutMs: 30000 },
    });
    return result?.bodyText || null;
}

let pluginMetas: ILoadedPluginMeta[] = [];
let pluginUpdateCallback: ((plugins: IPlugin.IPluginDelegate[]) => void) | null = null;

function toDelegates(): IPlugin.IPluginDelegate[] {
    return pluginMetas
        .filter((m) => m.hash && m.platform)
        .map((m) => ({
            ...m.meta,
            platform: m.platform,
            hash: m.hash,
            path: "",
            supportedMethod: m.supportedMethod,
        })) as unknown as IPlugin.IPluginDelegate[];
}

function notifyUpdate() {
    pluginUpdateCallback?.(JSON.parse(JSON.stringify(toDelegates())));
}

export async function loadAllPlugins(): Promise<IPlugin.IPluginDelegate[]> {
    await ensurePluginRuntime();
    const dir = await getPluginDir();
    const entries = await pluginFs.readDir(dir).catch(() => [] as any[]);
    const codes: Array<{ code: string; fileName: string }> = [];
    const hashSet = new Set<string>();
    // 静态导入 crypto-js 计算 hash（避免动态 import 复杂度）
    const CryptoJs = (await import("crypto-js")).default;
    for (const entry of entries) {
        if (!entry.isFile || !entry.name.endsWith(".js")) {
            continue;
        }
        try {
            const code = await pluginFs.readTextFile(`${dir}\\${entry.name}`);
            const hash = CryptoJs.SHA256(code).toString();
            if (hashSet.has(hash)) {
                continue;
            }
            hashSet.add(hash);
            codes.push({ code, fileName: entry.name });
        } catch {
            /* 忽略不可读文件 */
        }
    }
    const env = {
        pluginMeta: AppConfig.getConfig("private.pluginMeta") ?? {},
        platform: "win32",
        appVersion: getGlobalContext().appVersion,
        lang: AppConfig.getConfig("normal.language"),
    };
    pluginMetas = await callRuntime<ILoadedPluginMeta[]>("load-plugins", {
        plugins: codes.map((c) => ({ code: c.code })),
        env,
    });
    // 记录文件路径（卸载用）
    const metaWithFile = pluginMetas.map((m, i) => ({ ...m }));
    const codeHashes = codes.map((c) => CryptoJs.SHA256(c.code).toString());
    // @ts-ignore 附加文件名映射
    pluginMetas.forEach((m, i) => {
        (m as any).fileName = codes[i]?.fileName;
        (m as any).fileHash = codeHashes[i];
    });
    void metaWithFile;
    notifyUpdate();
    return toDelegates();
}

/**************************** 安装 / 卸载 / 更新 ****************************/
async function installFromRawCode(funcCode: string): Promise<void> {
    const CryptoJs = (await import("crypto-js")).default;
    const sha256 = CryptoJs.SHA256(funcCode).toString();
    // 与现有插件比对
    const existing = pluginMetas.find((m) => (m as any).fileHash === sha256 || m.hash === sha256);
    if (existing) {
        return; // 静默忽略重复安装
    }
    // 先在 iframe 中试加载，验证可解析并拿到 platform/version
    const env = {
        pluginMeta: AppConfig.getConfig("private.pluginMeta") ?? {},
        platform: "win32",
        appVersion: getGlobalContext().appVersion,
        lang: AppConfig.getConfig("normal.language"),
    };
    const [meta] = await callRuntime<ILoadedPluginMeta[]>("try-load-plugin", { plugins: [{ code: funcCode }], env });
    if (!meta?.hash || !meta.platform) {
        throw new Error(`插件无法解析! ${meta?.error || ""}`);
    }
    const oldVersionPlugin = pluginMetas.find((m) => m.platform === meta.platform);
    if (oldVersionPlugin && !AppConfig.getConfig("plugin.notCheckPluginVersion")) {
        if (compare(oldVersionPlugin.meta?.version ?? "", meta.meta?.version ?? "", ">")) {
            throw new Error("已安装更新版本的插件");
        }
    }
    const dir = await getPluginDir();
    const fileName = `${nanoid()}.js`;
    await pluginFs.writeTextFile(`${dir}\\${fileName}`, funcCode);
    if (oldVersionPlugin) {
        try {
            await pluginFs.remove(`${dir}\\${(oldVersionPlugin as any).fileName}`, { recursive: false });
        } catch {
            /* 忽略 */
        }
    }
    await loadAllPlugins();
}

async function installFromUrl(urlLike: string): Promise<void> {
    const url = urlLike.trim();
    const funcCode = await downloadPluginCode(url);
    if (funcCode) {
        await installFromRawCode(funcCode);
    }
}

export async function installPluginFromRemote(urlLike: string): Promise<void> {
    try {
        const url = urlLike.trim();
        if (url.endsWith(".json")) {
            const raw = await downloadPluginCode(appendRandomHash(url));
            const jsonFile = JSON.parse(raw || "{}");
            for (const cfg of jsonFile?.plugins ?? []) {
                await installFromUrl(appendRandomHash(cfg.url));
            }
        } else if (url.endsWith(".js")) {
            await installFromUrl(appendRandomHash(url));
        }
    } finally {
        notifyUpdate();
    }
}

export async function installPluginFromLocal(pathLike: string): Promise<void> {
    try {
        const url = pathLike.trim();
        if (url.endsWith(".js")) {
            const rawCode = await pluginFs.readTextFile(url);
            await installFromRawCode(rawCode);
        } else if (url.endsWith(".json")) {
            const jsonFile = JSON.parse(await pluginFs.readTextFile(url));
            for (const cfg of jsonFile?.plugins ?? []) {
                await installFromUrl(appendRandomHash(cfg.url));
            }
        }
    } finally {
        notifyUpdate();
    }
}

function appendRandomHash(url: string): string {
    return `${url}${url.includes("?") ? "&" : "?"}_=${Date.now()}`;
}

/** 简易路径拼接（Windows 语义） */
export function joinPath(base: string, rel: string): string {
    return `${base.replace(/[\\/]+$/, "")}\\${rel}`;
}

export async function uninstallPlugin(hash: string): Promise<void> {
    const target = pluginMetas.find((m) => m.hash === hash);
    if (target) {
        try {
            const dir = await getPluginDir();
            await pluginFs.remove(`${dir}\\${(target as any).fileName}`, { recursive: false });
        } catch {
            /* 忽略 */
        }
        await loadAllPlugins();
    }
}

export async function updateAllPlugins(): Promise<void> {
    for (const meta of pluginMetas) {
        if (meta.meta?.srcUrl) {
            try {
                await installFromUrl(appendRandomHash(meta.meta.srcUrl));
            } catch (e: any) {
                logger.logWarn("插件更新失败", { platform: meta.platform, error: e?.message });
            }
        }
    }
    // 兜底全量重载：批量更新中途任何失败都不应留下残缺插件表
    try {
        await loadAllPlugins();
    } catch {
        notifyUpdate();
    }
}

/**************************** 方法调用（PluginMethods 逻辑平移） ****************************/

function findPluginMeta(delegate: { hash?: string; platform?: string }): ILoadedPluginMeta | null {
    if (delegate.hash === localPluginHash || delegate.platform === localPluginName) {
        return null; // 本地音源：Rust lofty 实现（localPluginCall）
    }
    if (delegate.hash) {
        return pluginMetas.find((m) => m.hash === delegate.hash) ?? null;
    }
    if (delegate.platform) {
        return pluginMetas.find((m) => m.platform === delegate.platform) ?? null;
    }
    return null;
}

async function rawCall(meta: ILoadedPluginMeta, method: string, args: any[]): Promise<any> {
    return await callRuntime("call-method", { hash: meta.hash, method, args });
}

/** 分页/详情类方法的空结果兜底（对齐原主进程 PluginMethods 契约：
 *  不规范插件返回 null/undefined 或执行失败时返回空分页对象，
 *  调用方（useRecommendSheets 等）按原版语义不判空直接解引用） */
function fallbackPluginResult(method: string, args: any[]): any {
    switch (method) {
        case "search":
        case "getRecommendSheetsByTag":
        case "getArtistWorks":
        case "getMusicComments":
            return { isEnd: true, data: [] };
        case "getRecommendSheetTags":
            return { data: [] };
        case "getTopLists":
            return [];
        case "getTopListDetail":
            return { isEnd: true, topListItem: args[0], musicList: [] };
        case "getAlbumInfo":
            return { albumItem: args[0], musicList: args[0]?.musicList ?? [], isEnd: true };
        case "getMusicSheetInfo":
            return { sheetItem: args[0], musicList: args[0]?.musicList ?? [], isEnd: true };
        default:
            return null;
    }
}

/**************************** 本地音源（lofty 元数据，Rust 实现） ****************************/

async function localPluginCall(method: string, args: any[]): Promise<any> {
    switch (method) {
        case "getMediaSource": {
            const musicItem = args[0] as IMusic.IMusicItem;
            const localPath = (musicItem as any).$$localPath || musicItem.localPath;
            if (!localPath) {
                return { url: musicItem.url };
            }
            // 本地文件统一走 mediahub（阶段2：Range/协议）
            const { toMediahubUrl } = await import("@/common/mediahub");
            return { url: toMediahubUrl(localPath) };
        }
        case "getLyric": {
            const musicItem = args[0] as IMusic.IMusicItem;
            if (musicItem.rawLrc) {
                return { rawLrc: musicItem.rawLrc };
            }
            const localPath = (musicItem as any).$$localPath || musicItem.localPath;
            if (!localPath) {
                return null;
            }
            const result = await invoke<any>("read_companion_lrc", { mediaPath: localPath });
            if (result?.rawLrc) {
                return { rawLrc: result.rawLrc, translation: result.translation };
            }
            return null;
        }
        case "importMusicItem": {
            const filePath = args[0] as string;
            return await invoke<any>("parse_local_music_item", { path: filePath });
        }
        case "importMusicSheet": {
            const folderPath = args[0] as string;
            return (await invoke<any[]>("parse_local_music_item_folder", { folder: folderPath })) ?? [];
        }
        default:
            return null;
    }
}

export async function callPluginMethod(
    pluginDelegate: { hash?: string; platform?: string },
    method: string,
    ...args: any[]
): Promise<any> {
    // 本地音源分支
    if (pluginDelegate.hash === localPluginHash || pluginDelegate.platform === localPluginName) {
        try {
            return await localPluginCall(method, args);
        } catch (e: any) {
            logger.logError(`本地音源方法调用失败 ${method}`, e);
            return null;
        }
    }
    const meta = findPluginMeta(pluginDelegate);
    if (!meta) {
        // iframe 重载窗口期插件表可能短暂为空，同样按空结果兜底
        return fallbackPluginResult(method, args);
    }
    try {
        switch (method) {
            case "search": {
                const [query, page, type] = args;
                const result = await rawCall(meta, "search", [query, page, type]);
                if (Array.isArray(result?.data)) {
                    result.data.forEach((_: any) => resetMediaItem(_, meta.platform));
                    return { isEnd: result.isEnd ?? true, data: result.data };
                }
                return { isEnd: true, data: [] };
            }
            case "getMediaSource": {
                const [musicItem, quality = "standard", retryCount = 1] = args;
                if (!meta.supportedMethod.includes("getMediaSource")) {
                    return { url: musicItem?.qualities?.[quality]?.url ?? musicItem?.url };
                }
                try {
                    const { url, headers } =
                        (await rawCall(meta, "getMediaSource", [musicItem, quality])) ??
                        { url: musicItem?.qualities?.[quality]?.url };
                    if (!url) {
                        throw new Error("NOT RETRY");
                    }
                    return {
                        url,
                        headers,
                        userAgent: headers?.["user-agent"],
                    } as IPlugin.IMediaSourceResult;
                } catch (e: any) {
                    if (retryCount > 0 && e?.message !== "NOT RETRY") {
                        await delay(150);
                        return callPluginMethod(pluginDelegate, method, musicItem, quality, retryCount - 1);
                    }
                    return null;
                }
            }
            case "getMusicInfo": {
                if (!meta.supportedMethod.includes("getMusicInfo")) {
                    return null;
                }
                try {
                    return (await rawCall(meta, "getMusicInfo", [resetMediaItem(args[0], undefined, true)])) ?? null;
                } catch {
                    return null;
                }
            }
            case "getLyric": {
                const musicItem = args[0] as IMusic.IMusicItem;
                let rawLrc = musicItem.rawLrc;
                let lrcUrl = musicItem.lrc;
                let translation: string | undefined;
                if (rawLrc) {
                    return { rawLrc, lrc: lrcUrl };
                }
                // 本地伴生歌词读取（原主进程 fs 逻辑，阶段4 将随 lofty 一并完善）
                const localPath =
                    getInternalData<IMusic.IMusicItemInternalData>(musicItem, "downloadData")?.path ||
                    (musicItem as any).$$localPath;
                if (localPath) {
                    const { fsUtil } = await import("@shared/utils/renderer");
                    const dir = localPath.replace(/[\\/][^\\/]+$/, "");
                    const base = localPath.split(/[\\/]/).pop()!.replace(/\.[^.]+$/, "");
                    for (const ext of [".lrc", ".LRC", ".txt"]) {
                        const lrcPath = `${dir}\\${base}${ext}`;
                        if (await fsUtil.isFile(lrcPath)) {
                            try {
                                rawLrc = (await fsUtil.readFile(lrcPath)) as string;
                                const trPath = `${dir}\\${base}-tr${ext}`;
                                if (await fsUtil.isFile(trPath)) {
                                    translation = (await fsUtil.readFile(trPath)) as string;
                                }
                                if (rawLrc) {
                                    return { rawLrc, translation, lrc: lrcUrl };
                                }
                            } catch {
                                /* 忽略 */
                            }
                        }
                    }
                }
                try {
                    const lrcSource = await rawCall(meta, "getLyric", [resetMediaItem(musicItem, undefined, true)]);
                    rawLrc = lrcSource?.rawLrc;
                    lrcUrl = lrcSource?.lrc || lrcUrl;
                    translation = lrcSource?.translation;
                    if (rawLrc || translation) {
                        if (!rawLrc) {
                            rawLrc = translation;
                            translation = undefined;
                        }
                        return { rawLrc, translation };
                    }
                } catch {
                    /* 忽略 */
                }
                return lrcUrl ? { lrc: lrcUrl } : null;
            }
            case "importMusicSheet":
            case "importMusicItem": {
                // 本地导入依赖本地音源（阶段4）
                if (meta.platform === localPluginName) {
                    return method === "importMusicItem" ? null : [];
                }
                return await rawCall(meta, method, args);
            }
            default: {
                if (!meta.supportedMethod.includes(method)) {
                    return fallbackPluginResult(method, args);
                }
                const result = await rawCall(meta, method, args);
                if (result == null) {
                    return fallbackPluginResult(method, args);
                }
                if (method === "getRecommendSheetsByTag" && !Array.isArray(result.data)) {
                    result.data = [];
                }
                return result;
            }
        }
    } catch (e: any) {
        logger.logError(`插件方法调用失败 ${meta.platform}.${method}`, e);
        return fallbackPluginResult(method, args);
    }
}

export function onPluginUpdated(callback: (plugins: IPlugin.IPluginDelegate[]) => void) {
    pluginUpdateCallback = callback;
}
