/**
 * 主 frame 版 Rust HTTP adapter（阶段3）
 *
 * 渲染进程直连外网受 CORS 限制（原 Electron nodeIntegration 无此问题），
 * webdav 备份等主 frame 网络场景统一经 plugin_http_request（Rust reqwest）转发。
 */
import type { AxiosAdapter, AxiosResponse, InternalAxiosRequestConfig } from "axios";
import { invoke } from "@tauri-apps/api/core";
import qs from "qs";

function transformResponseData(result: any, responseType?: string): any {
    if (result.bodyBase64) {
        const binary = atob(result.bodyBase64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        return responseType === "arraybuffer" ? bytes.buffer : bytes;
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

export const rustHttpAdapter: AxiosAdapter = async (config: InternalAxiosRequestConfig) => {
    let url = config.url || "";
    if (!/^https?:/i.test(url) && config.baseURL) {
        url = config.baseURL + url;
    }
    if (config.params) {
        const query = config.paramsSerializer
            ? (config.paramsSerializer as any)(config.params)
            : qs.stringify(config.params);
        url += (url.includes("?") ? "&" : "?") + query;
    }
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries({ ...(config.headers || {}) })) {
        if (v != null) headers[k] = String(v);
    }
    let data: string | undefined;
    if (config.data != null) {
        data = typeof config.data === "string" ? config.data : JSON.stringify(config.data);
    }
    const result = await invoke<any>("plugin_http_request", {
        config: {
            url,
            method: (config.method || "get").toLowerCase(),
            headers,
            data,
            timeoutMs: config.timeout ?? 30000,
        },
        responseBinary: config.responseType === "arraybuffer" || config.responseType === "blob",
    });
    const response = {
        data: transformResponseData(result, config.responseType),
        status: result.status,
        statusText: "",
        headers: result.headers || {},
        config,
        request: {},
    } as AxiosResponse;
    return response;
};

/**
 * 局部 fetch patch：执行期间 window.fetch 走 Rust 代理（webdav 5 内部用全局
 * fetch 且无注入点；备份/恢复是用户显式动作，窗口内无并发 fetch，安全）。
 */
export async function withRustFetch<T>(task: () => Promise<T>): Promise<T> {
    const originalFetch = window.fetch;
    const rustFetch: typeof fetch = async (input, init) => {
        const url = typeof input === "string" ? input : (input as Request).url;
        const headers: Record<string, string> = {};
        const rawHeaders = (init?.headers ?? (input as Request)?.headers) as any;
        if (rawHeaders) {
            if (rawHeaders.forEach) {
                rawHeaders.forEach((v: any, k: any) => (headers[k] = String(v)));
            } else if (typeof rawHeaders === "object") {
                for (const [k, v] of Object.entries(rawHeaders)) {
                    headers[k] = String(v);
                }
            }
        }
        const method = (init?.method || "GET").toLowerCase();
        const body = typeof init?.body === "string" ? init.body : undefined;
        const result = await invoke<any>("plugin_http_request", {
            config: { url, method, headers, data: body, timeoutMs: 60000 },
        });
        const responseHeaders = new Headers();
        for (const [k, v] of Object.entries(result.headers || {})) {
            try {
                responseHeaders.set(k, String(v));
            } catch {
                /* 无效头名忽略 */
            }
        }
        return new Response(result.bodyText ?? "", {
            status: result.status,
            headers: responseHeaders,
        });
    };
    window.fetch = rustFetch;
    try {
        return await task();
    } finally {
        window.fetch = originalFetch;
    }
}
