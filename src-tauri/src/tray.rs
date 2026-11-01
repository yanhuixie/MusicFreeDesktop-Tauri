//! 系统托盘（阶段5）
//!
//! 对应 Electron 版 `src/main/tray-manager/index.ts`：
//! - 动态菜单：歌名/播放控制/循环模式 radio 子菜单/设置/退出，随播放状态重建
//! - 文案由主窗口经 tray_update_texts 推送（i18n 打包在前端）
//! - 菜单事件经 message_bus 下发主窗口
//! - macOS 状态栏歌词（setTitle，随 lyricText 更新）

use serde_json::Value;
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::menu::{CheckMenuItem, MenuBuilder, MenuItem, SubmenuBuilder};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager};

#[derive(Default)]
pub struct TrayState {
    pub tray: Option<tauri::tray::TrayIcon>,
    pub texts: HashMap<String, String>,
    last_signature: String,
}

fn text_of(state: &TrayState, key: &str) -> String {
    state.texts.get(key).cloned().unwrap_or_else(|| key.to_string())
}

pub fn setup(app: &AppHandle) -> Option<tauri::tray::TrayIcon> {
    let icon = app.default_window_icon().cloned()?;
    let tray = TrayIconBuilder::with_id("main-tray")
        .icon(icon)
        .tooltip("MusicFree")
        .on_menu_event(|app, event| {
            handle_menu_event(app, event.id().as_ref());
        })
        .on_tray_icon_event(|tray, event| {
            // 双击唤起主窗口（对应原版非 linux 平台 double-click）
            if let tauri::tray::TrayIconEvent::DoubleClick { .. } = event {
                show_main_window(tray.app_handle());
            }
        })
        .build(app)
        .ok()?;
    Some(tray)
}

fn show_main_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        if win.is_minimized().unwrap_or(false) {
            let _ = win.unminimize();
        }
        let _ = win.show();
        let _ = win.set_focus();
    }
}

fn handle_menu_event(app: &AppHandle, id: &str) {
    match id {
        "toggle-player" => crate::message_bus::send_command(app, "TogglePlayerState", Value::Null),
        "prev" => crate::message_bus::send_command(app, "SkipToPrevious", Value::Null),
        "next" => crate::message_bus::send_command(app, "SkipToNext", Value::Null),
        "repeat-loop" => crate::message_bus::send_command(app, "SetRepeatMode", Value::String("loop".into())),
        "repeat-queue" => crate::message_bus::send_command(app, "SetRepeatMode", Value::String("queue".into())),
        "repeat-shuffle" => crate::message_bus::send_command(app, "SetRepeatMode", Value::String("shuffle".into())),
        "open-detail" | "platform" => {
            show_main_window(app);
            crate::message_bus::send_command(app, "OpenMusicDetailPage", Value::Null);
        }
        "setting" => {
            show_main_window(app);
            crate::message_bus::send_command(app, "Navigate", Value::String("/main/setting".into()));
        }
        "exit" => {
            app.exit(0);
        }
        _ => {}
    }
}

fn menu_item(app: &AppHandle, id: &str, label: &str, enabled: bool) -> Option<MenuItem<tauri::Wry>> {
    MenuItem::with_id(app, id, label, enabled, None::<&str>).ok()
}

