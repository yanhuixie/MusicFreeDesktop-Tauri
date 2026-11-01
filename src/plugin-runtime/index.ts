/**
 * 插件运行时（阶段3）
 *
 * 对应计划 §2 插件运行时架构：运行在主窗口隐藏 iframe 中，
 * - Function() 执行插件源码（与 Electron 版同构，非真沙箱，安全水平持平）
 * - require shim：白名单依赖打包浏览器版（cheerio/crypto-js/dayjs/...）
 * - axios 全局 adapter → postMessage 请求代理 → 主 frame → Rust reqwest（无 CORS、cookie jar、代理）
 * - musicfree/storage → localStorage（10MB 上限，对齐原实现）
 * - @react-native-cookies/cookies → postMessage → Rust cookie jar
 */
import CryptoJs from "crypto-js";
import dayjs from "dayjs";
import axios, { type AxiosAdapter, type InternalAxiosRequestConfig, type AxiosResponse } from "axios";
import bigInt from "big-integer";
import qs from "qs";
import * as cheerio from "cheerio";
import he from "he";
import * as webdav from "webdav";

type IpcMessage = {
    __musicfree_plugin?: boolean;
    type: string;
    id?: number;
    [key: string]: any;
};

/**************************** postMessage RPC ****************************/
let rpcId = 0;
const pendingRpc = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();

function callMain<T = any>(type: string, payload: any, timeoutMs = 120000): Promise<T> {
    const id = ++rpcId;
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
            pendingRpc.delete(id);
            reject(new Error(`plugin-runtime rpc timeout: ${type}`));
        }, timeoutMs);
        pendingRpc.set(id, {
            resolve: (v) => { clearTimeout(timer); resolve(v); },
            reject: (e) => { clearTimeout(timer); reject(e); },
        });
        parent.postMessage({ __musicfree_plugin: true, type, id, payload } satisfies IpcMessage, "*");
    });
}

window.addEventListener("message", (evt: MessageEvent) => {
    const data = evt.data as IpcMessage;
    if (!data?.__musicfree_plugin) {
        return;
    }
    if (data.type === "rpc-response") {
        const pending = pendingRpc.get(data.id!);
        if (pending) {
            pendingRpc.delete(data.id!);
            if (data.ok) {
                pending.resolve(data.result);
            } else {
                pending.reject(new Error(data.error || "plugin bridge error"));
            }
        }
    } else if (data.type === "load-plugins") {
        void handleLoadPlugins(data);
    } else if (data.type === "load-plugin") {
        void handleLoadPlugin(data);
    } else if (data.type === "unload-plugin") {
        void handleUnloadPlugin(data);
    } else if (data.type === "try-load-plugin") {
        void handleTryLoadPlugin(data);
    } else if (data.type === "call-method") {
        void handleCallMethod(data);
    }
});

/**************************** storage polyfill（musicfree/storage） ****************************/
const STORAGE_KEY = "musicfree-plugin-storage";
const MAX_STORAGE_SIZE = 1024 * 1024 * 10;

function readStorageData(): Record<string, string> {
    try {
        return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    } catch {
        return {};
    }
}

function writeStorageData(data: Record<string, string>) {
    const serialized = JSON.stringify(data);
    if (serialized.length > MAX_STORAGE_SIZE) {
        throw new Error("Storage size exceeds limit");
    }
    localStorage.setItem(STORAGE_KEY, serialized);
}

const pluginStorage = {
    async setItem(key: string, value: unknown) {
        const data = readStorageData();
        data[key] = typeof value === "string" ? value : value?.toString?.() ?? "";
        writeStorageData(data);
    },
    async getItem(key: string) {
        return readStorageData()[key] ?? null;
    },
    async removeItem(key: string) {
        const data = readStorageData();
        delete data[key];
        writeStorageData(data);
    },
};

/**************************** cookies polyfill（@react-native-cookies/cookies） ****************************/
const reactNativeCookies = {
    async get(url: string) {
        const cookies = await callMain<any[]>("cookie-get", { url });
        const result: Record<string, string> = {};
        for (const c of cookies || []) {
            result[c.name] = c.value;
        }
        return result;
    },
    async set(options: { url: string; name: string; value: string }) {
        await callMain("cookie-set", options);
        return true;
    },
};

/**************************** axios adapter 代理 ****************************/
function transformRequestData(data: any): string | undefined {
    if (data == null) {
        return undefined;
    }
    if (typeof data === "string") {
        return data;
    }
    // axios 默认对对象体 JSON.stringify（此处对齐；FormData 等类型不支持）
    try {
        return JSON.stringify(data);
    } catch {
        return String(data);
    }
}

