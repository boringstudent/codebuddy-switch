//! 本地 API 反向代理服务（OpenAI 兼容接口）。
//!
//! 功能对齐 antigravity-tools 的 proxy_server：
//! - 上游 Key 池（从账号库导入，access_token 即上游凭据）
//! - 子 API Key 管理与鉴权（本地模式支持透传，开放模式强制子 Key）
//! - 请求路由：专一 / 临期优先 / 轮询 / 会话亲和 / 低分优先五种调用模式
//! - SSE 流式转发（强制上游 stream + include_usage，usage 透传并统计）
//! - 故障转移：429 冷却 / 额度耗尽 / 403 风控标记，最多尝试 3 个 Key
//! - 请求日志与每日统计，JSON 文件持久化（`~/.wb-switch/proxy_db.json`）

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
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
/// 日志默认保留天数（settings.log_retention_days 缺省值；显式 0 = 不按天数清理）。
const DEFAULT_LOG_RETENTION_DAYS: u64 = 7;
/// 日志默认体积上限 MB（settings.log_retention_max_mb 缺省值；显式 0 = 不按体积清理）。
const DEFAULT_LOG_RETENTION_MAX_MB: u64 = 50;
/// 单请求最多尝试的不同上游 Key 数。
const MAX_RETRIES: usize = 3;
/// 首字节超时：上游 10 秒不出首 chunk 视为可重试失败。
const FIRST_BYTE_TIMEOUT: Duration = Duration::from_secs(10);
/// 积分自动查询限频：同一 Key 5 分钟内最多查一次。
const POINTS_QUERY_INTERVAL_SECS: u64 = 300;

// 官方 CodeBuddy 客户端渠道标识（逆向自 CodeBuddy CN genie 扩展 4.12.1，见
// docs/TODO-渠道指纹与积分显示.md）。上游网关按这些头判定「已批准渠道」，
// 缺失会返回 400 code 11128（Illegal API invocation from an unapproved channel）。
/// User-Agent 的 platform 段（官方默认 "VSCode"）。
const OFFICIAL_PLATFORM: &str = "VSCode";
/// genie 扩展版本（product.json genieVersion；官方升级后跟随调整）。
const OFFICIAL_GENIE_VERSION: &str = "4.12.1";
/// User-Agent 的 productName 段（扩展包名）。
const OFFICIAL_PRODUCT_NAME: &str = "coding-copilot";

/// 构造模拟官方客户端的渠道标识头。每次调用生成新的 trace/conversation 标识。
///
/// `upstream_key` 用于经账号库补 `X-User-Id`（官方鉴权拦截器会自动携带）。
fn channel_headers(upstream_key: &Value) -> Vec<(&'static str, String)> {
    let trace_id = uuid::Uuid::new_v4().simple().to_string();
    // B3 spanId 为 16 位 hex。
    let span_id = uuid::Uuid::new_v4().simple().to_string()[..16].to_string();
    let conversation_id = uuid::Uuid::new_v4().to_string();
    let mut headers = vec![
        (
            "User-Agent",
            format!("{OFFICIAL_PLATFORM}/{OFFICIAL_GENIE_VERSION} {OFFICIAL_PRODUCT_NAME}/{OFFICIAL_GENIE_VERSION}"),
        ),
        ("X-IDE-Type", OFFICIAL_PLATFORM.to_string()),
        ("X-IDE-Name", OFFICIAL_PLATFORM.to_string()),
        ("X-IDE-Version", OFFICIAL_GENIE_VERSION.to_string()),
        ("X-Product-Version", OFFICIAL_GENIE_VERSION.to_string()),
        ("X-Product", "SaaS".to_string()),
        ("X-Request-Trace-Id", uuid::Uuid::new_v4().to_string()),
        ("X-Trace-ID", trace_id.clone()),
        ("X-Conversation-ID", conversation_id.clone()),
        ("X-Conversation-Request-ID", conversation_id.clone()),
        ("X-Conversation-Message-ID", conversation_id),
        ("X-Session-ID", uuid::Uuid::new_v4().simple().to_string()),
        ("X-B3-TraceId", trace_id.clone()),
        ("X-B3-SpanId", span_id.clone()),
        ("X-B3-Sampled", "1".to_string()),
        ("b3", format!("{trace_id}-{span_id}-1")),
    ];
    if let Some(account) = account_for_key(upstream_key) {
        if let Some(uid) = account::get_str(&account, "uid") {
            headers.push(("X-User-Id", uid));
        }
    }
    headers
}

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
    "hy3",
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
        "hy3" | "hy4-preview" | "hy3-preview" | "hunyuan-chat" | "hunyuan-2.0-thinking" => 256000,
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
            "log_retention_days": DEFAULT_LOG_RETENTION_DAYS,
            "log_retention_max_mb": DEFAULT_LOG_RETENTION_MAX_MB,
            "log_content_enabled": true,
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
    // 先增量折叠账本，再把权威统计回写展示缓存（被其它进程冲掉的累计在这里自愈）。
    fold_usage_events();
    let mut guard = db().lock().unwrap();
    guard.reload_if_changed();
    {
        let fold = usage_fold().lock().unwrap();
        sync_usage_into_db(&mut guard.data, &fold);
    }
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
    /// 文件被其他进程改过时（mtime 变化）先收敛重载，再叠加本进程的修改。
    fn reload_if_changed(&mut self) {
        let mtime = db_mtime();
        if mtime.is_some() && mtime != self.loaded_mtime {
            if let Ok(text) = std::fs::read_to_string(proxy_db_file()) {
                if let Ok(disk) = serde_json::from_str::<Value>(&text) {
                    self.data = converge_on_reload(&self.data, &disk);
                }
            }
            self.loaded_mtime = mtime;
        }
    }

    fn save(&mut self) {
        if let Some(parent) = proxy_db_file().parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(text) = std::fs::read_to_string(proxy_db_file()) {
            if let Ok(disk) = serde_json::from_str::<Value>(&text) {
                self.data = converge_on_save(&self.data, &disk);
            }
        }
        let content = serde_json::to_string_pretty(&self.data).unwrap_or_default();
        let _ = atomic_write(&proxy_db_file(), &content);
        // 记录自己写出的文件版本，避免下次锁内把自身写入误判为外部变更。
        self.loaded_mtime = db_mtime();
    }
}

/// 重载收敛：磁盘是配置权威（另一实例的增删改据此同步），本进程累计的单调数据
/// （计数 / Token / 积分 / 每日统计 / 日志）合并进来——不得被旧值整体替换
/// （2026-10-05 实证：另一实例写盘后本进程积分被冲掉）。
fn converge_on_reload(ours: &Value, disk: &Value) -> Value {
    let mut merged = merge_db_defaults(disk.clone());
    merge_monotonic_fields(&mut merged, ours);
    merged
}

/// 写盘收敛：本进程是配置权威，磁盘上的单调累计合并进来（另一实例可能同时在记数）。
fn converge_on_save(ours: &Value, disk: &Value) -> Value {
    let mut merged = ours.clone();
    merge_monotonic_fields(&mut merged, disk);
    merged
}

/// 单调递增的 Key 计数字段（合并时取最大）。
const MONOTONIC_KEY_FIELDS: [&str; 5] = [
    "used_count",
    "total_prompt_tokens",
    "total_completion_tokens",
    "total_tokens",
    "total_cached_tokens",
];

