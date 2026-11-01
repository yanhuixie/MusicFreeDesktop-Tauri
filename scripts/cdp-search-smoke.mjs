/**
 * 搜索冒烟（一次性）：命中清单启动 → 校验懒加载 → 触发真实搜索。
 * 用法：node scripts/cdp-search-smoke.mjs
 */
import WebSocket from "ws";
import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const EXE = "D:\\develop\\opensource\\MusicFreeDesktop\\src-tauri\\target\\release\\musicfree-desktop.exe";
const BASE = "http://127.0.0.1:9222";
const LOG = path.join(process.env.LOCALAPPDATA, "fun.upup.musicfree", "logs", "MusicFree.log");
const MANIFEST = path.join(process.env.APPDATA, "fun.upup.musicfree", "plugin-manifest.json");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function killApp() {
    try {
        execSync("taskkill /IM musicfree-desktop.exe /F", { stdio: "ignore" });
    } catch {}
}

function connect(wsUrl) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(wsUrl, { perMessageDeflate: false });
        const pending = new Map();
        let seq = 0;
        ws.on("open", () =>
            resolve({
                send(method, params = {}) {
                    const id = ++seq;
                    return new Promise((res, rej) => {
                        pending.set(id, { res, rej });
                        ws.send(JSON.stringify({ id, method, params }));
                    });
                },
                close: () => ws.close(),
            }),
        );
        ws.on("message", (raw) => {
            const msg = JSON.parse(raw.toString());
            if (msg.id && pending.has(msg.id)) {
                const { res, rej } = pending.get(msg.id);
                pending.delete(msg.id);
                msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
            }
        });
        ws.on("error", reject);
    });
}

async function evalJs(cdp, expression) {
    const r = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, timeout: 60000 });
    if (r.exceptionDetails) return "EXCEPTION " + JSON.stringify(r.exceptionDetails).slice(0, 300);
    return r.result?.value;
}

killApp();
await sleep(1200);
console.log("[manifest] exists:", fs.existsSync(MANIFEST), fs.existsSync(MANIFEST) ? fs.statSync(MANIFEST).size + "B" : "");
const logBefore = fs.existsSync(LOG) ? fs.readFileSync(LOG, "utf8").split("\n").length : 0;

const t0 = Date.now();
const child = spawn(EXE, [], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=9222" },
});
child.unref();

let page = null;
for (let i = 0; i < 300 && !page; i++) {
    try {
        const list = await (await fetch(`${BASE}/json/list`)).json();
        page = list.find((t) => t.type === "page" && /tauri\.localhost\/index\.html/.test(t.url));
    } catch {}
    if (!page) await sleep(50);
}
if (!page) {
    console.log("FAILED: no page");
    process.exit(1);
}
const cdp = await connect(page.webSocketDebuggerUrl);
await cdp.send("Runtime.enable");

let renderMs = null;
for (let i = 0; i < 200; i++) {
    const n = await evalJs(cdp, `document.getElementById('root')?.children.length ?? -1`);
    if (n > 0) {
        renderMs = Date.now() - t0;
        break;
    }
    await sleep(50);
}
console.log(`first render: ${renderMs}ms`);

await sleep(3000);
console.log("before search:", await evalJs(cdp, `JSON.stringify({ iframes: document.querySelectorAll('iframe').length, bg: getComputedStyle(document.documentElement).backgroundColor, bootBg: getComputedStyle(document.documentElement).getPropertyValue('--boot-bg'), cached: localStorage.getItem('themepack-bg'), media: navigator.mediaSession.metadata ? { title: navigator.mediaSession.metadata.title, artist: navigator.mediaSession.metadata.artist } : null, textLen: (document.body.innerText||'').length })`));

const query = "周杰伦";
await evalJs(cdp, `location.hash = '#/main/search/' + encodeURIComponent(${JSON.stringify(query)}), 'ok'`);
console.log("navigated to search");

let ok = false;
let last = "";
for (let i = 0; i < 40; i++) {
    await sleep(500);
    last = await evalJs(
        cdp,
        `(() => { const t = document.body.innerText || ''; return JSON.stringify({ iframes: document.querySelectorAll('iframe').length, textLen: t.length, hasQuery: t.includes(${JSON.stringify(query)}), tail: t.slice(0, 300) }); })()`,
    );
    try {
        const s = JSON.parse(last);
        // 搜索结果出现：文本长度明显增长
        if (s.iframes >= 1 && s.textLen > 800) {
            ok = true;
            console.log(`search result window after ${(i + 1) * 500}ms:`, JSON.stringify(s).slice(0, 500));
            break;
        }
    } catch {}
}
if (!ok) console.log("search did not yield content, last:", String(last).slice(0, 500));

await sleep(1500);
console.log("final:", await evalJs(cdp, `JSON.stringify({ iframes: document.querySelectorAll('iframe').length, textLen: (document.body.innerText||'').length, hasQuery: (document.body.innerText||'').includes(${JSON.stringify(query)}) })`));

console.log("new log lines:");
const lines = fs.readFileSync(LOG, "utf8").split("\n").slice(logBefore);
const interesting = lines.filter((l) => /Perf Renderer|loadAllPlugins|error|warn|starting new connection/.test(l));
for (const line of interesting.slice(0, 40)) console.log("   " + line.slice(0, 220));
console.log(`(log lines total: ${lines.length}, interesting: ${interesting.length})`);

cdp.close();
killApp();
console.log("done");
