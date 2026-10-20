//! 任务栏 thumbar 控制按钮（阶段5，Windows）
//!
//! 对应 Electron 版 thumb-bar-util 的 setThumbarButtons（原版另含已放弃的封面缩略图）。
//! 上一首/播放暂停/下一首 三按钮，播放状态变化时更新图标；
//! 按钮点击经 Win32 子类化捕获 WM_COMMAND。

#![cfg(target_os = "windows")]

use serde_json::Value;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::Com::CoCreateInstance;
use windows::Win32::UI::Shell::{
    DefSubclassProc, ITaskbarList3, SetWindowSubclass, THBF_ENABLED, THB_ICON,
    THB_TOOLTIP, THUMBBUTTON, THUMBBUTTONMASK,
};
use windows::Win32::UI::WindowsAndMessaging::{CreateIcon, DestroyIcon, HICON};

pub struct ThumbbarState {
    pub added: bool,
    pub playing: bool,
}

pub fn setup_state() -> Mutex<ThumbbarState> {
    Mutex::new(ThumbbarState { added: false, playing: false })
}

const SUBCLASS_ID: usize = 0x4D46; // "MF"

unsafe fn png_to_hicon(png_path: &std::path::Path) -> Option<HICON> {
    let bytes = std::fs::read(png_path).ok()?;
    let img = image::load_from_memory(&bytes).ok()?.to_rgba8();
    let (w, h) = img.dimensions();
    // BGRA、行序自下而上（CreateIcon 期望 DDB 行序）
    let mut color_bits = vec![0u8; (w as usize * 4) * h as usize];
    for y in 0..h as usize {
        for x in 0..w as usize {
            let src = img.get_pixel(x as u32, y as u32);
            let dy = h as usize - 1 - y;
            let dst = (dy * w as usize + x) * 4;
            color_bits[dst] = src.0[2];
            color_bits[dst + 1] = src.0[1];
            color_bits[dst + 2] = src.0[0];
            color_bits[dst + 3] = src.0[3];
        }
    }
    let mask_stride = (w as usize + 31) / 32 * 4;
    let and_mask = vec![0u8; mask_stride * h as usize];
    CreateIcon(
        None,
        w as i32,
        h as i32,
        1,
        32,
        and_mask.as_ptr(),
        color_bits.as_ptr(),
    )
    .ok()
}

fn apply_buttons(app: &AppHandle, playing: bool) {
    let Some(main) = app.get_webview_window("main") else { return };
    let hwnd_raw = match main.hwnd() {
        Ok(h) => h,
        Err(_) => return,
    };
    let hwnd = HWND(hwnd_raw.0 as *mut core::ffi::c_void);

    let res = crate::paths::res_dir(app);
    let icon_paths = [
        res.join("skip-left.png"),
        if playing { res.join("pause.png") } else { res.join("play.png") },
        res.join("skip-right.png"),
    ];
    let tips = [
        crate::tray::tray_text(app, "main.previous_music"),
        if playing {
            crate::tray::tray_text(app, "media.music_state_pause")
        } else {
            crate::tray::tray_text(app, "media.music_state_play")
        },
        crate::tray::tray_text(app, "main.next_music"),
    ];

    unsafe {
        let Ok(taskbar) = CoCreateInstance::<_, ITaskbarList3>(
            &windows::core::GUID::from_u128(0x56fdf344_fd6d_11d0_958a_006097c9a090),
            None,
            windows::Win32::System::Com::CLSCTX_ALL,
        ) else {
            return;
        };

        let mut icon_handles: Vec<HICON> = Vec::new();
        let mut buttons: [THUMBBUTTON; 3] = std::array::from_fn(|i| {
            let mut btn = THUMBBUTTON::default();
            btn.iId = (40001 + i) as u32;
            btn.dwFlags = THBF_ENABLED;
            btn.dwMask = THB_ICON | THB_TOOLTIP;
            if let Some(hicon) = png_to_hicon(&icon_paths[i]) {
                btn.hIcon = hicon;
                icon_handles.push(hicon);
            }
            let tip: Vec<u16> = tips[i].encode_utf16().collect();
            let n = tip.len().min(259);
            btn.szTip[..n].copy_from_slice(&tip[..n]);
            btn
        });

        let state = app.state::<Mutex<ThumbbarState>>();
        let Ok(mut guard) = state.lock() else { return };
        let result = if guard.added {
            taskbar.ThumbBarUpdateButtons(hwnd, &mut buttons)
        } else {
            let r = taskbar.ThumbBarAddButtons(hwnd, &mut buttons);
            if r.is_ok() {
                guard.added = true;
            }
            r
        };
        if result.is_err() {
            guard.added = false;
        }
        guard.playing = playing;
    }
}

unsafe extern "system" fn subclass_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _subclass_id: usize,
    ref_data: usize,
) -> LRESULT {
    if msg == 0x0111 {
        // WM_COMMAND：低 16 位为控件 id
        let id = (wparam.0 & 0xffff) as u32;
        if (40001..=40003).contains(&id) {
            let app = &*(ref_data as *const AppHandle);
            match id {
                40001 => crate::message_bus::send_command(app, "SkipToPrevious", Value::Null),
                40002 => crate::message_bus::send_command(app, "TogglePlayerState", Value::Null),
                40003 => crate::message_bus::send_command(app, "SkipToNext", Value::Null),
                _ => {}
            }
        }
    }
    DefSubclassProc(hwnd, msg, wparam, lparam)
}

/// 主窗口创建后调用：子类化捕获 thumbar 按钮 WM_COMMAND
pub fn init(app: &AppHandle) {
    if let Some(main) = app.get_webview_window("main") {
        if let Ok(hwnd) = main.hwnd() {
            let hwnd = HWND(hwnd.0 as *mut core::ffi::c_void);
            let app_ptr = Box::leak(Box::new(app.clone())) as *const AppHandle;
            unsafe {
                let _ = SetWindowSubclass(hwnd, Some(subclass_proc), SUBCLASS_ID, app_ptr as usize);
            }
        }
    }
    apply_buttons(app, false);
}

/// 播放状态变化入口（message_bus sync 时调用）
pub fn update_on_state_change(app: &AppHandle) {
    let playing = crate::message_bus::get_app_state(app)
        .get("playerState")
        .and_then(|v| v.as_str())
        .map(|s| s == "Playing")
        .unwrap_or(false);
    let state = app.state::<Mutex<ThumbbarState>>();
    let changed = state.lock().map(|g| g.playing != playing).unwrap_or(false);
    drop(state);
    if changed {
        apply_buttons(app, playing);
    }
}
