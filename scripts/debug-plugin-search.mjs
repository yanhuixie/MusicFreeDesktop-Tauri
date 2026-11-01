/**
 * 复刻 plugin-runtime/index.ts 的 shim，在 Node 中加载真实插件并调用 search，
 * 用于诊断 Tauri 移植后搜索结果为 0 的问题。
 * 用法: node scripts/debug-plugin-search.mjs [关键词] [平台过滤]
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";

const nodeRequire = createRequire(import.meta.url);
const PKG_ROOT = path.resolve(import.meta.dirname, "..");
const req = (p) => nodeRequire(path.join(PKG_ROOT, "node_modules", p));

const CryptoJs = req("crypto-js");
const dayjs = req("dayjs");
const axios = req("axios").default ?? req("axios");
const bigInt = req("big-integer");
const qs = req("qs");
const cheerio = req("cheerio");
const he = req("he");

/**************************** axios adapter：与 iframe proxyAdapter 同构，HTTP 落到 Node fetch ****************************/
function transformRequestData(data) {
    if (data == null) return undefined;
    if (typeof data === "string") return data;
    try { return JSON.stringify(data); } catch { return String(data); }
}

const proxyAdapter = async (config) => {
    let url = config.url || "";
    if (!/^https?:/i.test(url) && config.baseURL) url = config.baseURL + url;
    if (config.params) {
        const s = config.paramsSerializer ? config.paramsSerializer(config.params) : qs.stringify(config.params);
        url += (url.includes("?") ? "&" : "?") + s;
    }
    const headers = {};
    for (const [k, v] of Object.entries({ ...(config.headers || {}) })) {
        if (v != null) headers[k] = String(v);
    }
    const method = (config.method || "get").toLowerCase();
    const body = transformRequestData(config.data);
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), config.timeout ?? 15000);
    try {
        const resp = await fetch(url, {
            method,
            headers,
            body: method === "get" || method === "head" ? undefined : body,
            signal: controller.signal,
            redirect: "follow",
        });
        const status = resp.status;
        const respHeaders = {};
        resp.headers.forEach((v, k) => { respHeaders[k] = v; });
        const text = await resp.text();
        let data = text;
        const rt = config.responseType;
        if ((rt === "json" || !rt) && text) {
            try { data = JSON.parse(text); } catch { data = text; }
        }
        return { data, status, statusText: resp.statusText || "", headers: respHeaders, config, request: {} };
    } finally {
        clearTimeout(t);
    }
};

axios.defaults.adapter = proxyAdapter;
axios.defaults.timeout = 15000;

/**************************** require shim（与 iframe 一致） ****************************/
const packages = {
    cheerio,
    "crypto-js": CryptoJs,
    axios,
    dayjs,
    "big-integer": bigInt,
    qs,
    he,
    webdav: { createClient: () => { throw new Error("webdav unsupported in debug"); } },
    "musicfree/storage": {
        async setItem() {}, async getItem() { return null; }, async removeItem() {},
    },
};
const _require = (packageName) => {
    const pkg = packages[packageName];
    if (pkg) { pkg.default = pkg; return pkg; }
    return null;
};

/**************************** 插件加载（与 loadOnePlugin 一致） ****************************/
const envSnapshot = { pluginMeta: {}, platform: "win32", appVersion: "0.0.0-debug", lang: "zh-CN" };
function pluginEnv(pluginName) {
    return {
        getUserVariables: () => envSnapshot.pluginMeta?.[pluginName]?.userVariables ?? {},
        os: "win32",
        appVersion: envSnapshot.appVersion,
        lang: "zh-CN",
    };
}

function loadOnePlugin(code) {
    const _module = { exports: {}, loaded: false };
    try {
        const factory = Function(`
            'use strict';
            return function(require, __musicfree_require, module, exports, console, env, process) {
                ${code}
            }
        `)();
        const env = pluginEnv("");
        const _process = { platform: "win32", version: envSnapshot.appVersion, env, ensurePluginInitialized: Promise.resolve() };
        factory(_require, _require, _module, _module.exports, console, env, _process);
        const instance = _module.exports.default ?? _module.exports;
        return { instance };
    } catch (e) {
        return { instance: null, error: e?.stack || e?.message || String(e) };
    }
}

/**************************** main ****************************/
const keyword = process.argv[2] || "周杰伦";
const platformFilter = process.argv[3] || "";
const pluginDir = path.join(os.homedir(), "AppData", "Roaming", "fun.upup.musicfree", "musicfree-plugins");
const files = fs.readdirSync(pluginDir).filter((f) => f.endsWith(".js"));

for (const f of files) {
    const code = fs.readFileSync(path.join(pluginDir, f), "utf-8");
    const { instance, error } = loadOnePlugin(code);
    if (!instance) {
        console.log(`[LOAD-FAIL] ${f}: ${String(error).slice(0, 160)}`);
        continue;
    }
    const platform = instance.platform;
    if (!platform || typeof instance.search !== "function") {
        console.log(`[SKIP] ${f}: platform=${platform} hasSearch=${typeof instance.search}`);
        continue;
    }
    if (platformFilter && platform !== platformFilter) continue;
    const t0 = Date.now();
    try {
        const raw = await instance.search(keyword, 1, "music");
        const data = raw?.data;
        console.log(`[OK] ${platform} (${f}): isEnd=${raw?.isEnd} count=${Array.isArray(data) ? data.length : "NOT-ARRAY"} ${Date.now() - t0}ms`);
        if (!Array.isArray(data) || data.length === 0) {
            console.log(`      raw keys: ${JSON.stringify(Object.keys(raw ?? {}))} sample=${JSON.stringify(raw)?.slice(0, 300)}`);
        }
    } catch (e) {
        console.log(`[SEARCH-ERROR] ${platform} (${f}): ${String(e?.stack || e).slice(0, 400)}`);
    }
}
