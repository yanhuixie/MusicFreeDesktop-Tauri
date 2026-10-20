//! 本地音乐（阶段4）
//!
//! 对应 Electron 版 `common/file-util.ts`（music-metadata + jschardet + iconv-lite）
//! 与 `webworkers/local-file-watcher.ts`（chokidar depth 10）：
//! - parse_local_music_item：lofty 解析标签；GBK/GB2312 mojibake 修复
//!   （lofty 将 latin1 标签按码点读入 String，与 music-metadata 行为一致；
//!    对全 <0x100 的疑似 latin1 文本用 chardetng 检测后按原字节重解码）
//! - watch_local_dirs：notify 递归监听，防抖 500ms，路径增删事件 emit
//! - read_text_file_auto：伴生 .lrc/.txt 读取（编码自动检测）
//! - download_file：下载器单文件实现（进度事件 emit；并发控制在前端队列）

use base64::Engine;
use chardetng::EncodingDetector;
use lofty::prelude::*;
use serde::Serialize;
use serde_json::json;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

const SUPPORTED_EXT: &[&str] = &[
    ".mp3", ".mp4", ".m4s", ".flac", ".wma", ".wav", ".m4a", ".ogg", ".acc", ".aac", ".opus",
];

fn is_supported_media(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| {
            let with_dot = format!(".{}", e.to_lowercase());
            SUPPORTED_EXT.contains(&with_dot.as_str())
        })
        .unwrap_or(false)
}

