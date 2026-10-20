//! mediahub:// 流式媒体协议（阶段2）
//!
//! 对应计划 §3 阶段2，统一 Electron 版三条播放路径：
//! 1. 本地文件（原 file:// 直连 / node fs）
//! 2. 带自定义 header/UA 的远程音频（原 _setHeaders hack + request-forwarder 子进程）
//! 3. basic-auth URL（原 Authorization 转换）
//!
//! URL 格式：mediahub://localhost/f/<base64url(JSON{url,headers})>
//! - Range 请求头透传（拖动进度）
//! - m3u8 响应内容重写：分片/密钥 URL 一并编码为 mediahub，hls.js 全链路经代理（无 CORS）
//! - 响应注入 CORS 头（hls.js fetch 需要）

use base64::Engine;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tauri::http::{header, Request, Response};
use tauri::AppHandle;

#[derive(Serialize, Deserialize, Clone)]
pub struct MediahubPayload {
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub headers: Option<HashMap<String, String>>,
}

/// 编码 mediahub URL（前端辅助函数的 Rust 对应物，供 Rust 侧生成改写 URL）
/// Windows 上 Tauri 自定义协议实际形态为 http://{scheme}.localhost（WebView2 限制），
/// fetch/audio 元素才能访问；macOS/Linux 为 scheme://localhost
pub fn encode_mediahub_url(payload: &MediahubPayload) -> String {
    let json = serde_json::to_string(payload).unwrap_or_default();
    let b64 = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(json);
    if cfg!(windows) {
        format!("http://mediahub.localhost/f/{b64}")
    } else {
        format!("mediahub://localhost/f/{b64}")
    }
}

fn decode_payload(path: &str) -> Option<MediahubPayload> {
    let b64 = path.strip_prefix("/f/")?;
    let json = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(b64).ok()?;
    serde_json::from_slice(&json).ok()
}

fn with_cors(mut builder: tauri::http::response::Builder) -> tauri::http::response::Builder {
    builder = builder.header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*");
    builder = builder.header(header::ACCESS_CONTROL_ALLOW_HEADERS, "*");
    builder = builder.header(header::ACCESS_CONTROL_ALLOW_METHODS, "GET, HEAD, OPTIONS");
    builder
}

fn error_response(status: u16, msg: &str) -> Response<Vec<u8>> {
    with_cors(Response::builder().status(status))
        .header(header::CONTENT_TYPE, "text/plain")
        .body(msg.as_bytes().to_vec())
        .unwrap()
}

/// 解析本地路径（file:// URL 或绝对路径）
fn local_path_from_url(url: &str) -> Option<std::path::PathBuf> {
    let raw = if let Some(rest) = url.strip_prefix("file:///") {
        percent_decode(rest)
    } else if let Some(rest) = url.strip_prefix("file://") {
        percent_decode(rest)
    } else if cfg!(windows) && url.len() > 2 && url.as_bytes()[1] == b':' && (url.contains('\\') || url.contains('/')) {
        percent_decode(url)
    } else {
        return None;
    };
    let path = std::path::PathBuf::from(raw);
    path.is_file().then_some(path)
}

fn percent_decode(s: &str) -> String {
    let mut out = Vec::with_capacity(s.len());
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() + 1 && i + 2 <= bytes.len() - 1 + 1 {
            if i + 2 < bytes.len() {
                if let Ok(b) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                    out.push(b);
                    i += 3;
                    continue;
                }
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

/// m3u8 内容重写：分片 URI、EXT-X-KEY/MAP 的 URI 属性一并编码为 mediahub
fn rewrite_m3u8(content: &str, base_url: &str, payload: &MediahubPayload) -> String {
    let base = reqwest::Url::parse(base_url).ok();
    let mut out_lines: Vec<String> = Vec::with_capacity(64);
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            out_lines.push(line.to_string());
            continue;
        }
        if trimmed.starts_with('#') {
            // 标签行：处理 URI="..." 属性
            if let Some(rewritten) = rewrite_tag_uri(line, &base, payload) {
                out_lines.push(rewritten);
            } else {
                out_lines.push(line.to_string());
            }
        } else {
            // 分片行
            let absolute = base
                .as_ref()
                .and_then(|b| b.join(trimmed).ok())
                .map(|u| u.to_string())
                .unwrap_or_else(|| trimmed.to_string());
            let mut seg_payload = payload.clone();
            seg_payload.url = absolute;
            out_lines.push(encode_mediahub_url(&seg_payload));
        }
    }
    out_lines.join("\n") + "\n"
}

