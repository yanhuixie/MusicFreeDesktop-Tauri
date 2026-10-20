//! MusicFree Tauri 版主入口（阶段1）
//!
//! 对应 Electron 版 `src/main/index.ts` + `window-manager/index.ts`：
//! - 主窗口：tauri.conf.json 静态声明（1050x700 无边框），启动时恢复记忆的大小
//! - 歌词窗 / 迷你模式窗：按需创建，恢复记忆的位置
//! - 窗口位置/尺寸记忆：Resized/Moved 事件写入 app-config
//! - app-config / message-bus 模块化注册
//! - 单实例：二次启动唤起主窗口
//! - 日志：tauri-plugin-log

mod app_config;
mod message_bus;

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
    let builder = WebviewWindowBuilder::new(app, "lrc", WebviewUrl::App("lrc.html".into()))
        .title("MusicFree Lyric")
        .inner_size(LRC_MIN_WIDTH, LRC_MIN_HEIGHT)
        .min_inner_size(LRC_MIN_WIDTH, LRC_MIN_HEIGHT)
        .max_inner_size(16384.0, LRC_MAX_HEIGHT)
        .resizable(true)
        .decorations(false)
        .transparent(true)
        .skip_taskbar(true)
        .always_on_top(true)
        .visible(true);
    // 恢复记忆位置
    let builder = if let Some(pos) = app_config::get_config(app, "private.lyricWindowPosition") {
        let x = pos.get("x").and_then(|v| v.as_f64());
        let y = pos.get("y").and_then(|v| v.as_f64());
        if let (Some(x), Some(y)) = (x, y) {
            builder.position(x, y)
        } else {
            builder
        }
    } else {
        builder
    };
    let win = builder.build()?;
    // 宽度上限对齐显示器宽度
    if let Ok(Some(monitor)) = win.current_monitor() {
        let w = monitor.size().width as f64 / monitor.scale_factor();
        let _ = win.set_max_size(Some(tauri::Size::Logical(tauri::LogicalSize::new(w, LRC_MAX_HEIGHT))));
    }
    Ok(())
}

fn create_minimode_window(app: &AppHandle) -> tauri::Result<()> {
    if app.get_webview_window("minimode").is_some() {
        return Ok(());
    }
    let builder = WebviewWindowBuilder::new(
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
    .visible(true);
    // 恢复记忆位置
    let builder = if let Some(pos) = app_config::get_config(app, "private.minimodeWindowPosition") {
        let x = pos.get("x").and_then(|v| v.as_f64());
        let y = pos.get("y").and_then(|v| v.as_f64());
        if let (Some(x), Some(y)) = (x, y) {
            builder.position(x, y)
        } else {
            builder
        }
    } else {
        builder
    };
    builder.build()?;
    Ok(())
}

/// 对齐 Electron 版 utils preload 的 setLyricWindow(enabled)
/// 注：Windows 上从 command 线程同步 build 窗口会与主线程死锁，故 spawn 创建
#[tauri::command]
fn set_lyric_window(app: AppHandle, enabled: bool) -> Result<(), String> {
    if enabled {
        std::thread::spawn(move || {
            if let Err(e) = create_lyric_window(&app) {
                log::error!("创建歌词窗失败: {e}");
            }
        });
        Ok(())
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
        std::thread::spawn(move || {
            if let Err(e) = create_minimode_window(&app) {
                log::error!("创建迷你模式窗失败: {e}");
            }
        });
        Ok(())
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

/// 对齐 Electron 版 utils preload 的 minMainWindow
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

/// 对齐 Electron 版 utils preload 的 exitApp
#[tauri::command]
fn exit_app(app: AppHandle) -> Result<(), String> {
    app.exit(0);
    Ok(())
}

/// 对齐 Electron 版 utils preload 的 ignoreMouseEvent（歌词窗锁定穿透）
#[tauri::command]
fn ignore_mouse_event(app: AppHandle, window_label: String, ignore: bool) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(&window_label) {
        win.set_ignore_cursor_events(ignore).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 对齐 Electron 版 global-context preload 的 getGlobalContext（sendSync → invoke）
#[tauri::command]
fn get_global_context(app: AppHandle, window: tauri::WebviewWindow) -> serde_json::Value {
    let app_handle = &app;
    let data_dir = app_handle
        .path()
        .app_data_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    let temp_dir = std::env::temp_dir().to_string_lossy().to_string();
    let download_dir = app_handle
        .path()
        .download_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    let res_dir = data_dir.clone();
    let platform = if cfg!(target_os = "windows") {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    };
    serde_json::json!({
        "appVersion": app.package_info().version.to_string(),
        "workersPath": {"downloader": "", "localFileWatcher": "", "db": ""},
        "appPath": {
            "userData": data_dir,
            "temp": temp_dir,
            "downloads": download_dir,
            "res": res_dir,
        },
        "platform": platform,
        // 额外信息：当前窗口标签（message-bus / 阶段3 插件运行时定位用）
        "windowLabel": window.label(),
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_log::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // 二次启动：唤起主窗口（对应 Electron 版 second-instance）
            if let Some(win) = app.get_webview_window("main") {
                if win.is_minimized().unwrap_or(false) {
                    let _ = win.unminimize();
                }
                let _ = win.show();
                let _ = win.set_focus();
            }
        }))
        .manage(std::sync::Mutex::new(app_config::AppConfigState {
            config: serde_json::Map::new(),
            config_path: std::path::PathBuf::new(),
        }))
        .manage(message_bus::setup())
        .on_window_event(|window, event| {
            // 窗口位置/尺寸记忆（对应 Electron 版 window-manager 的 resize/dragEnd 持久化）
            let app = window.app_handle().clone();
            let label = window.label().to_string();
            if let tauri::WindowEvent::Resized(size) = event {
                if label == "main" {
                    let logical = size.to_logical::<f64>(window.scale_factor().unwrap_or(1.0));
                    app_config::set_config(
                        &app,
                        serde_json::json!({"private.mainWindowSize": {"width": logical.width, "height": logical.height}}),
                    );
                }
            } else if let tauri::WindowEvent::Moved(pos) = event {
                if label == "lrc" || label == "minimode" {
                    let logical = pos.to_logical::<f64>(window.scale_factor().unwrap_or(1.0));
                    let key = if label == "lrc" {
                        "private.lyricWindowPosition"
                    } else {
                        "private.minimodeWindowPosition"
                    };
                    app_config::set_config(
                        &app,
                        serde_json::json!({key: {"x": logical.x, "y": logical.y}}),
                    );
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            set_lyric_window,
            set_minimode_window,
            show_main_window,
            min_main_window,
            toggle_main_window_visible,
            toggle_main_window_maximize,
            exit_app,
            ignore_mouse_event,
            get_global_context,
            app_config::sync_app_config,
            app_config::set_app_config,
            app_config::reset_app_config,
            message_bus::sync_app_state,
        ])
        .setup(|app| {
            app_config::setup(&app.handle())?;
            // 主窗口恢复记忆大小
            if let Some(main) = app.get_webview_window("main") {
                if let Some(size) = app_config::get_config(&app.handle(), "private.mainWindowSize") {
                    let w = size.get("width").and_then(|v| v.as_f64());
                    let h = size.get("height").and_then(|v| v.as_f64());
                    if let (Some(w), Some(h)) = (w, h) {
                        let _ = main.set_size(tauri::Size::Logical(tauri::LogicalSize::new(w, h)));
                    }
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
