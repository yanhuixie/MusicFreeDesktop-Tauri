//! 插件 HTTP 请求代理（阶段3）
//!
//! 对应 Electron 版：主进程 axios（rejectUnauthorized:false 全局忽略证书）+
//! @react-native-cookies polyfill（session cookie jar）。
//! iframe 插件运行时无 CORS 能力，所有插件网络请求经 postMessage → 主 frame →
//! 本 command 转发；cookie 由 reqwest cookie store 自动携带与收集。

use base64::Engine;
use reqwest::{Client, Method};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::AppHandle;

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HttpRequestConfig {
    pub url: String,
    pub method: Option<String>,
    #[serde(default)]
    pub headers: Option<HashMap<String, String>>,
    /// 文本请求体（axios 对象体会先被 JSON.stringify）
    pub data: Option<String>,
    pub timeout_ms: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpResponseResult {
    pub status: u16,
    pub headers: HashMap<String, String>,
    /// 文本响应体（按 charset 解码）
    pub body_text: Option<String>,
    /// 二进制响应体 base64（responseType 为 arraybuffer/blob 时）
    pub body_base64: Option<String>,
}

struct ClientHolder {
    fingerprint: String,
    client: Client,
}

static CLIENT: std::sync::OnceLock<Mutex<ClientHolder>> = std::sync::OnceLock::new();

/// 依据 network.proxy.* 配置构建客户端；配置指纹变化时重建
fn get_client(app: &AppHandle) -> Client {
    let (enabled, host, port, username, password) = (
        crate::app_config::get_config(app, "network.proxy.enabled").and_then(|v| v.as_bool()).unwrap_or(false),
        crate::app_config::get_config(app, "network.proxy.host").and_then(|v| v.as_str().map(|s| s.to_string())).unwrap_or_default(),
        crate::app_config::get_config(app, "network.proxy.port").and_then(|v| v.as_i64()).unwrap_or(0),
        crate::app_config::get_config(app, "network.proxy.username").and_then(|v| v.as_str().map(|s| s.to_string())).unwrap_or_default(),
        crate::app_config::get_config(app, "network.proxy.password").and_then(|v| v.as_str().map(|s| s.to_string())).unwrap_or_default(),
    );

    let fingerprint = format!("{enabled}|{host}|{port}|{username}|{password}");
    let cell = CLIENT.get_or_init(|| Mutex::new(ClientHolder {
        fingerprint: String::new(),
        client: Client::new(),
    }));
    let mut guard = cell.lock().unwrap();
    if guard.fingerprint != fingerprint {
        let mut builder = Client::builder()
            .cookie_store(true)
            // 对齐 Electron 版主进程 axios rejectUnauthorized:false
            .danger_accept_invalid_certs(true);
        if enabled && !host.is_empty() && port > 0 {
            let proxy_url = if !username.is_empty() {
                format!("http://{username}:{password}@{host}:{port}")
            } else {
                format!("http://{host}:{port}")
            };
            if let Ok(proxy) = reqwest::Proxy::all(&proxy_url) {
                builder = builder.proxy(proxy);
            }
        }
        if let Ok(client) = builder.build() {
            guard.fingerprint = fingerprint;
            guard.client = client;
        }
    }
    guard.client.clone()
}

fn decode_body(bytes: Vec<u8>, content_type: Option<&String>, want_binary: bool) -> (Option<String>, Option<String>) {
    if want_binary {
        let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
        return (None, Some(b64));
    }
    // charset 处理：默认 utf-8；常见 gb2312/gbk 情况按 utf-8 有损转换（插件多自带解码）
    let _ = content_type;
    (Some(String::from_utf8_lossy(&bytes).to_string()), None)
}

#[tauri::command]
pub async fn plugin_http_request(
    app: AppHandle,
    config: HttpRequestConfig,
    response_binary: Option<bool>,
) -> Result<HttpResponseResult, String> {
    let want_binary = response_binary.unwrap_or(false);
    let client = get_client(&app);

    let method = config
        .method
        .as_deref()
        .and_then(|m| Method::from_bytes(m.to_uppercase().as_bytes()).ok())
        .unwrap_or(Method::GET);

    let mut req = client.request(method, &config.url);
    if let Some(timeout) = config.timeout_ms {
        req = req.timeout(std::time::Duration::from_millis(timeout.min(600_000)));
    }
    if let Some(headers) = &config.headers {
        for (k, v) in headers {
            req = req.header(k.as_str(), v.as_str());
        }
    }
    if let Some(data) = &config.data {
        req = req.body(data.clone());
    }

    let resp = req.send().await.map_err(|e| e.to_string())?;
    let status = resp.status().as_u16();
    let mut resp_headers: HashMap<String, String> = HashMap::new();
    let mut content_type: Option<String> = None;
    for (name, value) in resp.headers().iter() {
        let key = name.as_str().to_lowercase();
        let val = value.to_str().unwrap_or("").to_string();
        if key == "content-type" {
            content_type = Some(val.clone());
        }
        resp_headers.insert(key, val);
    }
    // set-cookie 镜像收集（供 @react-native-cookies polyfill 查询）
    for cookie_header in resp.headers().get_all(reqwest::header::SET_COOKIE) {
        if let Ok(raw) = cookie_header.to_str() {
            if let Some((name_value, _rest)) = raw.split_once(';') {
                if let Some((cname, cvalue)) = name_value.split_once('=') {
                    let cell = COOKIE_MIRROR.get_or_init(|| Mutex::new(Vec::new()));
                    if let Ok(mut jar) = cell.lock() {
                        jar.retain(|c| !(c.url == config.url && c.name == cname.trim()));
                        jar.push(MirrorCookie {
                            url: config.url.clone(),
                            name: cname.trim().to_string(),
                            value: cvalue.trim().to_string(),
                        });
                    }
                }
            }
        }
    }
    let body = resp.bytes().await.map_err(|e| e.to_string())?.to_vec();
    let (body_text, body_base64) = decode_body(body, content_type.as_ref(), want_binary);
    // set-cookie 的 jar 收集由 reqwest cookie store 自动完成（headers 中同时透出）

    Ok(HttpResponseResult {
        status,
        headers: resp_headers,
        body_text,
        body_base64,
    })
}

/// @react-native-cookies/cookies polyfill 的 Rust 侧：读取 jar 中 cookie
/// 简化实现：返回当前已收集的 set-cookie（无法直接枚举 reqwest jar，改为维护镜像）
#[tauri::command]
pub fn plugin_cookie_get(_url: String) -> Vec<HashMap<String, String>> {
    // reqwest 的 cookie store 不支持枚举；镜像记录见 plugin_cookie_set
    COOKIE_MIRROR
        .get_or_init(|| Mutex::new(Vec::new()))
        .lock()
        .map(|jar| {
            jar.iter()
                .filter(|c| c.url == _url || _url.starts_with(&c.url))
                .map(|c| {
                    let mut m = HashMap::new();
                    m.insert("name".into(), c.name.clone());
                    m.insert("value".into(), c.value.clone());
                    m
                })
                .collect()
        })
        .unwrap_or_default()
}

#[derive(Clone)]
struct MirrorCookie {
    url: String,
    name: String,
    value: String,
}

static COOKIE_MIRROR: std::sync::OnceLock<Mutex<Vec<MirrorCookie>>> = std::sync::OnceLock::new();

#[tauri::command]
pub fn plugin_cookie_set(url: String, name: String, value: String) {
    let cell = COOKIE_MIRROR.get_or_init(|| Mutex::new(Vec::new()));
    if let Ok(mut jar) = cell.lock() {
        jar.retain(|c| !(c.url == url && c.name == name));
        jar.push(MirrorCookie { url, name, value });
    }
}
