//! 本地 API 反向代理服务（OpenAI 兼容接口）。
//!
//! 功能对齐 antigravity-tools 的 proxy_server：
//! - 上游 Key 池（从账号库导入，access_token 即上游凭据）
//! - 子 API Key 管理与鉴权（本地模式支持透传，开放模式强制子 Key）
//! - 请求路由：专一 / 临期优先 / 轮询 / 会话亲和四种调用模式
//! - SSE 流式转发（强制上游 stream + include_usage，usage 透传并统计）
//! - 故障转移：429 冷却 / 额度耗尽 / 403 风控标记，最多尝试 3 个 Key
//! - 请求日志与每日统计，JSON 文件持久化（`~/.wb-switch/proxy_db.json`）

use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::body::Body;
use axum::extract::{DefaultBodyLimit, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, get, post};
use axum::Router;
use futures_util::StreamExt;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::modules::account;
use crate::modules::config::{atomic_write, store_dir};

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/// 默认上游 API base（OpenAI 兼容）。
pub const DEFAULT_UPSTREAM: &str = "https://copilot.tencent.com/v2";
const UPSTREAM_CHAT_PATH: &str = "/chat/completions";

/// 请求体上限 50MB（超长上下文 + 图片场景）。
const MAX_BODY_BYTES: usize = 50 * 1024 * 1024;
/// 请求日志环形保留条数。
const REQUEST_LOG_KEEP: usize = 1000;
/// 单请求最多尝试的不同上游 Key 数。
const MAX_RETRIES: usize = 3;
/// 首字节超时：上游 10 秒不出首 chunk 视为可重试失败。
const FIRST_BYTE_TIMEOUT: Duration = Duration::from_secs(10);
/// 积分自动查询限频：同一 Key 5 分钟内最多查一次。
const POINTS_QUERY_INTERVAL_SECS: u64 = 300;

/// 支持的模型列表（与上游实测可用集合保持一致）。
pub const SUPPORTED_MODELS: &[&str] = &[
    "auto",
    "deepseek-v4-pro",
    "deepseek-v4.1-flash",
    "deepseek-v4-flash",
    "deepseek-v3-2-volc",
    "deepseek-v3-0324",
    "deepseek-r1",
    "glm-5.3",
    "glm-5.3-flash",
    "glm-5.2",
    "glm-5.1",
    "glm-5.0-turbo",
    "glm-5v-turbo",
    "minimax-m3",
    "minimax-m2.7",
    "kimi-k3",
    "kimi-k2.6",
    "kimi-k2.5",
    "hy4-preview",
    "hy3-preview",
    "hunyuan-chat",
    "hunyuan-2.0-thinking",
];

/// 模型上下文长度（maxInputTokens），供客户端判断何时压缩上下文。
fn model_context_length(model: &str) -> u64 {
    match model {
        "auto" => 168000,
        "deepseek-v4-pro" | "deepseek-v4.1-flash" | "deepseek-v4-flash" => 1_000_000,
        "deepseek-v3-2-volc" | "deepseek-v3-0324" | "deepseek-r1" => 128000,
        "glm-5.3" | "glm-5.3-flash" | "glm-5.2" => 1_000_000,
        "glm-5.1" | "glm-5.0-turbo" | "glm-5v-turbo" => 200000,
        "minimax-m3" => 1_000_000,
        "minimax-m2.7" => 200000,
        "kimi-k3" | "kimi-k2.6" => 256000,
        "kimi-k2.5" => 1_000_000,
        "hy4-preview" | "hy3-preview" | "hunyuan-chat" | "hunyuan-2.0-thinking" => 256000,
        _ => 128000,
    }
}

// ---------------------------------------------------------------------------
// 数据存储（proxy_db.json）
// ---------------------------------------------------------------------------

fn proxy_db_file() -> std::path::PathBuf {
    store_dir().join("proxy_db.json")
}

fn default_db() -> Value {
    json!({
        "upstream_keys": [],
        "sub_api_keys": [],
        "request_logs": [],
        "daily_stats": {},
        "settings": {
            "port": 8002,
            "mode": "local",
            "upstream_proxy": "",
            "auto_start": false,
        }
    })
}

struct ProxyDb {
    data: Value,
    /// 已加载 / 已写文件的修改时间。桌面 App 与 webui server 可能同时运行，
    /// 两边都整文件写回 proxy_db.json；写前发现 mtime 变化就先从磁盘重载，
    /// 避免互相覆盖对方累计的 Token / 积分统计。
    loaded_mtime: Option<SystemTime>,
}

static DB: OnceLock<Mutex<ProxyDb>> = OnceLock::new();

fn db_mtime() -> Option<SystemTime> {
    std::fs::metadata(proxy_db_file())
        .ok()
        .and_then(|meta| meta.modified().ok())
}

fn db() -> &'static Mutex<ProxyDb> {
    DB.get_or_init(|| {
        let data = std::fs::read_to_string(proxy_db_file())
            .ok()
            .and_then(|text| serde_json::from_str::<Value>(&text).ok())
            .map(merge_db_defaults)
            .unwrap_or_else(default_db);
        Mutex::new(ProxyDb {
            data,
            loaded_mtime: db_mtime(),
        })
    })
}

fn lock_db() -> MutexGuard<'static, ProxyDb> {
    let mut guard = db().lock().unwrap();
    guard.reload_if_changed();
    guard
}

/// 旧版数据补齐缺失的顶层字段（settings 逐项合并）。
fn merge_db_defaults(mut data: Value) -> Value {
    let defaults = default_db();
    let obj = data.as_object_mut();
    let Some(obj) = obj else {
        return defaults;
    };
    for (key, value) in defaults.as_object().unwrap() {
        if key == "settings" {
            let settings = obj.entry("settings").or_insert_with(|| json!({}));
            if let (Some(target), Some(source)) = (settings.as_object_mut(), value.as_object()) {
                for (k, v) in source {
                    target.entry(k.clone()).or_insert_with(|| v.clone());
                }
            }
        } else {
            obj.entry(key.clone()).or_insert_with(|| value.clone());
        }
    }
    data
}

impl ProxyDb {
    /// 文件被其他进程改过时（mtime 变化）先从磁盘重载，再叠加本进程的修改。
    fn reload_if_changed(&mut self) {
        let mtime = db_mtime();
        if mtime.is_some() && mtime != self.loaded_mtime {
            if let Ok(text) = std::fs::read_to_string(proxy_db_file()) {
                if let Ok(data) = serde_json::from_str::<Value>(&text) {
                    self.data = merge_db_defaults(data);
                }
            }
            self.loaded_mtime = mtime;
        }
    }

    fn save(&mut self) {
        if let Some(parent) = proxy_db_file().parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let content = serde_json::to_string_pretty(&self.data).unwrap_or_default();
        let _ = atomic_write(&proxy_db_file(), &content);
        // 记录自己写出的文件版本，避免下次锁内把自身写入误判为外部变更。
        self.loaded_mtime = db_mtime();
    }
}

fn now_secs() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0)
}

fn today_str() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}

fn now_iso() -> String {
    chrono::Local::now().to_rfc3339()
}

// ---------------------------------------------------------------------------
// 上游 Key / 子 Key / 日志 / 统计的读写
// ---------------------------------------------------------------------------

