// 阶段2 验收：
// A. mediahub 协议：本地文件（Range）、远程转发（header 注入）、m3u8 改写
// B. HTMLAudioElement 实际播放 mediahub URL
// C. smtc_update command 不报错（OS 面板无法无人值守验证）
// 用法：先起 mock server（本脚本自带），再连 CDP 驱动 webview
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");

const CDP_PORT = 9223;
const MOCK_PORT = 9998;

// ---------- 1. 生成测试 WAV（5 秒 8kHz 8bit 单声道静音+方波） ----------
function makeWav(seconds) {
  const sampleRate = 8000;
  const numSamples = sampleRate * seconds;
  const dataSize = numSamples; // 8bit
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate, 28); // byte rate
  buf.writeUInt16LE(1, 32); // block align
  buf.writeUInt16LE(8, 34); // bits
  buf.write("data", 36);
  buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < numSamples; i++) {
    // 440Hz 方波，幅度小
    buf[44 + i] = Math.floor(Math.sin((i / sampleRate) * 2 * Math.PI * 440) > 0 ? 200 : 50);
  }
  return buf;
}

// ---------- 2. mock http server（header 校验 + Range + m3u8） ----------
function startMockServer() {
  const wav = makeWav(5);
  const receivedHeaders = {};
  const server = http.createServer((req, res) => {
    Object.assign(receivedHeaders, req.headers);
    if (req.url === "/audio.wav") {
      const range = req.headers["range"];
      if (range) {
        const m = range.match(/bytes=(\d+)-(\d*)/);
        const start = parseInt(m[1]);
        const end = m[2] ? Math.min(parseInt(m[2]), wav.length - 1) : wav.length - 1;
        const chunk = wav.slice(start, end + 1);
        res.writeHead(206, {
          "Content-Type": "audio/wav",
          "Content-Range": `bytes ${start}-${end}/${wav.length}`,
          "Content-Length": chunk.length,
          "Accept-Ranges": "bytes",
        });
        res.end(chunk);
      } else {
        res.writeHead(200, { "Content-Type": "audio/wav", "Content-Length": wav.length, "Accept-Ranges": "bytes" });
        res.end(wav);
      }
    } else if (req.url === "/stream.m3u8") {
      const content = [
        "#EXTM3U",
        "#EXT-X-VERSION:3",
        "#EXT-X-TARGETDURATION:5",
        "#EXTINF:5.0,",
        "seg1.wav",
        "#EXT-X-ENDLIST",
      ].join("\n");
      res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl" });
      res.end(content);
    } else if (req.url === "/seg1.wav") {
      res.writeHead(200, { "Content-Type": "audio/wav", "Content-Length": wav.length });
      res.end(wav);
    } else {
      res.writeHead(404); res.end("not found");
    }
  });
  return new Promise((resolve) => {
    server.listen(MOCK_PORT, "127.0.0.1", () => resolve({ server, wav, receivedHeaders }));
  });
}

// ---------- 3. CDP 驱动 ----------
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
      eval: (expr, timeoutMs = 15000) => new Promise((res2, rej2) => {
        const id = ++msgId;
        const timer = setTimeout(() => rej2(new Error("timeout: " + expr.slice(0, 80))), timeoutMs);
        pending.set(id, (msg) => { clearTimeout(timer); res2(msg); });
        ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression: expr, awaitPromise: true, returnByValue: true } }));
      }).then((m) => {
        if (m.result?.exceptionDetails) throw new Error("page error: " + (m.result.exceptionDetails.exception?.description || "").slice(0, 400));
        return m.result?.result?.value;
      }),
      close: () => ws.close(),
    });
  });
}

