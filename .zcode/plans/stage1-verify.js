// 阶段1 自动化验收脚本：通过 CDP 驱动 Tauri WebView2
// 用法: node stage1-verify.js
const CDP_PORT = 9223;

async function getPageWsUrl() {
  const res = await fetch(`http://localhost:${CDP_PORT}/json`);
  const pages = await res.json();
  const main = pages.find((p) => p.url.includes("index.html"));
  if (!main) throw new Error("main window page not found: " + JSON.stringify(pages.map(p => p.url)));
  return { wsUrl: main.webSocketDebuggerUrl, url: main.url };
}

async function main() {
  const { wsUrl, url } = await getPageWsUrl();
  console.log("[main window]", url);
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let msgId = 0;
  const pending = new Map();
  ws.onmessage = (evt) => {
    const msg = JSON.parse(evt.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  };
  const cdpCall = (method, params = {}) =>
    new Promise((resolve) => {
      const id = ++msgId;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evalInPage = async (expr) => {
    const res = await cdpCall("Runtime.evaluate", {
      expression: expr,
      awaitPromise: true,
      returnByValue: true,
    });
    if (res.result?.exceptionDetails) {
      throw new Error("page eval failed: " + JSON.stringify(res.result.exceptionDetails).slice(0, 500));
    }
    return res.result?.result?.value;
  };

  const results = [];

  // 验收1：sync_app_config 返回配置（含默认值合并）
  const configKeys = await evalInPage(
    `window.__TAURI_INTERNALS__.invoke('sync_app_config').then(c => JSON.stringify({keys: Object.keys(c).length, lang: c['normal.language'], closeBehavior: c['normal.closeBehavior']}))`
  );
  results.push(["1. sync_app_config 读取", configKeys]);

  // 验收2：set_app_config 持久化
  await evalInPage(
    `window.__TAURI_INTERNALS__.invoke('set_app_config', {patch: {"playMusic.defaultQuality": "high", "__stage1Test": true}})`
  );
  await new Promise((r) => setTimeout(r, 500));
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const configPath = path.join(os.homedir(), "AppData", "Roaming", "fun.upup.musicfree", "config.json");
  const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  results.push(["2a. set_app_config 写盘", `quality=${raw["playMusic.defaultQuality"]} __stage1Test=${raw["__stage1Test"]}`]);

  // 验收2b：事件广播（页面内 AppConfig 缓存更新）
  const uiConfig = await evalInPage(`JSON.stringify(window.__appconfig_probe || null)`);
  results.push(["2b. UI 侧探针(可选)", uiConfig]);

  // 验收3：歌词窗创建
  await evalInPage(`window.__TAURI_INTERNALS__.invoke('set_lyric_window', {enabled: true})`);
  await new Promise((r) => setTimeout(r, 2000));
  const pagesAfter = await (await fetch(`http://localhost:${CDP_PORT}/json`)).json();
  const lrcPage = pagesAfter.find((p) => p.url.includes("lrc.html"));
  results.push(["3. 歌词窗创建", lrcPage ? "OK " + lrcPage.url : "FAIL"]);

  // 验收4：迷你模式窗创建
  await evalInPage(`window.__TAURI_INTERNALS__.invoke('set_minimode_window', {enabled: true})`);
  await new Promise((r) => setTimeout(r, 2000));
  const pagesAfter2 = await (await fetch(`http://localhost:${CDP_PORT}/json`)).json();
  const miniPage = pagesAfter2.find((p) => p.url.includes("minimode.html"));
  results.push(["4. 迷你窗创建", miniPage ? "OK " + miniPage.url : "FAIL"]);

  // 验收5：message-bus 主→扩展窗口状态同步（歌词窗监听 app-state-changed）
  if (lrcPage) {
    const ws2 = new WebSocket(lrcPage.webSocketDebuggerUrl);
    await new Promise((res) => { ws2.onopen = res; });
    const pending2 = new Map();
    let msgId2 = 0;
    ws2.onmessage = (evt) => {
      const msg = JSON.parse(evt.data);
      if (msg.id && pending2.has(msg.id)) { pending2.get(msg.id)(msg); pending2.delete(msg.id); }
    };
    const evalInLrc = (expr) =>
      new Promise((resolve) => {
        const id = ++msgId2;
        pending2.set(id, resolve);
        ws2.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression: expr, awaitPromise: true, returnByValue: true } }));
      }).then((res) => res.result?.result?.value);
    // 在歌词窗里监听原生事件
    await evalInLrc(`window.__lrcEvents = []; window.__TAURI_INTERNALS__.invoke('get_global_context').catch(()=>{}); import('/node_modules/@tauri-apps/api/event.ts').then(m => m.listen('app-state-changed', e => window.__lrcEvents.push(e.payload))).then(un => window.__unlisten = un).then(() => 'ready')`);
    await new Promise((r) => setTimeout(r, 1000));
    // 主窗口同步状态
    await evalInPage(`window.__TAURI_INTERNALS__.invoke('sync_app_state', {patch: {lyricText: '阶段1验收歌词', progress: 42}})`);
    await new Promise((r) => setTimeout(r, 1000));
    const lrcEvents = await evalInLrc(`JSON.stringify(window.__lrcEvents)`);
    results.push(["5. message-bus 主→歌词窗", lrcEvents]);
    ws2.close();
  }

  // 验收6：关闭扩展窗口
  await evalInPage(`window.__TAURI_INTERNALS__.invoke('set_lyric_window', {enabled: false})`);
  await evalInPage(`window.__TAURI_INTERNALS__.invoke('set_minimode_window', {enabled: false})`);
  await new Promise((r) => setTimeout(r, 1500));
  const pagesFinal = await (await fetch(`http://localhost:${CDP_PORT}/json`)).json();
  results.push(["6. 扩展窗口关闭", pagesFinal.filter(p => p.url.includes("lrc.html") || p.url.includes("minimode.html")).length === 0 ? "OK" : "FAIL: " + pagesFinal.map(p => p.url).join(",")]);

  // 清理测试配置
  await evalInPage(`window.__TAURI_INTERNALS__.invoke('set_app_config', {patch: {"__stage1Test": null}})`);

  console.log("\n========== 阶段1 验收结果 ==========");
  for (const [name, value] of results) {
    console.log(`${name}: ${value}`);
  }
  ws.close();
}

main().catch((e) => { console.error("验收脚本失败:", e.message); process.exit(1); });