function transformResponseData(result: any, responseType?: string): any {
    if (result.bodyBase64) {
        const binary = atob(result.bodyBase64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        if (responseType === "arraybuffer") {
            return bytes.buffer;
        }
        return bytes; // blob 语义以 Uint8Array 交付（插件极少直接用 Blob API）
    }
    const text = result.bodyText ?? "";
    if (responseType === "json" || !responseType) {
        try {
            return JSON.parse(text);
        } catch {
            return text;
        }
    }
    return text;
}

const proxyAdapter: AxiosAdapter = async (config: InternalAxiosRequestConfig) => {
    let url = config.url || "";
    if (!/^https?:/i.test(url) && config.baseURL) {
        url = config.baseURL + url;
    }
    if (config.params) {
        const qs_ = config.paramsSerializer
            ? (config.paramsSerializer as any)(config.params)
            : qs.stringify(config.params);
        url += (url.includes("?") ? "&" : "?") + qs_;
    }
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries({ ...(config.headers || {}) })) {
        if (v != null) headers[k] = String(v);
    }
    const result = await callMain<any>("http", {
        url,
        method: (config.method || "get").toLowerCase(),
        headers,
        data: transformRequestData(config.data),
        timeoutMs: config.timeout ?? 15000,
        responseType: config.responseType,
    });
    const data = transformResponseData(result, config.responseType);
    const response: Partial<AxiosResponse> & { config: InternalAxiosRequestConfig; request: any } = {
        data,
        status: result.status,
        statusText: result.statusText || "",
        headers: result.headers || {},
        config,
        request: {},
    };
    return response as AxiosResponse;
};

axios.defaults.adapter = proxyAdapter;
axios.defaults.timeout = 15000;

/**************************** require shim 白名单 ****************************/
const packages: Record<string, any> = {
    cheerio,
    "crypto-js": CryptoJs,
    axios,
    dayjs,
    "big-integer": bigInt,
    qs,
    he,
    "@react-native-cookies/cookies": reactNativeCookies,
    webdav,
    "musicfree/storage": pluginStorage,
};

const _require = (packageName: string) => {
    const pkg = packages[packageName];
    if (pkg) {
        pkg.default = pkg;
        return pkg;
    }
    return null;
};

/**************************** 插件加载与执行 ****************************/
export enum PluginStateCode {
    VersionNotMatch = "VERSION NOT MATCH",
    CannotParse = "CANNOT PARSE",
}

interface LoadedPluginEntry {
    instance: any;
    stateCode?: PluginStateCode;
    error?: string;
}

const loadedPlugins = new Map<string, LoadedPluginEntry>();
// 环境快照（主 frame 在 load 时传入；getUserVariables 实时读取）
let envSnapshot: any = {};

const sha256 = CryptoJs.SHA256;

function pluginEnv(pluginName: string) {
    return {
        getUserVariables: () => envSnapshot.pluginMeta?.[pluginName]?.userVariables ?? {},
        os: envSnapshot.platform || "win32",
        appVersion: envSnapshot.appVersion,
        lang: envSnapshot.lang,
    };
}

function fallbackInstance() {
    return {
        _path: "",
        platform: "",
        appVersion: "",
        async getMediaSource(): Promise<any> {
            return null;
        },
        async search(): Promise<any> {
            return {};
        },
        async getAlbumInfo(): Promise<any> {
            return null;
        },
    };
}

function loadOnePlugin(code: string): LoadedPluginEntry {
    const _module: any = { exports: {}, loaded: false };
    let instance: any;
    try {
        const factory = Function(`
            'use strict';
            return function(require, __musicfree_require, module, exports, console, env, process) {
                ${code}
            }
        `)();
        const pluginNamePlaceholder = ""; // env.getUserVariables 依赖 platform，先以空名占位
        const env = pluginEnv(pluginNamePlaceholder);
        const _process = {
            platform: envSnapshot.platform || "win32",
            version: envSnapshot.appVersion,
            env,
            ensurePluginInitialized: Promise.resolve(),
        };
        factory(_require, _require, _module, _module.exports, console, env, _process);
        instance = _module.exports.default ?? _module.exports;
    } catch (e: any) {
        instance = fallbackInstance();
        return { instance, stateCode: PluginStateCode.CannotParse, error: e?.stack || e?.message || String(e) };
    }
    _module.loaded = true;
    if (Array.isArray(instance?.userVariables)) {
        instance.userVariables = instance.userVariables.filter((it: any) => it?.key);
    }
    return { instance };
}