fn rewrite_tag_uri(line: &str, base: &Option<reqwest::Url>, payload: &MediahubPayload) -> Option<String> {
    let uri_start = line.find("URI=\"")?;
    let value_start = uri_start + 5;
    let value_end = line[value_start..].find('"')? + value_start;
    let uri = &line[value_start..value_end];
    let absolute = base
        .as_ref()
        .and_then(|b| b.join(uri).ok())
        .map(|u| u.to_string())
        .unwrap_or_else(|| uri.to_string());
    let mut seg_payload = payload.clone();
    seg_payload.url = absolute;
    let encoded = encode_mediahub_url(&seg_payload);
    Some(format!("{}{}{}{}", &line[..uri_start + 5], encoded, "\"", &line[value_end + 1..]))
}

/// 解析 Range 头：返回 (start, end)（end 为闭区间；None 表示到文件尾）
fn parse_range(header_value: &str, total: u64) -> Option<(u64, u64)> {
    let spec = header_value.strip_prefix("bytes=")?;
    let mut parts = spec.splitn(2, '-');
    let start_str = parts.next()?.trim();
    let end_str = parts.next().unwrap_or("").trim();
    let start: u64 = if start_str.is_empty() {
        // suffix range: bytes=-N
        let n: u64 = end_str.parse().ok()?;
        if n == 0 { return None; }
        total.saturating_sub(n)
    } else {
        start_str.parse().ok()?
    };
    let end: u64 = if end_str.is_empty() {
        total.saturating_sub(1)
    } else {
        end_str.parse::<u64>().ok()?.min(total.saturating_sub(1))
    };
    if start > end { return None; }
    Some((start, end))
}

async fn serve_local_file(path: std::path::PathBuf, request_headers: &tauri::http::HeaderMap) -> Response<Vec<u8>> {
    use tokio::io::{AsyncReadExt, AsyncSeekExt, SeekFrom};
    let total = match tokio::fs::metadata(&path).await {
        Ok(m) => m.len(),
        Err(_) => return error_response(404, "file not found"),
    };
    let mime = mime_from_ext(path.extension().and_then(|e| e.to_str()).unwrap_or(""));

    let range_header = request_headers
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| parse_range(v, total));

    let mut file = match tokio::fs::File::open(&path).await {
        Ok(f) => f,
        Err(_) => return error_response(403, "cannot open file"),
    };

    match range_header {
        Some((start, end)) => {
            let length = end - start + 1;
            if let Err(_) = file.seek(SeekFrom::Start(start)).await {
                return error_response(416, "range not satisfiable");
            }
            let mut buf = vec![0u8; length as usize];
            if let Err(_) = file.read_exact(&mut buf).await {
                return error_response(500, "read error");
            }
            with_cors(Response::builder().status(206))
                .header(header::CONTENT_TYPE, mime)
                .header(header::CONTENT_LENGTH, length.to_string())
                .header(header::ACCEPT_RANGES, "bytes")
                .header(
                    header::CONTENT_RANGE,
                    format!("bytes {start}-{end}/{total}"),
                )
                .body(buf)
                .unwrap()
        }
        None => {
            let mut buf = Vec::with_capacity(total as usize);
            if file.read_to_end(&mut buf).await.is_err() {
                return error_response(500, "read error");
            }
            with_cors(Response::builder().status(200))
                .header(header::CONTENT_TYPE, mime)
                .header(header::CONTENT_LENGTH, total.to_string())
                .header(header::ACCEPT_RANGES, "bytes")
                .body(buf)
                .unwrap()
        }
    }
}

