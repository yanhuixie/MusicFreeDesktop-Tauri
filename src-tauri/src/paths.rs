//! 统一数据目录（阶段5：便携版支持）
//!
//! Electron 版 main/index.ts 的便携版重定向：exe 旁存在 portable/ 目录时
//! 数据全部落便携目录；否则用应用数据目录。
//! 所有数据写入点（app-config/themepack/插件目录/global-context）统一经此模块。

use std::path::PathBuf;
use tauri::{AppHandle, Manager};

pub fn data_dir(app: &AppHandle) -> PathBuf {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let portable = dir.join("portable");
            if portable.is_dir() {
                return portable;
            }
        }
    }
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("musicfree-fallback"))
}

pub fn is_portable() -> bool {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            return dir.join("portable").is_dir();
        }
    }
    false
}

/// 资源目录（res/：dev 为项目 res，打包为 resource dir 下 res）
pub fn res_dir(app: &AppHandle) -> PathBuf {
    if let Ok(dir) = app.path().resource_dir() {
        let packaged = dir.join("res");
        if packaged.is_dir() {
            return packaged;
        }
    }
    // dev：src-tauri 的上级项目根的 res
    if let Ok(exe) = std::env::current_exe() {
        // target/debug → 项目根
        let mut dir = exe.parent().map(|p| p.to_path_buf());
        for _ in 0..3 {
            if let Some(d) = dir {
                let candidate = d.join("res");
                if candidate.is_dir() {
                    return candidate;
                }
                dir = d.parent().map(|p| p.to_path_buf());
            }
        }
    }
    PathBuf::from("res")
}
