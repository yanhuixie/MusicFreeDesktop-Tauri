/**
 * CDP 诊断：连接 WebView2 远程调试端口，检查插件运行时状态并触发一次真实搜索。
 * 前置：WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 npm run tauri dev
 */
import WebSocket from "ws";

const BASE = "http://127.0.0.1:9222";

async function targets() {
    const r = await fetch(`${BASE}/json/list`);
    return r.json();
}

function connect(wsUrl) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(wsUrl, { perMessageDeflate: false });
        const pending = new Map();
        let seq = 0;
        const events = [];
        ws.on("open", () => resolve({
            send(method, params = {}) {
                const id = ++seq;
                return new Promise((res, rej) => {
                    pending.set(id, { res, rej });
                    ws.send(JSON.stringify({ id, method, params }));
                });
            },
            events,
            close: () => ws.close(),
        }));
        ws.on("message", (raw) => {
            const msg = JSON.parse(raw.toString());
            if (msg.id && pending.has(msg.id)) {
                const { res, rej } = pending.get(msg.id);
                pending.delete(msg.id);
                msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
                return;
            }
            events.push(msg);
        });
        ws.on("error", reject);
    });
}

async function evalJs(cdp, expression) {
    const r = await cdp.send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
        timeout: 60000,
    });
    if (r.exceptionDetails) {
        return `EXCEPTION: ${JSON.stringify(r.exceptionDetails).slice(0, 500)}`;
    }
    return r.result?.value;
}

const list = await targets();
console.log("== targets ==");
for (const t of list.filter((t) => t.type === "page")) {
    console.log(`  ${t.title} | ${t.url}`);
}
const page = list.find((t) => t.type === "page" && /localhost:5173|tauri\.localhost/.test(t.url) && !/minimode|lrc/.test(t.url));
if (!page) {
    console.log("no main page target found");
    process.exit(1);
}
const cdp = await connect(page.webSocketDebuggerUrl);
await cdp.send("Runtime.enable");
console.log(`\n== attached: ${page.url} ==\n`);

// 1. iframe 状态
console.log("== iframe ==");
console.log(await evalJs(cdp, `(() => {
    const ifr = document.querySelector('iframe');
    if (!ifr) return "NO IFRAME";
    let inner = "?";
    try { inner = ifr.contentWindow.location.href; } catch (e) { inner = "CROSS-ORIGIN: " + e.message; }
    return JSON.stringify({ src: ifr.src, connected: ifr.isConnected, inner, readyState: ifr.contentDocument?.readyState });
})()`));

// 2. 插件管理器状态（vite dev 下可直接 import 源码模块）
console.log("\n== PluginManager ==");
console.log(await evalJs(cdp, `(async () => {
    const pm = await import("/src/shared/plugin-manager/renderer.ts");
    const all = pm.default.getSupportedPlugin("search");
    return JSON.stringify({ total: all.length, sample: all.slice(0, 5).map((p) => ({ platform: p.platform, methods: p.supportedMethod.length })) });
})()`));

// 3. 监听主 frame 收到的插件 RPC 消息
await evalJs(cdp, `(() => {
    window.__pluginMsgs = [];
    window.addEventListener("message", (e) => {
        if (e.data?.__musicfree_plugin) {
            window.__pluginMsgs.push({ type: e.data.type, ok: e.data.ok, error: (e.data.error || "").slice(0, 120) });
        }
    });
    return "listener installed";
})()`);

// 4. 手动触发一次真实搜索（netease 或第一个可用插件）
console.log("\n== manual search ==");
console.log(await evalJs(cdp, `(async () => {
    const pm = await import("/src/shared/plugin-manager/renderer.ts");
    const all = pm.default.getSupportedPlugin("search");
    const pick = all.find((p) => p.platform === "netease") || all[0];
    if (!pick) return "NO SEARCHABLE PLUGIN";
    try {
        const t0 = performance.now();
        const r = await pm.default.callPluginDelegateMethod(pick, "search", "周杰伦", 1, "music");
        return JSON.stringify({ platform: pick.platform, ms: Math.round(performance.now() - t0), isEnd: r?.isEnd, count: r?.data?.length, first: r?.data?.[0]?.title });
    } catch (e) {
        return "THREW: " + (e?.stack || e?.message || String(e)).slice(0, 400);
    }
})()`));

console.log("\n== plugin RPC messages during search ==");
console.log(await evalJs(cdp, `JSON.stringify(window.__pluginMsgs)`));

// 5. 页面自身的 console 错误（回放最近事件）
console.log("\n== console events (collected) ==");
for (const ev of cdp.events.filter((e) => e.method === "Runtime.consoleAPICalled")) {
    const text = (ev.params.args || []).map((a) => a.value ?? a.description ?? "").join(" ");
    console.log(`  [${ev.params.type}] ${text.slice(0, 200)}`);
}

cdp.close();