pub fn list_upstream_keys() -> Vec<Value> {
    lock_db()
        .data
        .get("upstream_keys")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

pub fn list_sub_keys() -> Vec<Value> {
    lock_db()
        .data
        .get("sub_api_keys")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

pub fn add_upstream_key(key: Value) {
    let mut db = lock_db();
    db.data
        .as_object_mut()
        .unwrap()
        .entry("upstream_keys")
        .or_insert_with(|| json!([]))
        .as_array_mut()
        .unwrap()
        .push(key);
    db.save();
}

pub fn update_upstream_key(key_id: &str, updates: &Value) {
    let mut db = lock_db();
    update_key_in(db.data.pointer_mut("/upstream_keys"), key_id, updates);
    db.save();
}

pub fn delete_upstream_key(key_id: &str) {
    let mut db = lock_db();
    if let Some(keys) = db
        .data
        .get_mut("upstream_keys")
        .and_then(Value::as_array_mut)
    {
        keys.retain(|k| k.get("key_id").and_then(Value::as_str) != Some(key_id));
    }
    db.save();
}

pub fn add_sub_key(key: Value) {
    let mut db = lock_db();
    db.data
        .as_object_mut()
        .unwrap()
        .entry("sub_api_keys")
        .or_insert_with(|| json!([]))
        .as_array_mut()
        .unwrap()
        .push(key);
    db.save();
}

pub fn update_sub_key(key_id: &str, updates: &Value) {
    let mut db = lock_db();
    update_key_in(db.data.pointer_mut("/sub_api_keys"), key_id, updates);
    db.save();
}

pub fn delete_sub_key(key_id: &str) {
    let mut db = lock_db();
    if let Some(keys) = db
        .data
        .get_mut("sub_api_keys")
        .and_then(Value::as_array_mut)
    {
        keys.retain(|k| k.get("key_id").and_then(Value::as_str) != Some(key_id));
    }
    db.save();
}

fn update_key_in(keys: Option<&mut Value>, key_id: &str, updates: &Value) {
    let Some(keys) = keys.and_then(Value::as_array_mut) else {
        return;
    };
    for key in keys.iter_mut() {
        if key.get("key_id").and_then(Value::as_str) != Some(key_id) {
            continue;
        }
        if let (Some(target), Some(source)) = (key.as_object_mut(), updates.as_object()) {
            for (k, v) in source {
                target.insert(k.clone(), v.clone());
            }
        }
        return;
    }
}

pub fn get_settings() -> Value {
    lock_db().data.get("settings").cloned().unwrap_or(json!({}))
}

pub fn save_settings(updates: &Value) {
    let mut db = lock_db();
    let settings = db
        .data
        .as_object_mut()
        .unwrap()
        .entry("settings")
        .or_insert_with(|| json!({}));
    if let (Some(target), Some(source)) = (settings.as_object_mut(), updates.as_object()) {
        for (k, v) in source {
            target.insert(k.clone(), v.clone());
        }
    }
    db.save();
}

pub fn request_logs(since: f64, limit: usize) -> Vec<Value> {
    let logs = lock_db()
        .data
        .get("request_logs")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let filtered: Vec<Value> = if since > 0.0 {
        logs.into_iter()
            .filter(|l| l.get("timestamp").and_then(Value::as_f64).unwrap_or(0.0) > since)
            .collect()
    } else {
        logs
    };
    filtered
        .into_iter()
        .rev()
        .take(limit)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect()
}

pub fn clear_request_logs() {
    let mut db = lock_db();
    db.data["request_logs"] = json!([]);
    db.save();
}

fn add_request_log(db: &mut ProxyDb, entry: Value) {
    let logs = db
        .data
        .as_object_mut()
        .unwrap()
        .entry("request_logs")
        .or_insert_with(|| json!([]))
        .as_array_mut()
        .unwrap();
    logs.push(entry);
    if logs.len() > REQUEST_LOG_KEEP {
        let overflow = logs.len() - REQUEST_LOG_KEEP;
        logs.drain(..overflow);
    }
}

fn add_request_log_entry(entry: Value) {
    let mut db = lock_db();
    add_request_log(&mut db, entry);
    db.save();
}

pub fn daily_stats(category: &str, key_id: &str) -> Value {
    lock_db()
        .data
        .pointer(&format!("/daily_stats/{category}/{key_id}"))
        .cloned()
        .unwrap_or(json!({}))
}

/// 代理消耗总览：累计 + 今日的 Token / 积分 / 调用数（上游 Key 池口径）。
pub fn proxy_overview() -> Value {
    let upstream = list_upstream_keys();
    let today = today_str();
    let db = lock_db();
    let today_field = |key_id: &str, field: &str| -> f64 {
        db.data
            .pointer(&format!("/daily_stats/upstream/{key_id}/{today}/{field}"))
            .and_then(Value::as_f64)
            .unwrap_or(0.0)
    };
    let mut today_requests = 0.0;
    let mut today_tokens = 0.0;
    let mut today_credits = 0.0;
    let mut total_requests = 0.0;
    let mut total_prompt = 0.0;
    let mut total_completion = 0.0;
    let mut total_tokens = 0.0;
    let mut total_cached = 0.0;
    let mut total_credits = 0.0;
    for key in &upstream {
        let key_id = key
            .get("key_id")
            .and_then(Value::as_str)
            .unwrap_or_default();
        today_requests += today_field(key_id, "count");
        today_tokens += today_field(key_id, "total_tokens");
        today_credits += today_field(key_id, "credits");
        total_requests += key.get("used_count").and_then(Value::as_f64).unwrap_or(0.0);
        total_prompt += key
            .get("total_prompt_tokens")
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
        total_completion += key
            .get("total_completion_tokens")
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
        total_tokens += key
            .get("total_tokens")
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
        total_cached += key
            .get("total_cached_tokens")
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
        total_credits += key
            .get("total_credits")
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
    }
    json!({
        "total": {
            "requests": total_requests,
            "prompt_tokens": total_prompt,
            "completion_tokens": total_completion,
            "tokens": total_tokens,
            "cached_tokens": total_cached,
            "credits": total_credits,
        },
        "today": {
            "requests": today_requests,
            "tokens": today_tokens,
            "credits": today_credits,
        },
    })
}

/// 一次请求结束的完整入账（上游 Key + 子 Key + 每日统计 + 日志），一次锁一次写盘。
#[allow(clippy::too_many_arguments)]
fn record_request_end(
    upstream_key_id: &str,
    sub_key_id: &str,
    sub_key_label: &str,
    upstream_label: &str,
    model: &str,
    usage: &Value,
    duration_ms: u64,
    first_token_ms: u64,
) {
    let prompt = usage
        .get("prompt_tokens")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let completion = usage
        .get("completion_tokens")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let total = usage
        .get("total_tokens")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let cached = usage
        .get("cached_tokens")
        .and_then(Value::as_u64)
        .or_else(|| usage.get("prompt_cache_hit_tokens").and_then(Value::as_u64))
        .unwrap_or(0);
    let credit = usage.get("credit").and_then(Value::as_f64).unwrap_or(0.0);

    let mut db = lock_db();
    let today = today_str();
    let mut bump = |keys_path: &str, category: &str, key_id: &str| {
        if key_id.is_empty() {
            return;
        }
        if let Some(keys) = db.data.pointer_mut(keys_path).and_then(Value::as_array_mut) {
            for key in keys.iter_mut() {
                if key.get("key_id").and_then(Value::as_str) != Some(key_id) {
                    continue;
                }
                inc_u64(key, "used_count", 1);
                key["last_used_at"] = json!(now_iso());
                inc_u64(key, "total_prompt_tokens", prompt);
                inc_u64(key, "total_completion_tokens", completion);
                inc_u64(key, "total_tokens", total);
                inc_u64(key, "total_cached_tokens", cached);
                if credit > 0.0 {
                    let current = key
                        .get("total_credits")
                        .and_then(Value::as_f64)
                        .unwrap_or(0.0);
                    key["total_credits"] = json!((current + credit * 10000.0).round() / 10000.0);
                }
                break;
            }
        }
        // 每日统计（取不到则逐级创建后递增）。
        let day = db
            .data
            .as_object_mut()
            .unwrap()
            .entry("daily_stats")
            .or_insert_with(|| json!({}))
            .as_object_mut()
            .unwrap()
            .entry(category.to_string())
            .or_insert_with(|| json!({}))
            .as_object_mut()
            .unwrap()
            .entry(key_id.to_string())
            .or_insert_with(|| json!({}))
            .as_object_mut()
            .unwrap()
            .entry(today.clone())
            .or_insert_with(|| {
                json!({
                    "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0,
                    "cached_tokens": 0, "credits": 0.0, "count": 0
                })
            });
        if let Some(day) = day.as_object_mut() {
            inc_map_u64(day, "prompt_tokens", prompt);
            inc_map_u64(day, "completion_tokens", completion);
            inc_map_u64(day, "total_tokens", total);
            inc_map_u64(day, "cached_tokens", cached);
            if credit > 0.0 {
                let current = day.get("credits").and_then(Value::as_f64).unwrap_or(0.0);
                day.insert(
                    "credits".to_string(),
                    json!((current + credit * 10000.0).round() / 10000.0),
                );
            }
            inc_map_u64(day, "count", 1);
        }
    };
    bump("/upstream_keys", "upstream", upstream_key_id);
    // 透传模式没有真实子 Key，跳过子 Key 统计。
    if sub_key_id != "_passthrough_" {
        bump("/sub_api_keys", "sub", sub_key_id);
    }

    add_request_log(
        &mut db,
        json!({
            "timestamp": now_secs(),
            "sub_key_id": sub_key_id,
            "sub_key_label": sub_key_label,
            "main_key_id": upstream_key_id,
            "main_key_label": upstream_label,
            "model": model,
            "event": "end",
            "duration_ms": duration_ms,
            "prompt_tokens": prompt,
            "completion_tokens": completion,
            "first_token_ms": first_token_ms,
        }),
    );
    db.save();
}

fn inc_u64(value: &mut Value, key: &str, delta: u64) {
    if delta == 0 {
        return;
    }
    let current = value.get(key).and_then(Value::as_u64).unwrap_or(0);
    value[key] = json!(current + delta);
}

fn inc_map_u64(map: &mut serde_json::Map<String, Value>, key: &str, delta: u64) {
    if delta == 0 {
        return;
    }
    let current = map.get(key).and_then(Value::as_u64).unwrap_or(0);
    map.insert(key.to_string(), json!(current + delta));
}

/// 积分查询结果同步到上游 Key（智能禁用 / 恢复）。
///
/// 规则：积分归 0 → disabled；积分 > 100 且处于 disabled/exhausted/cooldown/
/// rate_limited → 恢复 active；accounts 为空（上游异常）时不做任何状态变更，
/// 避免把全部 Key 误禁用。
pub fn sync_quota_to_key(api_key: &str, remaining: f64, total: f64, packages: Option<&Value>) {
    let mut db = lock_db();
    let Some(keys) = db
        .data
        .get_mut("upstream_keys")
        .and_then(Value::as_array_mut)
    else {
        return;
    };
    for key in keys.iter_mut() {
        let matched = key.get("api_key").and_then(Value::as_str) == Some(api_key)
            || key.get("label").and_then(Value::as_str) == Some(api_key);
        if !matched {
            continue;
        }
        key["points"] = json!(format!("{remaining:.0}/{total:.0}"));
        key["points_updated_at"] = json!(now_iso());
        if let Some(packages) = packages.and_then(Value::as_array) {
            let summaries: Vec<Value> = packages
                .iter()
                .map(|pkg| {
                    json!({
                        "cycle_remain": pkg.get("cycle_remain").cloned().unwrap_or(json!(0)),
                        "cycle_end": pkg.get("cycle_end").cloned().unwrap_or(json!("")),
                        "package_name": pkg.get("package_name").cloned().unwrap_or(json!("")),
                        "package_type": pkg.get("package_type").cloned().unwrap_or(json!("")),
                    })
                })
                .collect();
            key["packages"] = json!(summaries);
        }
        let status = key
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("active")
            .to_string();
        if remaining <= 0.0 {
            if matches!(
                status.as_str(),
                "active" | "cooldown" | "rate_limited" | "exhausted"
            ) {
                key["status"] = json!("disabled");
            }
        } else if remaining > 100.0
            && matches!(
                status.as_str(),
                "disabled" | "exhausted" | "cooldown" | "rate_limited"
            )
        {
            key["status"] = json!("active");
        }
        break;
    }
    db.save();
}

// ---------------------------------------------------------------------------
// 从账号库导入上游 Key
// ---------------------------------------------------------------------------

/// 可供导入的账号（持有明文 access_token；加密信封态无法用作上游凭据）。
pub fn importable_accounts() -> Vec<Value> {
    account::load_accounts()
        .iter()
        .filter(|acc| {
            account::get_str(acc, "access_token").is_some()
                && !account::is_envelope(acc, "access_token")
        })
        .map(|acc| {
            json!({
                "id": account::display_value(acc, "id"),
                "uid": account::display_value(acc, "uid"),
                "name": account::account_display_name(acc),
                "variant": account::variant_of(acc).as_str(),
            })
        })
        .collect()
}

/// 把选中账号导入上游 Key 池（按 access_token 去重）。返回新导入数量。
pub fn import_accounts_as_keys(account_ids: &[String]) -> usize {
    let accounts = account::load_accounts();
    let existing: HashSet<String> = list_upstream_keys()
        .iter()
        .filter_map(|k| k.get("api_key").and_then(Value::as_str).map(str::to_string))
        .collect();
    let mut imported = 0;
    for acc in &accounts {
        let id = account::get_str(acc, "id").unwrap_or_default();
        if !account_ids.iter().any(|want| want == &id) {
            continue;
        }
        let Some(token) = account::get_str(acc, "access_token") else {
            continue;
        };
        if account::is_envelope(acc, "access_token") || existing.contains(&token) {
            continue;
        }
        add_upstream_key(json!({
            "key_id": format!("ck_{}", &uuid::Uuid::new_v4().simple().to_string()[..8]),
            "api_key": token,
            "label": account::account_display_name(acc),
            "account_id": id,
            "status": "active",
            "used_count": 0,
            "points": "",
            "points_updated_at": "",
            "packages": [],
            "created_at": now_iso(),
            "last_used_at": "",
            "total_prompt_tokens": 0,
            "total_completion_tokens": 0,
            "total_tokens": 0,
            "total_cached_tokens": 0,
            "total_credits": 0.0,
        }));
        imported += 1;
    }
    imported
}

// ---------------------------------------------------------------------------
// 积分查询与风控检测（批量，供管理接口调用）
// ---------------------------------------------------------------------------

static PROXY_HTTP: OnceLock<reqwest::Client> = OnceLock::new();

/// 代理转发专用 client：不读系统代理（避免 Clash 等回环），连接超时 10 秒，
/// 不设置整体超时（流式响应时长不可预估）。
fn proxy_http() -> &'static reqwest::Client {
    PROXY_HTTP.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .build()
            .expect("failed to build proxy reqwest client")
    })
}

