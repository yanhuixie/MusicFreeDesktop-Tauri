//! 主题包（阶段4）
//!
//! 对应 Electron 版 `shared/themepack/preload.ts` 的 Node 部分：
//! - .mftheme (zip) 解压安装（nanoid 目录）、卸载、列表（解析 config.json + MD5 hash）
//! - 主题文件读取（index.css / iframe html，前端注入用）
//! CSS/iframe 注入逻辑保留在 web 侧（themepack/renderer.ts）。

use base64::Engine;
use serde_json::Value;
use std::io::Read;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

fn themes_base_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("musicfree-themepacks");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// 解析主题目录 → IThemePack JSON（对齐 preload.parseThemePack）
fn parse_theme_dir(dir: &Path) -> Option<Value> {
    let config_path = dir.join("config.json");
    if !config_path.is_file() || !dir.join("index.css").is_file() {
        return None;
    }
    let raw = std::fs::read_to_string(&config_path).ok()?;
    let json: Value = serde_json::from_str(&raw).ok()?;
    let hash = {
        // 对齐 CryptoJS.MD5(rawConfig).toString()
        use md5::{Digest, Md5};
        let mut hasher = Md5::new();
        hasher.update(raw.as_bytes());
        hasher.finalize().iter().map(|b| format!("{:02x}", b)).collect::<String>()
    };    let preview = json.get("preview").and_then(|v| v.as_str());
    let preview = match preview {
        Some(p) if p.starts_with('#') => Some(p.to_string()),
        Some(p) => Some(p.replace("@/", &format!("{}/", dir.to_string_lossy()))),
        None => None,
    };
    let mut theme = json.clone();
    if let Some(obj) = theme.as_object_mut() {
        obj.insert("hash".into(), Value::String(hash));
        if let Some(p) = preview {
            obj.insert("preview".into(), Value::String(p));
        }
        obj.insert("path".into(), Value::String(dir.to_string_lossy().to_string()));
    }
    Some(theme)
}

#[tauri::command]
pub fn theme_load_packs(app: AppHandle) -> Result<Vec<Value>, String> {
    let base = themes_base_dir(&app)?;
    let mut packs = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&base) {
        for entry in entries.flatten() {
            if entry.path().is_dir() {
                if let Some(pack) = parse_theme_dir(&entry.path()) {
                    packs.push(pack);
                }
            }
        }
    }
    Ok(packs)
}

#[tauri::command]
pub fn theme_init_current(app: AppHandle, current_path: Option<String>) -> Result<Option<Value>, String> {
    themes_base_dir(&app)?;
    match current_path {
        Some(p) if !p.is_empty() => Ok(parse_theme_dir(Path::new(&p))),
        _ => Ok(None),
    }
}

/// 解压 .mftheme 到 nanoid 目录
#[tauri::command]
pub fn theme_install(app: AppHandle, theme_pack_path: String) -> Result<Option<Value>, String> {
    let base = themes_base_dir(&app)?;
    let cache_dir = base.join(nanoid_simple());
    let file = std::fs::File::open(&theme_pack_path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        // zip 路径穿越防护
        let entry_name = entry.name().to_string();
        if entry_name.contains("..") {
            continue;
        }
        let out_path = cache_dir.join(&entry_name);
        if entry.is_dir() {
            std::fs::create_dir_all(&out_path).map_err(|e| e.to_string())?;
        } else {
            if let Some(parent) = out_path.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            let mut content = Vec::new();
            entry.read_to_end(&mut content).map_err(|e| e.to_string())?;
            std::fs::write(&out_path, content).map_err(|e| e.to_string())?;
        }
    }
    match parse_theme_dir(&cache_dir) {
        Some(pack) => Ok(Some(pack)),
        None => {
            let _ = std::fs::remove_dir_all(&cache_dir);
            Ok(None)
        }
    }
}

/// 远程主题包：下载 → 安装（经 plugin_http_request 同一客户端能力）
#[tauri::command]
pub async fn theme_install_remote(app: AppHandle, remote_url: String) -> Result<Value, String> {
    let temp_dir = std::env::temp_dir();
    let temp_path = temp_dir.join(format!("musicfree-theme-{}.mftheme", nanoid_simple()));
    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client.get(&remote_url).send().await.map_err(|e| e.to_string())?;
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    tokio::fs::write(&temp_path, &bytes).await.map_err(|e| e.to_string())?;
    let result = theme_install(app, temp_path.to_string_lossy().to_string());
    let _ = tokio::fs::remove_file(&temp_path).await;
    match result {
        Ok(Some(pack)) => Ok(pack),
        Ok(None) => Err("Download fail".into()),
        Err(e) => Err(e),
    }
}

#[tauri::command]
pub fn theme_uninstall(theme_pack_path: String) -> Result<(), String> {
    let path = Path::new(&theme_pack_path);
    if path.is_dir() && path.to_string_lossy().contains("musicfree-themepacks") {
        std::fs::remove_dir_all(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 读取主题内文本文件（index.css / iframe html），供 web 侧注入
#[tauri::command]
pub fn theme_read_file(theme_pack_path: String, relative_path: String) -> Result<String, String> {
    // 路径穿越防护
    if relative_path.contains("..") {
        return Err("invalid path".into());
    }
    let full = Path::new(&theme_pack_path).join(&relative_path);
    std::fs::read_to_string(full).map_err(|e| e.to_string())
}

/// 图片资源 base64（preview 等相对资源，iframe src 用）
#[tauri::command]
pub fn theme_read_file_base64(theme_pack_path: String, relative_path: String) -> Result<String, String> {
    if relative_path.contains("..") {
        return Err("invalid path".into());
    }
    let full = Path::new(&theme_pack_path).join(&relative_path);
    let bytes = std::fs::read(full).map_err(|e| e.to_string())?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

fn nanoid_simple() -> String {
    // 21 位 nanoid 等价（字母数字）
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
    let mut id = String::with_capacity(21);
    let mut seed = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(42);
    for _ in 0..21 {
        seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        let idx = ((seed >> 33) as usize) % ALPHABET.len();
        id.push(ALPHABET[idx] as char);
    }
    id
}