fn file_stem(path: &str) -> String {
    Path::new(path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string()
}

/// GBK/GB2312 mojibake 修复（对齐 jschardet + iconv-lite 逻辑）
fn fix_mojibake(s: &str) -> String {
    if s.is_empty() || !s.chars().all(|c| (c as u32) < 0x100) {
        return s.to_string();
    }
    let bytes: Vec<u8> = s.chars().map(|c| c as u32 as u8).collect();
    let mut detector = EncodingDetector::new();
    detector.feed(&bytes, true);
    let encoding = detector.guess(None, true);
    // 只对中文系编码重解码，避免把法语等正常 latin1 文本破坏
    if matches!(encoding.name(), "GBK" | "gb18030" | "Big5" | "Shift_JIS") {
        let (decoded, _, had_errors) = encoding.decode(&bytes);
        if !had_errors {
            return decoded.to_string();
        }
    }
    s.to_string()
}

fn md5_hex(input: &str) -> String {
    // 与前端 CryptoJS.MD5(filePath) 完全对齐（本地音乐 id 进 Dexie，跨版本兼容）
    use md5::{Digest, Md5};
    let mut hasher = Md5::new();
    hasher.update(input.as_bytes());
    let digest = hasher.finalize();
    digest.iter().map(|b| format!("{:02x}", b)).collect()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalMusicItem {
    pub id: String,
    pub platform: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub artwork: Option<String>,
    pub url: String,
    pub local_path: String,
    pub raw_lrc: Option<String>,
}

fn parse_one(path: &str) -> LocalMusicItem {
    let id = md5_hex(path);
    let fallback = LocalMusicItem {
        id: id.clone(),
        platform: "本地".into(),
        title: file_stem(path),
        artist: "未知作者".into(),
        album: "未知专辑".into(),
        artwork: None,
        url: path.to_string(),
        local_path: path.to_string(),
        raw_lrc: None,
    };
    let Ok(tagged) = lofty::read_from_path(path) else {
        return fallback;
    };
    let tag = tagged.primary_tag().or_else(|| tagged.first_tag());
    let Some(tag) = tag else {
        return fallback;
    };
    let title = tag.title().map(|t| fix_mojibake(&t));
    let artist = tag.artist().map(|t| fix_mojibake(&t));
    let album = tag.album().map(|t| fix_mojibake(&t));
    let lyrics = tag
        .get_string(&lofty::tag::ItemKey::Lyrics)
        .map(|t| fix_mojibake(t));
    let artwork = tag.pictures().first().map(|pic| {
        let b64 = base64::engine::general_purpose::STANDARD.encode(pic.data());
        let mime = pic.mime_type().map(|m| m.as_str()).unwrap_or("image/jpeg");
        format!("data:{mime};base64,{b64}")
    });
    LocalMusicItem {
        id,
        platform: "本地".into(),
        title: title.filter(|t| !t.is_empty()).unwrap_or_else(|| file_stem(path)),
        artist: artist.filter(|t| !t.is_empty()).unwrap_or_else(|| "未知作者".into()),
        album: album.filter(|t| !t.is_empty()).unwrap_or_else(|| "未知专辑".into()),
        artwork,
        url: path.to_string(),
        local_path: path.to_string(),
        raw_lrc: lyrics,
    }
}

#[tauri::command]
pub fn parse_local_music_item(path: String) -> LocalMusicItem {
    parse_one(&path)
}

#[tauri::command]
pub async fn parse_local_music_item_folder(folder: String) -> Result<Vec<LocalMusicItem>, String> {
    let dir = Path::new(&folder);
    if !dir.is_dir() {
        return Ok(vec![]);
    }
    let mut entries = tokio::fs::read_dir(dir).await.map_err(|e| e.to_string())?;
    let mut items = Vec::new();
    while let Ok(Some(entry)) = entries.next_entry().await {
        let path = entry.path();
        if path.is_file() && is_supported_media(&path) {
            items.push(parse_one(&path.to_string_lossy()));
        }
    }
    Ok(items)
}

/// 伴生歌词读取（.lrc/.LRC/.txt 与 -tr 翻译），编码自动检测
#[tauri::command]
pub async fn read_companion_lrc(media_path: String) -> Result<serde_json::Value, String> {
    let p = PathBuf::from(&media_path);
    let dir = p.parent().ok_or("invalid path")?;
    let stem = p.file_stem().and_then(|s| s.to_str()).ok_or("invalid path")?;
    let mut raw_lrc: Option<String> = None;
    let mut translation: Option<String> = None;
    for ext in [".lrc", ".LRC", ".txt"] {
        let lrc_path = dir.join(format!("{stem}{ext}"));
        if lrc_path.is_file() {
            if let Ok(content) = read_text_auto(&lrc_path).await {
                raw_lrc = Some(content);
                let tr_path = dir.join(format!("{stem}-tr{ext}"));
                if tr_path.is_file() {
                    translation = read_text_auto(&tr_path).await.ok();
                }
                break;
            }
        }
    }
    Ok(json!({ "rawLrc": raw_lrc, "translation": translation }))
}

async fn read_text_auto(path: &Path) -> Result<String, String> {
    let bytes = tokio::fs::read(path).await.map_err(|e| e.to_string())?;
    let mut detector = EncodingDetector::new();
    detector.feed(&bytes, true);
    let encoding = detector.guess(None, true);
    let (text, _, had_errors) = encoding.decode(&bytes);
    if had_errors {
        Ok(String::from_utf8_lossy(&bytes).to_string())
    } else {
        Ok(text.to_string())
    }
}

/**************************** 目录监听（notify，防抖 500ms） ****************************/

pub struct WatcherState {
    watcher: Option<notify::RecommendedWatcher>,
    watched: Vec<String>,
    added: Vec<String>,
    removed: Vec<String>,
    last_flush: std::time::Instant,
}

fn flush_events(app: &AppHandle, state: &mut WatcherState) {
    if state.added.is_empty() && state.removed.is_empty() {
        return;
    }
    let added = std::mem::take(&mut state.added);
    let removed = std::mem::take(&mut state.removed);
    state.last_flush = std::time::Instant::now();
    let _ = app.emit(
        "local-music-changed",
        json!({ "added": added, "removed": removed }),
    );
}

fn should_flush(state: &WatcherState) -> bool {
    state.last_flush.elapsed() >= std::time::Duration::from_millis(500)
        && (!state.added.is_empty() || !state.removed.is_empty())
}

#[tauri::command]
pub fn watch_local_dirs(app: AppHandle, add: Option<Vec<String>>, remove: Option<Vec<String>>) -> Result<(), String> {
    use notify::Watcher;
    let state = app.state::<Mutex<WatcherState>>();
    let mut guard = state.lock().unwrap();

    if guard.watcher.is_none() {
        let app_handle = app.clone();
        let watcher = notify::recommended_watcher(move |res: Result<notify::Event, notify::Error>| {
            if let Ok(event) = res {
                let state = app_handle.state::<Mutex<WatcherState>>();
                let mut guard = state.lock().unwrap();
                match event.kind {
                    notify::EventKind::Create(_) => {
                        for path in event.paths {
                            if path.is_file() && is_supported_media(&path) {
                                guard.added.push(path.to_string_lossy().to_string());
                            }
                        }
                    }
                    notify::EventKind::Remove(_) => {
                        for path in event.paths {
                            if is_supported_media(&path) {
                                guard.removed.push(path.to_string_lossy().to_string());
                            }
                        }
                    }
                    _ => {}
                }
                let flush_now = should_flush(&guard);
                if flush_now {
                    flush_events(&app_handle, &mut guard);
                    return;
                }
                // 兜底：防抖窗口结束后仍无新事件时定时 flush（对齐 chokidar debounce 语义）
                let app_flush = app_handle.clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_millis(600)).await;
                    let state = app_flush.state::<Mutex<WatcherState>>();
                    let mut guard = state.lock().unwrap();
                    if should_flush(&guard) {
                        flush_events(&app_flush, &mut guard);
                    }
                });
            }
        })
        .map_err(|e| e.to_string())?;
        guard.watcher = Some(watcher);
    }

    if let Some(add) = add {
        for dir in &add {
            if let Some(watcher) = guard.watcher.as_mut() {
                let _ = watcher.watch(Path::new(dir), notify::RecursiveMode::Recursive);
            }
            guard.watched.push(dir.clone());
        }
    }
    if let Some(remove) = remove {
        for dir in &remove {
            if let Some(watcher) = guard.watcher.as_mut() {
                let _ = watcher.unwatch(Path::new(dir));
            }
        }
        guard.watched.retain(|d| !remove.contains(d));
    }
    Ok(())
}

