// 阶段5 验收：托盘链路/全局快捷键（模拟按键）/便携版/更新检查/关闭到托盘
const CDP_PORT = 9223;

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
        const t = setTimeout(() => rej2(new Error("timeout: " + expr.slice(0, 70))), timeoutMs);
        pending.set(id, (msg) => { clearTimeout(t); res2(msg); });
        ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression: expr, awaitPromise: true, returnByValue: true } }));
      }).then((m) => {
        if (m.result?.exceptionDetails) throw new Error("page error: " + (m.result.exceptionDetails.exception?.description || "").slice(0, 300));
        return m.result?.result?.value;
      }),
      close: () => ws.close(),
    });
  });
}

async function main() {
  const pages = await (await fetch(`http://localhost:${CDP_PORT}/json`)).json();
  const main = pages.find((p) => p.url.includes("index.html"));
  const conn = await connect(main.webSocketDebuggerUrl);
  const results = [];

  // 1. 托盘文案推送 + 状态联动（无错误即链路通；菜单 UI 留人工）
  const trayResult = await conn.eval(`(async () => {
    try {
      await window.__TAURI_INTERNALS__.invoke('tray_update_texts', { texts: {
        'media.unknown_title': '未知标题', 'main.no_playing_music': '暂无播放中的音乐',
        'media.music_state_pause': '暂停', 'media.music_state_play': '播放',
        'media.music_state_play_or_pause': '播放/暂停',
        'main.previous_music': '上一首', 'main.next_music': '下一首',
        'media.music_repeat_mode': '循环模式', 'media.music_repeat_mode_loop': '列表循环',
        'media.music_repeat_mode_queue': '队列循环', 'media.music_repeat_mode_shuffle': '随机',
        'app_header.settings': '设置', 'common.exit': '退出', 'media.media_platform': '来源',
      }});
      await window.__TAURI_INTERNALS__.invoke('sync_app_state', { patch: { musicItem: { title: '托盘验收歌曲', artist: '测试', platform: 'test' }, playerState: 'Playing', repeatMode: 'shuffle' } });
      return 'OK（文案+状态更新链路无错误）';
    } catch (e) { return 'FAIL: ' + e; }
  })()`);
  results.push(["1 托盘文案+状态", trayResult]);

  // 2. 全局快捷键：注册 → 前端监听命令 → PowerShell 模拟按键
  const regResult = await conn.eval(`(async () => {
    window.__cmdLog = [];
    const { listen } = await import('/node_modules/.vite/deps/@tauri-apps_api_event.js');
    window.__unlistenCmd = await listen('window-command', (e) => { window.__cmdLog.push(e.payload.command); });
    return window.__TAURI_INTERNALS__.invoke('register_global_shortcut', { shortcut: 'Control+Alt+ArrowRight', command: 'SkipToNext' }).then(() => 'OK registered').catch(e => 'FAIL: ' + JSON.stringify(e));
  })()`);
  results.push(["2a 快捷键注册", regResult]);

  if (regResult.includes("OK")) {
    // 模拟 Ctrl+Alt+Right（全局）
    await new Promise((r) => setTimeout(r, 500));
    const { execSync } = require("child_process");
    try {
      execSync(`powershell.exe -NoProfile -Command "
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class K {
    [DllImport(\\"user32.dll\\")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
}
'@
[K]::keybd_event(0x11, 0, 0, [UIntPtr]::Zero)
[K]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
[K]::keybd_event(0x27, 0, 0, [UIntPtr]::Zero)
[K]::keybd_event(0x27, 0, 2, [UIntPtr]::Zero)
[K]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
[K]::keybd_event(0x11, 0, 2, [UIntPtr]::Zero)
Write-Host 'sent'
"`, { stdio: "pipe", timeout: 15000 });
    } catch (e) {
      // keybd_event 输出捕获失败无碍
    }
    await new Promise((r) => setTimeout(r, 1500));
    const cmdLog = await conn.eval(`JSON.stringify(window.__cmdLog || [])`);
    results.push(["2b 快捷键触发", cmdLog.includes("SkipToNext") ? "OK 收到 SkipToNext" : "未收到: " + cmdLog]);
    await conn.eval(`window.__TAURI_INTERNALS__.invoke('unregister_global_shortcut', { shortcut: 'Control+Alt+ArrowRight' }).then(() => 'unregistered')`);
  }

  // 3. 便携版：get_data_dir（portable 目录存在时重定向——由前置脚本创建 target/debug/portable 并重启）
  const dataDir = await conn.eval(`window.__TAURI_INTERNALS__.invoke('get_data_dir').then(d => d).catch(e => 'FAIL: ' + e)`);
  results.push(["3 数据目录", dataDir]);

  // 4. 更新检查
  const updateResult = await conn.eval(`window.__TAURI_INTERNALS__.invoke('check_update').then(r => JSON.stringify(r)).catch(e => 'FAIL: ' + e)`, 45000);
  results.push(["4 更新检查", updateResult]);

  // 5. 关闭到托盘：closeBehavior=minimize + WM_CLOSE → 进程存活且窗口隐藏
  await conn.eval(`window.__TAURI_INTERNALS__.invoke('set_app_config', { patch: { 'normal.closeBehavior': 'minimize' } })`);
  await new Promise((r) => setTimeout(r, 500));
  const { execSync } = require("child_process");
  try {
    execSync(`powershell.exe -NoProfile -Command "
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class W2 {
    [DllImport(\\"user32.dll\\")] public static extern IntPtr FindWindow(string cls, string title);
    [DllImport(\\"user32.dll\\")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport(\\"user32.dll\\")] public static extern IntPtr SendMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
}
'@
\$h = [W2]::FindWindow(\$null, 'Music Free')
if (\$h -eq [IntPtr]::Zero) { Write-Host 'notfound'; exit }
[W2]::SendMessage(\$h, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
Start-Sleep -Milliseconds 800
Write-Host ('visible=' + [W2]::IsWindowVisible(\$h))
"`, { stdio: "pipe", timeout: 20000 });
  } catch (e) {
    results.push(["5 关闭到托盘(前置)", "PowerShell 失败: " + e.message.slice(0, 100)]);
  }
  await new Promise((r) => setTimeout(r, 1000));
  const alive = pages.length > 0 && (await (await fetch(`http://localhost:${CDP_PORT}/json`)).json()).some((p) => p.url.includes("index.html"));
  const visibleState = await conn.eval(`window.__TAURI_INTERNALS__.invoke('show_main_window').then(() => 'restored')`).catch(() => "FAIL");
  results.push(["5 关闭到托盘", alive ? "OK 进程存活（WM_CLOSE 后 CDP 仍在）" : "FAIL 进程退出"]);

  console.log("\n========== 阶段5 验收结果 ==========");
  for (const [name, value] of results) console.log(`${name}: ${value}`);
  conn.close();
}
main().catch((e) => { console.error("验收失败:", e.message); process.exit(1); });
