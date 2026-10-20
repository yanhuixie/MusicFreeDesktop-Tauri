// 阶段3 验收：插件运行时全链路
// 1. mock server 提供测试插件源码 + 搜索/歌单 API + 音频 + cookie 端点
// 2. CDP 驱动主窗口：安装插件 → 搜索 → getMediaSource（headers）→ 歌词 → storage → cookie jar
const http = require("http");

const CDP_PORT = 9223;
const MOCK_PORT = 9997;

// ---------- 测试插件源码（模拟社区插件 CommonJS 格式） ----------
const TEST_PLUGIN_CODE = `
const axios = require("axios");
module.exports = {
    platform: "测试音源",
    version: "1.0.0",
    srcUrl: "http://127.0.0.1:${MOCK_PORT}/test-plugin.js",
    async search(query, page, type) {
        const result = await axios.get("http://127.0.0.1:${MOCK_PORT}/api/search", { params: { query, page } });
        return result.data;
    },
    async getMediaSource(musicItem, quality) {
        return {
            url: "http://127.0.0.1:${MOCK_PORT}/audio.wav",
            headers: { referer: "https://test.example.com", "user-agent": "PluginTestUA" },
        };
    },
    async getLyric(musicItem) {
        return { rawLrc: "[00:00.00]测试歌词第一行\\n[00:01.00]测试歌词第二行" };
    },
    async getMusicSheetInfo(sheetItem) {
        const result = await axios.get("http://127.0.0.1:${MOCK_PORT}/api/sheet");
        return result.data;
    },
    async testStorage() {
        const storage = require("musicfree/storage");
        await storage.setItem("stage3key", "stage3value");
        return await storage.getItem("stage3key");
    },
    async testCookies() {
        const cookies = require("@react-native-cookies/cookies");
        await cookies.get("http://127.0.0.1:${MOCK_PORT}/set-cookie");
        return true;
    },
};
`;

// ---------- 生成 WAV ----------
function makeWav(seconds) {
  const sampleRate = 8000;
  const numSamples = sampleRate * seconds;
  const dataSize = numSamples;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate, 28);
  buf.writeUInt16LE(1, 32);
  buf.writeUInt16LE(8, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < numSamples; i++) {
    buf[44 + i] = Math.sin((i / sampleRate) * 2 * Math.PI * 440) > 0 ? 200 : 50;
  }
  return buf;
}