/// 依据 AppState + 文案重建托盘菜单（状态签名变化才重建，避免 progress 抖动）
pub fn rebuild_if_needed(app: &AppHandle) {
    let app_state = crate::message_bus::get_app_state(app);
    let music_item = app_state.get("musicItem").cloned().unwrap_or(Value::Null);
    let player_state = crate::message_bus::player_state_name(app);
    let repeat_mode = app_state.get("repeatMode").and_then(|v| v.as_str()).unwrap_or("loop");
    let lyric_text = app_state.get("lyricText").and_then(|v| v.as_str()).unwrap_or("");

    let title = music_item.get("title").and_then(|v| v.as_str()).unwrap_or("");
    let artist = music_item.get("artist").and_then(|v| v.as_str()).unwrap_or("");
    let platform = music_item.get("platform").and_then(|v| v.as_str()).unwrap_or("");
    let has_music = !music_item.is_null() && !title.is_empty();

    let state = app.state::<Mutex<TrayState>>();
    let Ok(mut guard) = state.lock() else { return };
    if guard.tray.is_none() {
        return;
    }

    // macOS 状态栏歌词（不影响菜单签名）
    #[cfg(target_os = "macos")]
    if let Some(tray) = &guard.tray {
        let t = if lyric_text.is_empty() {
            None
        } else if lyric_text.chars().count() > 7 {
            Some(format!(" {}...", lyric_text.chars().take(7).collect::<String>()))
        } else {
            Some(format!(" {lyric_text}"))
        };
        let _ = tray.set_title(t.as_deref());
    }

    let signature = format!("{title}|{artist}|{platform}|{player_state}|{repeat_mode}|{}", text_of(&guard, "common.exit"));
    if signature == guard.last_signature {
        return;
    }
    guard.last_signature = signature;

    let unknown_title = text_of(&guard, "media.unknown_title");
    let full_name = if has_music {
        format!(
            "{}{}",
            if title.is_empty() { unknown_title.as_str() } else { title },
            if artist.is_empty() { String::new() } else { format!(" - {artist}") }
        )
    } else {
        String::new()
    };

    if has_music {
        if let Some(tray) = &guard.tray {
            let _ = tray.set_tooltip(Some(full_name.as_str()));
        }
    } else if let Some(tray) = &guard.tray {
        let _ = tray.set_tooltip(Some("MusicFree"));
    }

    let toggle_label = if has_music {
        if player_state == "Playing" {
            text_of(&guard, "media.music_state_pause")
        } else {
            text_of(&guard, "media.music_state_play")
        }
    } else {
        text_of(&guard, "media.music_state_play_or_pause")
    };

    // 循环模式 radio 子菜单
    let mk_radio = |id: &str, label: String, checked: bool| -> Option<CheckMenuItem<tauri::Wry>> {
        CheckMenuItem::with_id(app, id, label, true, checked, None::<&str>).ok()
    };
    let submenu = match (
        mk_radio("repeat-loop", text_of(&guard, "media.music_repeat_mode_loop"), repeat_mode == "loop"),
        mk_radio("repeat-queue", text_of(&guard, "media.music_repeat_mode_queue"), repeat_mode == "queue-repeat"),
        mk_radio("repeat-shuffle", text_of(&guard, "media.music_repeat_mode_shuffle"), repeat_mode == "shuffle"),
    ) {
        (Some(a), Some(b), Some(c)) => SubmenuBuilder::new(app, text_of(&guard, "media.music_repeat_mode"))
            .item(&a)
            .item(&b)
            .item(&c)
            .build()
            .ok(),
        _ => None,
    };

    let menu = MenuBuilder::new(app);
    let menu = if has_music {
        let short_name = if full_name.chars().count() > 12 {
            format!("{}...", full_name.chars().take(12).collect::<String>())
        } else {
            full_name.clone()
        };
        match (
            menu_item(app, "open-detail", &short_name, true),
            menu_item(app, "platform", &format!("{}: {}", text_of(&guard, "media.media_platform"), platform), true),
        ) {
            (Some(a), Some(b)) => menu.item(&a).item(&b),
            _ => return,
        }
    } else {
        match menu_item(app, "no-music", &text_of(&guard, "main.no_playing_music"), false) {
            Some(a) => menu.item(&a),
            None => return,
        }
    };

    let Some(submenu) = submenu else { return };
    let (
        Some(m_toggle),
        Some(m_prev),
        Some(m_next),
        Some(m_setting),
        Some(m_exit),
    ) = (
        menu_item(app, "toggle-player", &toggle_label, has_music),
        menu_item(app, "prev", &text_of(&guard, "main.previous_music"), has_music),
        menu_item(app, "next", &text_of(&guard, "main.next_music"), has_music),
        menu_item(app, "setting", &text_of(&guard, "app_header.settings"), true),
        menu_item(app, "exit", &text_of(&guard, "common.exit"), true),
    ) else {
        return;
    };
    let Ok(menu) = menu
        .item(&m_toggle)
        .item(&m_prev)
        .item(&m_next)
        .item(&submenu)
        .separator()
        .item(&m_setting)
        .separator()
        .item(&m_exit)
        .build()
    else {
        return;
    };

    if let Some(tray) = &guard.tray {
        let _ = tray.set_menu(Some(menu));
    }
}

/// 跨模块文案查询（thumbbar 等复用）
pub fn tray_text(app: &AppHandle, key: &str) -> String {
    let state = app.state::<Mutex<TrayState>>();
    state
        .lock()
        .map(|g| text_of(&g, key))
        .unwrap_or_else(|_| key.to_string())
}

/// 主窗口推送托盘文案（i18n 语言包在前端；语言变化时重新推送）
#[tauri::command]
pub fn tray_update_texts(app: AppHandle, texts: HashMap<String, String>) {
    {
        let state = app.state::<Mutex<TrayState>>();
        let Ok(mut guard) = state.lock() else { return };
        guard.texts = texts;
        guard.last_signature.clear(); // 强制重建
    }
    rebuild_if_needed(&app);
}
