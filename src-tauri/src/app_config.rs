//! 应用配置（阶段1）
//!
//! 对应 Electron 版 `src/shared/app-config/main.ts`：
//! - config.json 持久化于应用数据目录
//! - 旧版嵌套结构配置迁移（v0 → v1 扁平化）
//! - set 时全窗口广播 `app-config:update` 事件
//! 默认值与前端同源：include 前端目录下的 default-app-config.json

use serde_json::{Map, Value};
use std::{fs, path::PathBuf, sync::Mutex};
use tauri::{AppHandle, Emitter, Manager};

pub struct AppConfigState {
    pub config: Map<String, Value>,
    pub config_path: PathBuf,
}

pub fn default_config() -> Map<String, Value> {
    serde_json::from_str(include_str!("../../src/shared/app-config/default-app-config.json"))
        .expect("invalid default-app-config.json")
}

/// v0（嵌套结构）→ v1（扁平 key）迁移，对照 Electron 版 main.ts migrateOldVersionConfig
fn migrate_old_config(old: Map<String, Value>) -> Map<String, Value> {
    let get = |section: &str, key: &str| old.get(section).and_then(|s| s.get(key)).cloned();
    let mut new: Map<String, Value> = Map::new();
    let mut pairs: Vec<(String, Value)> = vec![
        ("normal.closeBehavior".into(), get("normal", "closeBehavior").map(|v| if v == "exit" { Value::String("exit_app".into()) } else { v }).unwrap_or(Value::Null)),
        ("normal.maxHistoryLength".into(), get("normal", "maxHistoryLength").unwrap_or(Value::Null)),
        ("normal.checkUpdate".into(), get("normal", "checkUpdate").unwrap_or(Value::Null)),
        ("normal.taskbarThumb".into(), get("normal", "taskbarThumb").unwrap_or(Value::Null)),
        ("normal.musicListColumnsShown".into(), get("normal", "musicListColumnsShown").unwrap_or(Value::Null)),
        ("normal.language".into(), get("normal", "language").unwrap_or(Value::Null)),
        ("playMusic.caseSensitiveInSearch".into(), get("playMusic", "caseSensitiveInSearch").unwrap_or(Value::Null)),
        ("playMusic.defaultQuality".into(), get("playMusic", "defaultQuality").unwrap_or(Value::Null)),
        ("playMusic.whenQualityMissing".into(), get("playMusic", "whenQualityMissing").unwrap_or(Value::Null)),
        ("playMusic.clickMusicList".into(), get("playMusic", "clickMusicList").unwrap_or(Value::Null)),
        ("playMusic.playError".into(), get("playMusic", "playError").unwrap_or(Value::Null)),
        ("playMusic.audioOutputDevice".into(), get("playMusic", "audioOutputDevice").unwrap_or(Value::Null)),
        ("playMusic.whenDeviceRemoved".into(), get("playMusic", "whenDeviceRemoved").unwrap_or(Value::Null)),
        ("lyric.enableStatusBarLyric".into(), get("lyric", "enableStatusBarLyric").unwrap_or(Value::Null)),
        ("lyric.enableDesktopLyric".into(), get("lyric", "enableDesktopLyric").unwrap_or(Value::Null)),
        ("lyric.alwaysOnTop".into(), get("lyric", "alwaysOnTop").unwrap_or(Value::Null)),
        ("lyric.lockLyric".into(), get("lyric", "lockLyric").unwrap_or(Value::Null)),
        ("lyric.fontData".into(), get("lyric", "fontData").unwrap_or(Value::Null)),
        ("lyric.fontColor".into(), get("lyric", "fontColor").unwrap_or(Value::Null)),
        ("lyric.fontSize".into(), get("lyric", "fontSize").unwrap_or(Value::Null)),
        ("lyric.strokeColor".into(), get("lyric", "strokeColor").unwrap_or(Value::Null)),
        ("shortCut.enableLocal".into(), get("shortCut", "enableLocal").unwrap_or(Value::Null)),
        ("shortCut.enableGlobal".into(), get("shortCut", "enableGlobal").unwrap_or(Value::Null)),
        ("download.path".into(), get("download", "path").unwrap_or(Value::Null)),
        ("download.defaultQuality".into(), get("download", "defaultQuality").unwrap_or(Value::Null)),
        ("download.whenQualityMissing".into(), get("download", "whenQualityMissing").unwrap_or(Value::Null)),
        ("download.concurrency".into(), get("download", "concurrency").unwrap_or(Value::Null)),
        ("plugin.autoUpdatePlugin".into(), get("plugin", "autoUpdatePlugin").unwrap_or(Value::Null)),
        ("plugin.notCheckPluginVersion".into(), get("plugin", "notCheckPluginVersion").unwrap_or(Value::Null)),
        ("network.proxy.enabled".into(), get("network", "proxy").and_then(|p| p.get("enabled").cloned()).unwrap_or(Value::Null)),
        ("network.proxy.host".into(), get("network", "proxy").and_then(|p| p.get("host").cloned()).unwrap_or(Value::Null)),
        ("network.proxy.port".into(), get("network", "proxy").and_then(|p| p.get("port").cloned()).unwrap_or(Value::Null)),
        ("network.proxy.username".into(), get("network", "proxy").and_then(|p| p.get("username").cloned()).unwrap_or(Value::Null)),
        ("network.proxy.password".into(), get("network", "proxy").and_then(|p| p.get("password").cloned()).unwrap_or(Value::Null)),
        ("backup.resumeBehavior".into(), get("backup", "resumeBehavior").unwrap_or(Value::Null)),
        ("backup.webdav.url".into(), get("backup", "webdav").and_then(|b| b.get("url").cloned()).unwrap_or(Value::Null)),
        ("backup.webdav.username".into(), get("backup", "webdav").and_then(|b| b.get("username").cloned()).unwrap_or(Value::Null)),
        ("backup.webdav.password".into(), get("backup", "webdav").and_then(|b| b.get("password").cloned()).unwrap_or(Value::Null)),
        ("localMusic.watchDir".into(), get("localMusic", "watchDir").unwrap_or(Value::Null)),
        ("private.lyricWindowPosition".into(), get("private", "lyricWindowPosition").unwrap_or(Value::Null)),
        ("private.minimodeWindowPosition".into(), get("private", "minimodeWindowPosition").unwrap_or(Value::Null)),
        ("private.pluginMeta".into(), get("private", "pluginMeta").unwrap_or(Value::Null)),
        ("private.minimode".into(), get("private", "minimode").unwrap_or(Value::Null)),
    ];
    // 快捷键配置整体迁移并补 toggle-main-window-visible
    let mut shortcuts = get("shortCut", "shortcuts").unwrap_or(Value::Object(Map::new()));
    if let Some(obj) = shortcuts.as_object_mut() {
        obj.insert("toggle-main-window-visible".into(), serde_json::json!({"local": null, "global": null}));
    }
    pairs.push(("shortCut.shortcuts".into(), shortcuts));
    for (k, v) in pairs {
        if !v.is_null() {
            new.insert(k, v);
        }
    }
    new
}

