// 阶段4 验收：本地音源（lofty）/伴生歌词/下载/watcher/主题包
const CDP_PORT = 9223;
const MOCK_PORT = 9995;
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execSync } = require("child_process");

// ---------- 生成带 ID3v2.3 标签的测试 MP3 ----------
function makeTaggedMp3(title, artist, album) {
  // ID3v2.3：帧内容编码 0x00 (latin1)
  function textFrame(id, text) {
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
    const content = Buffer.concat([Buffer.from([0x01]), utf16, Buffer.from([0x00, 0x00])]);
    const head = Buffer.alloc(10);
    head.write(id, 0, "latin1");
    head.writeUInt32BE(content.length, 4);
    return Buffer.concat([head, content]);
  }
  const frames = Buffer.concat([
    textFrame("TIT2", title),
    textFrame("TPE1", artist),
    textFrame("TALB", album),
  ]);
  const tagHeader = Buffer.alloc(10);
  tagHeader.write("ID3", 0, "latin1");
  tagHeader[3] = 3; // ver 2.3
  tagHeader[4] = 0;
  // synchsafe size
  const size = frames.length;
  tagHeader[6] = (size >> 21) & 0x7f;
  tagHeader[7] = (size >> 14) & 0x7f;
  tagHeader[8] = (size >> 7) & 0x7f;
  tagHeader[9] = size & 0x7f;
  // MPEG1 Layer3 128kbps 44.1kHz 帧（417B），lofty 只需帧头合法
  const frame = Buffer.alloc(417);
  frame[0] = 0xff; frame[1] = 0xfb; frame[2] = 0x90; frame[3] = 0x00;
  const audio = Buffer.concat(Array(8).fill(frame));
  return Buffer.concat([tagHeader, frames, audio]);
}

// ---------- 生成 .mftheme 主题包（zip） ----------
function makeThemePack(themeName) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mftheme-src-"));
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({
    name: themeName,
    author: "stage4",
    version: "1.0.0",
    preview: "#ff8c00",
    iframe: null,
  }));
  fs.writeFileSync(path.join(dir, "index.css"), "body { --primaryColor: #123456; } /* @/res/bg.png */");
  const zipPath = path.join(os.tmpdir(), `stage4-theme-${Date.now()}.zip`);
  execSync(`powershell.exe -NoProfile -Command "Compress-Archive -Path '${dir.replace(/\\/g, "/")}/*' -DestinationPath '${zipPath.replace(/\\/g, "/")}' -Force"`);
  const mfthemePath = zipPath.replace(/\.zip$/, ".mftheme");
  fs.renameSync(zipPath, mfthemePath);
  return mfthemePath;
}

function startMock() {
  const wav = makeWav(2);
  const server = http.createServer((req, res) => {
    if (req.url.startsWith("/audio.wav")) {
      res.writeHead(200, { "Content-Type": "audio/wav", "Content-Length": wav.length });
      res.end(wav);
    } else { res.writeHead(404); res.end(); }
  });
  return new Promise((r) => server.listen(MOCK_PORT, "127.0.0.1", () => r(server)));
}
function makeWav(seconds) {
  const sampleRate = 8000, numSamples = sampleRate * seconds, dataSize = numSamples;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + dataSize, 4); buf.write("WAVE", 8);
  buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24); buf.writeUInt32LE(sampleRate, 28); buf.writeUInt16LE(1, 32); buf.writeUInt16LE(8, 34);
  buf.write("data", 36); buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < numSamples; i++) buf[44 + i] = 160;
  return buf;
}

// ---------- CDP ----------
function connect(wsUrl) {
  return new Promise(async (resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    let msgId = 0; const pending = new Map();
    const eventHandlers = [];
    ws.onmessage = (evt) => {
      const msg = JSON.parse(evt.data);
      if (msg.method && eventHandlers.length) {
        for (const h of eventHandlers) h(msg);
      }
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    };
    resolve({
      eval: (expr, timeoutMs = 30000) => new Promise((res2, rej2) => {
        const id = ++msgId;
        const t = setTimeout(() => rej2(new Error("timeout: " + expr.slice(0, 80))), timeoutMs);
        pending.set(id, (msg) => { clearTimeout(t); res2(msg); });
        ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression: expr, awaitPromise: true, returnByValue: true } }));
      }).then((m) => {
        if (m.result?.exceptionDetails) {
          console.error("EVAL FAILED, expression head:", expr.slice(0, 300));
          console.error("exception:", JSON.stringify(m.result.exceptionDetails.exception || {}).slice(0, 300));
          throw new Error("page error: " + (m.result.exceptionDetails.exception?.description || "").slice(0, 400));
        }
        return m.result?.result?.value;
      }),
      onEvent: (handler) => eventHandlers.push(handler),
      close: () => ws.close(),
    });
  });
}

