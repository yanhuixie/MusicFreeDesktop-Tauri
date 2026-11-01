//! 消息总线（阶段1）
//!
//! 对应 Electron 版 `src/shared/message-bus/main.ts`：
//! MessageChannelMain 端口直连 → Tauri 定向事件（emit_to）
//! - 主窗口 `sync_app_state` command：合并 AppState 并转发到扩展窗口
//! - 扩展窗口 → 主窗口的命令走前端 emitTo("main")（无需 Rust 中转）
//! - Rust 侧保存 AppState，供托盘/SMTC（阶段2/5）消费

use serde_json::{Map, Value};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

pub struct AppStateState(pub Mutex<Value>);

pub fn setup() -> AppStateState {
    AppStateState(Mutex::new(Value::Object(Map::new())))
}

/// 主窗口上报状态变化：合并存储 + 定向转发到扩展窗口
#[tauri::command]
pub fn sync_app_state(app: AppHandle, patch: Value) {
    {
        let state = app.state::<AppStateState>();
        let mut guard = state.0.lock().unwrap();
        if let Some(obj) = guard.as_object_mut() {
            if let Some(patch_obj) = patch.as_object() {
                for (k, v) in patch_obj {
                    obj.insert(k.clone(), v.clone());
                }
            }
        }
    }
    for label in ["lrc", "minimode"] {
        if let Some(win) = app.get_webview_window(label) {
            let _ = win.emit("app-state-changed", &patch);
        }
    }
    // 托盘 / thumbar 随播放状态重建（内部有签名比对节流）
    crate::tray::rebuild_if_needed(&app);
    #[cfg(target_os = "windows")]
    crate::thumbbar::update_on_state_change(&app);
}

/// 供托盘等 Rust 模块读取当前状态
pub fn get_app_state(app: &AppHandle) -> Value {
    let state = app.state::<AppStateState>();
    let value = state.0.lock().unwrap().clone();
    value
}

/// 播放状态名。前端 PlayerState 为数字枚举（constant.ts：None=0/Playing=1/Paused=2），
/// JSON 上报即数字；兼容字符串形式以便人工排查。
pub fn player_state_name(app: &AppHandle) -> String {
    match get_app_state(app).get("playerState") {
        Some(Value::Number(n)) => match n.as_i64() {
            Some(1) => "Playing".into(),
            Some(2) => "Paused".into(),
            _ => "None".into(),
        },
        Some(Value::String(s)) => s.clone(),
        _ => String::new(),
    }
}

/// 供托盘等 Rust 模块向主窗口下发命令（对应 Electron 版 messageBus.sendCommand）
pub fn send_command(app: &AppHandle, command: &str, data: Value) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.emit(
            "window-command",
            serde_json::json!({ "command": command, "data": data }),
        );
    }
}
