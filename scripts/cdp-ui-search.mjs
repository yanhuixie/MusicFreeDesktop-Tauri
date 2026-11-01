/** CDP UI 级验证：走真实路由触发搜索，读 store 与 DOM */
import WebSocket from "ws";

const list = await (await fetch("http://127.0.0.1:9222/json/list")).json();
const page = list.find((t) => t.type === "page" && t.url.includes("localhost:5173"));
const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
let seq = 0;
const pending = new Map();
const send = (method, params = {}) =>
    new Promise((res, rej) => {
        const id = ++seq;
        pending.set(id, { res, rej });
        ws.send(JSON.stringify({ id, method, params }));
    });
ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) {
        const { res, rej } = pending.get(m.id);
        pending.delete(m.id);
        m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
    }
});
await new Promise((r) => ws.on("open", r));
await send("Runtime.enable");
const ev = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true, timeout: 60000 });
    return r.exceptionDetails ? "EXC: " + JSON.stringify(r.exceptionDetails).slice(0, 300) : r.result?.value;
};

console.log("navigate:", await ev("location.hash = '#/main/search/' + encodeURIComponent('周杰伦'), 'ok'"));
await new Promise((r) => setTimeout(r, 8000));

console.log("store:", await ev(`(async () => {
    const { searchResultsStore } = await import("/src/renderer/pages/main-page/views/search-view/store/search-result.ts");
    const s = searchResultsStore.getValue();
    const out = {};
    for (const [type, byHash] of Object.entries(s)) {
        const entries = Object.entries(byHash);
        if (entries.length) out[type] = entries.slice(0, 3).map(([h, r]) => ({ hash: h.slice(0, 8), state: r.state, n: r.data?.length, q: r.query }));
    }
    return JSON.stringify(out);
})()`));

console.log("dom:", await ev(`(() => {
    const rows = document.querySelectorAll(".search-view-container .music-grid-item, .search-view-container [class*=list] .row, .search-view-container .music-item");
    const tabs = document.querySelectorAll(".tab-list-container .tab");
    const bodyText = document.querySelector(".search-view-container")?.innerText?.slice(0, 200);
    return JSON.stringify({ resultRows: rows.length, pluginTabs: tabs.length, bodyText });
})()`));
ws.close();