pub fn setup_watcher_state() -> Mutex<WatcherState> {
    Mutex::new(WatcherState {
        watcher: None,
        watched: Vec::new(),
        added: Vec::new(),
        removed: Vec::new(),
        last_flush: std::time::Instant::now(),
    })
}

/// 获取当前监听目录（前端持久化 localWatchDir 恢复用）
#[tauri::command]
pub fn get_watched_dirs(app: AppHandle) -> Vec<String> {
    app.state::<Mutex<WatcherState>>()
        .lock()
        .map(|s| s.watched.clone())
        .unwrap_or_default()
}

/**************************** 下载器 ****************************/

#[tauri::command]
pub async fn download_file(app: AppHandle, source: serde_json::Value, file_path: String) -> Result<(), String> {
    let url = source.get("url").and_then(|v| v.as_str()).ok_or("no url")?.to_string();
    let mut headers: HashMap<String, String> = HashMap::new();
    if let Some(h) = source.get("headers").and_then(|v| v.as_object()) {
        for (k, v) in h {
            if let Some(vs) = v.as_str() {
                headers.insert(k.clone(), vs.to_string());
            }
        }
    }
    if let Some(ua) = source.get("userAgent").and_then(|v| v.as_str()) {
        headers.insert("user-agent".into(), ua.to_string());
    }
    // basic-auth URL → Authorization
    if let Ok(mut parsed) = reqwest::Url::parse(&url) {
        let username = parsed.username().to_string();
        let password = parsed.password().unwrap_or("").to_string();
        if !username.is_empty() && !password.is_empty() {
            use base64::Engine as _;
            let credentials = format!(
                "{}:{}",
                percent_decode(&username),
                percent_decode(&password)
            );
            let encoded = base64::engine::general_purpose::STANDARD.encode(credentials);
            headers.insert("Authorization".into(), format!("Basic {encoded}"));
            let _ = parsed.set_username("");
            let _ = parsed.set_password(None);
        }
        // 目标路径为目录则报错
        if Path::new(&file_path).is_dir() {
            let _ = app.emit("download-progress", json!({
                "filePath": file_path, "state": "error", "msg": "Filepath is a directory"
            }));
            return Err("Filepath is a directory".into());
        }
        emit_progress(&app, &file_path, "downloading", Some(0), Some(0));

        let client = reqwest::Client::builder()
            .danger_accept_invalid_certs(true)
            .build()
            .map_err(|e| e.to_string())?;
        let mut req = client.get(parsed);
        for (k, v) in &headers {
            req = req.header(k.as_str(), v.as_str());
        }
        let resp = match req.send().await {
            Ok(r) => r,
            Err(e) => {
                let _ = tokio::fs::remove_file(&file_path).await;
                emit_progress(&app, &file_path, "error", None, None);
                let _ = app.emit("download-progress", json!({"filePath": file_path, "state": "error", "msg": e.to_string()}));
                return Err(e.to_string());
            }
        };
        let total = resp.content_length().unwrap_or(0);
        emit_progress(&app, &file_path, "downloading", Some(0), Some(total));
        use futures_util::StreamExt;
        use tokio::io::AsyncWriteExt;
        let mut file = tokio::io::BufWriter::new(tokio::fs::File::create(&file_path).await.map_err(|e| e.to_string())?);
        let mut stream = resp.bytes_stream();
        let mut current: u64 = 0;
        let mut last_emit: u64 = 0;
        while let Some(chunk) = stream.next().await {
            let chunk = match chunk {
                Ok(c) => c,
                Err(e) => {
                    let _ = tokio::fs::remove_file(&file_path).await;
                    let _ = app.emit("download-progress", json!({"filePath": file_path, "state": "error", "msg": e.to_string()}));
                    return Err(e.to_string());
                }
            };
            if let Err(e) = file.write_all(&chunk).await {
                let _ = tokio::fs::remove_file(&file_path).await;
                let _ = app.emit("download-progress", json!({"filePath": file_path, "state": "error", "msg": e.to_string()}));
                return Err(e.to_string());
            }
            current += chunk.len() as u64;
            // 进度节流（~64KB 批量，对齐原 throttle）
            if current - last_emit >= 65536 {
                last_emit = current;
                emit_progress(&app, &file_path, "downloading", Some(current), Some(total));
            }
        }
        let _ = file.flush().await;
        emit_progress(&app, &file_path, "done", Some(current), Some(total));
        Ok(())
    } else {
        Err("invalid url".into())
    }
}

fn emit_progress(app: &AppHandle, file_path: &str, state: &str, current: Option<u64>, total: Option<u64>) {
    let _ = app.emit(
        "download-progress",
        json!({
            "filePath": file_path,
            "state": state,
            "currentSize": current.unwrap_or(0),
            "totalSize": total.unwrap_or(0),
        }),
    );
}

fn percent_decode(s: &str) -> String {
    // 简化实现：仅处理 %XX
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(b) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}