function startMockServer() {
  const wav = makeWav(3);
  const state = { lastCookieHeader: null, pluginRequests: 0 };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${MOCK_PORT}`);
    if (url.pathname === "/test-plugin.js") {
      res.writeHead(200, { "Content-Type": "application/javascript" });
      res.end(TEST_PLUGIN_CODE);
    } else if (url.pathname === "/api/search") {
      state.pluginRequests++;
      const query = url.searchParams.get("query");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        isEnd: true,
        data: [{ id: "m1", title: `结果-${query}`, artist: "插件艺人", album: "插件专辑", platform: "测试音源" }],
      }));
    } else if (url.pathname === "/api/sheet") {
      state.pluginRequests++;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        title: "测试歌单",
        musicList: [{ id: "s1", title: "歌单曲目", artist: "歌单艺人", platform: "测试音源" }],
      }));
    } else if (url.pathname === "/audio.wav") {
      state.pluginRequests++;
      const referer = req.headers["referer"];
      const ua = req.headers["user-agent"];
      state.mediaHeaders = { referer, ua };
      res.writeHead(200, { "Content-Type": "audio/wav", "Content-Length": wav.length });
      res.end(wav);
    } else if (url.pathname === "/set-cookie") {
      res.writeHead(200, {
        "Set-Cookie": "session=stage3token; Path=/",
        "Content-Type": "application/json",
      });
      res.end('{"ok":true}');
    } else if (url.pathname === "/check-cookie") {
      state.lastCookieHeader = req.headers["cookie"] || null;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ cookie: state.lastCookieHeader }));
    } else {
      res.writeHead(404); res.end();
    }
  });
  return new Promise((resolve) => server.listen(MOCK_PORT, "127.0.0.1", () => resolve({ server, state })));
}

// ---------- CDP ----------
function connect(wsUrl) {
  return new Promise(async (resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    let msgId = 0; const pending = new Map();
    ws.onmessage = (evt) => {
      const msg = JSON.parse(evt.data);
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    };
    resolve({
      eval: (expr, timeoutMs = 30000) => new Promise((res2, rej2) => {
        const id = ++msgId;
        const timer = setTimeout(() => rej2(new Error("timeout: " + expr.slice(0, 90))), timeoutMs);
        pending.set(id, (msg) => { clearTimeout(timer); res2(msg); });
        ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression: expr, awaitPromise: true, returnByValue: true } }));
      }).then((m) => {
        if (m.result?.exceptionDetails) throw new Error("page error: " + (m.result.exceptionDetails.exception?.description || "").slice(0, 500));
        return m.result?.result?.value;
      }),
      close: () => ws.close(),
    });
  });
}

async function main() {
  const { server, state } = await startMockServer();
  console.log("mock server:", MOCK_PORT);
  try {
    const pages = await (await fetch(`http://localhost:${CDP_PORT}/json`)).json();
    const main = pages.find((p) => p.url.includes("index.html"));
    const conn = await connect(main.webSocketDebuggerUrl);

    // 导入页面模块（vite dev 模块路径）
    const bridgeMod = await conn.eval(`import('/src/shared/plugin-manager/renderer/plugin-bridge.ts').then(m => 'bridge ok: ' + Object.keys(m).join(','))`);
    console.log("模块导入:", bridgeMod);

    // 1. 卸载旧测试插件（幂等）
    await conn.eval(`import('/src/shared/plugin-manager/renderer/plugin-bridge.ts').then(async m => {
      const delegates = await m.loadAllPlugins();
      const old = delegates.find(d => d.platform === '测试音源');
      if (old) { await m.uninstallPlugin(old.hash); return 'uninstalled old'; }
      return 'no old';
    })`);

    // 2. 安装插件
    const installResult = await conn.eval(`import('/src/shared/plugin-manager/renderer/plugin-bridge.ts').then(m => m.installPluginFromRemote('http://127.0.0.1:${MOCK_PORT}/test-plugin.js').then(() => 'installed').catch(e => 'INSTALL_FAIL: ' + e.message))`, 60000);
    console.log("安装:", installResult);

    // 3. 加载列表
    const delegates = await conn.eval(`import('/src/shared/plugin-manager/renderer/plugin-bridge.ts').then(m => m.loadAllPlugins().then(d => JSON.stringify(d.map(x => ({platform: x.platform, methods: x.supportedMethod.length, version: x.version})))))`, 60000);
    console.log("插件列表:", delegates);

    // 4. 搜索
    const searchResult = await conn.eval(`import('/src/shared/plugin-manager/renderer/plugin-bridge.ts').then(m => m.callPluginMethod({platform: '测试音源'}, 'search', '测试查询', 1, 'music').then(r => JSON.stringify(r)).catch(e => 'SEARCH_FAIL: ' + e.message))`, 60000);
    console.log("搜索:", searchResult);

    // 5. getMediaSource（headers 提取）
    const mediaResult = await conn.eval(`import('/src/shared/plugin-manager/renderer/plugin-bridge.ts').then(m => m.callPluginMethod({platform: '测试音源'}, 'getMediaSource', {id: 'm1', platform: '测试音源'}, 'standard').then(r => JSON.stringify(r)).catch(e => 'MEDIA_FAIL: ' + e.message))`, 60000);
    console.log("真实源:", mediaResult);

    // 6. 歌词
    const lyricResult = await conn.eval(`import('/src/shared/plugin-manager/renderer/plugin-bridge.ts').then(m => m.callPluginMethod({platform: '测试音源'}, 'getLyric', {id: 'm1', platform: '测试音源'}).then(r => JSON.stringify(r)).catch(e => 'LYRIC_FAIL: ' + e.message))`, 60000);
    console.log("歌词:", lyricResult);

    // 7. 歌单详情
    const sheetResult = await conn.eval(`import('/src/shared/plugin-manager/renderer/plugin-bridge.ts').then(m => m.callPluginMethod({platform: '测试音源'}, 'getMusicSheetInfo', {id: 'sheet1', platform: '测试音源'}).then(r => JSON.stringify(r?.title) + ' musicList=' + (r?.musicList?.length)).catch(e => 'SHEET_FAIL: ' + e.message))`, 60000);
    console.log("歌单:", sheetResult);

    // 8. storage polyfill
    const storageResult = await conn.eval(`import('/src/shared/plugin-manager/renderer/plugin-bridge.ts').then(m => m.callPluginMethod({platform: '测试音源'}, 'testStorage').then(r => JSON.stringify(r)).catch(e => 'STORAGE_FAIL: ' + e.message))`, 60000);
    console.log("storage:", storageResult);

    // 9. cookie jar：先请求 set-cookie（经 Rust）再 check-cookie 验证携带
    const cookieResult = await conn.eval(`window.__TAURI_INTERNALS__.invoke('plugin_http_request', {config: {url: 'http://127.0.0.1:${MOCK_PORT}/set-cookie', method: 'get'}}).then(() => window.__TAURI_INTERNALS__.invoke('plugin_http_request', {config: {url: 'http://127.0.0.1:${MOCK_PORT}/check-cookie', method: 'get'}})).then(r => r.bodyText).catch(e => 'COOKIE_FAIL: ' + e.message))`);
    console.log("cookie jar:", cookieResult);

    // 10. 插件 cookies polyfill 查询
    const cookieGetResult = await conn.eval(`import('/src/shared/plugin-manager/renderer/plugin-bridge.ts').then(m => m.callPluginMethod({platform: '测试音源'}, 'testCookies').then(r => JSON.stringify(r)).catch(e => 'CG_FAIL: ' + e.message))`, 60000);
    console.log("cookies polyfill:", cookieGetResult);

    console.log("\n上游观察: mediaHeaders =", JSON.stringify(state.mediaHeaders), "pluginRequests =", state.pluginRequests);
    conn.close();
  } finally {
    server.close();
  }
}
main().catch((e) => { console.error("验收失败:", e.message); process.exit(1); });
