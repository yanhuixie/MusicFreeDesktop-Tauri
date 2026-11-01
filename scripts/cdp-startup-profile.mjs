/**
 * CDP 启动耗时剖析（一次性诊断脚本）
 *
 * 前置：以 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 启动应用。
 * 做法：连上主页面 → addScriptToEvaluateOnNewDocument 注入计时钩子 → Page.reload 复现启动
 *      → 收集 invoke / IndexedDB / postMessage / longtask / paint 时间线。
 */
import WebSocket from "ws";

const BASE = "http://127.0.0.1:9222";
const WAIT_MS = Number(process.env.WAIT_MS || 25000);

function connect(wsUrl) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(wsUrl, { perMessageDeflate: false });
        const pending = new Map();
        let seq = 0;
        ws.on("open", () => resolve({
            send(method, params = {}) {
                const id = ++seq;
                return new Promise((res, rej) => {
                    pending.set(id, { res, rej });
                    ws.send(JSON.stringify({ id, method, params }));
                });
            },
            close: () => ws.close(),
        }));
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
    const r = await cdp.send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
        timeout: 120000,
    });
    if (r.exceptionDetails) {
        return "EXCEPTION: " + JSON.stringify(r.exceptionDetails).slice(0, 500);
    }
    return r.result?.value;
}

const INJECT = `
(() => {
  if (window.__perfLog) return;
  window.__perfLog = [];
  window.__perfT0 = performance.now();
  const rec = (type, name, ms, extra) => {
    window.__perfLog.push({
      t: Math.round(performance.now() - window.__perfT0),
      type, name,
      ms: ms == null ? null : Math.round(ms * 10) / 10,
      extra: extra === undefined ? null : extra,
    });
  };
  rec("mark", "inject");
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) rec("longtask", "", e.duration, Math.round(e.startTime));
    }).observe({ entryTypes: ["longtask"] });
  } catch (e) {}
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) rec("paint", e.name, e.startTime);
    }).observe({ entryTypes: ["paint"] });
  } catch (e) {}

  const wrapInvoke = () => {
    const I = window.__TAURI_INTERNALS__;
    if (!I || typeof I.invoke !== "function" || I.invoke.__wrapped) return false;
    const orig = I.invoke;
    const w = function (cmd, args, opts) {
      const t0 = performance.now();
      rec("invoke-start", cmd);
      let p;
      try {
        p = orig.call(this, cmd, args, opts);
      } catch (e) {
        rec("invoke-throw", cmd, performance.now() - t0, String(e));
        throw e;
      }
      if (p && typeof p.then === "function") {
        p.then(
          () => rec("invoke", cmd, performance.now() - t0),
          () => rec("invoke-reject", cmd, performance.now() - t0)
        );
      }
      return p;
    };
    w.__wrapped = true;
    I.invoke = w;
    return true;
  };
  if (!wrapInvoke()) {
    const timer = setInterval(() => { if (wrapInvoke()) clearInterval(timer); }, 1);
    setTimeout(() => clearInterval(timer), 8000);
  }

  try {
    const openOrig = IDBFactory.prototype.open;
    IDBFactory.prototype.open = function (...a) {
      const t0 = performance.now();
      const r = openOrig.apply(this, a);
      r.addEventListener("success", () => rec("idb-open", String(a[0]), performance.now() - t0));
      return r;
    };
    const transOrig = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (...a) {
      rec("idb-tx", String(a[0]), null, typeof a[1] === "string" ? a[1] : (a[1] && a[1].name) || "");
      return transOrig.apply(this, a);
    };
  } catch (e) { rec("err", "idb-patch", null, String(e)); }

  try {
    const pmOrig = window.postMessage.bind(window);
    window.postMessage = function (msg, target, transfer) {
      let n = 0, bytes = 0;
      try {
        if (msg && msg.__musicfree_plugin && msg.payload && Array.isArray(msg.payload.plugins)) {
          n = msg.payload.plugins.length;
          for (const p of msg.payload.plugins) bytes += (p && p.code ? p.code.length : 0);
        }
      } catch (e) {}
      rec("postMessage", String(msg && msg.type ? msg.type : "?"), null, n ? { n, mb: Math.round(bytes / 10485.76) / 100 } : null);
      return pmOrig(msg, target, transfer);
    };
  } catch (e) { rec("err", "pm-patch", null, String(e)); }

  try {
    const appendOrig = Node.prototype.appendChild;
    Node.prototype.appendChild = function (child) {
      if (child && child.tagName === "IFRAME") rec("iframe-append", String(child.src));
      return appendOrig.call(this, child);
    };
  } catch (e) {}

  // 主 frame 收到 iframe 的 runtime-ready / rpc-response 的时间点
  window.addEventListener("message", (e) => {
    const d = e.data;
    if (d && d.__musicfree_plugin) {
      rec("message-in", String(d.type), null, d.type === "rpc-response" ? { ok: d.ok } : null);
    }
  }, true);
})();
`;