/// 把 `disk` 里的单调累计数据合并进 `ours`（计数取最大、每日统计逐字段取最大、日志按时间并集）。
///
/// 只合并**两边都存在**的 Key：不采纳磁盘上多出来的整个 Key（否则会复活本进程刚删除的 Key）；
/// `daily_stats` 是历史记录、没有删除语义，全部并入。
fn merge_monotonic_fields(ours: &mut Value, disk: &Value) {
    for keys_path in ["upstream_keys", "sub_api_keys"] {
        let Some(disk_keys) = disk.get(keys_path).and_then(Value::as_array) else {
            continue;
        };
        let Some(our_keys) = ours.get_mut(keys_path).and_then(Value::as_array_mut) else {
            continue;
        };
        for disk_key in disk_keys {
            let Some(key_id) = disk_key.get("key_id").and_then(Value::as_str) else {
                continue;
            };
            let Some(our_key) = our_keys
                .iter_mut()
                .find(|key| key.get("key_id").and_then(Value::as_str) == Some(key_id))
            else {
                continue;
            };
            for field in MONOTONIC_KEY_FIELDS {
                let disk_value = disk_key.get(field).and_then(Value::as_f64).unwrap_or(0.0);
                let our_value = our_key.get(field).and_then(Value::as_f64).unwrap_or(0.0);
                if disk_value > our_value {
                    our_key[field] = disk_key.get(field).cloned().unwrap_or(Value::Null);
                }
            }
            for field in ["total_credits", "last_used_at"] {
                let disk_value = disk_key.get(field).cloned().unwrap_or(Value::Null);
                let our_value = our_key.get(field).cloned().unwrap_or(Value::Null);
                let ordering = our_value
                    .as_str()
                    .zip(disk_value.as_str())
                    .map(|(our, disk)| our.cmp(disk))
                    .or_else(|| {
                        our_value
                            .as_f64()
                            .zip(disk_value.as_f64())
                            .and_then(|(our, disk)| our.partial_cmp(&disk))
                    });
                if ordering.is_some_and(|ordering| ordering.is_lt()) {
                    our_key[field] = disk_value;
                }
            }
        }
    }
    // 每日统计：category → key_id → date → 字段，逐字段取最大。
    if let Some(disk_stats) = disk.get("daily_stats").and_then(Value::as_object) {
        let our_stats = ours
            .as_object_mut()
            .map(|root| {
                root.entry("daily_stats".to_string())
                    .or_insert_with(|| json!({}))
            })
            .and_then(Value::as_object_mut);
        if let Some(our_stats) = our_stats {
            for (category, keys) in disk_stats {
                let Some(disk_keys) = keys.as_object() else {
                    continue;
                };
                let our_keys = our_stats
                    .entry(category.clone())
                    .or_insert_with(|| json!({}))
                    .as_object_mut();
                let Some(our_keys) = our_keys else {
                    continue;
                };
                for (key_id, dates) in disk_keys {
                    let Some(disk_dates) = dates.as_object() else {
                        continue;
                    };
                    let our_dates = our_keys
                        .entry(key_id.clone())
                        .or_insert_with(|| json!({}))
                        .as_object_mut();
                    let Some(our_dates) = our_dates else {
                        continue;
                    };
                    for (date, disk_day) in disk_dates {
                        let our_day = our_dates.entry(date.clone()).or_insert_with(|| json!({}));
                        let (Some(our_day), Some(disk_day)) =
                            (our_day.as_object_mut(), disk_day.as_object())
                        else {
                            continue;
                        };
                        for (field, disk_value) in disk_day {
                            let disk_num = disk_value.as_f64().unwrap_or(0.0);
                            let our_num = our_day.get(field).and_then(Value::as_f64).unwrap_or(0.0);
                            if disk_num > our_num {
                                our_day.insert(field.clone(), disk_value.clone());
                            }
                        }
                    }
                }
            }
        }
    }
    // 请求日志：清空墓碑 `logs_cleared_at` 取双方较大者，早于它的条目先滤掉
    // （否则「清空日志」会被另一进程持有的旧日志经合并带回来，2026-10-05 实证清空按钮失效），
    // 剩余条目按内容去重取并集、按时间排序后保留最新 1000 条。
    let cleared_marker = ours
        .get("logs_cleared_at")
        .and_then(Value::as_f64)
        .into_iter()
        .chain(disk.get("logs_cleared_at").and_then(Value::as_f64))
        .fold(0.0_f64, f64::max);
    let keep_entry = |entry: &Value| {
        entry
            .get("timestamp")
            .and_then(Value::as_f64)
            .unwrap_or(0.0)
            > cleared_marker
    };
    if let Some(our_logs) = ours.get_mut("request_logs").and_then(Value::as_array_mut) {
        our_logs.retain(keep_entry);
    }
    // settings 需在取得 request_logs 可变借用之前读出（同一 ours，避免借用冲突）。
    let settings = ours.get("settings").cloned().unwrap_or(json!({}));
    let our_logs = ours
        .as_object_mut()
        .map(|root| {
            root.entry("request_logs".to_string())
                .or_insert_with(|| json!([]))
        })
        .and_then(Value::as_array_mut);
    if let Some(our_logs) = our_logs {
        let mut seen: std::collections::HashSet<String> =
            our_logs.iter().map(|entry| entry.to_string()).collect();
        if let Some(disk_logs) = disk.get("request_logs").and_then(Value::as_array) {
            for entry in disk_logs {
                if keep_entry(entry) && seen.insert(entry.to_string()) {
                    our_logs.push(entry.clone());
                }
            }
        }
        our_logs.sort_by(|left, right| {
            let left_ts = left.get("timestamp").and_then(Value::as_f64).unwrap_or(0.0);
            let right_ts = right
                .get("timestamp")
                .and_then(Value::as_f64)
                .unwrap_or(0.0);
            left_ts
                .partial_cmp(&right_ts)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        trim_request_logs(our_logs, &settings);
    }
    if cleared_marker > 0.0 {
        ours["logs_cleared_at"] = json!(cleared_marker);
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
    // 先惰性销毁到期子 Key（独立锁，勿与下面的读取嵌套）。
    purge_expired_sub_keys();
    lock_db()
        .data
        .get("sub_api_keys")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

/// 惰性销毁到期子 Key（`expires_at` 秒级时间戳，0 / 缺省 = 无限）；有销毁才写盘。
///
/// 读取路径（列表 / 鉴权）都会经过，到期即删，无需后台定时器。
pub fn purge_expired_sub_keys() -> usize {
    let mut db = lock_db();
    let now = now_secs();
    let Some(keys) = db
        .data
        .get_mut("sub_api_keys")
        .and_then(Value::as_array_mut)
    else {
        return 0;
    };
    let before = keys.len();
    keys.retain(|k| {
        let expires_at = k.get("expires_at").and_then(Value::as_f64).unwrap_or(0.0);
        expires_at <= 0.0 || expires_at > now
    });
    let removed = before - keys.len();
    if removed > 0 {
        db.save();
    }
    removed
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
    // 清空墓碑：并发合并时早于该时刻的日志不得再被带回来（见 merge_monotonic_fields）。
    db.data["logs_cleared_at"] = json!(now_secs());
    db.save();
}

/// 请求日志裁剪：固定条数 + 保留天数 + 体积上限（设置驱动，显式 0 = 不启用该维度）。
///
/// 调用方必须自行传入 settings——本函数常在持有 db 锁的上下文里运行，
/// 不能再调 `get_settings()`（会二次加锁死锁）。
fn trim_request_logs(logs: &mut Vec<Value>, settings: &Value) {
    // 条数（固定硬上限，防止无界增长）。
    if logs.len() > REQUEST_LOG_KEEP {
        let overflow = logs.len() - REQUEST_LOG_KEEP;
        logs.drain(..overflow);
    }
    // 保留天数。
    let days = settings
        .get("log_retention_days")
        .and_then(Value::as_u64)
        .unwrap_or(DEFAULT_LOG_RETENTION_DAYS);
    if days > 0 {
        let cutoff = now_secs() - days as f64 * 86400.0;
        logs.retain(|entry| json_f64(entry.get("timestamp")).unwrap_or(0.0) >= cutoff);
    }
    // 体积上限（按序列化字节估算，从最旧开始删到达标）。
    let max_mb = settings
        .get("log_retention_max_mb")
        .and_then(Value::as_u64)
        .unwrap_or(DEFAULT_LOG_RETENTION_MAX_MB);
    if max_mb > 0 {
        let max_bytes = (max_mb as usize) * 1024 * 1024;
        let mut size: usize = logs.iter().map(|entry| entry.to_string().len()).sum();
        let mut drop_n = 0;
        while size > max_bytes && drop_n < logs.len() {
            size = size.saturating_sub(logs[drop_n].to_string().len());
            drop_n += 1;
        }
        if drop_n > 0 {
            logs.drain(..drop_n);
        }
    }
}

fn add_request_log(db: &mut ProxyDb, entry: Value) {
    let settings = db.data.get("settings").cloned().unwrap_or(json!({}));
    let logs = db
        .data
        .as_object_mut()
        .unwrap()
        .entry("request_logs")
        .or_insert_with(|| json!([]))
        .as_array_mut()
        .unwrap();
    logs.push(entry);
    trim_request_logs(logs, &settings);
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
///
/// 口径以 `daily_stats` 的**全量历史**为准（含已删除的上游 Key）：删除 Key 只移除凭据，
/// 不得把它的历史消耗从总览里抹掉——否则总览的「今日积分 / Token」会在删 Key 后回退
/// （2026-10-05 用户实证）。无 daily 记录的存量 Key 回退取 Key 自身的累计字段。
pub fn proxy_overview() -> Value {
    let upstream = list_upstream_keys();
    let today = today_str();
    let db = lock_db();
    let daily = db
        .data
        .pointer("/daily_stats/upstream")
        .cloned()
        .unwrap_or(json!({}));
    let mut totals = sum_daily_stats(&daily, &today);
    // 兼容没有 daily 记录的存量 Key（例如统计功能上线前就有累计字段的数据）。
    if let Some(keys) = daily.as_object() {
        for key in &upstream {
            let key_id = key
                .get("key_id")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if keys.contains_key(key_id) {
                continue;
            }
            totals.requests += key.get("used_count").and_then(Value::as_f64).unwrap_or(0.0);
            totals.prompt += key
                .get("total_prompt_tokens")
                .and_then(Value::as_f64)
                .unwrap_or(0.0);
            totals.completion += key
                .get("total_completion_tokens")
                .and_then(Value::as_f64)
                .unwrap_or(0.0);
            totals.tokens += key
                .get("total_tokens")
                .and_then(Value::as_f64)
                .unwrap_or(0.0);
            totals.cached += key
                .get("total_cached_tokens")
                .and_then(Value::as_f64)
                .unwrap_or(0.0);
            totals.credits += key
                .get("total_credits")
                .and_then(Value::as_f64)
                .unwrap_or(0.0);
        }
    }
    json!({
        "total": {
            "requests": totals.requests,
            "prompt_tokens": totals.prompt,
            "completion_tokens": totals.completion,
            "tokens": totals.tokens,
            "cached_tokens": totals.cached,
            "credits": totals.credits,
        },
        "today": {
            "requests": totals.today_requests,
            "tokens": totals.today_tokens,
            "credits": totals.today_credits,
        },
    })
}

/// daily_stats 汇总累加器（总览用）。
#[derive(Default)]
struct DailyTotals {
    requests: f64,
    prompt: f64,
    completion: f64,
    tokens: f64,
    cached: f64,
    credits: f64,
    today_requests: f64,
    today_tokens: f64,
    today_credits: f64,
}

/// 汇总 `daily_stats/upstream` 全量历史（含已删除 Key 的记录），并单独累计「今日」。
fn sum_daily_stats(daily: &Value, today: &str) -> DailyTotals {
    let mut totals = DailyTotals::default();
    if let Some(keys) = daily.as_object() {
        for days in keys.values().filter_map(Value::as_object) {
            for (date, day) in days {
                totals.add(day, date == today);
            }
        }
    }
    totals
}

impl DailyTotals {
    fn add(&mut self, day: &Value, is_today: bool) {
        let field = |name: &str| day.get(name).and_then(Value::as_f64).unwrap_or(0.0);
        let count = field("count");
        let tokens = field("total_tokens");
        let credits = field("credits");
        self.requests += count;
        self.prompt += field("prompt_tokens");
        self.completion += field("completion_tokens");
        self.tokens += tokens;
        self.cached += field("cached_tokens");
        self.credits += credits;
        if is_today {
            self.today_requests += count;
            self.today_tokens += tokens;
            self.today_credits += credits;
        }
    }
}

/// 按字符截断（不是字节，避免 UTF-8 截出乱码）。
fn truncate_chars(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    text.chars().take(max).collect()
}

/// 日志中问答内容的最大字符数。
const LOG_CONTENT_MAX_CHARS: usize = 500;

/// 取请求 messages 中最后一条 user 消息的文本部分（多模态只取 text，图片等跳过）。
fn extract_last_user_text(request: &Value) -> String {
    let text_of = |message: &Value| -> String {
        match message.get("content") {
            Some(Value::String(s)) => s.clone(),
            Some(Value::Array(parts)) => parts
                .iter()
                .filter_map(|p| p.get("text").and_then(Value::as_str).map(str::to_string))
                .collect::<Vec<_>>()
                .join(" "),
            _ => String::new(),
        }
    };
    request
        .get("messages")
        .and_then(Value::as_array)
        .map(|messages| {
            messages
                .iter()
                .rev()
                .find(|m| m.get("role").and_then(Value::as_str) == Some("user"))
                .map(text_of)
                .unwrap_or_default()
        })
        .unwrap_or_default()
}

/// 一次请求结束的完整入账（上游 Key + 子 Key + 每日统计 + 日志），一次锁一次写盘。
///
/// `question` / `answer` 为已截断的问答文本（日志展开用），空串表示不记录。
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
    question: &str,
    answer: &str,
) {
    let (prompt, completion, total, cached, credit) = usage_numbers(usage);

    // 事件溯源：先记账本（权威来源），再更新 proxy_db 展示缓存（被冲掉可自愈）。
    // model 用于子 Key 的模型维度统计（旧事件无此字段，折叠时归 "unknown"）。
    append_usage_event(&json!({
        "type": "end",
        "ts": now_secs(),
        "date": today_str(),
        "upstream": upstream_key_id,
        "sub": sub_key_id,
        "model": model,
        "prompt": prompt,
        "completion": completion,
        "total": total,
        "cached": cached,
        "credit": credit,
    }));

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

    let mut entry = json!({
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
        "credit": (credit * 10000.0).round() / 10000.0,
        "first_token_ms": first_token_ms,
    });
    // 问答内容（日志展开用）：只在非空时写入，失败日志不采集。
    if !question.is_empty() {
        entry["question"] = json!(question);
    }
    if !answer.is_empty() {
        entry["answer"] = json!(answer);
    }
    add_request_log(&mut db, entry);
    db.save();
}

/// 该厂商接口常把数字序列化成字符串（billing 接口的 `"credit": "1.25"`、`"total": "3000"`），
/// SSE 的 usage 同样出现字符串数字：一律按「数值或数字字符串」解析，否则积分 / Token 会被记成 0，
/// 子 Key 的积分上限与 Token 上限因此永不触发（2026-10-05 本机实证：356 次请求只记到 0.35 积分）。
fn json_u64(value: Option<&Value>) -> Option<u64> {
    match value? {
        Value::Number(_) => value.and_then(Value::as_u64),
        Value::String(text) => text.trim().parse::<u64>().ok(),
        _ => None,
    }
}

fn json_f64(value: Option<&Value>) -> Option<f64> {
    match value? {
        Value::Number(_) => value.and_then(Value::as_f64),
        Value::String(text) => text.trim().parse::<f64>().ok(),
        _ => None,
    }
}

/// 从 SSE 的 usage 对象提取（prompt, completion, total, cached, credit）。
///
/// 全部字段容忍数字字符串；`total_tokens` 缺失 / 为 0 时用 prompt + completion 兜底，
/// 否则子 Key 的 Token 上限会随「没记上」而永不触发。
fn usage_numbers(usage: &Value) -> (u64, u64, u64, u64, f64) {
    let prompt = json_u64(usage.get("prompt_tokens")).unwrap_or(0);
    let completion = json_u64(usage.get("completion_tokens")).unwrap_or(0);
    let total = json_u64(usage.get("total_tokens"))
        .filter(|total| *total > 0)
        .unwrap_or(prompt + completion);
    // 兼容 OpenAI 风格的嵌套字段（kimi 系上游把缓存命中放在 prompt_tokens_details 里，
    // 只读顶层会恒为 0，界面「缓存命中」因此不显示）。
    let cached = json_u64(usage.get("cached_tokens"))
        .or_else(|| json_u64(usage.get("prompt_cache_hit_tokens")))
        .or_else(|| json_u64(usage.pointer("/prompt_tokens_details/cached_tokens")))
        .unwrap_or(0);
    let credit = json_f64(usage.get("credit")).unwrap_or(0.0);
    (prompt, completion, total, cached, credit)
}

// ---------------------------------------------------------------------------
// 用量事件账本（次数 / Token / 积分的权威来源）
// ---------------------------------------------------------------------------
//
// 设计动因（2026-10-05 连续实证）：proxy_db.json 的累计字段是整文件读-改-写，
// 任何持有旧内存的进程（旧版本 / 第二实例）写盘都会把它们冲掉；本机系统时钟还会跳变
// （日志时间戳与 mtime 对不上）。因此次数 / Token / 积分改为**事件溯源**：
// `proxy_usage.jsonl` 首行是基线快照（迁移存量），之后逐请求追加一行；
// 权威统计 = 折叠全量事件，proxy_db.json 的累计字段只是折叠结果的展示缓存，
// 被其它进程冲掉后下一次读取自动重建（自愈）。事件是单行小写追加，
// 多实例并发只会并集增长，永不互相覆盖。

const USAGE_EVENTS_FILE: &str = "proxy_usage.jsonl";

/// 单个 Key（或单日）的折叠累计值。
#[derive(Default, Clone, Copy, PartialEq, Debug)]
struct KeyFold {
    used: u64,
    prompt: u64,
    completion: u64,
    total: u64,
    cached: u64,
    credits: f64,
}

impl KeyFold {
    fn add(&mut self, prompt: u64, completion: u64, total: u64, cached: u64, credit: f64) {
        self.used += 1;
        self.prompt += prompt;
        self.completion += completion;
        self.total += total;
        self.cached += cached;
        self.credits += credit;
    }

    fn from_json(value: &Value) -> KeyFold {
        KeyFold {
            used: json_u64(value.get("used")).unwrap_or(0),
            prompt: json_u64(value.get("prompt")).unwrap_or(0),
            completion: json_u64(value.get("completion")).unwrap_or(0),
            total: json_u64(value.get("total")).unwrap_or(0),
            cached: json_u64(value.get("cached")).unwrap_or(0),
            credits: json_f64(value.get("credits")).unwrap_or(0.0),
        }
    }

    /// 逐字段取最大（并入基线快照用，重复基线不会叠加）。
    fn merge_max(&mut self, other: &KeyFold) {
        self.used = self.used.max(other.used);
        self.prompt = self.prompt.max(other.prompt);
        self.completion = self.completion.max(other.completion);
        self.total = self.total.max(other.total);
        self.cached = self.cached.max(other.cached);
        self.credits = self.credits.max(other.credits);
    }
}

/// 账本的折叠状态（进程内缓存，按已读长度增量推进）。
#[derive(Default)]
struct UsageFold {
    folded_len: u64,
    upstream: HashMap<String, KeyFold>,
    sub: HashMap<String, KeyFold>,
    /// (key_id, date) → 当日累计。
    daily_upstream: HashMap<(String, String), KeyFold>,
    daily_sub: HashMap<(String, String), KeyFold>,
    /// (sub_key_id, model) → 该子 Key 按模型的累计（模型维度统计用）。
    sub_model: HashMap<(String, String), KeyFold>,
    /// (是否上游, key_id) → 清零时刻；不晚于它的该 Key 事件不计入。
    reset_floor: HashMap<(bool, String), f64>,
    /// 账本文件是否存在（不存在时 sync 不动 proxy_db 缓存，回退到旧计数口径）。
    ledger_present: bool,
}

static USAGE_FOLD: OnceLock<Mutex<UsageFold>> = OnceLock::new();

fn usage_fold() -> &'static Mutex<UsageFold> {
    USAGE_FOLD.get_or_init(|| Mutex::new(UsageFold::default()))
}

fn usage_events_path() -> PathBuf {
    store_dir().join(USAGE_EVENTS_FILE)
}

/// 切出完整行（到最后一个换行为止）；半行留给下一轮。
fn complete_json_lines(bytes: &[u8]) -> (Vec<String>, u64) {
    let Some(last_newline) = bytes.iter().rposition(|byte| *byte == b'\n') else {
        return (Vec::new(), 0);
    };
    let text = String::from_utf8_lossy(&bytes[..last_newline]).into_owned();
    let lines = text
        .lines()
        .map(|line| line.trim().to_string())
        .filter(|line| !line.is_empty())
        .collect();
    (lines, (last_newline + 1) as u64)
}

/// 折叠一行账本事件（纯函数）。
fn fold_line(fold: &mut UsageFold, line: &str) {
    let Ok(entry) = serde_json::from_str::<Value>(line) else {
        return;
    };
    match entry.get("type").and_then(Value::as_str) {
        Some("baseline") => {
            for (is_upstream, scope) in [(true, "upstream"), (false, "sub")] {
                if let Some(keys) = entry.get(scope).and_then(Value::as_object) {
                    for (key_id, totals) in keys {
                        let target = if is_upstream {
                            &mut fold.upstream
                        } else {
                            &mut fold.sub
                        };
                        target
                            .entry(key_id.clone())
                            .or_default()
                            .merge_max(&KeyFold::from_json(totals));
                    }
                }
                let daily_scope = if is_upstream {
                    "daily_upstream"
                } else {
                    "daily_sub"
                };
                if let Some(days) = entry.get(daily_scope).and_then(Value::as_object) {
                    for (compound, totals) in days {
                        let Some((key_id, date)) = compound.split_once('|') else {
                            continue;
                        };
                        let target = if is_upstream {
                            &mut fold.daily_upstream
                        } else {
                            &mut fold.daily_sub
                        };
                        target
                            .entry((key_id.to_string(), date.to_string()))
                            .or_default()
                            .merge_max(&KeyFold::from_json(totals));
                    }
                }
            }
            // 子 Key 模型维度基线（账本重写实入；旧版基线无此字段则跳过）。
            if let Some(models) = entry.get("sub_model").and_then(Value::as_object) {
                for (compound, totals) in models {
                    let Some((key_id, model)) = compound.split_once('|') else {
                        continue;
                    };
                    fold.sub_model
                        .entry((key_id.to_string(), model.to_string()))
                        .or_default()
                        .merge_max(&KeyFold::from_json(totals));
                }
            }
        }
        Some("reset") => {
            let Some(key_id) = entry.get("key_id").and_then(Value::as_str) else {
                return;
            };
            let is_upstream = entry.get("scope").and_then(Value::as_str) == Some("upstream");
            let ts = json_f64(entry.get("ts")).unwrap_or(0.0);
            let (keys, daily) = if is_upstream {
                (&mut fold.upstream, &mut fold.daily_upstream)
            } else {
                (&mut fold.sub, &mut fold.daily_sub)
            };
            keys.remove(key_id);
            daily.retain(|(id, _), _| id != key_id);
            if !is_upstream {
                fold.sub_model.retain(|(id, _), _| id != key_id);
            }
            fold.reset_floor
                .insert((is_upstream, key_id.to_string()), ts);
        }
        Some("end") => {
            let ts = json_f64(entry.get("ts")).unwrap_or(0.0);
            let prompt = json_u64(entry.get("prompt")).unwrap_or(0);
            let completion = json_u64(entry.get("completion")).unwrap_or(0);
            let total = json_u64(entry.get("total"))
                .filter(|total| *total > 0)
                .unwrap_or(prompt + completion);
            let cached = json_u64(entry.get("cached")).unwrap_or(0);
            let credit = json_f64(entry.get("credit")).unwrap_or(0.0);
            let date = entry
                .get("date")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            for (is_upstream, field) in [(true, "upstream"), (false, "sub")] {
                let Some(key_id) = entry.get(field).and_then(Value::as_str) else {
                    continue;
                };
                if key_id.is_empty() || key_id == "_passthrough_" {
                    continue;
                }
                let floor = fold
                    .reset_floor
                    .get(&(is_upstream, key_id.to_string()))
                    .copied()
                    .unwrap_or(0.0);
                if ts <= floor {
                    continue;
                }
                let (keys, daily) = if is_upstream {
                    (&mut fold.upstream, &mut fold.daily_upstream)
                } else {
                    (&mut fold.sub, &mut fold.daily_sub)
                };
                keys.entry(key_id.to_string())
                    .or_default()
                    .add(prompt, completion, total, cached, credit);
                if !date.is_empty() {
                    daily
                        .entry((key_id.to_string(), date.clone()))
                        .or_default()
                        .add(prompt, completion, total, cached, credit);
                }
                // 子 Key 模型维度：旧事件无 model 归 "unknown"；与上面的 floor 检查共用同一放行点。
                if !is_upstream {
                    let model = entry
                        .get("model")
                        .and_then(Value::as_str)
                        .filter(|m| !m.is_empty())
                        .unwrap_or("unknown")
                        .to_string();
                    fold.sub_model
                        .entry((key_id.to_string(), model))
                        .or_default()
                        .add(prompt, completion, total, cached, credit);
                }
            }
        }
        _ => {}
    }
}

/// 增量折叠账本（只读新增字节；文件被外部截短 / 替换时全量重折）。
fn fold_usage_events() {
    use std::io::{Read, Seek, SeekFrom};
    let path = usage_events_path();
    let mut fold = usage_fold().lock().unwrap();
    let Ok(mut file) = std::fs::File::open(&path) else {
        return;
    };
    let len = file.metadata().map(|meta| meta.len()).unwrap_or(0);
    if len < fold.folded_len {
        *fold = UsageFold::default();
    }
    fold.ledger_present = true;
    if len == fold.folded_len {
        return;
    }
    if file.seek(SeekFrom::Start(fold.folded_len)).is_err() {
        return;
    }
    let mut tail = Vec::new();
    if file.read_to_end(&mut tail).is_err() {
        return;
    }
    let (lines, consumed) = complete_json_lines(&tail);
    for line in lines {
        fold_line(&mut fold, &line);
    }
    fold.folded_len += consumed;
}

/// 迁移基线：proxy_db.json 现有累计 → 账本首行（折叠值因此始终 ≥ 历史值）。
fn usage_baseline() -> Value {
    let disk = std::fs::read_to_string(proxy_db_file())
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .unwrap_or(json!({}));
    let key_totals = |keys_path: &str| -> serde_json::Map<String, Value> {
        let mut map = serde_json::Map::new();
        if let Some(keys) = disk.get(keys_path).and_then(Value::as_array) {
            for key in keys {
                let Some(key_id) = key.get("key_id").and_then(Value::as_str) else {
                    continue;
                };
                map.insert(
                    key_id.to_string(),
                    json!({
                        "used": key.get("used_count").and_then(Value::as_u64).unwrap_or(0),
                        "prompt": key.get("total_prompt_tokens").and_then(Value::as_u64).unwrap_or(0),
                        "completion": key.get("total_completion_tokens").and_then(Value::as_u64).unwrap_or(0),
                        "total": key.get("total_tokens").and_then(Value::as_u64).unwrap_or(0),
                        "cached": key.get("total_cached_tokens").and_then(Value::as_u64).unwrap_or(0),
                        "credits": key.get("total_credits").and_then(Value::as_f64).unwrap_or(0.0),
                    }),
                );
            }
        }
        map
    };
    let daily_totals = |category: &str| -> serde_json::Map<String, Value> {
        let mut map = serde_json::Map::new();
        if let Some(keys) = disk
            .pointer(&format!("/daily_stats/{category}"))
            .and_then(Value::as_object)
        {
            for (key_id, dates) in keys {
                let Some(dates) = dates.as_object() else {
                    continue;
                };
                for (date, day) in dates {
                    map.insert(
                        format!("{key_id}|{date}"),
                        json!({
                            "used": day.get("count").and_then(Value::as_u64).unwrap_or(0),
                            "prompt": day.get("prompt_tokens").and_then(Value::as_u64).unwrap_or(0),
                            "completion": day.get("completion_tokens").and_then(Value::as_u64).unwrap_or(0),
                            "total": day.get("total_tokens").and_then(Value::as_u64).unwrap_or(0),
                            "cached": day.get("cached_tokens").and_then(Value::as_u64).unwrap_or(0),
                            "credits": day.get("credits").and_then(Value::as_f64).unwrap_or(0.0),
                        }),
                    );
                }
            }
        }
        map
    };
    json!({
        "type": "baseline",
        "ts": now_secs(),
        "upstream": Value::Object(key_totals("upstream_keys")),
        "sub": Value::Object(key_totals("sub_api_keys")),
        "daily_upstream": Value::Object(daily_totals("upstream")),
        "daily_sub": Value::Object(daily_totals("sub")),
    })
}

/// 把折叠状态序列化为账本基线行（与 `usage_baseline` 同构，供账本重写实入）。
fn fold_to_baseline(fold: &UsageFold) -> Value {
    let totals_json = |t: &KeyFold| {
        json!({
            "used": t.used,
            "prompt": t.prompt,
            "completion": t.completion,
            "total": t.total,
            "cached": t.cached,
            "credits": t.credits,
        })
    };
    let key_totals = |keys: &HashMap<String, KeyFold>| -> serde_json::Map<String, Value> {
        keys.iter()
            .map(|(id, t)| (id.clone(), totals_json(t)))
            .collect()
    };
    let compound_totals =
        |keys: &HashMap<(String, String), KeyFold>| -> serde_json::Map<String, Value> {
            keys.iter()
                .map(|((a, b), t)| (format!("{a}|{b}"), totals_json(t)))
                .collect()
        };
    json!({
        "type": "baseline",
        "ts": now_secs(),
        "upstream": Value::Object(key_totals(&fold.upstream)),
        "sub": Value::Object(key_totals(&fold.sub)),
        "daily_upstream": Value::Object(compound_totals(&fold.daily_upstream)),
        "daily_sub": Value::Object(compound_totals(&fold.daily_sub)),
        "sub_model": Value::Object(compound_totals(&fold.sub_model)),
    })
}

/// 账本保留策略（启动时执行）：把过期 / 超限事件**折叠进新基线**后重写
/// proxy_usage.jsonl。绝不能直接删旧事件——那会让全量统计回退；
/// 必须先折叠进基线（事件溯源设计见 USAGE_EVENTS_FILE 上方注释）。
fn prune_usage_ledger() {
    let settings = get_settings();
    let days = settings
        .get("log_retention_days")
        .and_then(Value::as_u64)
        .unwrap_or(DEFAULT_LOG_RETENTION_DAYS);
    let max_mb = settings
        .get("log_retention_max_mb")
        .and_then(Value::as_u64)
        .unwrap_or(DEFAULT_LOG_RETENTION_MAX_MB);
    if days == 0 && max_mb == 0 {
        return;
    }
    let path = usage_events_path();
    let Ok(text) = std::fs::read_to_string(&path) else {
        return;
    };
    let cutoff = if days > 0 {
        now_secs() - days as f64 * 86400.0
    } else {
        // 不按天数清理时 cutoff 放到未来，事件全部保留（仅受体积约束）。
        f64::MAX
    };
    let mut fold = UsageFold::default();
    let mut kept: Vec<String> = Vec::new();
    let mut pruned = 0usize;
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(entry) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let is_baseline = entry.get("type").and_then(Value::as_str) == Some("baseline");
        let ts = json_f64(entry.get("ts")).unwrap_or(0.0);
        if is_baseline || ts < cutoff {
            // 旧基线与过期事件一律折叠进新基线，不保留原文。
            fold_line(&mut fold, line);
            if !is_baseline {
                pruned += 1;
            }
        } else {
            kept.push(line.to_string());
        }
    }
    // 体积约束：从最旧事件开始继续折叠，直到文件体积达标。
    if max_mb > 0 {
        let max_bytes = (max_mb as usize) * 1024 * 1024;
        let mut size: usize = kept.iter().map(|line| line.len() + 1).sum();
        let mut drop_n = 0;
        while size > max_bytes && drop_n < kept.len() {
            size = size.saturating_sub(kept[drop_n].len() + 1);
            fold_line(&mut fold, &kept[drop_n]);
            drop_n += 1;
        }
        if drop_n > 0 {
            pruned += drop_n;
            kept.drain(..drop_n);
        }
    }
    if pruned == 0 {
        return;
    }
    // 原子重写：先写临时文件再改名，避免半途崩溃丢账本。
    let mut content = format!("{}\n", fold_to_baseline(&fold));
    for line in &kept {
        content.push_str(line);
        content.push('\n');
    }
    let tmp = path.with_extension("jsonl.tmp");
    let written = std::fs::write(&tmp, content).and_then(|_| std::fs::rename(&tmp, &path));
    if written.is_ok() {
        // 进程内折叠缓存的文件偏移已失效，重置后下次读取全量重折。
        *usage_fold().lock().unwrap() = UsageFold::default();
        add_request_log_entry(json!({
            "timestamp": now_secs(),
            "event": "log_prune",
            "error": format!("日志保留策略：{pruned} 条过期/超限账本事件已折叠进基线"),
        }));
    }
}

/// 追加一条账本事件；文件不存在时先落基线快照（存量累计并入账本）。
fn append_usage_event(entry: &Value) {
    let path = usage_events_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if !path.exists() {
        // create_new：并发进程同时首写时只有一个落基线，另一个直接追加（基线等价，无害）。
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&path)
        {
            let _ =
                std::io::Write::write_all(&mut file, format!("{}\n", usage_baseline()).as_bytes());
        }
    }
    if let Ok(mut file) = std::fs::OpenOptions::new().append(true).open(&path) {
        let _ = std::io::Write::write_all(&mut file, format!("{entry}\n").as_bytes());
    }
}

/// 把折叠结果写回 proxy_db 的展示缓存（计数 / 每日统计）。
///
/// 账本存在时权威覆盖：其它进程把 proxy_db.json 的累计字段冲掉后，
/// 下一次读取即按账本自愈（2026-10-05 实证反复被旧实例覆写）。
fn sync_usage_into_db(data: &mut Value, fold: &UsageFold) {
    if !fold.ledger_present {
        return;
    }
    for (is_upstream, keys_path) in [(true, "upstream_keys"), (false, "sub_api_keys")] {
        let Some(keys) = data.get_mut(keys_path).and_then(Value::as_array_mut) else {
            continue;
        };
        let folds = if is_upstream {
            &fold.upstream
        } else {
            &fold.sub
        };
        for key in keys.iter_mut() {
            let Some(key_id) = key.get("key_id").and_then(Value::as_str) else {
                continue;
            };
            let Some(totals) = folds.get(key_id) else {
                continue;
            };
            key["used_count"] = json!(totals.used);
            key["total_prompt_tokens"] = json!(totals.prompt);
            key["total_completion_tokens"] = json!(totals.completion);
            key["total_tokens"] = json!(totals.total);
            key["total_cached_tokens"] = json!(totals.cached);
            key["total_credits"] = json!((totals.credits * 10000.0).round() / 10000.0);
        }
    }
    let daily_stats = data
        .as_object_mut()
        .map(|root| {
            root.entry("daily_stats".to_string())
                .or_insert_with(|| json!({}))
        })
        .and_then(Value::as_object_mut);
    if let Some(daily_stats) = daily_stats {
        for (is_upstream, category) in [(true, "upstream"), (false, "sub")] {
            let folds = if is_upstream {
                &fold.daily_upstream
            } else {
                &fold.daily_sub
            };
            let mut by_key = serde_json::Map::new();
            for ((key_id, date), totals) in folds {
                let day = by_key
                    .entry(key_id.clone())
                    .or_insert_with(|| json!({}))
                    .as_object_mut();
                if let Some(day) = day {
                    day.insert(
                        date.clone(),
                        json!({
                            "prompt_tokens": totals.prompt,
                            "completion_tokens": totals.completion,
                            "total_tokens": totals.total,
                            "cached_tokens": totals.cached,
                            "credits": (totals.credits * 10000.0).round() / 10000.0,
                            "count": totals.used,
                        }),
                    );
                }
            }
            daily_stats.insert(category.to_string(), Value::Object(by_key));
        }
    }
}

/// 清零一个子 Key 的累计用量（次数 / Token / 积分）：账本落清零标记，
/// 不晚于该时刻的该 Key 事件不再计入；限额检查随下一次读取回到零基线。
pub fn reset_sub_key_usage(key_id: &str) {
    append_usage_event(
        &json!({"type": "reset", "scope": "sub", "key_id": key_id, "ts": now_secs()}),
    );
    let mut db = lock_db();
    db.save();
}

/// 子 Key 的模型维度统计：总调用次数、各模型调用次数 / Token / 占比。
///
/// 数据来自事件账本折叠（权威源）；旧事件无 model 字段归 "unknown"。
/// 占比保留两位小数（×100 后四舍五入到 0.01%）。
pub fn sub_key_model_stats(key_id: &str) -> Value {
    fold_usage_events();
    let fold = usage_fold().lock().unwrap();
    let mut models: Vec<(String, KeyFold)> = fold
        .sub_model
        .iter()
        .filter(|((id, _), _)| id == key_id)
        .map(|((_, model), totals)| (model.clone(), *totals))
        .collect();
    // 次数降序，次数相同按 Token 降序。
    models.sort_by(|a, b| {
        b.1.used
            .cmp(&a.1.used)
            .then_with(|| b.1.total.cmp(&a.1.total))
    });
    let total_count: u64 = models.iter().map(|(_, t)| t.used).sum();
    let total_tokens: u64 = models.iter().map(|(_, t)| t.total).sum();
    let pct = |part: u64, whole: u64| {
        if whole > 0 {
            (part as f64 * 10000.0 / whole as f64).round() / 100.0
        } else {
            0.0
        }
    };
    let rows: Vec<Value> = models
        .iter()
        .map(|(model, t)| {
            json!({
                "model": model,
                "count": t.used,
                "total_tokens": t.total,
                "prompt_tokens": t.prompt,
                "completion_tokens": t.completion,
                "cached_tokens": t.cached,
                "credits": (t.credits * 10000.0).round() / 10000.0,
                "count_pct": pct(t.used, total_count),
                "token_pct": pct(t.total, total_tokens),
            })
        })
        .collect();
    json!({
        "key_id": key_id,
        "total_count": total_count,
        "total_tokens": total_tokens,
        "models": rows,
    })
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

/// 批量并发刷新上限（积分 / 状态检测共用）：太小提速不明显，太大容易被上游风控。
const BULK_QUERY_CONCURRENCY: usize = 8;

/// 批量刷新所有上游 Key 积分（8 路并发）。返回 {success, failed}。
pub async fn refresh_all_key_points() -> Value {
    use futures_util::stream::{self, StreamExt};
    let keys: Vec<Value> = list_upstream_keys()
        .into_iter()
        .filter(|key| {
            !key
                .get("api_key")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .is_empty()
        })
        .collect();
    let results = stream::iter(keys.into_iter().map(|key| async move {
        let api_key = key
            .get("api_key")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        (api_key, query_key_points(&key).await)
    }))
    .buffer_unordered(BULK_QUERY_CONCURRENCY)
    .collect::<Vec<_>>()
    .await;
    let mut success = 0;
    let mut failed = 0;
    for (api_key, result) in results {
        match result {
            Some((remaining, total, packages)) => {
                sync_quota_to_key(&api_key, remaining, total, Some(&packages));
                success += 1;
            }
            None => failed += 1,
        }
    }
    json!({"success": success, "failed": failed})
}

/// 单个 Key 状态探测结果。
enum ProbeOutcome {
    Normal,
    Abnormal,
    Failed,
}

/// 批量检测上游 Key 风控状态（最轻量 chat 请求，8 路并发）。返回 {normal, abnormal, failed}。
pub async fn check_all_key_status() -> Value {
    use futures_util::stream::{self, StreamExt};
    let keys: Vec<Value> = list_upstream_keys()
        .into_iter()
        .filter(|k| {
            matches!(
                k.get("status").and_then(Value::as_str),
                Some("active" | "cooldown" | "rate_limited")
            ) && k.get("api_key").and_then(Value::as_str).is_some()
        })
        .collect();
    let outcomes = stream::iter(keys.into_iter().map(|key| async move {
        let api_key = key
            .get("api_key")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let key_id = key
            .get("key_id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let upstream = upstream_url();
        // 探测请求同样带官方渠道头，否则 11128 会让全部 Key 被误判 failed。
        let mut probe_builder = proxy_http()
            .post(format!("{upstream}{UPSTREAM_CHAT_PATH}"))
            .header("Content-Type", "application/json")
            .header("Authorization", format!("Bearer {api_key}"));
        for (name, value) in channel_headers(&key) {
            probe_builder = probe_builder.header(name, value);
        }
        let result = probe_builder
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
        let outcome = match result {
            Ok(resp) => {
                let status = resp.status().as_u16();
                let body = resp.text().await.unwrap_or_default();
                if status == 200 || status == 429 {
                    ProbeOutcome::Normal
                } else if status == 403 && body.contains("\"code\":11140") {
                    ProbeOutcome::Abnormal
                } else {
                    ProbeOutcome::Failed
                }
            }
            Err(_) => ProbeOutcome::Failed,
        };
        (key_id, outcome)
    }))
    .buffer_unordered(BULK_QUERY_CONCURRENCY)
    .collect::<Vec<_>>()
    .await;
    let mut normal = 0;
    let mut abnormal = 0;
    let mut failed = 0;
    for (key_id, outcome) in outcomes {
        match outcome {
            ProbeOutcome::Normal => normal += 1,
            ProbeOutcome::Abnormal => {
                update_upstream_key(&key_id, &json!({"status": "abnormal"}));
                abnormal += 1;
            }
            ProbeOutcome::Failed => failed += 1,
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
    /// sub_key_id → (分钟窗口, 窗口内已放行请求数)，子 Key RPM 限流。
    rpm_windows: Mutex<HashMap<String, (u64, u64)>>,
}

/// 固定分钟窗口的 RPM 限流：`true` = 放行（并已计数），`false` = 本分钟额度已用完。
///
/// `rpm == 0` 视为不限（兼容旧数据）；窗口按 epoch 分钟切换即重置。
fn rpm_allow(
    windows: &mut HashMap<String, (u64, u64)>,
    sub_key_id: &str,
    rpm: u64,
    now: u64,
) -> bool {
    if rpm == 0 {
        return true;
    }
    let window = now / 60;
    let entry = windows.entry(sub_key_id.to_string()).or_insert((window, 0));
    if entry.0 != window {
        *entry = (window, 0);
    }
    if entry.1 >= rpm {
        return false;
    }
    entry.1 += 1;
    true
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
/// key_mode：1 专一（粘住一个用到不可用）/ 2 临期优先 / 3 轮询 / 4 会话亲和 / 5 低分优先。
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
        5 => {
            // 低分优先：剩余积分最少的 Key 优先（无积分信息排最后）；并发数为次级排序键。
            let concurrency = |k: &Value| {
                concurrent_count(runtime, k.get("key_id").and_then(Value::as_str).unwrap_or(""))
            };
            available.sort_by(|a, b| {
                remaining_points(a)
                    .partial_cmp(&remaining_points(b))
                    .unwrap_or(std::cmp::Ordering::Equal)
                    .then_with(|| concurrency(a).cmp(&concurrency(b)))
            });
            available.into_iter().next()
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

/// 该 Key 的剩余积分（`points` 字段 "remaining/total" 的 remaining）；无积分信息排最后。
fn remaining_points(key: &Value) -> f64 {
    key.get("points")
        .and_then(Value::as_str)
        .and_then(|points| points.split('/').next())
        .and_then(|remaining| remaining.trim().parse::<f64>().ok())
        .unwrap_or(f64::MAX)
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

/// 把上游错误体清洗成 OpenAI 风格 error JSON 字符串（返回给客户端用）。
///
/// 只取人类可读的 `msg`（400 时优先 `displayMsg.zh`，11128 的 msg 是英文内部文案），
/// 剥离 `code`/`requestId` 等上游内部字段；绝不拼接上游 Key 的 label / key_id / api_key。
/// 401/403 不透传上游 msg（避免泄露上游鉴权细节），维持通用文案。
fn sanitize_upstream_error(status: u16, body_text: &str) -> String {
    let parsed: Option<Value> = serde_json::from_str(body_text).ok();
    let field = |name: &str| {
        parsed
            .as_ref()
            .and_then(|body| body.get(name).and_then(Value::as_str))
            .map(str::to_string)
    };
    let msg = field("msg");
    let msg_zh = parsed
        .as_ref()
        .and_then(|body| body.pointer("/displayMsg/zh"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let (kind, message) = match status {
        429 => (
            "rate_limit_exceeded",
            msg.or(msg_zh)
                .unwrap_or_else(|| "请求频率超限，请稍后重试".to_string()),
        ),
        400 => (
            "upstream_bad_request",
            msg_zh
                .or(msg)
                .unwrap_or_else(|| "上游拒绝请求，可能是参数问题".to_string()),
        ),
        401 | 403 => (
            "upstream_auth_error",
            "上游认证失败，请检查上游 Key 是否有效".to_string(),
        ),
        _ => (
            "upstream_error",
            msg.or(msg_zh)
                .unwrap_or_else(|| format!("上游返回错误（{status}）")),
        ),
    };
    json!({"error": {"message": message, "type": kind}}).to_string()
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
            "/v1/key/info",
            get(key_info_handler).options(options_handler),
        )
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

/// GET /v1/key/info：子 Key 自查——限额 / 已用 / 支持模型。
///
/// 脱敏红线：只返回该子 Key 自身信息；不返回 allowed_key_ids 明细，
/// 不暴露上游 Key 的 label / 余额 / 状态。透传模式无真实子 Key，按 404 处理。
async fn key_info_handler(State(state): State<ProxyState>, headers: HeaderMap) -> Response {
    let Some(sub_key) = authenticate(&state, &headers) else {
        // 与 chat 一致：open 模式返回 401，本地模式避免触发客户端重登录用 503。
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
    if sub_key.get("key_id").and_then(Value::as_str) == Some("_passthrough_") {
        return json_response(
            StatusCode::NOT_FOUND,
            json!({"error": {"message": "Endpoint not found", "type": "not_found"}}),
        );
    }
    let u64_of = |field: &str| sub_key.get(field).and_then(Value::as_u64).unwrap_or(0);
    let f64_of = |field: &str| sub_key.get(field).and_then(Value::as_f64).unwrap_or(0.0);
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
    // 空 = 不限制，返回全量支持列表，客户端无需关心空数组语义。
    let models: Vec<&str> = SUPPORTED_MODELS
        .iter()
        .copied()
        .filter(|m| allowed.is_empty() || allowed.iter().any(|a| a == m))
        .collect();
    json_response(
        StatusCode::OK,
        json!({
            "object": "key.info",
            "label": sub_key.get("label").and_then(Value::as_str).unwrap_or(""),
            "limits": {
                "max_usage": u64_of("max_usage"),
                "max_tokens": u64_of("max_tokens"),
                "max_credits": f64_of("max_credits"),
                "rate_limit_rpm": u64_of("rate_limit_rpm"),
            },
            "usage": {
                "used_count": u64_of("used_count"),
                "total_prompt_tokens": u64_of("total_prompt_tokens"),
                "total_completion_tokens": u64_of("total_completion_tokens"),
                "total_tokens": u64_of("total_tokens"),
                "total_cached_tokens": u64_of("total_cached_tokens"),
                "total_credits": f64_of("total_credits"),
            },
            "allowed_models": models,
            "allowed_all_models": allowed.is_empty(),
            "limits_note": "limits 中 0 表示不限",
        }),
    )
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
                // 门槛同样容忍字符串数字：否则整个 usage 对象被丢弃，Token / 积分一并漏记。
                if json_u64(usage.get("prompt_tokens")).is_some() {
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

// ---------------------------------------------------------------------------
// 子 Key 限额（次数 / Token / 积分）
// ---------------------------------------------------------------------------

/// 子 Key 累计用量的超限判定结果。
///
/// 三个维度同一结构：`max_* <= 0` 视为不限，已用量**达到**上限即拒绝；
/// 判定顺序固定为 次数 → Token → 积分，命中即返回，429 文案与既有客户端约定一致。
#[derive(Debug, PartialEq)]
enum SubKeyLimit {
    Usage { used: u64, max: u64 },
    Tokens { used: u64, max: u64 },
    Credits { used: f64, max: f64 },
}

impl SubKeyLimit {
    fn message(&self) -> &'static str {
        match self {
            SubKeyLimit::Usage { .. } => "Usage limit exceeded",
            SubKeyLimit::Tokens { .. } => "Token limit exceeded",
            SubKeyLimit::Credits { .. } => "Credit limit exceeded",
        }
    }
}

/// 累计限额检查（纯函数）：次数（`used_count` / `max_usage`）→ Token（`total_tokens` /
/// `max_tokens`）→ 积分（`total_credits` / `max_credits`），全部维度未超限返回 `None`。
fn check_sub_key_limits(sub_key: &Value) -> Option<SubKeyLimit> {
    let u64_of = |field: &str| sub_key.get(field).and_then(Value::as_u64).unwrap_or(0);
    let max_usage = u64_of("max_usage");
    let used = u64_of("used_count");
    if max_usage > 0 && used >= max_usage {
        return Some(SubKeyLimit::Usage {
            used,
            max: max_usage,
        });
    }
    let max_tokens = u64_of("max_tokens");
    let used_tokens = u64_of("total_tokens");
    if max_tokens > 0 && used_tokens >= max_tokens {
        return Some(SubKeyLimit::Tokens {
            used: used_tokens,
            max: max_tokens,
        });
    }
    let f64_of = |field: &str| sub_key.get(field).and_then(Value::as_f64).unwrap_or(0.0);
    let max_credits = f64_of("max_credits");
    let used_credits = f64_of("total_credits");
    if max_credits > 0.0 && used_credits >= max_credits {
        return Some(SubKeyLimit::Credits {
            used: used_credits,
            max: max_credits,
        });
    }
    None
}

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

    // 2. 子 Key 状态与用量上限（透传模式跳过）：次数 → Token → 积分，见 check_sub_key_limits。
    if !is_passthrough {
        if let Some(limit) = check_sub_key_limits(&sub_key) {
            return json_response(
                StatusCode::TOO_MANY_REQUESTS,
                json!({"error": {"message": limit.message(), "type": "rate_limit"}}),
            );
        }
        // RPM 限流（每分钟固定窗口，0 = 不限）。
        let rpm = sub_key
            .get("rate_limit_rpm")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let sub_key_id = sub_key
            .get("key_id")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let allowed = rpm_allow(
            &mut state.runtime.rpm_windows.lock().unwrap(),
            sub_key_id,
            rpm,
            now_secs() as u64,
        );
        if !allowed {
            return json_response(
                StatusCode::TOO_MANY_REQUESTS,
                json!({"error": {"message": format!("Rate limit exceeded ({rpm} rpm)"), "type": "rate_limit"}}),
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

    // 日志问答内容开关（默认开）：关闭时 end 日志不写 question/answer。
    let log_content_enabled = get_settings()
        .get("log_content_enabled")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let question = if log_content_enabled {
        truncate_chars(&extract_last_user_text(&request), LOG_CONTENT_MAX_CHARS)
    } else {
        String::new()
    };

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

        // 官方渠道标识头：缺失会被上游网关判为「未批准渠道」（400 code 11128）。
        let mut send_builder = proxy_http()
            .post(&target_url)
            .header("Content-Type", "application/json")
            .header("Authorization", format!("Bearer {api_key}"))
            .header("X-Request-ID", uuid::Uuid::new_v4().simple().to_string());
        for (name, value) in channel_headers(&upstream_key) {
            send_builder = send_builder.header(name, value);
        }
        let send_result = send_builder
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
                last_error = sanitize_upstream_error(status, &body_text);
                last_status = StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_GATEWAY);
                continue;
            }
            tried.insert(key_id.clone());
            // 上游 4xx 认证错误不能原样转发给客户端（会触发重登录），统一转 502；
            // 错误体统一清洗：透传可读 msg、剥离内部字段、不掺 Key 信息。
            last_status = match status {
                401 | 403 | 400 => StatusCode::BAD_GATEWAY,
                other => StatusCode::from_u16(other).unwrap_or(StatusCode::BAD_GATEWAY),
            };
            last_error = sanitize_upstream_error(status, &body_text);
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
            let question_task = question.clone();
            tokio::spawn(async move {
                let mut scan = UsageScan::new();
                // 同步聚合回复文本（日志 answer 用），与转发互不干扰。
                let mut collector = SseCollector::default();
                scan.feed(&first_text);
                collector.feed(&first_text);
                let mut client_gone = tx.send(Ok(first_chunk)).await.is_err();
                while let Some(item) = stream.next().await {
                    match item {
                        Ok(bytes) => {
                            let text = String::from_utf8_lossy(&bytes).to_string();
                            scan.feed(&text);
                            collector.feed(&text);
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
                    &question_task,
                    &truncate_chars(&collector.content, LOG_CONTENT_MAX_CHARS),
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
        let mut collector = SseCollector::default();
        scan.feed(&first_text);
        collector.feed(&first_text);
        let mut model_name = model.clone();
        while let Some(item) = stream.next().await {
            match item {
                Ok(bytes) => {
                    let text = String::from_utf8_lossy(&bytes).to_string();
                    scan.feed(&text);
                    collector.feed(&text);
                }
                Err(_) => break,
            }
        }
        if !collector.model_name.is_empty() {
            model_name = collector.model_name.clone();
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
            &question,
            &truncate_chars(&collector.content, LOG_CONTENT_MAX_CHARS),
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
                "id": if collector.chat_id.is_empty() { format!("chatcmpl-{}", &uuid::Uuid::new_v4().simple().to_string()[..16]) } else { collector.chat_id.clone() },
                "object": "chat.completion",
                "created": now_secs() as u64,
                "model": model_name,
                "choices": [{
                    "index": 0,
                    "message": {
                        "role": "assistant",
                        "content": collector.content.clone(),
                        "reasoning_content": collector.reasoning.clone(),
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

/// 带跨 chunk 残留缓冲的 SSE 聚合器（content / reasoning / id / model）。
///
/// 取代逐 chunk 调用的 collect_sse_text：后者按「每次喂入的文本」按行解析，
/// data 行被 TCP 分包截断时该行永远不完整、内容永久丢失（2026-10-06 实证：
/// 大上下文流式请求日志「有问无答」——回复集中在少数几行，一行被截断就全丢）。
/// 本结构与 UsageScan 同款思路：不完整行留在 tail 等下次拼接。
#[derive(Default)]
struct SseCollector {
    tail: String,
    content: String,
    reasoning: String,
    chat_id: String,
    model_name: String,
}

impl SseCollector {
    fn feed(&mut self, chunk: &str) {
        self.tail.push_str(chunk);
        while let Some(pos) = self.tail.find('\n') {
            let line: String = self.tail.drain(..=pos).collect();
            let Some(data) = line.trim().strip_prefix("data: ") else {
                continue;
            };
            if data == "[DONE]" {
                continue;
            }
            let Ok(chunk) = serde_json::from_str::<Value>(data) else {
                continue;
            };
            if let Some(id) = chunk.get("id").and_then(Value::as_str) {
                self.chat_id = id.to_string();
            }
            if let Some(m) = chunk.get("model").and_then(Value::as_str) {
                self.model_name = m.to_string();
            }
            for choice in chunk
                .get("choices")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
            {
                let delta = choice.get("delta").cloned().unwrap_or(json!({}));
                if let Some(content) = delta.get("content").and_then(Value::as_str) {
                    self.content.push_str(content);
                }
                if let Some(reasoning) = delta.get("reasoning_content").and_then(Value::as_str) {
                    self.reasoning.push_str(reasoning);
                }
            }
        }
        // tail 防御性上限（畸形流永远不换行时不至于撑爆内存）。
        if self.tail.len() > 65536 {
            self.tail.clear();
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
    // 启动时执行一次日志保留策略（过期/超限账本事件折叠进基线后重写）。
    prune_usage_ledger();
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

#[cfg(test)]
mod tests {
    use super::*;

    /// 该厂商接口常把数字序列化成字符串：解析必须两种形态都收，
    /// 否则积分 / Token 记成 0，子 Key 上限永不触发（2026-10-05 本机实证）。
    #[test]
    fn json_numbers_accept_both_numeric_and_string_forms() {
        assert_eq!(json_u64(Some(&json!(123))), Some(123));
        assert_eq!(json_u64(Some(&json!("123"))), Some(123));
        assert_eq!(json_u64(Some(&json!(" 123 "))), Some(123));
        assert_eq!(json_u64(Some(&json!("12.3"))), None);
        assert_eq!(json_u64(Some(&json!("abc"))), None);
        assert_eq!(json_u64(Some(&json!(true))), None);
        assert_eq!(json_u64(None), None);

        assert_eq!(json_f64(Some(&json!(1.5))), Some(1.5));
        assert_eq!(json_f64(Some(&json!(2))), Some(2.0));
        assert_eq!(json_f64(Some(&json!("1.25"))), Some(1.25));
        assert_eq!(json_f64(Some(&json!("abc"))), None);
        assert_eq!(json_f64(None), None);
    }

    /// usage 全字段字符串形态时仍须完整入账；total 缺失 / 为 0 时用 prompt + completion 兜底。
    #[test]
    fn usage_numbers_tolerate_string_fields_and_backfill_the_total() {
        let usage = json!({
            "prompt_tokens": "100",
            "completion_tokens": "50",
            "total_tokens": "150",
            "cached_tokens": "20",
            "credit": "1.25",
        });
        assert_eq!(usage_numbers(&usage), (100, 50, 150, 20, 1.25));

        // 缺 total_tokens / total_tokens 为 0 → prompt + completion。
        let usage = json!({"prompt_tokens": 100, "completion_tokens": 50});
        assert_eq!(usage_numbers(&usage).2, 150);
        let usage = json!({"prompt_tokens": 100, "completion_tokens": 50, "total_tokens": 0});
        assert_eq!(usage_numbers(&usage).2, 150);

        // credit 缺失 → 0；cached 兼容 prompt_cache_hit_tokens。
        let usage = json!({"prompt_tokens": 1, "prompt_cache_hit_tokens": 1});
        assert_eq!(usage_numbers(&usage), (1, 0, 1, 1, 0.0));

        // cached 兼容 OpenAI 嵌套 prompt_tokens_details.cached_tokens（含数字字符串）。
        let usage = json!({"prompt_tokens": 10, "prompt_tokens_details": {"cached_tokens": 6}});
        assert_eq!(usage_numbers(&usage).3, 6);
        let usage = json!({"prompt_tokens": 10, "prompt_tokens_details": {"cached_tokens": "7"}});
        assert_eq!(usage_numbers(&usage).3, 7);
        // 顶层字段优先于嵌套字段。
        let usage = json!({"prompt_tokens": 10, "cached_tokens": 3, "prompt_tokens_details": {"cached_tokens": 6}});
        assert_eq!(usage_numbers(&usage).3, 3);
    }

    /// usage 采纳门槛同样容忍字符串数字：否则整个 usage 对象被丢弃，Token / 积分一并漏记。
    #[test]
    fn usage_scan_accepts_usage_chunks_with_string_typed_numbers() {
        let mut scan = UsageScan::new();
        scan.feed("data: {\"choices\":[],\"usage\":{\"prompt_tokens\":\"100\",\"completion_tokens\":\"50\",\"total_tokens\":\"150\",\"credit\":\"0.5\"}}\n\n");
        assert_eq!(
            usage_numbers(&scan.usage),
            (100, 50, 150, 0, 0.5),
            "字符串形态的 usage 不得被整条丢弃"
        );

        // data 行被 TCP 分包截断时靠 tail 拼接，仍须采纳入账。
        let mut scan = UsageScan::new();
        scan.feed("data: {\"usage\":{\"prompt_to");
        scan.feed("kens\": 7, \"completion_tokens\": 3}}\n");
        assert_eq!(usage_numbers(&scan.usage).0, 7);

        // 没有 prompt_tokens 的 usage（如 null 占位）不采纳。
        let mut scan = UsageScan::new();
        scan.feed("data: {\"usage\":null}\ndata: [DONE]\n");
        assert!(scan.usage.is_null());
    }

    /// 总览以 daily_stats 全量历史为准：已删除 Key（daily 里没有对应上游 Key）的消耗
    /// 仍计入累计与今日，不得回退（2026-10-05 用户实证「今日积分消耗回退」）。
    #[test]
    fn daily_summary_counts_deleted_keys_and_splits_today() {
        let daily = json!({
            "ck_alive": {
                "2026-10-05": {"count": 2, "prompt_tokens": 100, "completion_tokens": 50, "total_tokens": 150, "cached_tokens": 10, "credits": 1.5},
                "2026-10-04": {"count": 1, "prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15, "cached_tokens": 0, "credits": 0.5}
            },
            // 已删除的 Key：记录必须仍被计入。
            "ck_deleted": {
                "2026-10-05": {"count": 3, "prompt_tokens": 300, "completion_tokens": 60, "total_tokens": 360, "cached_tokens": 0, "credits": 2.0}
            }
        });
        let totals = sum_daily_stats(&daily, "2026-10-05");
        assert_eq!(totals.requests, 6.0);
        assert_eq!(totals.tokens, 525.0);
        assert_eq!(totals.credits, 4.0);
        assert_eq!(totals.prompt, 410.0);
        assert_eq!(totals.completion, 115.0);
        assert_eq!(totals.cached, 10.0);
        assert_eq!(totals.today_requests, 5.0);
        assert_eq!(totals.today_tokens, 510.0);
        assert_eq!(totals.today_credits, 3.5);
    }

    /// RPM 限流：窗口内计数到上限即拒绝，跨分钟窗口重置，0 = 不限。
    #[test]
    fn rpm_limit_counts_per_minute_and_resets_each_window() {
        let mut windows = HashMap::new();
        // rpm = 2：前两次放行，第三次拒绝。
        assert!(rpm_allow(&mut windows, "sk_a", 2, 61));
        assert!(rpm_allow(&mut windows, "sk_a", 2, 61));
        assert!(!rpm_allow(&mut windows, "sk_a", 2, 119));
        // 下一分钟窗口重置。
        assert!(rpm_allow(&mut windows, "sk_a", 2, 120));
        // 不同子 Key 互不影响。
        assert!(rpm_allow(&mut windows, "sk_b", 1, 120));
        assert!(!rpm_allow(&mut windows, "sk_b", 1, 120));
        // rpm = 0 视为不限（兼容旧数据）。
        for _ in 0..100 {
            assert!(rpm_allow(&mut windows, "sk_c", 0, 120));
        }
    }

    /// 多实例并发写：单调累计字段取最大合并，另一个进程的旧内存整文件覆写不得冲掉
    /// 本进程累计的 Token / 积分（2026-10-05 实证「积分被冲成当次请求的值」）。
    #[test]
    fn merge_keeps_the_larger_counters_and_never_resurrects_deleted_keys() {
        let mut ours = json!({
            "upstream_keys": [
                {"key_id": "ck_a", "used_count": 100, "total_tokens": 5000, "total_credits": 3.5, "last_used_at": "2026-10-05T22:00:00+08:00", "status": "active"},
            ],
            "sub_api_keys": [
                {"key_id": "sk_a", "used_count": 60, "total_tokens": 3000, "total_credits": 1.2},
            ],
            "daily_stats": {
                "upstream": {
                    "ck_a": {"2026-10-05": {"count": 100, "credits": 3.5, "total_tokens": 5000}},
                    "ck_ours_only": {"2026-10-05": {"count": 1, "credits": 0.1, "total_tokens": 10}}
                }
            },
            "request_logs": [
                {"timestamp": 3.0, "event": "end", "sub_key_id": "sk_a"},
                {"timestamp": 1.0, "event": "end", "sub_key_id": "sk_a"}
            ],
            // 本测试聚焦合并语义，显式关闭保留策略（否则合成时间戳会被按天数清掉）。
            "settings": {"log_retention_days": 0, "log_retention_max_mb": 0},
        });
        // 另一进程的旧内存：计数整体更小、日志只有更早的一条、还有一个本进程已删除的 Key。
        let disk = json!({
            "upstream_keys": [
                {"key_id": "ck_a", "used_count": 80, "total_tokens": 4000, "total_credits": 1.0, "last_used_at": "2026-10-05T21:00:00+08:00", "status": "disabled"},
                {"key_id": "ck_deleted", "used_count": 999, "total_tokens": 999, "total_credits": 9.0}
            ],
            "sub_api_keys": [
                {"key_id": "sk_a", "used_count": 80, "total_tokens": 3500, "total_credits": 0.4},
            ],
            "daily_stats": {
                "upstream": {
                    "ck_a": {"2026-10-05": {"count": 80, "credits": 1.0, "total_tokens": 4000}, "2026-10-04": {"count": 7, "credits": 0.7, "total_tokens": 70}},
                    "ck_deleted": {"2026-10-05": {"count": 9, "credits": 0.9, "total_tokens": 90}}
                },
                "sub": {"sk_a": {"2026-10-05": {"count": 80, "credits": 0.4, "total_tokens": 3500}}}
            },
            "request_logs": [
                {"timestamp": 1.0, "event": "end", "sub_key_id": "sk_a"},
                {"timestamp": 2.0, "event": "end", "sub_key_id": "sk_b"}
            ],
        });
        merge_monotonic_fields(&mut ours, &disk);

        // 本进程更大的计数原样保留（不被旧值冲掉）；磁盘更大的字段被吸收。
        let ck_a = &ours["upstream_keys"][0];
        assert_eq!(ck_a["used_count"], json!(100));
        assert_eq!(ck_a["total_tokens"], json!(5000));
        assert_eq!(ck_a["total_credits"], json!(3.5));
        assert_eq!(ck_a["status"], json!("active"), "状态字段以本进程为准");
        let sk_a = &ours["sub_api_keys"][0];
        assert_eq!(sk_a["used_count"], json!(80), "磁盘更大的计数要吸收");
        assert_eq!(sk_a["total_tokens"], json!(3500));
        assert_eq!(sk_a["total_credits"], json!(1.2), "积分取最大");
        // 磁盘上多出来的 Key 不得复活（本进程可能刚删除它）。
        assert_eq!(ours["upstream_keys"].as_array().unwrap().len(), 1);
        // 每日统计：同日期取最大，磁盘独有的日期 / 类别并入。
        let upstream_daily = &ours["daily_stats"]["upstream"]["ck_a"];
        assert_eq!(upstream_daily["2026-10-05"]["count"], json!(100));
        assert_eq!(upstream_daily["2026-10-04"]["count"], json!(7));
        assert_eq!(
            ours["daily_stats"]["sub"]["sk_a"]["2026-10-05"]["count"],
            json!(80)
        );
        // 日志：并集去重、按时间排序。
        let logs = ours["request_logs"].as_array().unwrap();
        assert_eq!(logs.len(), 3);
        let stamps: Vec<f64> = logs
            .iter()
            .map(|entry| entry["timestamp"].as_f64().unwrap())
            .collect();
        assert_eq!(stamps, vec![1.0, 2.0, 3.0]);
    }

    /// 限额判定：次数 → Token → 积分的固定顺序；`used == max` 即拒绝；0 / 缺省 = 不限。
    #[test]
    fn sub_key_limits_hit_in_order_and_respect_zero_as_unlimited() {
        // 全部不设限 → 放行。
        assert_eq!(check_sub_key_limits(&json!({})), None);
        assert_eq!(
            check_sub_key_limits(
                &json!({"max_usage": 0, "used_count": 999, "max_tokens": 0, "total_tokens": 999, "max_credits": 0.0, "total_credits": 999.0})
            ),
            None
        );
        // 次数优先命中。
        assert_eq!(
            check_sub_key_limits(
                &json!({"max_usage": 10, "used_count": 10, "max_tokens": 5, "total_tokens": 9})
            ),
            Some(SubKeyLimit::Usage { used: 10, max: 10 })
        );
        // 次数未超限 → Token 命中。
        assert_eq!(
            check_sub_key_limits(
                &json!({"max_usage": 10, "used_count": 9, "max_tokens": 100, "total_tokens": 100})
            ),
            Some(SubKeyLimit::Tokens {
                used: 100,
                max: 100
            })
        );
        // 积分命中（达到上限即拒绝）。
        assert_eq!(
            check_sub_key_limits(&json!({"max_credits": 2.5, "total_credits": 2.5})),
            Some(SubKeyLimit::Credits {
                used: 2.5,
                max: 2.5
            })
        );
        // 差一点也不拒绝。
        assert_eq!(
            check_sub_key_limits(
                &json!({"max_usage": 10, "used_count": 9, "max_tokens": 100, "total_tokens": 99, "max_credits": 2.5, "total_credits": 2.49})
            ),
            None
        );
        assert_eq!(
            SubKeyLimit::Usage { used: 1, max: 1 }.message(),
            "Usage limit exceeded"
        );
        assert_eq!(
            SubKeyLimit::Tokens { used: 1, max: 1 }.message(),
            "Token limit exceeded"
        );
        assert_eq!(
            SubKeyLimit::Credits {
                used: 1.0,
                max: 1.0
            }
            .message(),
            "Credit limit exceeded"
        );
    }

    /// 清空日志墓碑：合并时早于墓碑的条目不得被另一进程的旧日志带回来；
    /// 墓碑取双方较大者，晚于墓碑的新日志保留。
    #[test]
    fn cleared_logs_stay_cleared_across_merges() {
        let mut ours = json!({
            "request_logs": [{"timestamp": 150.0, "event": "end", "note": "ours-new"}],
            "logs_cleared_at": 100.0,
            // 合成时间戳是远古时间，关闭保留策略以免干扰墓碑语义断言。
            "settings": {"log_retention_days": 0, "log_retention_max_mb": 0},
        });
        let disk = json!({
            "request_logs": [
                {"timestamp": 80.0, "event": "end", "note": "disk-old"},
                {"timestamp": 120.0, "event": "end", "note": "disk-new"}
            ],
        });
        merge_monotonic_fields(&mut ours, &disk);
        let logs = ours["request_logs"].as_array().unwrap();
        assert_eq!(logs.len(), 2, "早于墓碑的 disk-old 不得复活：{logs:?}");
        assert_eq!(logs[0]["note"], json!("disk-new"));
        assert_eq!(logs[1]["note"], json!("ours-new"));
        assert_eq!(ours["logs_cleared_at"], json!(100.0), "墓碑必须随合并保留");

        // 磁盘上有更大的墓碑（另一实例后清的）→ 采纳大墓碑，中间段落一并清掉。
        let mut ours = json!({
            "request_logs": [{"timestamp": 150.0, "event": "end"}],
            "logs_cleared_at": 100.0,
            "settings": {"log_retention_days": 0, "log_retention_max_mb": 0},
        });
        let disk = json!({"request_logs": [], "logs_cleared_at": 200.0});
        merge_monotonic_fields(&mut ours, &disk);
        assert!(ours["request_logs"].as_array().unwrap().is_empty());
        assert_eq!(ours["logs_cleared_at"], json!(200.0));
    }

    /// 日志保留策略：超期条目被删除、近期条目保留；体积超限从最旧开始删；0 = 不限制。
    #[test]
    fn trim_request_logs_respects_days_and_size_limits() {
        let now = now_secs();
        let entry = |age_days: f64| json!({"timestamp": now - age_days * 86400.0, "event": "end", "note": "x".repeat(64)});
        // 天数：7 天前的删掉，3 天内的保留；0 = 不按天数清理。
        let mut logs = vec![entry(10.0), entry(3.0), entry(1.0)];
        trim_request_logs(
            &mut logs,
            &json!({"log_retention_days": 7, "log_retention_max_mb": 0}),
        );
        assert_eq!(logs.len(), 2);
        let mut logs = vec![entry(10.0), entry(3.0)];
        trim_request_logs(
            &mut logs,
            &json!({"log_retention_days": 0, "log_retention_max_mb": 0}),
        );
        assert_eq!(logs.len(), 2, "0 = 不按天数清理");

        // 体积：1000 条 × 约 1.2KB ≈ 1.2MB > 1MB 上限（条数维度不触发），
        // 从最旧开始删到达标，最新的保留。生产日志按时间升序（最旧在前），此处同序构造。
        let mut logs: Vec<Value> = (0..1000)
            .rev()
            .map(|i| json!({"timestamp": now - i as f64, "event": "end", "note": "x".repeat(1200) , "seq": i}))
            .collect();
        trim_request_logs(
            &mut logs,
            &json!({"log_retention_days": 0, "log_retention_max_mb": 1}),
        );
        assert!(logs.len() < 1000, "超体积应删最旧：剩余 {}", logs.len());
        assert!(
            logs.len() > 600,
            "只删到达标为止，不应过度清理：剩余 {}",
            logs.len()
        );
        assert_eq!(logs.last().unwrap()["seq"], json!(0));
    }

    /// SseCollector：data 行被 TCP 分包截断时不丢内容（逐字节喂入也应完整聚合）。
    #[test]
    fn sse_collector_survives_split_lines() {
        let stream = "data: {\"id\":\"c1\",\"model\":\"glm-5.3\",\"choices\":[{\"delta\":{\"content\":\"你好\"}}]}\n\ndata: {\"choices\":[{\"delta\":{\"content\":\"，世界\"}}]}\n\ndata: [DONE]\n";
        let mut collector = SseCollector::default();
        // 逐字符喂入，模拟最恶劣的分包（生产侧字节级分包由 from_utf8_lossy 先行归并）。
        for ch in stream.chars() {
            collector.feed(&ch.to_string());
        }
        assert_eq!(collector.content, "你好，世界");
        assert_eq!(collector.chat_id, "c1");
        assert_eq!(collector.model_name, "glm-5.3");
    }

    /// 重载收敛：磁盘是配置权威（另一实例改了上限 / 新增 Key），
    /// 本进程已累计的计数与积分不得被磁盘的旧值冲掉。
    #[test]
    fn reload_adopts_disk_config_but_keeps_our_counters() {
        let ours = json!({
            "sub_api_keys": [
                {"key_id": "sk_a", "label": "旧标签", "max_credits": 100.0, "used_count": 50, "total_tokens": 9000, "total_credits": 7.5}
            ],
            "request_logs": [],
        });
        let disk = json!({
            "sub_api_keys": [
                {"key_id": "sk_a", "label": "新标签", "max_credits": 300.0, "used_count": 40, "total_tokens": 8000, "total_credits": 2.0},
                {"key_id": "sk_b", "label": "另一实例新建", "used_count": 1, "total_tokens": 10, "total_credits": 0.1}
            ],
            "request_logs": [],
        });
        let merged = converge_on_reload(&ours, &disk);
        let sk_a = &merged["sub_api_keys"][0];
        assert_eq!(sk_a["label"], json!("新标签"), "配置以磁盘为准");
        assert_eq!(sk_a["max_credits"], json!(300.0));
        assert_eq!(sk_a["used_count"], json!(50), "计数取最大，不得回退");
        assert_eq!(sk_a["total_tokens"], json!(9000));
        assert_eq!(sk_a["total_credits"], json!(7.5));
        assert_eq!(
            merged["sub_api_keys"].as_array().unwrap().len(),
            2,
            "另一实例新建的 Key 要同步进来"
        );

        // 写盘收敛：本进程是配置权威，磁盘的更大计数被吸收。
        let merged = converge_on_save(&ours, &disk);
        let sk_a = &merged["sub_api_keys"][0];
        assert_eq!(sk_a["label"], json!("旧标签"), "写盘时配置以本进程为准");
        assert_eq!(sk_a["used_count"], json!(50));
        assert_eq!(
            merged["sub_api_keys"].as_array().unwrap().len(),
            1,
            "写盘不采纳磁盘多出的 Key（防复活已删 Key）"
        );
    }

    /// 账本折叠：基线并入、逐请求累计、清零后只计清零之后的事件、透传不计。
    #[test]
    fn usage_ledger_folds_baseline_events_and_resets() {
        let mut fold = UsageFold::default();
        for line in [
            r#"{"type":"baseline","upstream":{"ck_a":{"used":10,"prompt":100,"completion":50,"total":150,"cached":0,"credits":1.0}},"daily_upstream":{"ck_a|2026-10-04":{"used":10,"prompt":100,"completion":50,"total":150,"cached":0,"credits":1.0}}}"#,
            r#"{"type":"end","ts":1000.0,"date":"2026-10-05","upstream":"ck_a","sub":"sk_a","prompt":10,"completion":5,"total":15,"cached":0,"credit":0.5}"#,
            r#"{"type":"end","ts":1001.0,"date":"2026-10-05","upstream":"ck_a","sub":"sk_a","prompt":20,"completion":5,"total":25,"cached":0,"credit":0.25}"#,
            r#"{"type":"reset","scope":"sub","key_id":"sk_a","ts":1002.0}"#,
            // 不晚于清零时刻的事件：不计入（时钟跳变 / 乱序也安全）。
            r#"{"type":"end","ts":1001.5,"date":"2026-10-05","sub":"sk_a","prompt":99,"completion":0,"total":99,"cached":0,"credit":9.9}"#,
            r#"{"type":"end","ts":1003.0,"date":"2026-10-05","sub":"sk_a","prompt":7,"completion":3,"total":10,"cached":0,"credit":0.1}"#,
            // 透传模式不计子 Key。
            r#"{"type":"end","ts":1004.0,"date":"2026-10-05","sub":"_passthrough_","prompt":1,"completion":1,"total":2,"cached":0,"credit":0.01}"#,
            // 坏行静默跳过。
            "{not json",
        ] {
            fold_line(&mut fold, line);
        }
        let up = &fold.upstream["ck_a"];
        assert_eq!((up.used, up.total, up.credits), (12, 190, 1.75));
        let sub = &fold.sub["sk_a"];
        assert_eq!(
            (sub.used, sub.total, sub.credits),
            (1, 10, 0.1),
            "清零后只计清零之后的事件"
        );
        assert!(!fold.sub.contains_key("_passthrough_"));
        assert_eq!(
            fold.daily_upstream[&("ck_a".to_string(), "2026-10-05".to_string())].used,
            2
        );
        assert_eq!(
            fold.daily_upstream[&("ck_a".to_string(), "2026-10-04".to_string())].used,
            10,
            "基线的每日统计并入"
        );
        // 重复基线不叠加（逐字段取最大）。
        fold_line(
            &mut fold,
            r#"{"type":"baseline","upstream":{"ck_a":{"used":10,"prompt":100,"completion":50,"total":150,"cached":0,"credits":1.0}}}"#,
        );
        assert_eq!(fold.upstream["ck_a"].used, 12);
    }

    /// 低分优先排序键：解析 "remaining/total"；空值 / 坏格式排最后。
    #[test]
    fn remaining_points_parses_quota_and_unknown_sorts_last() {
        assert_eq!(remaining_points(&json!({"points": "850/1000"})), 850.0);
        assert_eq!(remaining_points(&json!({"points": "0/1000"})), 0.0);
        assert_eq!(remaining_points(&json!({"points": " 12.5 /100"})), 12.5);
        assert_eq!(remaining_points(&json!({"points": ""})), f64::MAX);
        assert_eq!(remaining_points(&json!({"points": "abc"})), f64::MAX);
        assert_eq!(remaining_points(&json!({})), f64::MAX);
    }

    /// 账本回写：proxy_db 的累计字段被其它进程冲掉后，按折叠结果自愈重建。
    #[test]
    fn sync_usage_into_db_restores_clobbered_counters() {
        let mut fold = UsageFold {
            ledger_present: true,
            ..UsageFold::default()
        };
        fold.upstream.insert(
            "ck_a".to_string(),
            KeyFold {
                used: 66,
                prompt: 1000,
                completion: 500,
                total: 1500,
                cached: 10,
                credits: 7.25,
            },
        );
        fold.sub.insert(
            "sk_a".to_string(),
            KeyFold {
                used: 9,
                prompt: 90,
                completion: 10,
                total: 100,
                cached: 0,
                credits: 1.23456,
            },
        );
        fold.daily_sub.insert(
            ("sk_a".to_string(), "2026-10-05".to_string()),
            KeyFold {
                used: 9,
                prompt: 90,
                completion: 10,
                total: 100,
                cached: 0,
                credits: 1.23456,
            },
        );
        // 模拟被旧实例覆写后的 proxy_db：计数全被冲小。
        let mut data = json!({
            "upstream_keys": [{"key_id": "ck_a", "used_count": 1, "total_tokens": 5, "total_credits": 0.01, "status": "active"}],
            "sub_api_keys": [{"key_id": "sk_a", "used_count": 0, "total_tokens": 0, "total_credits": 0.0, "max_credits": 300.0}],
            "daily_stats": {"upstream": {}, "sub": {}},
        });
        sync_usage_into_db(&mut data, &fold);
        let ck = &data["upstream_keys"][0];
        assert_eq!(ck["used_count"], json!(66));
        assert_eq!(ck["total_tokens"], json!(1500));
        assert_eq!(ck["total_credits"], json!(7.25));
        assert_eq!(ck["status"], json!("active"), "非统计字段不动");
        let sk = &data["sub_api_keys"][0];
        assert_eq!(sk["used_count"], json!(9));
        assert_eq!(sk["total_credits"], json!(1.2346), "回写保留 4 位小数");
        assert_eq!(sk["max_credits"], json!(300.0), "限额配置不动");
        let day = &data["daily_stats"]["sub"]["sk_a"]["2026-10-05"];
        assert_eq!(day["count"], json!(9));
        assert_eq!(day["credits"], json!(1.2346));

        // 账本不存在：不动缓存（回退到 proxy_db 旧计数口径）。
        let mut data = json!({"sub_api_keys": [{"key_id": "sk_a", "used_count": 42}]});
        sync_usage_into_db(&mut data, &UsageFold::default());
        assert_eq!(data["sub_api_keys"][0]["used_count"], json!(42));
    }
}