function b64url(str) {
  return Buffer.from(str, "utf-8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function mediahubUrl(url, headers) {
  const payload = headers && Object.keys(headers).length ? { url, headers } : { url };
  return `http://mediahub.localhost/f/${b64url(JSON.stringify(payload))}`;
}

async function main() {
  const { server, wav, receivedHeaders } = await startMockServer();
  const wavPath = path.join(os.tmpdir(), "musicfree-stage2-test.wav");
  fs.writeFileSync(wavPath, wav);
  console.log("测试 WAV:", wavPath, wav.length, "bytes; mock server: 127.0.0.1:" + MOCK_PORT);

  try {
    const pages = await (await fetch(`http://localhost:${CDP_PORT}/json`)).json();
    const main = pages.find((p) => p.url.includes("index.html"));
    if (!main) throw new Error("主窗口未找到");
    const conn = await connect(main.webSocketDebuggerUrl);

    const results = [];
    const fetchInfo = (url, headers) => `(async () => {
      const r = await fetch(${JSON.stringify(url)}, { headers: ${JSON.stringify(headers || {})} });
      const buf = await r.arrayBuffer();
      return JSON.stringify({status: r.status, type: r.headers.get('content-type'), len: buf.byteLength, contentRange: r.headers.get('content-range')});
    })()`;

    // A1. 本地文件全量
    results.push(["A1 本地文件 200", await conn.eval(fetchInfo(mediahubUrl(wavPath)))]);

    // A2. 本地文件 Range
    results.push(["A2 本地文件 Range 206", await conn.eval(fetchInfo(mediahubUrl(wavPath), { Range: "bytes=100-199" }))]);

    // A3. 远程转发（无 header）
    results.push(["A3 远程转发 200", await conn.eval(fetchInfo(mediahubUrl(`http://127.0.0.1:${MOCK_PORT}/audio.wav`)))]);

    // A4. 远程转发 + Range + header 注入
    results.push(["A4 远程+Range", await conn.eval(fetchInfo(mediahubUrl(`http://127.0.0.1:${MOCK_PORT}/audio.wav`, { referer: "https://music.example.com", "user-agent": "MusicFreeTestAgent" }), { Range: "bytes=0-99" }))]);

    // A5. m3u8 改写
    const m3u8Result = await conn.eval(`(async () => {
      const r = await fetch(${JSON.stringify(mediahubUrl(`http://127.0.0.1:${MOCK_PORT}/stream.m3u8`, { "x-test": "1" }))});
      const text = await r.text();
      return text;
    })()`);
    results.push(["A5 m3u8 改写", m3u8Result.includes("mediahub.localhost/f/") ? "OK: 分片已改写" : "FAIL: " + m3u8Result.slice(0, 200)]);

    // B. HTMLAudioElement 播放 mediahub 本地文件
    const playResult = await conn.eval(`(async () => {
      return await new Promise((resolve) => {
        const audio = new Audio(${JSON.stringify(mediahubUrl(wavPath))});
        audio.play();
        let elapsed = 0;
        const timer = setInterval(() => {
          elapsed += 500;
          if (audio.currentTime > 0.3 || elapsed > 8000) {
            clearInterval(timer);
            resolve(JSON.stringify({ currentTime: audio.currentTime, duration: audio.duration, readyState: audio.readyState, error: audio.error ? audio.error.code : null }));
          }
        }, 500);
      });
    })()`, 20000);
    results.push(["B audio 播放本地", playResult]);

    // B2. 播放远程（带 header）
    const playResult2 = await conn.eval(`(async () => {
      return await new Promise((resolve) => {
        const audio = new Audio(${JSON.stringify(mediahubUrl(`http://127.0.0.1:${MOCK_PORT}/audio.wav`, { referer: "https://music.example.com" }))});
        audio.play();
        let elapsed = 0;
        const timer = setInterval(() => {
          elapsed += 500;
          if (audio.currentTime > 0.3 || elapsed > 8000) {
            clearInterval(timer);
            resolve(JSON.stringify({ currentTime: audio.currentTime, duration: audio.duration, error: audio.error ? audio.error.code : null }));
          }
        }, 500);
      });
    })()`, 20000);
    results.push(["B2 audio 播放远程+header", playResult2]);

    // B3. seek（Range 透传）
    const seekResult = await conn.eval(`(async () => {
      return await new Promise((resolve) => {
        const audio = new Audio(${JSON.stringify(mediahubUrl(wavPath))});
        audio.play();
        setTimeout(() => {
          audio.currentTime = 3.5;
          setTimeout(() => {
            resolve(JSON.stringify({ currentTime: audio.currentTime, seeked: audio.currentTime >= 3.4 && audio.currentTime <= 5.6 }));
          }, 2000);
        }, 1500);
      });
    })()`, 20000);
    results.push(["B3 seek 拖动", seekResult]);

    // C. smtc_update
    const smtcResult = await conn.eval(`window.__TAURI_INTERNALS__.invoke('smtc_update', {update: {playing: true, title: '验收歌曲', artist: '测试'}}).then(() => 'OK').catch(e => 'FAIL: ' + JSON.stringify(e))`);
    results.push(["C smtc_update", smtcResult]);

    // mock server 收到的 header 校验
    results.push(["A4b header 注入到达", receivedHeaders["referer"] === "https://music.example.com" && receivedHeaders["user-agent"] === "MusicFreeTestAgent" ? `OK (referer=${receivedHeaders["referer"]}, ua=${receivedHeaders["user-agent"]})` : "FAIL: " + JSON.stringify({ referer: receivedHeaders["referer"], ua: receivedHeaders["user-agent"] })]);

    console.log("\n========== 阶段2 验收结果 ==========");
    for (const [name, value] of results) console.log(`${name}: ${value}`);
    conn.close();
  } finally {
    server.close();
  }
}
main().catch((e) => { console.error("验收失败:", e.message); process.exit(1); });
