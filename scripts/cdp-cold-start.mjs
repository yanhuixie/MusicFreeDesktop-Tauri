/**
 * 冷启动验证（一次性）：测量进程启动→首屏渲染耗时，并检查插件清单/懒加载行为。
 * 用法：node scripts/cdp-cold-start.mjs <delete-manifest|keep-manifest> <label>
 */
import WebSocket from "ws";
import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const EXE = "D:\\develop\\opensource\\MusicFreeDesktop\\src-tauri\\target\\release\\musicfree-desktop.exe";
const BASE = "http://127.0.0.1:9222";
const LOG = path.join(process.env.LOCALAPPDATA, "fun.upup.musicfree", "logs", "MusicFree.log");
const MANIFEST = path.join(process.env.APPDATA, "fun.upup.musicfree", "plugin-manifest.json");
const mode = process.argv[2] || "keep-manifest";
const label = process.argv[3] || "run";

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

async function waitForPage(timeoutMs = 20000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            const list = await (await fetch(`${BASE}/json/list`)).json();
            const page = list.find((t) => t.type === "page" && /tauri\.localhost\/index\.html/.test(t.url));
            if (page) return { page, ms: Date.now() - start };
        } catch {}
        await sleep(50);
    }
    return null;
}

// ---- start ----
killApp();
await sleep(1200);
if (mode === "delete-manifest") {
    try {
        fs.unlinkSync(MANIFEST);
        console.log("[manifest] deleted");
    } catch {
        console.log("[manifest] not present");
    }
} else {
    console.log("[manifest] exists:", fs.existsSync(MANIFEST));
}

const logBefore = fs.existsSync(LOG) ? fs.readFileSync(LOG, "utf8").split("\n").length : 0;
const t0 = Date.now();
const child = spawn(EXE, [], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=9222" },
});
child.unref();

const found = await waitForPage();
if (!found) {
    console.log("FAILED: no CDP page");
    process.exit(1);
}
const cdp = await connect(found.page.webSocketDebuggerUrl);
await cdp.send("Runtime.enable");

// 逐步轮询 root 渲染
let renderMs = null;
let earlyBg = null;
for (let i = 0; i < 200; i++) {
    const state = await evalJs(
        cdp,
        `(() => { const r = document.getElementById('root'); return JSON.stringify({n: r ? r.children.length : -1, bg: getComputedStyle(document.documentElement).backgroundColor, ifr: document.querySelectorAll('iframe').length}); })()`,
    );
    if (typeof state === "string" && state.startsWith("{")) {
        const s = JSON.parse(state);
        if (earlyBg === null) earlyBg = s.bg;
        if (s.n > 0) {
            renderMs = Date.now() - t0;
            break;
        }
    }
    await sleep(50);
}
console.log(`[${label}] page target after ${found.ms}ms, first render after ${renderMs}ms, background=${earlyBg}`);

await sleep(3500);
const after = await evalJs(
    cdp,
    `JSON.stringify({ rootChildren: document.getElementById('root').children.length, iframes: document.querySelectorAll('iframe').length, textLen: (document.body.innerText || '').length })`,
);
console.log(`[${label}] after 3.5s:`, after);
console.log(`[${label}] background now:`, await evalJs(cdp, `getComputedStyle(document.documentElement).backgroundColor`));
console.log(`[${label}] manifest exists:`, fs.existsSync(MANIFEST), fs.existsSync(MANIFEST) ? `${fs.statSync(MANIFEST).size}B` : "");

console.log(`[${label}] new log lines:`);
const lines = fs.readFileSync(LOG, "utf8").split("\n").slice(logBefore);
for (const line of lines) {
    if (/Perf Renderer|loadAllPlugins|插件/.test(line)) console.log("   " + line.slice(0, 240));
}

cdp.close();
killApp();
console.log(`[${label}] done`);