async function main() {
  const server = await startMock();
  // 准备资产
  const assetDir = fs.mkdtempSync(path.join(os.tmpdir(), "musicfree-stage4-"));
  const mp3Path = path.join(assetDir, "测试歌曲.mp3");
  fs.writeFileSync(mp3Path, makeTaggedMp3("标题测试", "艺术家测试", "专辑测试"));
  fs.writeFileSync(path.join(assetDir, "测试歌曲.lrc"), "[00:00.00]伴生歌词第一行\n[00:01.00]伴生歌词第二行");
  const subDir = path.join(assetDir, "子目录");
  fs.mkdirSync(subDir);
  fs.writeFileSync(path.join(subDir, "第二首.mp3"), makeTaggedMp3("第二首标题", "第二首艺术家", "专辑B"));
  const themePath = makeThemePack("阶段4测试主题");
  console.log("资产目录:", assetDir);

  try {
    const pages = await (await fetch(`http://localhost:${CDP_PORT}/json`)).json();
    const main = pages.find((p) => p.url.includes("index.html"));
    const conn = await connect(main.webSocketDebuggerUrl);
    const results = [];
    const inv = (cmd, args) => `window.__TAURI_INTERNALS__.invoke('${cmd}', ${JSON.stringify(args)})`;

    // 1. 本地单曲解析（lofty 标签）
    const item = await conn.eval(`(async () => { const r = await ${inv("parse_local_music_item", { path: mp3Path })}; return JSON.stringify({title: r.title, artist: r.artist, album: r.album, id: r.id, platform: r.platform}); })()`);
    results.push(["1 单曲解析", item]);

    // 2. 目录扫描
    const folderItems = await conn.eval(`(async () => { const r = await ${inv("parse_local_music_item_folder", { folder: assetDir })}; return 'count=' + r.length + ' titles=' + r.map(x => x.title).join(','); })()`);
    results.push(["2 目录扫描", folderItems]);

    // 3. 本地音源 getMediaSource（mediahub URL）
    const mediaUrl = await conn.eval(`(async () => { const m = await import('/src/shared/plugin-manager/renderer/plugin-bridge.ts'); const r = await m.callPluginMethod({platform: '本地'}, 'getMediaSource', {id: 'x', platform: '本地', localPath: ${JSON.stringify(mp3Path)}, $$localPath: ${JSON.stringify(mp3Path)}}, 'standard'); return r && r.url; })()`);
    results.push(["3 getMediaSource", mediaUrl]);

    // 3b. mediahub URL 可访问
    if (mediaUrl) {
      const fetched = await conn.eval(`(async () => { const r = await fetch(${JSON.stringify(mediaUrl)}); return 'HTTP ' + r.status + ' len=' + (await r.arrayBuffer()).byteLength; })()`);
      results.push(["3b mediahub 播放", fetched]);
    }

    // 4. 伴生歌词
    const lrc = await conn.eval(`(async () => { const m = await import('/src/shared/plugin-manager/renderer/plugin-bridge.ts'); const r = await m.callPluginMethod({platform: '本地'}, 'getLyric', {id: 'x', platform: '本地', $$localPath: ${JSON.stringify(mp3Path)}}); return JSON.stringify(r); })()`);
    results.push(["4 伴生歌词", lrc]);

    // 5. 下载（进度事件）
    const downloadResult = await conn.eval(`(async () => {
      const events = [];
      const { listen } = await import('/node_modules/.vite/deps/@tauri-apps_api_event.js');
      const un = await listen('download-progress', e => events.push(e.payload.state));
      const downloadPath = ${JSON.stringify(path.join(assetDir, "下载测试.wav").replace(/\\/g, "\\\\"))};
      try {
        await window.__TAURI_INTERNALS__.invoke('download_file', { source: { url: 'http://127.0.0.1:${MOCK_PORT}/audio.wav' }, filePath: downloadPath });
      } catch (e) { /* 事件回报错误 */ }
      await new Promise(r => setTimeout(r, 500));
      un();
      return JSON.stringify({ events: [...new Set(events)] });
    })()`, 60000);
    results.push(["5 下载", downloadResult]);
    results.push(["5b 文件落盘", fs.existsSync(path.join(assetDir, "下载测试.wav")) ? `OK ${fs.statSync(path.join(assetDir, "下载测试.wav")).size}B` : "FAIL"]);

    // 6. watcher（监听目录 → 新文件 → local-music-changed 事件）
    // 先注册监听并开始 watch，写文件后再取结果（避免 listen 晚于事件）
    await conn.eval(`(async () => {
      const { listen } = await import('/node_modules/.vite/deps/@tauri-apps_api_event.js');
      window.__watchResult = new Promise((resolve) => {
        const timer = setTimeout(() => resolve('TIMEOUT'), 15000);
        listen('local-music-changed', (e) => { clearTimeout(timer); resolve(JSON.stringify(e.payload)); });
      });
      await window.__TAURI_INTERNALS__.invoke('watch_local_dirs', { add: [${JSON.stringify(subDir)}] });
      return 'watching';
    })()`);
    await new Promise((r) => setTimeout(r, 800));
    // 写入新文件触发
    fs.writeFileSync(path.join(subDir, "新歌.mp3"), makeTaggedMp3("监听新歌", "w", "a"));
    const watchEvent = await conn.eval(`window.__watchResult`, 20000);
    results.push(["6 watcher", watchEvent]);

    // 7. 主题：安装 → 列表 → 读取 → 卸载
    const themeInstall = await conn.eval(`(async () => { const r = await ${inv("theme_install", { themePackPath: themePath })}; return r ? 'OK name=' + r.name + ' hash=' + (r.hash || '').slice(0, 8) : 'FAIL'; })()`);
    results.push(["7a 主题安装", themeInstall]);
    const themeList = await conn.eval(`(async () => { const r = await ${inv("theme_load_packs", {})}; const t = (r||[]).find(x => x.name === '阶段4测试主题'); return t ? 'OK in list, path=' + t.path : 'FAIL: ' + JSON.stringify((r||[]).map(x=>x.name)); })()`);
    results.push(["7b 主题列表", themeList]);
    if (themeList && themeList.includes("path=")) {
      const themeDir = themeList.split("path=")[1];
      const themeCss = await conn.eval(`(async () => { const r = await ${inv("theme_read_file", { themePackPath: themeDir, relativePath: "index.css" })}; return r && r.includes('--primaryColor') ? 'OK' : 'FAIL: ' + r; })()`);
      results.push(["7c 主题CSS读取", themeCss]);
      // selectTheme 注入
      const injected = await conn.eval(`(async () => { const m = await import('/src/shared/themepack/renderer.ts').then(x => x.default || x); await m.selectTheme({hash: 'test', path: ${JSON.stringify(themeDir)}, name: 't'}); const node = document.querySelector('#themepack-node'); return node && node.innerHTML.includes('--primaryColor') ? 'OK 已注入' : 'FAIL: ' + (node ? node.innerHTML.slice(0, 80) : 'no node'); })()`);
      results.push(["7d CSS注入", injected]);
      const uninstalled = await conn.eval(`(async () => {
        // 循环卸载所有同名主题（含历次运行残留）
        for (let i = 0; i < 10; i++) {
          const r = await ${inv("theme_load_packs", {})};
          const t = (r||[]).find(x => x.name === '阶段4测试主题');
          if (!t) return 'OK 已全部卸载';
          await ${inv("theme_uninstall", { themePackPath: "__PLACEHOLDER__" })};
        }
        return 'FAIL 仍存在';
      })()`.split('"__PLACEHOLDER__"').join(JSON.stringify("THEME_DIR_PLACEHOLDER")).replace('"THEME_DIR_PLACEHOLDER"', 't.path'), 30000);
      results.push(["7e 主题卸载", uninstalled]);
    }

    console.log("\n========== 阶段4 验收结果 ==========");
    for (const [name, value] of results) console.log(`${name}: ${value}`);
    conn.close();
  } finally {
    server.close();
  }
}
main().catch((e) => { console.error("验收失败:", e.message); process.exit(1); });
