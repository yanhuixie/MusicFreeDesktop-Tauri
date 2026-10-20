//! MusicFree Tauri 版窗口管理（阶段0）
//!
//! 对应 Electron 版 `src/main/window-manager/index.ts`：
//! - 主窗口：tauri.conf.json 静态声明（1050x700 无边框）
//! - 歌词窗 / 迷你模式窗：按需创建（对齐原 window-manager 的 show/close 语义）
//! 后续阶段在此追加 app-config、媒体协议、插件管理等模块。

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

/// 歌词窗尺寸约束（对齐 Electron 版 window-manager）
const LRC_MIN_WIDTH: f64 = 920.0;
const LRC_MIN_HEIGHT: f64 = 92.0;
const LRC_MAX_HEIGHT: f64 = 240.0;
/// 迷你模式窗尺寸
const MINIMODE_WIDTH: f64 = 340.0;
const MINIMODE_HEIGHT: f64 = 72.0;

fn create_lyric_window(app: &AppHandle) -> tauri::Result<()> {
    if app.get_webview_window("lrc").is_some() {
        return Ok(());
    }
    WebviewWindowBuilder::new(app, "lrc", WebviewUrl::App("lrc.html".into()))
        .title("MusicFree Lyric")
        .inner_size(LRC_MIN_WIDTH, LRC_MIN_HEIGHT)
        .min_inner_size(LRC_MIN_WIDTH, LRC_MIN_HEIGHT)
        // 宽度上限 = 显示器宽度，阶段1 接入显示器信息后动态设置
        .max_inner_size(16384.0, LRC_MAX_HEIGHT)
        .resizable(true)
        .decorations(false)
        .transparent(true)
        .skip_taskbar(true)
        .always_on_top(true)
        .visible(true)
        .build()?;
    Ok(())
}

fn create_minimode_window(app: &AppHandle) -> tauri::Result<()> {
    if app.get_webview_window("minimode").is_some() {
        return Ok(());
    }
    WebviewWindowBuilder::new(
        app,
        "minimode",
        WebviewUrl::App("minimode.html".into()),
    )
    .title("MusicFree MiniMode")
    .inner_size(MINIMODE_WIDTH, MINIMODE_HEIGHT)
    .resizable(false)
    .decorations(false)
    .skip_taskbar(true)
    .always_on_top(true)
    .visible(true)
    .build()?;
    Ok(())
}

/// 对齐 Electron 版 utils preload 的 setLyricWindow(enabled)
#[tauri::command]
fn set_lyric_window(app: AppHandle, enabled: bool) -> Result<(), String> {
    if enabled {
        create_lyric_window(&app).map_err(|e| e.to_string())
    } else if let Some(win) = app.get_webview_window("lrc") {
        win.close().map_err(|e| e.to_string())
    } else {
        Ok(())
    }
}

/// 对齐 Electron 版 utils preload 的 setMinimodeWindow(enabled)
#[tauri::command]
fn set_minimode_window(app: AppHandle, enabled: bool) -> Result<(), String> {
    if enabled {
        create_minimode_window(&app).map_err(|e| e.to_string())
    } else if let Some(win) = app.get_webview_window("minimode") {
        win.close().map_err(|e| e.to_string())
    } else {
        Ok(())
    }
}

/// 对齐 Electron 版 utils preload 的 showMainWindow
#[tauri::command]
fn show_main_window(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("main") {
        if win.is_minimized().unwrap_or(false) {
            let _ = win.unminimize();
        }
        win.show().map_err(|e| e.to_string())?;
        win.set_focus().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 对齐 Electron 版 utils preload 的 minMainWindow（skip_task_bar 阶段5 接托盘语义）
#[tauri::command]
fn min_main_window(app: AppHandle, skip_task_bar: bool) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("main") {
        if skip_task_bar {
            win.hide().map_err(|e| e.to_string())?;
        } else {
            win.minimize().map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// 对齐 Electron 版 utils preload 的 toggleMainWindowVisible
#[tauri::command]
fn toggle_main_window_visible(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("main") {
        if win.is_visible().unwrap_or(false) {
            win.hide().map_err(|e| e.to_string())?;
        } else {
            if win.is_minimized().unwrap_or(false) {
                let _ = win.unminimize();
            }
            win.show().map_err(|e| e.to_string())?;
            win.set_focus().map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// 对齐 Electron 版 utils preload 的 toggleMainWindowMaximize
#[tauri::command]
fn toggle_main_window_maximize(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("main") {
        if win.is_maximized().unwrap_or(false) {
            win.unmaximize().map_err(|e| e.to_string())?;
        } else {
            win.maximize().map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            set_lyric_window,
            set_minimode_window,
            show_main_window,
            min_main_window,
            toggle_main_window_visible,
            toggle_main_window_maximize,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