const list = await (await fetch(`${BASE}/json/list`)).json();
const page = list.find(
    (t) => t.type === "page" && /tauri\.localhost|localhost:5173/.test(t.url) && !/minimode|lrc/.test(t.url) && !/plugin-runtime/.test(t.url)
);
if (!page) {
    console.log("no main page target; targets:", list.map((t) => `${t.type}:${t.url}`).join("\n"));
    process.exit(1);
}
console.log("attached:", page.url);
const cdp = await connect(page.webSocketDebuggerUrl);
await cdp.send("Runtime.enable");
await cdp.send("Page.enable");
await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: INJECT });

console.log("reloading...");
const t0 = Date.now();
await cdp.send("Page.reload", { ignoreCache: true });

// 轮询到 #root 有内容（或超时）
for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const state = await evalJs(cdp, `(() => { const r = document.getElementById('root'); return r ? r.children.length : -1; })()`);
    if (state > 0) {
        console.log(`render detected after ${Date.now() - t0}ms (root children: ${state})`);
        break;
    }
}
await new Promise((r) => setTimeout(r, 2000));

const log = await evalJs(cdp, `JSON.stringify(window.__perfLog)`);
const paint = await evalJs(cdp, `JSON.stringify(performance.getEntriesByType('paint').map(e => ({name: e.name, start: Math.round(e.startTime)})))`);
const nav = await evalJs(cdp, `JSON.stringify((() => { const n = performance.getEntriesByType('navigation')[0]; return n ? {domContentLoaded: Math.round(n.domContentLoadedEventEnd), load: Math.round(n.loadEventEnd), responseEnd: Math.round(n.responseEnd)} : null; })())`);
const res = await evalJs(cdp, `JSON.stringify(performance.getEntriesByType('resource').filter(e => /\\.(js|css)$/.test(e.name)).map(e => ({ n: e.name.split('/').pop(), start: Math.round(e.startTime), dur: Math.round(e.duration), size: e.transferSize })))`);

console.log("\n== navigation ==", nav);
console.log("== paint ==", paint);
console.log("== js/css resources ==");
try { for (const r of JSON.parse(res)) console.log("  ", JSON.stringify(r)); } catch { console.log(res); }

console.log("\n== timeline ==");
try {
    for (const e of JSON.parse(log)) {
        const extra = e.extra ? " " + JSON.stringify(e.extra) : "";
        console.log(`  t=${String(e.t).padStart(6)}ms ${e.type.padEnd(14)} ${e.name.padEnd(52)} ${e.ms == null ? "" : e.ms + "ms"}${extra}`);
    }
} catch { console.log(log); }

// iframe 内部时间线（同源可读）
const ifrLog = await evalJs(cdp, `(() => { try { const f = document.querySelector('iframe'); return JSON.stringify(f && f.contentWindow && f.contentWindow.__perfLog ? f.contentWindow.__perfLog : null); } catch (e) { return 'ERR ' + e.message; } })()`);
console.log("\n== iframe timeline ==");
try { for (const e of JSON.parse(ifrLog)) console.log(`  t=${String(e.t).padStart(6)}ms ${e.type} ${e.name} ${e.ms == null ? "" : e.ms + "ms"}`); } catch { console.log(ifrLog); }

cdp.close();