/// 找到上游 Key 对应的账号库账号（account_id 优先，api_key 匹配兜底）。
fn account_for_key(key: &Value) -> Option<Value> {
    let accounts = account::load_accounts();
    if let Some(id) = key.get("account_id").and_then(Value::as_str) {
        if let Some(acc) = accounts
            .iter()
            .find(|a| account::get_str(a, "id").as_deref() == Some(id))
        {
            return Some(acc.clone());
        }
    }
    let api_key = key
        .get("api_key")
        .and_then(Value::as_str)
        .unwrap_or_default();
    accounts
        .into_iter()
        .find(|a| account::get_str(a, "access_token").as_deref() == Some(api_key))
}

/// 查询上游 Key 的积分（复用 credits 官方链路：正确端点/请求头/档位与 token 刷新）。
///
/// 失败返回 None（上游异常不算 0 分，不触发禁用），调用方按失败计数。
async fn query_key_points(key: &Value) -> Option<(f64, f64, Value)> {
    let account = account_for_key(key)?;
    let result = crate::modules::credits::get_credit_expiry(&account).await;
    if result.get("ok").and_then(Value::as_bool) != Some(true) {
        return None;
    }
    let remaining = result.get("totalRemaining").and_then(Value::as_f64)?;
    let total = result
        .get("totalCapacity")
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    let packages: Vec<Value> = result
        .get("resources")
        .and_then(Value::as_array)
        .map(|resources| {
            resources
                .iter()
                .map(|r| {
                    json!({
                        "cycle_remain": r.get("remaining").and_then(Value::as_f64).unwrap_or(0.0),
                        // expireAt 为毫秒时间戳，转秒供临期优先排序解析。
                        "cycle_end": r.get("expireAt").and_then(Value::as_i64)
                            .map(|ms| (ms / 1000).to_string()).unwrap_or_default(),
                        "package_name": r.get("packageName").cloned().unwrap_or(json!("")),
                        "package_type": r.get("packageCode").cloned().unwrap_or(json!("")),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    if packages.is_empty() {
        return None;
    }
    Some((remaining, total, json!(packages)))
}

/// 批量刷新所有上游 Key 积分。返回 {success, failed}。
pub async fn refresh_all_key_points() -> Value {
    let keys = list_upstream_keys();
    let mut success = 0;
    let mut failed = 0;
    for key in keys {
        let api_key = key
            .get("api_key")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        if api_key.is_empty() {
            continue;
        }
        match query_key_points(&key).await {
            Some((remaining, total, packages)) => {
                sync_quota_to_key(&api_key, remaining, total, Some(&packages));
                success += 1;
            }
            None => failed += 1,
        }
    }
    json!({"success": success, "failed": failed})
}

/// 批量检测上游 Key 风控状态（最轻量 chat 请求）。返回 {normal, abnormal, failed}。
pub async fn check_all_key_status() -> Value {
    let keys: Vec<Value> = list_upstream_keys()
        .into_iter()
        .filter(|k| {
            matches!(
                k.get("status").and_then(Value::as_str),
                Some("active" | "cooldown" | "rate_limited")
            ) && k.get("api_key").and_then(Value::as_str).is_some()
        })
        .collect();
    let mut normal = 0;
    let mut abnormal = 0;
    let mut failed = 0;
    for key in keys {
        let api_key = key
            .get("api_key")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let key_id = key
            .get("key_id")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let upstream = upstream_url();
        let result = proxy_http()
            .post(format!("{upstream}{UPSTREAM_CHAT_PATH}"))
            .header("Content-Type", "application/json")
            .header("Authorization", format!("Bearer {api_key}"))
            .json(&json!({
                "model": "auto",
                "stream": true,
                "stream_options": {"include_usage": true},
                "messages": [
                    {"role": "system", "content": "You are a helpful assistant."},
                    {"role": "user", "content": "hi"}
                ]
            }))
            .timeout(Duration::from_secs(30))
            .send()
            .await;
        match result {
            Ok(resp) => {
                let status = resp.status().as_u16();
                let body = resp.text().await.unwrap_or_default();
                if status == 200 || status == 429 {
                    normal += 1;
                } else if status == 403 && body.contains("\"code\":11140") {
                    update_upstream_key(key_id, &json!({"status": "abnormal"}));
                    abnormal += 1;
                } else {
                    failed += 1;
                }
            }
            Err(_) => failed += 1,
        }
    }
    json!({"normal": normal, "abnormal": abnormal, "failed": failed})
}

/// 请求完成后限频查分（5 分钟一次），异步执行不阻塞转发。
fn maybe_refresh_key_points(runtime: &RuntimeState, upstream_key: &Value) {
    let key_id = upstream_key
        .get("key_id")
        .and_then(Value::as_str)
        .unwrap_or_default();
    {
        let mut stamps = runtime.points_query_stamps.lock().unwrap();
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let last = stamps.get(key_id).copied().unwrap_or(0);
        if now.saturating_sub(last) < POINTS_QUERY_INTERVAL_SECS {
            return;
        }
        stamps.insert(key_id.to_string(), now);
    }
    let key = upstream_key.clone();
    let api_key = upstream_key
        .get("api_key")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    tokio::spawn(async move {
        if let Some((remaining, total, packages)) = query_key_points(&key).await {
            sync_quota_to_key(&api_key, remaining, total, Some(&packages));
        }
    });
}

// ---------------------------------------------------------------------------
// 路由运行时状态（内存）
// ---------------------------------------------------------------------------

#[derive(Default)]
struct RuntimeState {
    /// key_id → 当前并发请求数（负载感知排序）。
    concurrent: Mutex<HashMap<String, u64>>,
    /// pool_hash → 专一模式当前粘住的 key_id。
    dedicated: Mutex<HashMap<String, String>>,
    /// pool_hash → 轮询游标。
    round_robin: Mutex<HashMap<String, usize>>,
    /// session_hash → (key_id, expire_ts)，会话亲和绑定（TTL 1 小时）。
    sticky: Mutex<HashMap<String, (String, f64)>>,
    /// key_id → {model: expire_ts}，模型级冷却。
    model_cooldowns: Mutex<HashMap<String, HashMap<String, f64>>>,
    /// key_id → 渐进退避计数（成功后归零）。
    cooldown_counts: Mutex<HashMap<String, u32>>,
    /// key_id → 上次积分查询 epoch 秒（限频）。
    points_query_stamps: Mutex<HashMap<String, u64>>,
}

#[derive(Clone)]
struct ProxyState {
    /// "local"（透传兼容）或 "open"（强制子 Key 鉴权）。
    mode: std::sync::Arc<String>,
    runtime: std::sync::Arc<RuntimeState>,
}

fn concurrent_count(runtime: &RuntimeState, key_id: &str) -> u64 {
    runtime
        .concurrent
        .lock()
        .unwrap()
        .get(key_id)
        .copied()
        .unwrap_or(0)
}

fn upstream_url() -> String {
    let custom = get_settings()
        .get("upstream_proxy")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    if custom.is_empty() {
        DEFAULT_UPSTREAM.to_string()
    } else {
        custom.trim_end_matches('/').to_string()
    }
}

/// 会话标识：system + 第一条 user 消息的 SHA-256 前 16 位（会话亲和模式用）。
fn session_id_of(request: &Value) -> String {
    let mut system_content = String::new();
    let mut first_user = String::new();
    for message in request
        .get("messages")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
    {
        let role = message.get("role").and_then(Value::as_str).unwrap_or("");
        let content = match message.get("content") {
            Some(Value::String(s)) => s.clone(),
            Some(Value::Array(parts)) => parts
                .iter()
                .filter_map(|p| p.get("text").and_then(Value::as_str).map(str::to_string))
                .collect::<Vec<_>>()
                .join(" "),
            _ => String::new(),
        };
        if role == "system" && system_content.is_empty() {
            system_content = content;
        } else if role == "user" && first_user.is_empty() {
            first_user = content;
            break;
        }
    }
    let combined = format!("{system_content}{first_user}");
    if combined.is_empty() {
        return String::new();
    }
    let digest = Sha256::digest(combined.as_bytes());
    digest[..8].iter().map(|b| format!("{b:02x}")).collect()
}

fn key_in_model_cooldown(runtime: &RuntimeState, key_id: &str, model: &str) -> bool {
    let mut cooldowns = runtime.model_cooldowns.lock().unwrap();
    let Some(expire) = cooldowns
        .get(key_id)
        .and_then(|models| models.get(model))
        .copied()
    else {
        return false;
    };
    if now_secs() < expire {
        return true;
    }
    // 过期条目顺手清理。
    if let Some(models) = cooldowns.get_mut(key_id) {
        models.remove(model);
    }
    false
}

/// 标记模型级冷却，渐进退避 10→20→40→80 秒封顶。返回冷却秒数。
fn mark_model_cooldown(runtime: &RuntimeState, key_id: &str, model: &str) -> u64 {
    let count = {
        let mut counts = runtime.cooldown_counts.lock().unwrap();
        let count = counts.get(key_id).copied().unwrap_or(0) + 1;
        counts.insert(key_id.to_string(), count);
        count
    };
    let secs = (10u64 * 2u64.pow(count.saturating_sub(1))).min(80);
    runtime
        .model_cooldowns
        .lock()
        .unwrap()
        .entry(key_id.to_string())
        .or_default()
        .insert(model.to_string(), now_secs() + secs as f64);
    secs
}

fn reset_cooldown_count(runtime: &RuntimeState, key_id: &str) {
    runtime
        .cooldown_counts
        .lock()
        .unwrap()
        .insert(key_id.to_string(), 0);
}

/// 选择一个可用上游 Key。
///
/// key_mode：1 专一（粘住一个用到不可用）/ 2 临期优先 / 3 轮询 / 4 会话亲和。
fn select_key(
    runtime: &RuntimeState,
    model: &str,
    allowed_key_ids: &[String],
    exclude: &HashSet<String>,
    key_mode: u64,
    request: &Value,
) -> Option<Value> {
    let mut available: Vec<Value> = list_upstream_keys()
        .into_iter()
        .filter(|k| {
            if k.get("status").and_then(Value::as_str) != Some("active") {
                return false;
            }
            let key_id = k.get("key_id").and_then(Value::as_str).unwrap_or("");
            if !allowed_key_ids.is_empty() && !allowed_key_ids.iter().any(|id| id == key_id) {
                return false;
            }
            if exclude.contains(key_id) {
                return false;
            }
            model.is_empty() || !key_in_model_cooldown(runtime, key_id, model)
        })
        .collect();
    if available.is_empty() {
        return None;
    }

    let pool_hash = if allowed_key_ids.is_empty() {
        "global".to_string()
    } else {
        let mut ids = allowed_key_ids.to_vec();
        ids.sort();
        format!("{:x}", Sha256::digest(ids.join(",").as_bytes()))
    };

    match key_mode {
        2 => {
            // 临期优先：最快过期且仍有剩余的积分组所在 Key 优先；并发数为次级排序键。
            available.sort_by_key(|k| {
                (
                    earliest_expiring_ts(k),
                    concurrent_count(
                        runtime,
                        k.get("key_id").and_then(Value::as_str).unwrap_or(""),
                    ),
                )
            });
            available.into_iter().next()
        }
        3 => {
            available.sort_by_key(|k| {
                concurrent_count(
                    runtime,
                    k.get("key_id").and_then(Value::as_str).unwrap_or(""),
                )
            });
            let mut rr = runtime.round_robin.lock().unwrap();
            let idx = rr.get(&pool_hash).copied().unwrap_or(0) % available.len();
            rr.insert(pool_hash, idx + 1);
            available.into_iter().nth(idx)
        }
        4 => {
            let session_id = session_id_of(request);
            if !session_id.is_empty() {
                let binding = runtime.sticky.lock().unwrap().get(&session_id).cloned();
                if let Some((bound_id, expire)) = binding {
                    if now_secs() > expire {
                        runtime.sticky.lock().unwrap().remove(&session_id);
                    } else if let Some(key) = available
                        .iter()
                        .find(|k| k.get("key_id").and_then(Value::as_str) == Some(&bound_id))
                    {
                        return Some(key.clone());
                    } else {
                        runtime.sticky.lock().unwrap().remove(&session_id);
                    }
                }
            }
            available.sort_by_key(|k| {
                concurrent_count(
                    runtime,
                    k.get("key_id").and_then(Value::as_str).unwrap_or(""),
                )
            });
            let chosen = available.into_iter().next()?;
            if !session_id.is_empty() {
                let key_id = chosen
                    .get("key_id")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                runtime
                    .sticky
                    .lock()
                    .unwrap()
                    .insert(session_id, (key_id, now_secs() + 3600.0));
            }
            Some(chosen)
        }
        _ => {
            // 专一模式：上次用的 Key 仍可用就继续用，否则选并发最低的并记住。
            if let Some(dedicated_id) = runtime.dedicated.lock().unwrap().get(&pool_hash).cloned() {
                if let Some(key) = available
                    .iter()
                    .find(|k| k.get("key_id").and_then(Value::as_str) == Some(&dedicated_id))
                {
                    return Some(key.clone());
                }
            }
            available.sort_by_key(|k| {
                concurrent_count(
                    runtime,
                    k.get("key_id").and_then(Value::as_str).unwrap_or(""),
                )
            });
            let chosen = available.into_iter().next()?;
            let key_id = chosen
                .get("key_id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            runtime.dedicated.lock().unwrap().insert(pool_hash, key_id);
            Some(chosen)
        }
    }
}

/// 该 Key 最快过期且仍有剩余积分的积分组过期时间戳；无过期信息排最后。
fn earliest_expiring_ts(key: &Value) -> u64 {
    let mut earliest: Option<u64> = None;
    for pkg in key
        .get("packages")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
    {
        if pkg
            .get("cycle_remain")
            .and_then(Value::as_f64)
            .unwrap_or(0.0)
            <= 0.0
        {
            continue;
        }
        let end = pkg.get("cycle_end").cloned().unwrap_or(json!(""));
        let ts = match &end {
            Value::String(s) if s.contains('T') => chrono::DateTime::parse_from_rfc3339(s)
                .ok()
                .map(|dt| dt.timestamp().max(0) as u64),
            Value::String(s) => s.trim().parse::<f64>().ok().map(|v| v as u64),
            Value::Number(n) => n.as_f64().map(|v| v as u64),
            _ => None,
        };
        if let Some(ts) = ts {
            if earliest.is_none_or(|current| ts < current) {
                earliest = Some(ts);
            }
        }
    }
    earliest.unwrap_or(u64::MAX)
}

// ---------------------------------------------------------------------------
// 鉴权
// ---------------------------------------------------------------------------

fn authenticate(state: &ProxyState, headers: &HeaderMap) -> Option<Value> {
    let auth = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default();
    let token = auth.strip_prefix("Bearer ").unwrap_or("").trim();
    if token.is_empty() {
        return None;
    }
    if let Some(sub) = list_sub_keys().into_iter().find(|sk| {
        sk.get("api_key").and_then(Value::as_str) == Some(token)
            && sk.get("is_active").and_then(Value::as_bool).unwrap_or(true)
    }) {
        return Some(sub);
    }
    // 开放模式：不匹配子 Key 直接拒绝。
    if state.mode.as_str() == "open" {
        return None;
    }
    // 本地模式透传：WorkBuddy 客户端会带自己的 JWT，不配置子 Key 也能转发。
    let tail = &token[token.len().saturating_sub(6)..];
    Some(json!({
        "key_id": "_passthrough_",
        "api_key": token,
        "label": format!("透传(...{tail})"),
        "is_active": true,
        "allowed_models": [],
        "allowed_key_ids": [],
        "max_usage": 0,
        "used_count": 0,
        "rate_limit_rpm": 1000,
        "key_mode": 1,
    }))
}

// ---------------------------------------------------------------------------
// 错误分类（故障转移决策）
// ---------------------------------------------------------------------------

#[derive(PartialEq)]
enum Failover {
    /// 同 Key 重试一次（502/503/超时/连接错误）。
    RetrySame,
    /// 直接换 Key（401/403/429 等）。
    SwitchKey,
    /// 不重试，直接返回客户端（上下文超长 / 网关拦截）。
    Fatal,
}

fn classify_error(status: u16, body: &str) -> Failover {
    match status {
        0 => Failover::RetrySame,
        400 => {
            if body.trim().is_empty()
                || body.contains("input length too long")
                || body.contains("\"code\":11115")
            {
                Failover::Fatal
            } else {
                Failover::SwitchKey
            }
        }
        401 => {
            let lower = body.to_lowercase();
            if lower.contains("<html>") || lower.contains("<!doctype") {
                Failover::Fatal
            } else {
                Failover::SwitchKey
            }
        }
        502 | 503 => Failover::RetrySame,
        _ => Failover::SwitchKey,
    }
}

// ---------------------------------------------------------------------------
// axum handlers
// ---------------------------------------------------------------------------

pub fn proxy_router(mode: &str) -> Router {
    let state = ProxyState {
        mode: std::sync::Arc::new(mode.to_string()),
        runtime: std::sync::Arc::new(RuntimeState::default()),
    };
    Router::new()
        .route("/", get(index_handler))
        .route("/v1", get(index_handler))
        .route("/v1/", get(index_handler))
        .route("/v1/models", get(models_handler))
        .route("/v1/engines", get(engines_handler))
        .route(
            "/v1/chat/completions",
            post(chat_completions_handler).options(options_handler),
        )
        .fallback(any(not_found_handler))
        .layer(DefaultBodyLimit::max(MAX_BODY_BYTES))
        .with_state(state)
}

fn json_response(status: StatusCode, data: Value) -> Response {
    (
        status,
        [
            ("Content-Type", "application/json; charset=utf-8"),
            ("Access-Control-Allow-Origin", "*"),
        ],
        serde_json::to_string(&data).unwrap_or_default(),
    )
        .into_response()
}

async fn index_handler() -> Response {
    json_response(
        StatusCode::OK,
        json!({
            "object": "api.index",
            "message": "wb-switch API proxy is running",
            "version": env!("CARGO_PKG_VERSION"),
        }),
    )
}

async fn models_handler(State(state): State<ProxyState>, headers: HeaderMap) -> Response {
    let sub_key = authenticate(&state, &headers);
    if state.mode.as_str() == "open" && sub_key.is_none() {
        return json_response(
            StatusCode::UNAUTHORIZED,
            json!({"error": {"message": "Invalid API key", "type": "authentication_error"}}),
        );
    }
    let allowed: Vec<String> = sub_key
        .as_ref()
        .and_then(|sk| sk.get("allowed_models").and_then(Value::as_array))
        .map(|models| {
            models
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    let list: Vec<&str> = SUPPORTED_MODELS
        .iter()
        .copied()
        .filter(|m| allowed.is_empty() || allowed.iter().any(|a| a == m))
        .collect();
    let data: Vec<Value> = list
        .iter()
        .map(|m| {
            let ctx = model_context_length(m);
            json!({
                "id": m,
                "object": "model",
                "created": now_secs() as u64,
                "owned_by": "wb-switch-proxy",
                "maxInputTokens": ctx,
                "max_input_tokens": ctx,
                "context_length": ctx,
                "contextLength": ctx,
                "maxContextTokens": ctx,
                "context_window": ctx,
                "max_context_window": ctx,
            })
        })
        .collect();
    json_response(StatusCode::OK, json!({"object": "list", "data": data}))
}

async fn engines_handler() -> Response {
    json_response(StatusCode::OK, json!({"object": "list", "data": []}))
}

async fn not_found_handler() -> Response {
    // 404 而不是 401：避免客户端把未识别端点误判为认证失效触发重登录。
    json_response(
        StatusCode::NOT_FOUND,
        json!({"error": {"message": "Endpoint not found", "type": "not_found"}}),
    )
}

/// OPTIONS 预检：Electron/WebView 客户端会发 CORS 预检，缺了会被 501 卡死。
async fn options_handler() -> Response {
    Response::builder()
        .status(StatusCode::OK)
        .header("Access-Control-Allow-Origin", "*")
        .header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        .header(
            "Access-Control-Allow-Headers",
            "Authorization, Content-Type, Accept",
        )
        .header("Access-Control-Max-Age", "86400")
        .header("Content-Length", "0")
        .body(Body::empty())
        .unwrap()
}

struct UsageScan {
    /// 跨 chunk 残留的未解析文本（data 行可能被 TCP 分包截断）。
    tail: String,
    usage: Value,
}

impl UsageScan {
    fn new() -> Self {
        Self {
            tail: String::new(),
            usage: Value::Null,
        }
    }

    /// 扫描 SSE chunk，捕获最后一个带 prompt_tokens 的 usage 对象。
    /// 未完整的最后一行留在 tail，等后续 chunk 拼接（TCP 分包可能截断 data 行）。
    fn feed(&mut self, chunk: &str) {
        self.tail.push_str(chunk);
        while let Some(pos) = self.tail.find('\n') {
            let line: String = self.tail.drain(..=pos).collect();
            let Some(data) = line.trim().strip_prefix("data: ") else {
                continue;
            };
            if data == "[DONE]" || !data.contains("\"usage\"") {
                continue;
            }
            let Ok(chunk_json) = serde_json::from_str::<Value>(data) else {
                continue;
            };
            if let Some(usage) = chunk_json.get("usage") {
                if usage.get("prompt_tokens").and_then(Value::as_u64).is_some() {
                    self.usage = usage.clone();
                }
            }
        }
        if self.tail.len() > 65536 {
            self.tail.clear();
        }
    }
}

/// 扫描 chunk 文本检测错误（上下文超长 / 错误事件）。
fn detect_stream_error(text: &str) -> Option<&'static str> {
    let lower = text.to_lowercase();
    for keyword in [
        "context_length_exceeded",
        "input length too long",
        "context window",
        "maximum context length",
    ] {
        if lower.contains(keyword) {
            return Some("context_too_long");
        }
    }
    if text.contains("\"error\"") {
        return Some("stream_error");
    }
    None
}

const CONTEXT_TOO_LONG_MESSAGE: &str = "当前对话上下文过长，超出模型限制。请新开一个对话继续。";

async fn chat_completions_handler(
    State(state): State<ProxyState>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    let t0 = std::time::Instant::now();

    // 1. 鉴权。本地模式不返回 401/403（WorkBuddy 客户端收到 401 会触发重新登录），用 503。
    let Some(sub_key) = authenticate(&state, &headers) else {
        add_request_log_entry(json!({
            "timestamp": now_secs(),
            "event": "auth_fail",
            "error": "请求缺少或不匹配 Bearer token",
            "request_path": "/v1/chat/completions",
        }));
        if state.mode.as_str() == "open" {
            return json_response(
                StatusCode::UNAUTHORIZED,
                json!({"error": {"message": "Invalid API key", "type": "authentication_error"}}),
            );
        }
        return json_response(
            StatusCode::SERVICE_UNAVAILABLE,
            json!({"error": {"message": "Service temporarily unavailable", "type": "server_error"}}),
        );
    };

    let is_passthrough = sub_key.get("key_id").and_then(Value::as_str) == Some("_passthrough_");

    // 2. 子 Key 状态与用量上限（透传模式跳过）。
    if !is_passthrough {
        let max_usage = sub_key
            .get("max_usage")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let used = sub_key
            .get("used_count")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        if max_usage > 0 && used >= max_usage {
            return json_response(
                StatusCode::TOO_MANY_REQUESTS,
                json!({"error": {"message": "Usage limit exceeded", "type": "rate_limit"}}),
            );
        }
        // Token 上限（累计 total_tokens，0 = 不限）。
        let max_tokens = sub_key
            .get("max_tokens")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let used_tokens = sub_key
            .get("total_tokens")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        if max_tokens > 0 && used_tokens >= max_tokens {
            return json_response(
                StatusCode::TOO_MANY_REQUESTS,
                json!({"error": {"message": "Token limit exceeded", "type": "rate_limit"}}),
            );
        }
        // 积分上限（累计 total_credits，0 = 不限）。
        let max_credits = sub_key
            .get("max_credits")
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
        let used_credits = sub_key
            .get("total_credits")
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
        if max_credits > 0.0 && used_credits >= max_credits {
            return json_response(
                StatusCode::TOO_MANY_REQUESTS,
                json!({"error": {"message": "Credit limit exceeded", "type": "rate_limit"}}),
            );
        }
    }

    // 3. 解析请求体。
    let Ok(mut request) = serde_json::from_slice::<Value>(&body) else {
        return json_response(
            StatusCode::BAD_REQUEST,
            json!({"error": {"message": "Invalid request body", "type": "invalid_request"}}),
        );
    };
    let mut model = request
        .get("model")
        .and_then(Value::as_str)
        .unwrap_or("auto")
        .to_string();
    if model.is_empty() {
        model = "auto".to_string();
    }

    // 上游要求至少 2 条 message，不足时补 system 消息。
    let message_count = request
        .get("messages")
        .and_then(Value::as_array)
        .map(|m| m.len())
        .unwrap_or(0);
    if message_count < 2 {
        let messages = request
            .as_object_mut()
            .unwrap()
            .entry("messages")
            .or_insert_with(|| json!([]));
        messages.as_array_mut().unwrap().insert(
            0,
            json!({"role": "system", "content": "You are a helpful assistant."}),
        );
    }

    // 4. 模型白名单（透传模式跳过）。
    if !is_passthrough {
        let allowed: Vec<String> = sub_key
            .get("allowed_models")
            .and_then(Value::as_array)
            .map(|models| {
                models
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();
        if !allowed.is_empty() && !allowed.iter().any(|m| m == &model) {
            return json_response(
                StatusCode::SERVICE_UNAVAILABLE,
                json!({"error": {"message": format!("Model {model} not available"), "type": "server_error"}}),
            );
        }
    }

    let client_wants_stream = request
        .get("stream")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    // 上游只支持流式：强制 stream + include_usage（最后一个 chunk 带 token/credit 统计）。
    request["stream"] = json!(true);
    request
        .as_object_mut()
        .unwrap()
        .entry("stream_options")
        .or_insert_with(|| json!({}))["include_usage"] = json!(true);

    let allowed_key_ids: Vec<String> = sub_key
        .get("allowed_key_ids")
        .and_then(Value::as_array)
        .map(|ids| {
            ids.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    let key_mode = sub_key.get("key_mode").and_then(Value::as_u64).unwrap_or(1);
    let upstream = upstream_url();
    let target_url = format!("{upstream}{UPSTREAM_CHAT_PATH}");

    let mut tried: HashSet<String> = HashSet::new();
    let mut same_key_retried: HashSet<String> = HashSet::new();
    let mut last_error = String::new();
    let mut last_status = StatusCode::SERVICE_UNAVAILABLE;
    let mut last_cooldown_secs = 0u64;

    for _attempt in 0..MAX_RETRIES {
        let Some(upstream_key) = select_key(
            &state.runtime,
            &model,
            &allowed_key_ids,
            &tried,
            key_mode,
            &request,
        ) else {
            break;
        };
        let key_id = upstream_key
            .get("key_id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let key_label = upstream_key
            .get("label")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let api_key = upstream_key
            .get("api_key")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();

        state
            .runtime
            .concurrent
            .lock()
            .unwrap()
            .entry(key_id.clone())
            .and_modify(|n| *n += 1)
            .or_insert(1);

        let send_result = proxy_http()
            .post(&target_url)
            .header("Content-Type", "application/json")
            .header("Authorization", format!("Bearer {api_key}"))
            .header("X-Request-ID", uuid::Uuid::new_v4().simple().to_string())
            .json(&request)
            .timeout(Duration::from_secs(120))
            .send()
            .await;

        let resp = match send_result {
            Ok(resp) => resp,
            Err(error) => {
                dec_concurrent(&state.runtime, &key_id);
                add_request_log_entry(log_entry(
                    &sub_key,
                    Some(&upstream_key),
                    &model,
                    "error",
                    &format!("转发异常: {error}"),
                    0,
                ));
                if same_key_retried.insert(key_id.clone()) {
                    // 超时/连接错误：同 Key 重试一次。
                    last_error = format!("Proxy error: {error}");
                    last_status = StatusCode::INTERNAL_SERVER_ERROR;
                    continue;
                }
                tried.insert(key_id.clone());
                last_error = format!("Proxy error: {error}");
                last_status = StatusCode::INTERNAL_SERVER_ERROR;
                continue;
            }
        };

        let status = resp.status().as_u16();
        if status != 200 {
            dec_concurrent(&state.runtime, &key_id);
            let body_text = resp.text().await.unwrap_or_default();
            let failover = classify_error(status, &body_text);
            let event = if status == 429 {
                "upstream_429"
            } else {
                "upstream_error"
            };

            match status {
                429 => {
                    let quota_exhausted = serde_json::from_str::<Value>(&body_text)
                        .ok()
                        .and_then(|err| {
                            err.pointer("/error/data/code")
                                .or_else(|| err.get("code"))
                                .and_then(Value::as_i64)
                        })
                        .is_some_and(|code| code == 14018 || code == 14019);
                    if quota_exhausted {
                        update_upstream_key(&key_id, &json!({"status": "exhausted"}));
                    } else {
                        last_cooldown_secs = mark_model_cooldown(&state.runtime, &key_id, &model);
                    }
                }
                403 if body_text.contains("\"code\":11140") => {
                    // 上游风控：标记 abnormal，不再参与调度。
                    update_upstream_key(&key_id, &json!({"status": "abnormal"}));
                }
                400 if body_text.trim().is_empty()
                    || body_text.contains("input length too long")
                    || body_text.contains("\"code\":11115") =>
                {
                    add_request_log_entry(log_entry(
                        &sub_key,
                        Some(&upstream_key),
                        &model,
                        "upstream_error",
                        "上游返回 400：上下文超长",
                        400,
                    ));
                    return json_response(
                        StatusCode::BAD_REQUEST,
                        json!({"error": {"message": CONTEXT_TOO_LONG_MESSAGE, "type": "context_too_long"}}),
                    );
                }
                401 if body_text.to_lowercase().contains("<html>")
                    || body_text.to_lowercase().contains("<!doctype") =>
                {
                    add_request_log_entry(log_entry(
                        &sub_key,
                        Some(&upstream_key),
                        &model,
                        "upstream_error",
                        "401 网关拦截（HTML 响应）",
                        401,
                    ));
                    return json_response(
                        StatusCode::BAD_GATEWAY,
                        json!({"error": {"message": "请求被上游网关拦截，可能是上下文过长或请求格式异常。请尝试新开对话。", "type": "upstream_gateway_rejected"}}),
                    );
                }
                _ => {}
            }
            add_request_log_entry(log_entry(
                &sub_key,
                Some(&upstream_key),
                &model,
                event,
                &format!(
                    "上游返回 {status}: {}",
                    body_text.chars().take(200).collect::<String>()
                ),
                status,
            ));

            if failover == Failover::RetrySame && !same_key_retried.contains(&key_id) {
                same_key_retried.insert(key_id.clone());
                last_error = body_text;
                last_status = StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_GATEWAY);
                continue;
            }
            tried.insert(key_id.clone());
            // 上游 4xx 认证错误不能原样转发给客户端（会触发重登录），统一转 502。
            last_status = match status {
                401 | 403 | 400 => StatusCode::BAD_GATEWAY,
                other => StatusCode::from_u16(other).unwrap_or(StatusCode::BAD_GATEWAY),
            };
            last_error = match status {
                401 | 403 => json!({"error": {"message": "上游认证失败，请检查上游 Key 是否有效", "type": "upstream_auth_error"}}).to_string(),
                400 => json!({"error": {"message": "上游拒绝请求，可能是参数问题", "type": "upstream_bad_request"}}).to_string(),
                _ => body_text,
            };
            continue;
        }

        // ─── 200：先取首 chunk（10s 首字节超时），检测通过再发响应头 ───
        let mut stream = resp.bytes_stream();
        let first_chunk = match tokio::time::timeout(FIRST_BYTE_TIMEOUT, stream.next()).await {
            Ok(Some(Ok(bytes))) => bytes,
            Ok(Some(Err(error))) => {
                dec_concurrent(&state.runtime, &key_id);
                tried.insert(key_id.clone());
                last_error = format!("上游首 chunk 读取失败: {error}");
                last_status = StatusCode::BAD_GATEWAY;
                continue;
            }
            Ok(None) | Err(_) => {
                dec_concurrent(&state.runtime, &key_id);
                tried.insert(key_id.clone());
                last_error = "上游首字节超时或空响应".to_string();
                last_status = StatusCode::BAD_GATEWAY;
                continue;
            }
        };
        let first_text = String::from_utf8_lossy(&first_chunk).to_string();
        match detect_stream_error(&first_text) {
            Some("context_too_long") => {
                dec_concurrent(&state.runtime, &key_id);
                return json_response(
                    StatusCode::BAD_REQUEST,
                    json!({"error": {"message": CONTEXT_TOO_LONG_MESSAGE, "type": "context_too_long"}}),
                );
            }
            Some(_) => {
                // 首 chunk 带错误事件：换 Key 重试。
                dec_concurrent(&state.runtime, &key_id);
                tried.insert(key_id.clone());
                last_error = "首 chunk 包含错误事件".to_string();
                last_status = StatusCode::BAD_GATEWAY;
                continue;
            }
            None => {}
        }

        let first_token_ms = t0.elapsed().as_millis() as u64;
        let sub_key_id = sub_key
            .get("key_id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let sub_key_label = sub_key
            .get("label")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();

        if client_wants_stream {
            // 流式：后台任务驱动上游流，客户端断连也继续 drain 以拿到 usage 统计。
            let (tx, rx) = tokio::sync::mpsc::channel::<Result<axum::body::Bytes, String>>(32);
            let runtime = state.runtime.clone();
            let key_id_task = key_id.clone();
            let key_for_points = upstream_key.clone();
            tokio::spawn(async move {
                let mut scan = UsageScan::new();
                scan.feed(&first_text);
                let mut client_gone = tx.send(Ok(first_chunk)).await.is_err();
                while let Some(item) = stream.next().await {
                    match item {
                        Ok(bytes) => {
                            scan.feed(&String::from_utf8_lossy(&bytes));
                            if !client_gone && tx.send(Ok(bytes)).await.is_err() {
                                client_gone = true;
                            }
                        }
                        Err(error) => {
                            let _ = tx.send(Err(error.to_string())).await;
                            break;
                        }
                    }
                }
                drop(tx);
                dec_concurrent(&runtime, &key_id_task);
                reset_cooldown_count(&runtime, &key_id_task);
                record_request_end(
                    &key_id_task,
                    &sub_key_id,
                    &sub_key_label,
                    &key_label,
                    &model,
                    &scan.usage,
                    t0.elapsed().as_millis() as u64,
                    first_token_ms,
                );
                maybe_refresh_key_points(&runtime, &key_for_points);
            });
            let body_stream = futures_util::stream::unfold(rx, |mut rx| async move {
                rx.recv()
                    .await
                    .map(|item| (item.map_err(std::io::Error::other), rx))
            });
            return Response::builder()
                .status(StatusCode::OK)
                .header("Content-Type", "text/event-stream; charset=utf-8")
                .header("Cache-Control", "no-cache")
                .header("Access-Control-Allow-Origin", "*")
                .body(Body::from_stream(body_stream))
                .unwrap();
        }

        // 非流式：聚合完整 SSE 为标准 chat.completion JSON。
        let mut scan = UsageScan::new();
        scan.feed(&first_text);
        let mut content_parts: Vec<String> = Vec::new();
        let mut reasoning_parts: Vec<String> = Vec::new();
        let mut chat_id = String::new();
        let mut model_name = model.clone();
        collect_sse_text(
            &first_text,
            &mut content_parts,
            &mut reasoning_parts,
            &mut chat_id,
            &mut model_name,
        );
        while let Some(item) = stream.next().await {
            match item {
                Ok(bytes) => {
                    let text = String::from_utf8_lossy(&bytes).to_string();
                    scan.feed(&text);
                    collect_sse_text(
                        &text,
                        &mut content_parts,
                        &mut reasoning_parts,
                        &mut chat_id,
                        &mut model_name,
                    );
                }
                Err(_) => break,
            }
        }
        dec_concurrent(&state.runtime, &key_id);
        reset_cooldown_count(&state.runtime, &key_id);
        record_request_end(
            &key_id,
            &sub_key_id,
            &sub_key_label,
            &key_label,
            &model,
            &scan.usage,
            t0.elapsed().as_millis() as u64,
            first_token_ms,
        );
        maybe_refresh_key_points(&state.runtime, &upstream_key);

        let usage = if scan.usage.is_null() {
            json!({"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0})
        } else {
            scan.usage.clone()
        };
        return json_response(
            StatusCode::OK,
            json!({
                "id": if chat_id.is_empty() { format!("chatcmpl-{}", &uuid::Uuid::new_v4().simple().to_string()[..16]) } else { chat_id },
                "object": "chat.completion",
                "created": now_secs() as u64,
                "model": model_name,
                "choices": [{
                    "index": 0,
                    "message": {
                        "role": "assistant",
                        "content": content_parts.join(""),
                        "reasoning_content": reasoning_parts.join(""),
                    },
                    "finish_reason": "stop",
                }],
                "usage": usage,
            }),
        );
    }

    // ─── 所有重试失败 ───
    if last_error.is_empty() {
        add_request_log_entry(log_entry(
            &sub_key,
            None,
            &model,
            "error",
            "无可用的上游 Key（Key 池为空或全部耗尽/冷却中）",
            0,
        ));
        return json_response(
            StatusCode::SERVICE_UNAVAILABLE,
            json!({"error": {"message": "No available upstream keys", "type": "server_error"}}),
        );
    }
    add_request_log_entry(log_entry(
        &sub_key,
        None,
        &model,
        "error",
        &format!(
            "所有重试失败（尝试了 {} 个 Key）: {}",
            tried.len(),
            last_error.chars().take(300).collect::<String>()
        ),
        0,
    ));
    let mut response = json_response(
        last_status,
        serde_json::from_str(&last_error)
            .unwrap_or_else(|_| json!({"error": {"message": last_error, "type": "server_error"}})),
    );
    if last_status == StatusCode::TOO_MANY_REQUESTS && last_cooldown_secs > 0 {
        response.headers_mut().insert(
            "Retry-After",
            axum::http::HeaderValue::from_str(&last_cooldown_secs.to_string()).unwrap(),
        );
    }
    response
}

fn dec_concurrent(runtime: &RuntimeState, key_id: &str) {
    let mut counts = runtime.concurrent.lock().unwrap();
    if let Some(n) = counts.get_mut(key_id) {
        *n = n.saturating_sub(1);
    }
}

fn log_entry(
    sub_key: &Value,
    upstream_key: Option<&Value>,
    model: &str,
    event: &str,
    error: &str,
    upstream_status: u16,
) -> Value {
    json!({
        "timestamp": now_secs(),
        "sub_key_id": sub_key.get("key_id").cloned().unwrap_or(json!("")),
        "sub_key_label": sub_key.get("label").cloned().unwrap_or(json!("")),
        "main_key_id": upstream_key.and_then(|k| k.get("key_id")).cloned().unwrap_or(json!("")),
        "main_key_label": upstream_key.and_then(|k| k.get("label")).cloned().unwrap_or(json!("")),
        "model": model,
        "event": event,
        "error": error,
        "upstream_status": upstream_status,
        "request_path": "/v1/chat/completions",
    })
}

/// 非流式聚合：从 SSE 文本中提取 content / reasoning / id / model。
fn collect_sse_text(
    text: &str,
    content_parts: &mut Vec<String>,
    reasoning_parts: &mut Vec<String>,
    chat_id: &mut String,
    model_name: &mut String,
) {
    for line in text.lines() {
        let Some(data) = line.trim().strip_prefix("data: ") else {
            continue;
        };
        if data == "[DONE]" {
            return;
        }
        let Ok(chunk) = serde_json::from_str::<Value>(data) else {
            continue;
        };
        if let Some(id) = chunk.get("id").and_then(Value::as_str) {
            *chat_id = id.to_string();
        }
        if let Some(m) = chunk.get("model").and_then(Value::as_str) {
            *model_name = m.to_string();
        }
        for choice in chunk
            .get("choices")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
        {
            let delta = choice.get("delta").cloned().unwrap_or(json!({}));
            if let Some(content) = delta.get("content").and_then(Value::as_str) {
                content_parts.push(content.to_string());
            }
            if let Some(reasoning) = delta.get("reasoning_content").and_then(Value::as_str) {
                reasoning_parts.push(reasoning.to_string());
            }
        }
    }
}

// ---------------------------------------------------------------------------
// 服务生命周期
// ---------------------------------------------------------------------------

struct ServerHandle {
    port: u16,
    mode: String,
    abort: tokio::task::AbortHandle,
}

static SERVER: OnceLock<Mutex<Option<ServerHandle>>> = OnceLock::new();

fn server_slot() -> &'static Mutex<Option<ServerHandle>> {
    SERVER.get_or_init(|| Mutex::new(None))
}

pub fn proxy_server_status() -> Value {
    let settings = get_settings();
    let guard = server_slot().lock().unwrap();
    match guard.as_ref() {
        Some(handle) => json!({
            "running": true,
            "port": handle.port,
            "mode": handle.mode,
            "url": format!("http://127.0.0.1:{}/v1", handle.port),
            "settings": settings,
        }),
        None => json!({
            "running": false,
            "port": settings.get("port").and_then(Value::as_u64).unwrap_or(8002),
            "mode": settings.get("mode").and_then(Value::as_str).unwrap_or("local"),
            "settings": settings,
        }),
    }
}

/// 启动代理服务（local 绑 127.0.0.1，open 绑 0.0.0.0）。已运行则先停后启。
pub async fn start_proxy_server(port: u16, mode: &str) -> Result<Value, String> {
    stop_proxy_server();
    let host = if mode == "open" {
        "0.0.0.0"
    } else {
        "127.0.0.1"
    };
    let listener = tokio::net::TcpListener::bind(format!("{host}:{port}"))
        .await
        .map_err(|e| format!("端口 {port} 绑定失败（可能被占用）: {e}"))?;
    let mode_owned = mode.to_string();
    let task = tokio::spawn(async move {
        let _ = axum::serve(listener, proxy_router(&mode_owned)).await;
    });
    *server_slot().lock().unwrap() = Some(ServerHandle {
        port,
        mode: mode.to_string(),
        abort: task.abort_handle(),
    });
    save_settings(&json!({"port": port, "mode": mode}));
    Ok(proxy_server_status())
}

pub fn stop_proxy_server() -> Value {
    let handle = server_slot().lock().unwrap().take();
    if let Some(handle) = handle {
        handle.abort.abort();
    }
    proxy_server_status()
}

/// 应用启动时按设置自动拉起代理服务（settings.auto_start = true）。
pub async fn auto_start_proxy_server() {
    let settings = get_settings();
    if settings
        .get("auto_start")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        let port = settings.get("port").and_then(Value::as_u64).unwrap_or(8002) as u16;
        let mode = settings
            .get("mode")
            .and_then(Value::as_str)
            .unwrap_or("local")
            .to_string();
        let _ = start_proxy_server(port, &mode).await;
    }
}

// ---------------------------------------------------------------------------
// 子 Key 创建辅助
// ---------------------------------------------------------------------------

pub fn new_sub_key_id() -> String {
    format!("sk_{}", &uuid::Uuid::new_v4().simple().to_string()[..8])
}

pub fn new_sub_api_key() -> String {
    format!("sk-{}", uuid::Uuid::new_v4().simple())
}

pub fn now_iso_string() -> String {
    now_iso()
}

/// 子 Key 可用积分总和（其允许的上游 Key 剩余积分之和）。
pub fn total_points_for_sub_key(allowed_key_ids: &[String]) -> f64 {
    list_upstream_keys()
        .iter()
        .filter(|k| {
            allowed_key_ids.is_empty()
                || k.get("key_id")
                    .and_then(Value::as_str)
                    .is_some_and(|id| allowed_key_ids.iter().any(|a| a == id))
        })
        .filter_map(|k| {
            k.get("points")
                .and_then(Value::as_str)
                .and_then(|p| p.split('/').next()?.trim().parse::<f64>().ok())
        })
        .sum()
}
