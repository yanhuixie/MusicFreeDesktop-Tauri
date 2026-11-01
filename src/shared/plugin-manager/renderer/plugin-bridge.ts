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
    fileName?: string;
}

/** 插件清单缓存条目：size+mtimeMs 未变则启动时跳过读文件/哈希/执行 */
interface IPluginManifestEntry {
    fileName: string;
    size: number;
    mtimeMs: number;
    hash: string;
    platform: string;
    stateCode?: string;
    error?: string;
    supportedMethod: string[];
    meta: any;
}

/** 扫描阶段临时携带插件源码（解析后即丢弃，不落清单） */
interface IPluginScanEntry extends IPluginManifestEntry {
    code?: string;
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
/** iframe 代际：重载后自增，用于丢弃旧 iframe 在飞 RPC 的结果 */
let iframeGeneration = 0;
/** 已把代码送入 iframe 的插件 hash（懒加载：清单命中时首次调用才执行插件代码） */
const runtimeLoadedHashes = new Set<string>();
const runtimeLoadPending = new Map<string, Promise<void>>();

window.addEventListener("message", (evt: MessageEvent) => {
    const data = evt.data as IpcMessage;
    if (!data?.__musicfree_plugin) {
        return;
    }
    if (data.type === "runtime-ready") {
        runtimeReadyResolve?.();
        if (runtimeEverReady) {
            // WebView2 丢弃/重载隐藏 iframe 后 DOM 元素不变（isConnected 恒真），
            // 二次 runtime-ready 是唯一重载信号：递增代际、清空镜像与在飞懒加载，
            // 并让在飞 RPC 立即失败（否则会等满 120s 超时）
            iframeGeneration += 1;
            runtimeLoadedHashes.clear();
            runtimeLoadPending.clear();
            for (const pending of pendingRpc.values()) {
                clearTimeout(pending.timer);
                pending.reject(new Error("plugin runtime reloaded"));
            }
            pendingRpc.clear();
            if (pluginMetas.length && !runtimeSelfHealing) {
                runtimeSelfHealing = true;
                void loadAllPlugins()
                    .catch(() => {})
                    .finally(() => {
                        runtimeSelfHealing = false;
                    });
            }
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
    iframeGeneration += 1;
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
let dataDir: string | null = null;

async function getDataDir(): Promise<string> {
    if (!dataDir) {
        dataDir = (await invoke<string>("get_data_dir")) || "";
    }
    return dataDir;
}

async function getPluginDir(): Promise<string> {
    if (pluginDir) {
        return pluginDir;
    }
    // 便携版支持（阶段5）：exe 旁 portable/ 目录优先
    const userData = await getDataDir();
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

/** 清单缓存：命中时启动不再读取/执行 6.7MB 插件代码，插件实例在首次方法调用时懒加载 */
const PLUGIN_MANIFEST_VERSION = 1;
let manifestRaw = "";

async function getManifestPath(): Promise<string | null> {
    const dir = await getDataDir();
    // 数据目录异常时禁用清单缓存（避免落到盘根 \plugin-manifest.json）
    return dir ? joinPath(dir, "plugin-manifest.json") : null;
}

async function readPluginManifest(): Promise<IPluginManifestEntry[]> {
    try {
        const path = await getManifestPath();
        if (!path) {
            return [];
        }
        const raw = await pluginFs.readTextFile(path);
        const parsed = JSON.parse(raw);
        // app 版本变化可能改变插件 meta（如版本兼容判断），缓存整体作废
        if (
            parsed?.version === PLUGIN_MANIFEST_VERSION &&
            parsed?.appVersion === getGlobalContext().appVersion &&
            Array.isArray(parsed.plugins)
        ) {
            manifestRaw = raw;
            return parsed.plugins.filter(
                (entry: any) =>
                    entry &&
                    typeof entry.fileName === "string" &&
                    typeof entry.hash === "string" &&
                    entry.hash.length > 0 &&
                    Number.isFinite(entry.size) &&
                    Number.isFinite(entry.mtimeMs) &&
                    Array.isArray(entry.supportedMethod),
            );
        }
    } catch {
        /* 无缓存或缓存损坏：走全量扫描 */
    }
    manifestRaw = "";
    return [];
}

async function writePluginManifest(entries: IPluginManifestEntry[]): Promise<void> {
    try {
        const path = await getManifestPath();
        if (!path) {
            return;
        }
        const raw = JSON.stringify({
            version: PLUGIN_MANIFEST_VERSION,
            appVersion: getGlobalContext().appVersion,
            plugins: entries.map(
                ({ fileName, size, mtimeMs, hash, platform, stateCode, error, supportedMethod, meta }) => ({
                    fileName,
                    size,
                    mtimeMs,
                    hash,
                    platform,
                    stateCode,
                    error,
                    supportedMethod,
                    meta,
                }),
            ),
        });
        if (raw === manifestRaw) {
            return;
        }
        await pluginFs.writeTextFile(path, raw);
        manifestRaw = raw;
    } catch {
        /* 缓存写入失败不影响本次加载 */
    }
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

function pluginEnv() {
    return {
        pluginMeta: AppConfig.getConfig("private.pluginMeta") ?? {},
        platform: "win32",
        appVersion: getGlobalContext().appVersion,
        lang: AppConfig.getConfig("normal.language"),
    };
}

let loadPluginsChain: Promise<unknown> = Promise.resolve();
/** 插件表是否完成过一次成功扫描（安装/卸载入口据此确保去重与版本校验有效） */
let pluginsInitialized = false;

/** 串行化：启动/安装更新/自愈可能并发调用，避免 iframe 插件表与主 frame 镜像分叉 */
export function loadAllPlugins(): Promise<IPlugin.IPluginDelegate[]> {
    const run = loadPluginsChain.then(
        () => loadAllPluginsImpl(),
        () => loadAllPluginsImpl(),
    );
    loadPluginsChain = run.catch(() => {});
    return run;
}

async function loadAllPluginsImpl(): Promise<IPlugin.IPluginDelegate[]> {
    const startedAt = performance.now();
    const dir = await getPluginDir();
    let readDirResult: Awaited<ReturnType<typeof pluginFs.readDir>> | null = null;
    // 目录可能被外部程序/杀软短暂占用：失败后重试一次
    for (let attempt = 0; attempt < 2 && !readDirResult; attempt++) {
        try {
            readDirResult = await pluginFs.readDir(dir);
        } catch {
            readDirResult = null;
            if (attempt === 0) {
                await new Promise((resolve) => setTimeout(resolve, 200));
            }
        }
    }
    if (!readDirResult) {
        // 读目录失败时保持现有插件表，不能把空清单落盘
        logger.logWarn("读取插件目录失败", { dir });
        return toDelegates();
    }
    const entries = readDirResult.filter((entry) => entry.isFile && entry.name.endsWith(".js"));
    const cachedByName = new Map((await readPluginManifest()).map((entry) => [entry.fileName, entry]));

    // 1) 逐个 stat 比对缓存；未命中的并行读取代码并计算 hash
    const scanned = await Promise.all(
        entries.map(async (entry): Promise<IPluginScanEntry | null> => {
            const filePath = `${dir}\\${entry.name}`;
            try {
                const info = await pluginFs.stat(filePath);
                const size = info.size ?? 0;
                const mtime = info.mtime ? new Date(info.mtime).getTime() : 0;
                const mtimeMs = Number.isFinite(mtime) ? mtime : 0;
                const cached = cachedByName.get(entry.name);
                if (
                    cached &&
                    mtimeMs > 0 &&
                    cached.size === size &&
                    cached.mtimeMs === mtimeMs &&
                    cached.platform
                ) {
                    return cached;
                }
                // 仅缓存未命中时加载 crypto-js
                const CryptoJs = (await import("crypto-js")).default;
                const code = await pluginFs.readTextFile(filePath);
                return {
                    fileName: entry.name,
                    size,
                    mtimeMs,
                    hash: CryptoJs.SHA256(code).toString(),
                    platform: "",
                    supportedMethod: [],
                    meta: {},
                    code,
                };
            } catch {
                return null;
            }
        }),
    );

    const valid = scanned.filter((entry): entry is IPluginScanEntry => !!entry);
    const changed = valid.filter((entry) => !entry.platform && entry.code != null);
    // 2) 只在文件新增/变更时解析元数据；load-plugins 合并进 iframe 插件表（不清空）
    if (changed.length) {
        await ensurePluginRuntime();
        const generation = iframeGeneration;
        try {
            const parsed = await callRuntime<ILoadedPluginMeta[]>("load-plugins", {
                plugins: changed.map((entry) => ({ code: entry.code!, hash: entry.hash })),
                env: pluginEnv(),
            });
            changed.forEach((entry, index) => {
                const meta = parsed?.[index];
                entry.platform = meta?.platform ?? "";
                entry.stateCode = meta?.stateCode;
                entry.error = meta?.error;
                entry.supportedMethod = meta?.supportedMethod ?? [];
                entry.meta = meta?.meta ?? {};
                entry.hash = meta?.hash || entry.hash;
                // 只登记 iframe 实际注册成功的插件（解析失败时 meta.hash 为空）
                if (meta?.hash && generation === iframeGeneration) {
                    runtimeLoadedHashes.add(meta.hash);
                }
            });
        } catch (e: any) {
            logger.logWarn("插件解析失败，沿用缓存/空结果", { error: e?.message });
        }
    }
    valid.forEach((entry) => {
        delete entry.code;
    });

    // 3) 同内容去重（保留首个文件名），重建委托表
    const seenHashes = new Set<string>();
    const unique: IPluginManifestEntry[] = [];
    for (const entry of valid) {
        if (!entry.hash || !entry.platform || seenHashes.has(entry.hash)) {
            continue;
        }
        seenHashes.add(entry.hash);
        unique.push(entry);
    }
    pluginMetas = unique.map((entry) => ({
        hash: entry.hash,
        platform: entry.platform,
        stateCode: entry.stateCode,
        error: entry.error,
        supportedMethod: entry.supportedMethod,
        meta: entry.meta,
        fileName: entry.fileName,
    }));
    await writePluginManifest(valid);

    logger.logPerf(
        `loadAllPlugins ready: ${unique.length} plugins, ${changed.length} parsed, ${Math.round(performance.now() - startedAt)}ms`,
    );
    pluginsInitialized = true;
    notifyUpdate();
    return toDelegates();
}

/**************************** 安装 / 卸载 / 更新 ****************************/
async function installFromRawCode(funcCode: string): Promise<void> {
    // 启动期深链/手动安装可能早于插件表扫描：先确保去重与版本校验基于完整插件表
    if (!pluginsInitialized) {
        await loadAllPlugins().catch(() => {});
    }
    const CryptoJs = (await import("crypto-js")).default;
    const sha256 = CryptoJs.SHA256(funcCode).toString();
    // 与现有插件比对
    const existing = pluginMetas.find((m) => m.hash === sha256);
    if (existing) {
        return; // 静默忽略重复安装
    }
    // 先在 iframe 中试加载，验证可解析并拿到 platform/version
    const env = pluginEnv();
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
            await pluginFs.remove(`${dir}\\${oldVersionPlugin.fileName}`, { recursive: false });
        } catch {
            /* 忽略 */
        }
        // 旧版本实例已无委托引用，清理 iframe 内引用
        unloadPluginInstance(oldVersionPlugin.hash);
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
    if (!pluginsInitialized) {
        await loadAllPlugins().catch(() => {});
    }
    const target = pluginMetas.find((m) => m.hash === hash);
    if (target) {
        try {
            const dir = await getPluginDir();
            await pluginFs.remove(`${dir}\\${target.fileName}`, { recursive: false });
        } catch {
            /* 忽略 */
        }
        // 等在飞懒加载结束再卸载，避免其晚到的镜像回写撤销本次清理
        await runtimeLoadPending.get(hash)?.catch(() => {});
        unloadPluginInstance(hash);
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
    await ensurePluginCodeLoaded(meta);
    return await callRuntime("call-method", { hash: meta.hash, method, args });
}

/** 懒加载：清单命中的插件在首次方法调用时才读取代码并送入 iframe 执行 */
async function ensurePluginCodeLoaded(meta: ILoadedPluginMeta): Promise<void> {
    if (runtimeLoadedHashes.has(meta.hash)) {
        return;
    }
    const pending = runtimeLoadPending.get(meta.hash);
    if (pending) {
        return pending;
    }
    const task = (async () => {
        if (!meta.fileName) {
            throw new Error(`插件文件未知: ${meta.platform || meta.hash.slice(0, 8)}`);
        }
        const dir = await getPluginDir();
        const code = await pluginFs.readTextFile(`${dir}\\${meta.fileName}`);
        await ensurePluginRuntime();
        const generation = iframeGeneration;
        const loaded = await callRuntime<boolean>("load-plugin", {
            hash: meta.hash,
            code,
            env: pluginEnv(),
        });
        if (!loaded) {
            throw new Error(`插件加载失败: ${meta.platform || meta.hash.slice(0, 8)}`);
        }
        // iframe 在 RPC 期间被重建时结果已失效，不能写入镜像
        if (generation === iframeGeneration) {
            runtimeLoadedHashes.add(meta.hash);
        }
    })().finally(() => {
        // 只删自己这一条：重载时 clear 后可能已创建新一代同 hash 的 task
        if (runtimeLoadPending.get(meta.hash) === task) {
            runtimeLoadPending.delete(meta.hash);
        }
    });
    runtimeLoadPending.set(meta.hash, task);
    return task;
}

/** 清理 iframe 内插件实例引用（无法停止插件模块已创建的定时器，彻底回收需重建 iframe） */
function unloadPluginInstance(hash: string): void {
    runtimeLoadedHashes.delete(hash);
    runtimeLoadPending.delete(hash);
    if (pluginIframe?.isConnected) {
        void callRuntime("unload-plugin", { hash }).catch(() => {});
    }
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
