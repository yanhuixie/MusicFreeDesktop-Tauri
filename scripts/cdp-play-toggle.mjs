/** CDP 驱动播放/暂停，验证 thumbar 状态切换链路（连 9223，生产 tauri.localhost） */
import WebSocket from "ws";

const list = await (await fetch("http://127.0.0.1:9223/json/list")).json();
const page = list.find((t) => t.type === "page" && (t.url.includes("tauri.localhost") || t.url.includes("index.html")));
if (!page) {
    console.log("NO_PAGE targets:", list.map((t) => t.url));
    process.exit(1);
}
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

const iconState = () =>
    ev(`(() => {
    const d = document.querySelector('.play-or-pause svg path')?.getAttribute('d') || 'NONE';
    return d.startsWith('M4.5 5.653') ? 'play' : 'pause:' + d.slice(0, 24);
})()`);

// 1. 点击歌单大播放按钮（antd 按钮内的 span 文本）
console.log("click-play:", await ev(`(() => {
    const span = [...document.querySelectorAll('span')].find(e => e.textContent.trim() === '播放' && e.offsetParent && e.closest('button,[role=button],.ant-btn'));
    const target = span?.closest('button,[role=button],.ant-btn') || span?.parentElement;
    if (!target) return 'NO_PLAY_BTN';
    target.click();
    return 'CLICKED';
})()`));

await new Promise((r) => setTimeout(r, 6000));
console.log("icon-after-play:", await iconState());

// 2. 点底部栏切暂停
console.log("click-toggle:", await ev(`(() => {
    const el = document.querySelector('.play-or-pause.controller-btn');
    if (!el) return 'NO_TOGGLE';
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return 'CLICKED';
})()`));
await new Promise((r) => setTimeout(r, 2500));
console.log("icon-after-toggle1:", await iconState());

// 3. 再切回播放
console.log("click-toggle2:", await ev(`(() => {
    const el = document.querySelector('.play-or-pause.controller-btn');
    if (!el) return 'NO_TOGGLE';
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return 'CLICKED';
})()`));
await new Promise((r) => setTimeout(r, 2500));
console.log("icon-after-toggle2:", await iconState());

ws.close();