fn mime_from_ext(ext: &str) -> &'static str {
    match ext.to_lowercase().as_str() {
        "mp3" => "audio/mpeg",
        "flac" => "audio/flac",
        "flv" => "video/x-flv",
        "m4a" => "audio/mp4",
        "m4b" => "audio/mp4",
        "m4p" => "audio/mp4",
        "m4v" | "mp4" => "video/mp4",
        "mkv" | "webm" => "video/webm",
        "mov" => "video/quicktime",
        "ogg" | "oga" | "opus" => "audio/ogg",
        "wav" => "audio/x-wav",
        "wma" => "audio/x-ms-wma",
        "wv" => "audio/x-ffmpeg-shorten",
        "m3u8" => "application/vnd.apple.mpegurl",
        "ts" => "video/mp2t",
        "aac" => "audio/aac",
        "ape" => "audio/ape",
        "key" | "pem" => "application/octet-stream",
        _ => "application/octet-stream",
    }
}

/// 建代理客户端（阶段3 将应用 network.proxy.* 配置）
fn proxy_client() -> reqwest::Client {
    reqwest::Client::builder()
        .danger_accept_invalid_certs(false)
        .build()
        .unwrap_or_default()
}

pub async fn handle(request: Request<Vec<u8>>, _app: &AppHandle) -> Response<Vec<u8>> {
    let uri = request.uri().to_string();
    log::info!("[mediahub] request uri: {uri}");
    // 两种形态（http://mediahub.localhost/f/x 或 mediahub://localhost/f/x）的 path 均为 /f/x
    let path = request.uri().path().to_string();

    let Some(payload) = decode_payload(&path) else {
        return error_response(400, "invalid mediahub payload");
    };

    // 1. 本地文件
    if let Some(path) = local_path_from_url(&payload.url) {
        return serve_local_file(path, request.headers()).await;
    }

    // 2. 远程转发
    let url = match reqwest::Url::parse(&payload.url) {
        Ok(u) => u,
        Err(_) => return error_response(400, "invalid url"),
    };
    if url.scheme() != "http" && url.scheme() != "https" {
        return error_response(400, "unsupported scheme");
    }

    let mut req = proxy_client().get(url.clone());
    // 透传 Range（拖动进度）
    if let Some(range) = request.headers().get(header::RANGE) {
        req = req.header(header::RANGE, range);
    }
    // 注入自定义 header
    if let Some(headers) = &payload.headers {
        for (k, v) in headers {
            req = req.header(k.as_str(), v.as_str());
        }
    }

    let resp = match req.send().await {
        Ok(r) => r,
        Err(e) => return error_response(502, &format!("upstream error: {e}")),
    };

    let status = resp.status().as_u16();
    let mut builder = with_cors(Response::builder().status(status));
    let mut is_m3u8 = false;
    for (name, value) in resp.headers().iter() {
        let lower = name.as_str().to_lowercase();
        if matches!(lower.as_str(), "content-type" | "content-length" | "content-range" | "accept-ranges") {
            if lower == "content-type" {
                if let Ok(ct) = value.to_str() {
                    is_m3u8 = ct.contains("mpegurl") || ct.contains("m3u8");
                }
            }
            builder = builder.header(name.clone(), value.clone());
        }
    }

    // 流式收集（音频文件整体拉取；Range 请求时为片段）
    let mut stream = resp.bytes_stream();
    let mut data: Vec<u8> = Vec::new();
    let mut stream_error: Option<String> = None;
    while let Some(chunk) = stream.next().await {
        match chunk {
            Ok(c) => data.extend_from_slice(&c),
            Err(e) => {
                stream_error = Some(e.to_string());
                break;
            }
        }
    }
    if let Some(e) = stream_error {
        return error_response(502, &format!("stream error: {e}"));
    }
    let body = data;

    // m3u8 内容改写（分片 URL → mediahub）
    if is_m3u8 {
        let content = String::from_utf8_lossy(&body).to_string();
        let rewritten = rewrite_m3u8(&content, url.as_str(), &payload);
        return builder
            .header(header::CONTENT_LENGTH, rewritten.len().to_string())
            .body(rewritten.into_bytes())
            .unwrap();
    }

    builder.body(body).unwrap()
}