pub fn setup(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let data_dir = crate::paths::data_dir(app);
    fs::create_dir_all(&data_dir)?;
    let config_path = data_dir.join("config.json");

    // Electron 版配置继承：旧版 userData 目录为同级 %APPDATA%/MusicFree
    if !config_path.exists() {
        if let Some(electron_dir) = data_dir.parent().map(|p| p.join("MusicFree")) {
            let old_config = electron_dir.join("config.json");
            if old_config.exists() {
                let _ = fs::copy(&old_config, &config_path);
            }
        }
    }

    let mut config: Map<String, Value> = match fs::read_to_string(&config_path) {
        Ok(raw) => serde_json::from_str::<Value>(&raw)
            .ok()
            .and_then(|v| v.as_object().cloned())
            .unwrap_or_default(),
        Err(_) => Map::new(),
    };

    let schema_version = config
        .get("$schema-version")
        .and_then(Value::as_i64)
        .unwrap_or(-1);
    if schema_version < 0 && !config.is_empty() {
        config = migrate_old_config(config);
        config.insert("$schema-version".into(), Value::from(1));
    }
    // 默认值填充
    for (k, v) in default_config() {
        config.entry(k).or_insert(v);
    }
    persist(&config_path, &config)?;

    *app.state::<Mutex<AppConfigState>>().lock().unwrap() = AppConfigState {
        config,
        config_path,
    };
    Ok(())
}

fn persist(path: &PathBuf, config: &Map<String, Value>) -> Result<(), Box<dyn std::error::Error>> {
    fs::write(path, serde_json::to_string_pretty(&Value::Object(config.clone()))?)?;
    Ok(())
}

/// 广播配置更新到所有窗口（对应 Electron 版 webContents.send）
fn emit_config_update(app: &AppHandle, patch: &Value) {
    let _ = app.emit("app-config:update", patch);
}

/// 合并 patch、写盘并广播；Rust 内部（窗口位置记忆等）与 command 共用
pub fn set_config(app: &AppHandle, patch: Value) {
    let Some(patch_map) = patch.as_object().cloned() else {
        return;
    };
    let state = app.state::<Mutex<AppConfigState>>();
    {
        let mut guard = state.lock().unwrap();
        for (k, v) in &patch_map {
            guard.config.insert(k.clone(), v.clone());
        }
        if persist(&guard.config_path, &guard.config).is_err() {
            log::warn!("写入配置文件失败");
        }
    }
    // 歌词窗联动（阶段6，对齐原版 window-manager 的 onConfigUpdated）
    if let Some(font_size) = patch_map.get("lyric.fontSize").and_then(|v| v.as_f64()) {
        if let Some(win) = app.get_webview_window("lrc") {
            let height = (60.0 + font_size * 2.0).clamp(92.0, 240.0);
            let width = win.inner_size().map(|s| s.width as f64).unwrap_or(920.0);
            let _ = win.set_size(tauri::Size::Logical(tauri::LogicalSize::new(width, height)));
        }
    }
    if let Some(locked) = patch_map.get("lyric.lockLyric").and_then(|v| v.as_bool()) {
        if let Some(win) = app.get_webview_window("lrc") {
            let _ = win.set_ignore_cursor_events(locked);
        }
    }
    emit_config_update(app, &Value::Object(patch_map));
}

pub fn get_config(app: &AppHandle, key: &str) -> Option<Value> {
    let state = app.state::<Mutex<AppConfigState>>();
    let guard = state.lock().unwrap();
    let value = guard.config.get(key).cloned();
    value
}

#[tauri::command]
pub fn sync_app_config(app: AppHandle) -> Value {
    let state = app.state::<Mutex<AppConfigState>>();
    let config = state.lock().unwrap().config.clone();
    Value::Object(config)
}

#[tauri::command]
pub fn set_app_config(app: AppHandle, patch: Value) {
    set_config(&app, patch);
}

#[tauri::command]
pub fn reset_app_config(app: AppHandle) {
    let state = app.state::<Mutex<AppConfigState>>();
    let mut guard = state.lock().unwrap();
    *guard.config_mut() = default_config();
    let _ = persist(&guard.config_path, &guard.config);
    let full = Value::Object(guard.config.clone());
    drop(guard);
    let _ = app.emit("app-config:update", full);
}

impl AppConfigState {
    fn config_mut(&mut self) -> &mut Map<String, Value> {
        &mut self.config
    }
}
