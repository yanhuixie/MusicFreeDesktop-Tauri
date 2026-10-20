//! SMTC 系统媒体控制（阶段2）
//!
//! 对应计划：Electron 版依赖 Chromium 自动映射 SMTC；Tauri/WebView2 无此机制，
//! 用 souvlaki crate 实现（Windows SMTC 优先）。
//! 播放状态/元数据/进度由前端 audio-controller 经 `smtc_update` command 上报；
//! 系统事件（播放/暂停/上一首/下一首/进度条）经 message_bus 下发主窗口。

use souvlaki::{MediaControlEvent, MediaControls, MediaMetadata, MediaPosition, PlatformConfig};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager};

pub struct SmtcState {
    pub controls: Option<MediaControls>,
    pub last_playing: bool,
}

pub fn setup(app: &AppHandle) -> SmtcState {
    let hwnd = app
        .get_webview_window("main")
        .and_then(|w| w.hwnd().ok())
        .map(|h| h.0 as *mut core::ffi::c_void);

    let config = PlatformConfig {
        dbus_name: "musicfree",
        display_name: "MusicFree",
        hwnd,
    };

    let app_for_cb = app.clone();
    match MediaControls::new(config) {
        Ok(mut controls) => {
            let attach_result = controls.attach(move |event: MediaControlEvent| {
                // ICommand 现有命令集：TogglePlayerState 语义覆盖 Play/Pause/Toggle
                // （系统面板只在播放中提供 Pause、暂停中提供 Play）
                let command = match event {
                    MediaControlEvent::Play | MediaControlEvent::Pause | MediaControlEvent::Toggle => "TogglePlayerState",
                    MediaControlEvent::Next => "SkipToNext",
                    MediaControlEvent::Previous => "SkipToPrevious",
                    _ => return,
                };
                crate::message_bus::send_command(&app_for_cb, command, serde_json::Value::Null);
            });
            if let Err(e) = attach_result {
                log::warn!("SMTC attach 失败: {e:?}");
                return SmtcState { controls: None, last_playing: false };
            }
            SmtcState { controls: Some(controls), last_playing: false }
        }
        Err(e) => {
            log::warn!("SMTC 初始化失败: {e:?}");
            SmtcState { controls: None, last_playing: false }
        }
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SmtcUpdate {
    pub playing: Option<bool>,
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub duration: Option<f64>,
    pub position: Option<f64>,
    /// 是否清空元数据（切歌间隙）
    pub reset: Option<bool>,
}

#[tauri::command]
pub fn smtc_update(state: tauri::State<'_, Mutex<SmtcState>>, update: SmtcUpdate) {
    let mut guard = state.lock().unwrap();
    let mut last_playing = guard.last_playing;
    let mut controls_opt = guard.controls.take();
    let Some(controls) = controls_opt.as_mut() else {
        guard.controls = controls_opt;
        return;
    };

    if let Some(true) = update.reset {
        let _ = controls.set_metadata(MediaMetadata::default());
        guard.controls = controls_opt;
        return;
    }

    let metadata_changed = update.title.is_some() || update.artist.is_some() || update.album.is_some() || update.duration.is_some();
    if metadata_changed {
        let _ = controls.set_metadata(MediaMetadata {
            title: update.title.as_deref(),
            album: update.album.as_deref(),
            artist: update.artist.as_deref(),
            cover_url: None,
            duration: update.duration.map(|d| Duration::from_secs_f64(d.max(0.0))),
        });
    }

    if let Some(playing) = update.playing {
        if playing != last_playing {
            let _ = controls.set_playback(if playing {
                souvlaki::MediaPlayback::Playing { progress: None }
            } else {
                souvlaki::MediaPlayback::Paused { progress: None }
            });
            last_playing = playing;
        }
    }

    if let Some(position) = update.position {
        let progress = MediaPosition(Duration::from_secs_f64(position.max(0.0)));
        let _ = controls.set_playback(if last_playing {
            souvlaki::MediaPlayback::Playing { progress: Some(progress) }
        } else {
            souvlaki::MediaPlayback::Paused { progress: Some(progress) }
        });
    }

    guard.last_playing = last_playing;
    guard.controls = controls_opt;
}