function safeSerialize(value: any): any {
    // 结构化克隆不可传递函数/Symbol/undefined；对齐 Electron IPC 的 structured clone 行为
    try {
        return JSON.parse(
            JSON.stringify(value, (k, v) => {
                if (typeof v === "function") {
                    return undefined;
                }
                if (typeof v === "symbol") {
                    return undefined;
                }
                return v;
            }),
        );
    } catch {
        return null;
    }
}

function instanceMeta(entry: LoadedPluginEntry, code: string, providedHash?: string) {
    const instance = entry.instance;
    const supportedMethod: string[] = [];
    const meta: any = {};
    for (const k in instance) {
        if (typeof instance[k] === "function") {
            supportedMethod.push(k);
        } else {
            try {
                meta[k] = safeSerialize(instance[k]);
            } catch {
                /* 忽略不可序列化字段 */
            }
        }
    }
    return {
        // 主 frame 已算过 hash 时直接复用，避免对全量插件代码重复 SHA256
        hash: instance.platform ? providedHash || sha256(code).toString() : "",
        platform: instance.platform ?? "",
        stateCode: entry.stateCode,
        error: entry.error,
        supportedMethod,
        meta,
    };
}

async function handleLoadPlugins(data: IpcMessage) {
    const { plugins, env } = data.payload || {};
    envSnapshot = env || {};
    const results: any[] = [];
    // 合并语义：只覆盖/新增本次传入的插件，不清空已加载实例，
    // 避免安装/更新期间并发的方法调用命中空表
    for (const { code, hash } of plugins || []) {
        const entry = loadOnePlugin(code);
        const meta = instanceMeta(entry, code, hash);
        if (meta.hash) {
            loadedPlugins.set(meta.hash, entry);
        }
        results.push(meta);
        // iframe 与主 frame 同线程：逐个插件之间让出主线程，避免批量执行造成长卡顿
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
    parent.postMessage({
        __musicfree_plugin: true,
        type: "rpc-response",
        id: data.id,
        ok: true,
        result: results,
    } satisfies IpcMessage, "*");
}

/** 懒加载单个插件（清单命中时首次调用）：只写入不清理其他已加载实例 */
async function handleLoadPlugin(data: IpcMessage) {
    const { code, hash, env } = data.payload || {};
    if (env) {
        envSnapshot = env;
    }
    const entry = loadOnePlugin(code);
    const meta = instanceMeta(entry, code, hash);
    if (meta.hash) {
        loadedPlugins.set(meta.hash, entry);
    }
    parent.postMessage({
        __musicfree_plugin: true,
        type: "rpc-response",
        id: data.id,
        ok: true,
        result: !!meta.hash,
    } satisfies IpcMessage, "*");
}

/** 卸载插件：移除 iframe 内实例，停止其模块级定时器/监听的后续引用 */
async function handleUnloadPlugin(data: IpcMessage) {
    const { hash } = data.payload || {};
    if (hash) {
        loadedPlugins.delete(hash);
    }
    parent.postMessage({
        __musicfree_plugin: true,
        type: "rpc-response",
        id: data.id,
        ok: true,
        result: true,
    } satisfies IpcMessage, "*");
}

/** 试加载（安装校验用）：仅解析并返回 meta，不写入 loadedPlugins */
async function handleTryLoadPlugin(data: IpcMessage) {
    const { plugins, env } = data.payload || {};
    if (env) {
        envSnapshot = env;
    }
    const results: any[] = [];
    for (const { code } of plugins || []) {
        const entry = loadOnePlugin(code);
        results.push(instanceMeta(entry, code));
    }
    parent.postMessage({
        __musicfree_plugin: true,
        type: "rpc-response",
        id: data.id,
        ok: true,
        result: results,
    } satisfies IpcMessage, "*");
}

async function handleCallMethod(data: IpcMessage) {
    const { hash, method, args } = data.payload || {};
    const entry = loadedPlugins.get(hash);
    const fn = entry?.instance?.[method];
    let ok = true;
    let result: any = null;
    let error: string | null = null;
    if (typeof fn !== "function") {
        ok = false;
        error = `method ${method} not found on plugin ${hash?.slice(0, 8)}`;
    } else {
        try {
            result = await fn.apply(entry.instance, args);
        } catch (e: any) {
            ok = false;
            error = e?.stack || e?.message || String(e);
        }
    }
    parent.postMessage({
        __musicfree_plugin: true,
        type: "rpc-response",
        id: data.id,
        ok,
        result: safeSerialize(result),
        error: error ?? undefined,
    } satisfies IpcMessage, "*");
}

// 就绪信号
parent.postMessage({ __musicfree_plugin: true, type: "runtime-ready" } satisfies IpcMessage, "*");

