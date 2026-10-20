/**
 * mediahub:// 协议 URL 构造（阶段2）
 *
 * Tauri 版统一媒体管线：Rust 侧注册 mediahub 自定义协议，
 * 将带自定义 header 的远程音频 / basic-auth / 本地文件统一为流式代理。
 * 对应 Electron 版的三套 hack（_setHeaders + request-forwarder + file://）。
 */

export interface IMediahubPayload {
    url: string;
    headers?: Record<string, string>;
}

function base64UrlEncode(str: string): string {
    const bytes = new TextEncoder().encode(str);
    let binary = "";
    for (const b of bytes) {
        binary += String.fromCharCode(b);
    }
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function toMediahubUrl(url: string, headers?: Record<string, string>): string {
    const payload: IMediahubPayload = headers && Object.keys(headers).length ? { url, headers } : { url };
    const encoded = base64UrlEncode(JSON.stringify(payload));
    // Windows 上 Tauri 自定义协议实际形态为 http://{scheme}.localhost（WebView2 限制），
    // fetch / audio 元素 / hls.js 才能访问；macOS/Linux 为 scheme://localhost
    if (/Windows/i.test(navigator.userAgent)) {
        return `http://mediahub.localhost/f/${encoded}`;
    }
    return `mediahub://localhost/f/${encoded}`;
}

/** 判断是否本地文件 URL（本地音源：file:// 或绝对路径） */
export function isLocalFileUrl(url: string): boolean {
    if (url.startsWith("file:")) {
        return true;
    }
    // Windows 盘符绝对路径 D:\... 或 D:/...
    return /^[a-zA-Z]:[\\/]/.test(url);
}
