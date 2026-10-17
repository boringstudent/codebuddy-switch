//! 模型目录：从 CodeBuddy CN API 拉取全部模型列表及参数（思考强度 / max 模式），
//! 持久化到 `~/.wb-switch/model_catalog.json`，供 API 代理 `/v1/models` 与
//! 「模型管理」页面使用。
//!
//! 数据源优先级（逐个尝试，第一个返回非空模型数组的胜出）：
//! 1. 代理上游 `{upstream}/models`（OpenAI 兼容，DEFAULT_UPSTREAM = copilot.tencent.com/v2）；
//! 2. CodeBuddy CN 插件接口 `{cn_endpoint}/v2/plugin/models`。
//!
//! 鉴权用账号库中第一个带 access_token 的国内版账号；没有可用账号时返回明确错误。
//! 响应结构以官方返回为准（字段可能随版本变化）：解析时对每个模型保留 `raw` 原文，
//! 并尽量提取 `id / name / context_length / thinking_levels / max_mode` 常见字段，
//! 前端对未识别字段展示 raw，不因缺字段而丢弃整个模型。

use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::AtomicBool;

use crate::modules::account;
use crate::modules::config::{atomic_write, http_request, now_ms, store_dir};

static FETCH_RUNNING: AtomicBool = AtomicBool::new(false);

/// 目录文件。
fn catalog_file() -> std::path::PathBuf {
    store_dir().join("model_catalog.json")
}

/// 读取持久化目录；不存在/损坏时返回带默认配置的空目录。
pub fn load_catalog() -> Value {
    let text = std::fs::read_to_string(catalog_file()).unwrap_or_default();
    let mut cat: Value = serde_json::from_str(&text).unwrap_or_else(|_| json!({}));
    if !cat.is_object() {
        cat = json!({});
    }
    if !cat.get("models").map(|v| v.is_array()).unwrap_or(false) {
        cat["models"] = json!([]);
    }
    if cat.get("auto_update").and_then(|v| v.as_bool()).is_none() {
        cat["auto_update"] = json!(false);
    }
    if cat
        .get("update_interval_hours")
        .and_then(|v| v.as_i64())
        .unwrap_or(0)
        <= 0
    {
        cat["update_interval_hours"] = json!(24);
    }
    cat
}

fn save_catalog(cat: &Value) {
    let _ = atomic_write(
        &catalog_file(),
        &serde_json::to_string_pretty(cat).unwrap_or_default(),
    );
}

/// 保存自动更新配置（合并写，不动 models 列表）。
pub fn save_catalog_config(patch: &Value) -> Value {
    let mut cat = load_catalog();
    for key in ["auto_update", "update_interval_hours"] {
        if let Some(v) = patch.get(key) {
            cat[key] = v.clone();
        }
    }
    save_catalog(&cat);
    cat
}

/// 取一个可用于拉取模型列表的国内版账号 token。
fn pick_token() -> Option<String> {
    account::load_accounts().into_iter().find_map(|acc| {
        if account::variant_of(&acc).as_str() != "cn" {
            return None;
        }
        account::get_str(&acc, "access_token").filter(|t| !t.trim().is_empty())
    })
}

/// 从响应 JSON 中提取模型数组：兼容 `data` / `models` / `list` / 顶层数组。
fn extract_models(resp: &Value) -> Option<Vec<Value>> {
    let arr = if resp.is_array() {
        resp.as_array().cloned()
    } else {
        ["data", "models", "list"]
            .iter()
            .find_map(|k| resp.get(k).and_then(|v| v.as_array()).cloned())
    }?;
    let models: Vec<Value> = arr.into_iter().filter(|m| m.is_object()).collect();
    if models.is_empty() {
        None
    } else {
        Some(models)
    }
}

/// 从单个模型原文提取标准化字段（未知字段留在 raw 里由前端展示）。
fn normalize_model(raw: &Value) -> Option<Value> {
    let id = raw
        .get("id")
        .or_else(|| raw.get("model"))
        .or_else(|| raw.get("name"))
        .or_else(|| raw.get("modelId"))
        .and_then(|v| v.as_str())?
        .trim()
        .to_string();
    if id.is_empty() {
        return None;
    }
    let name = raw
        .get("displayName")
        .or_else(|| raw.get("display_name"))
        .or_else(|| raw.get("label"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let context_length = raw
        .get("maxInputTokens")
        .or_else(|| raw.get("context_length"))
        .or_else(|| raw.get("contextLength"))
        .or_else(|| raw.get("max_context_length"))
        .and_then(|v| v.as_u64());
    // 思考强度：官方字段不定，逐个候选键尝试；数组原样保留字符串项。
    let thinking_levels = [
        "thinkingLevels",
        "thinking_levels",
        "thinking",
        "reasoningLevels",
    ]
    .iter()
    .find_map(|k| raw.get(k))
    .and_then(|v| {
        if v.is_array() {
            Some(v.clone())
        } else if v.is_object() {
            v.get("levels").cloned()
        } else {
            None
        }
    });
    // max 模式：布尔或对象都原样记录。
    let max_mode = ["maxMode", "max_mode", "max", "supportMaxMode"]
        .iter()
        .find_map(|k| raw.get(k))
        .cloned();
    let mut out = json!({"id": id, "raw": raw});
    if let Some(v) = name {
        out["name"] = json!(v);
    }
    if let Some(v) = context_length {
        out["context_length"] = json!(v);
    }
    if let Some(v) = thinking_levels {
        out["thinking_levels"] = v;
    }
    if let Some(v) = max_mode {
        out["max_mode"] = v;
    }
    enrich_from_server_shape(&mut out, raw);
    Some(out)
}

/// 从服务器 product-config 形态的模型记录提取丰富字段（实测样例见
/// `~/.workbuddy/cache/conversation-product-spill/acc-product-config-v3-*.json`）：
/// `credits:"x0.79 credits"` 积分倍率、`reasoning.supportedEfforts` 思考强度档位、
/// `contextWindow.supportedLengths` 上下文档位（Max 模式 = 最大档位）等。
fn enrich_from_server_shape(out: &mut Value, raw: &Value) {
    // 积分倍率："x0.79 credits" / "x0.21" / 数字，统一解析为 f64。
    if let Some(mult) = raw.get("credits").and_then(|v| {
        v.as_str()
            .and_then(|s| {
                let t = s.trim().trim_start_matches('x').trim_start_matches('X');
                let num: String = t
                    .chars()
                    .take_while(|c| c.is_ascii_digit() || *c == '.')
                    .collect();
                num.parse::<f64>().ok()
            })
            .or_else(|| v.as_f64())
    }) {
        out["credits_multiplier"] = json!((mult * 10000.0).round() / 10000.0);
    }
    // 思考强度：reasoning 对象（服务器实测形态）。
    if let Some(r) = raw.get("reasoning").filter(|v| v.is_object()) {
        if let Some(levels) = r.get("supportedEfforts").and_then(|v| v.as_array()) {
            out["thinking_levels"] = json!(levels);
        }
        if let Some(effort) = r
            .get("defaultEffort")
            .or_else(|| r.get("effort"))
            .and_then(|v| v.as_str())
        {
            out["default_effort"] = json!(effort);
        }
        if let Some(v) = r.get("canDisableThinking").and_then(|v| v.as_bool()) {
            out["can_disable_thinking"] = json!(v);
        }
    }
    for key in ["onlyReasoning", "supportsReasoning"] {
        if let Some(v) = raw.get(key).and_then(|v| v.as_bool()) {
            out[if key == "onlyReasoning" {
                "only_reasoning"
            } else {
                "supports_reasoning"
            }] = json!(v);
        }
    }
    if let Some(v) = raw.get("maxOutputTokens").and_then(|v| v.as_u64()) {
        out["max_output_tokens"] = json!(v);
    }
    if let Some(v) = raw.get("maxAllowedSize").and_then(|v| v.as_u64()) {
        out["max_allowed_size"] = json!(v);
    }
    // 上下文档位：Max 模式对应客户端发送 contextWindowTokens=最大档位。
    if let Some(cw) = raw.get("contextWindow").filter(|v| v.is_object()) {
        let supported: Vec<u64> = cw
            .get("supportedLengths")
            .and_then(|v| v.as_array())
            .map(|a| a.iter().filter_map(|x| x.as_u64()).collect())
            .unwrap_or_default();
        if !supported.is_empty() {
            out["context_lengths"] = json!(supported);
            if let Some(max_len) = out["context_lengths"]
                .as_array()
                .and_then(|a| a.iter().filter_map(|x| x.as_u64()).max())
            {
                // Max 模式 = 可选的最大上下文档位（客户端以 contextWindowTokens 传给上游）。
                out["max_mode"] = json!(max_len);
            }
        }
        if let Some(v) = cw.get("defaultLength").and_then(|v| v.as_u64()) {
            out["context_default"] = json!(v);
        }
    }
    if let Some(v) = raw.get("temperature").and_then(|v| v.as_f64()) {
        out["temperature"] = json!(v);
    }
    if let Some(v) = raw.get("top_p").and_then(|v| v.as_f64()) {
        out["top_p"] = json!(v);
    }
    if let Some(v) = raw.get("relatedModels").filter(|v| v.is_object()) {
        out["related_models"] = v.clone();
    }
    if let Some(v) = raw.get("tags").and_then(|v| v.as_array()) {
        out["tags"] = json!(v);
    }
}

/// 立即从远端拉取模型列表并落盘。返回更新后的目录（含 source / updated_at）。
pub async fn refresh_catalog() -> Value {
    if FETCH_RUNNING.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return json!({"ok": false, "error": "已有拉取任务在进行中"});
    }
    let result = refresh_catalog_inner().await;
    FETCH_RUNNING.store(false, std::sync::atomic::Ordering::SeqCst);
    result
}

async fn refresh_catalog_inner() -> Value {
    let Some(token) = pick_token() else {
        // 无 token：远端不可用，直接走客户端配置缓存（不需要联网鉴权）。
        return refresh_catalog_from_client_cache();
    };
    let mut headers = HashMap::new();
    headers.insert("Authorization".to_string(), format!("Bearer {token}"));
    // 实测：官方 config 端点校验 UA 中的 copilot 版本号（2026-10 抓包验证，
    // UA 无版本号时返回 400 "get coding copilot version error"）。
    headers.insert(
        "User-Agent".to_string(),
        "CodeBuddy/1.0.0 coding-copilot/3.0.0".to_string(),
    );

    let candidates = [
        // 实测 200 的产品配置端点（返回 data.models）。
        "https://www.workbuddy.cn/v3/config".to_string(),
        format!("{}/models", crate::modules::proxy::DEFAULT_UPSTREAM),
        format!(
            "{}/v2/plugin/models",
            crate::modules::variant::WbVariant::Cn.api_endpoint()
        ),
        "https://www.workbuddy.cn/config/models".to_string(),
    ];
    let mut last_error = String::new();
    for url in candidates {
        let resp = http_request(&url, "GET", None, Some(&headers)).await;
        if let Some(models_raw) = extract_models(&resp) {
            let models: Vec<Value> = models_raw.iter().filter_map(normalize_model).collect();
            if models.is_empty() {
                last_error = format!("{url} 返回的模型缺少 id 字段");
                continue;
            }
            let mut cat = load_catalog();
            cat["models"] = json!(models);
            cat["updated_at"] = json!(now_ms());
            cat["source"] = json!(url);
            save_catalog(&cat);
            return json!({
                "ok": true,
                "count": cat["models"].as_array().map(|a| a.len()).unwrap_or(0),
                "source": url,
                "catalog": cat,
            });
        }
        last_error = format!(
            "{url} → {}",
            resp.get("message")
                .or_else(|| resp.get("msg"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .unwrap_or_else(|| "响应中没有模型列表".to_string())
        );
    }
    // 远端全失败：回落客户端配置缓存（服务器原样下发的完整参数，不需要鉴权）。
    match refresh_catalog_from_client_cache() {
        v if v.get("ok").and_then(Value::as_bool) == Some(true) => v,
        v => json!({
            "ok": false,
            "error": format!(
                "远端失败：{last_error}；配置缓存失败：{}",
                v.get("error").and_then(Value::as_str).unwrap_or("未知")
            ),
        }),
    }
}

// ---------------------------------------------------------------------------
// 客户端配置缓存数据源：CodeBuddy CN 客户端本地保存的产品配置
// ---------------------------------------------------------------------------
//
// 实测：客户端每次同步产品配置都会落盘
// `~/.workbuddy/cache/conversation-product-spill/acc-product-config-v3-*.json`，
// 内含服务器原样下发的完整 models 数组（credits 倍率 / reasoning.supportedEfforts /
// contextWindow.supportedLengths / relatedModels 等全字段），是参数最全的数据源。

/// 从客户端产品配置缓存刷新目录（不联网、不需要 token）。
pub fn refresh_catalog_from_client_cache() -> Value {
    let dir = crate::modules::variant::WbVariant::Cn
        .data_root()
        .join("cache")
        .join("conversation-product-spill");
    let mut files: Vec<std::path::PathBuf> = std::fs::read_dir(&dir)
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .map(|e| e.path())
                .filter(|p| {
                    p.file_name()
                        .and_then(|n| n.to_str())
                        .map(|n| n.starts_with("acc-product-config-v3-") && n.ends_with(".json"))
                        .unwrap_or(false)
                })
                .collect()
        })
        .unwrap_or_default();
    if files.is_empty() {
        return json!({"ok": false, "error": "未找到客户端产品配置缓存（请先运行一次 CodeBuddy CN 客户端）"});
    }
    // 按修改时间升序处理：同 id 时新文件覆盖旧文件，保证最终为最新值。
    files.sort_by_key(|p| {
        std::fs::metadata(p)
            .and_then(|m| m.modified())
            .unwrap_or(std::time::SystemTime::UNIX_EPOCH)
    });
    let mut merged: HashMap<String, Value> = HashMap::new();
    let mut order: Vec<String> = Vec::new();
    let mut used = 0usize;
    for file in &files {
        let Ok(text) = std::fs::read_to_string(file) else {
            continue;
        };
        let Ok(doc) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        let Some(models) = doc.get("models").and_then(|v| v.as_array()) else {
            continue;
        };
        used += 1;
        for raw in models {
            let Some(model) = normalize_model(raw) else {
                continue;
            };
            let id = model["id"].as_str().unwrap_or("").to_string();
            match merged.entry(id) {
                std::collections::hash_map::Entry::Vacant(slot) => {
                    order.push(slot.key().clone());
                    slot.insert(model);
                    continue;
                }
                std::collections::hash_map::Entry::Occupied(mut slot) => {
                    // 同 id 覆盖策略：字段丰富度更高的优先（新文件的条目字段可能更稀疏，
                    // 如新版缓存里 contextWindow 为 null，不能让旧文件的档位信息被冲掉）。
                    let richness = |m: &Value| {
                        [
                            "thinking_levels",
                            "credits_multiplier",
                            "context_lengths",
                            "max_mode",
                            "context_length",
                        ]
                        .iter()
                        .filter(|k| m.get(**k).is_some())
                        .count()
                    };
                    if richness(&model) >= richness(slot.get()) {
                        slot.insert(model);
                    }
                }
            }
        }
    }
    if merged.is_empty() {
        return json!({"ok": false, "error": "客户端配置缓存中没有可解析的模型（结构可能已变更）"});
    }
    let models: Vec<Value> = order.iter().map(|id| merged[id].clone()).collect();
    let mut cat = load_catalog();
    cat["models"] = json!(models);
    cat["updated_at"] = json!(now_ms());
    cat["source"] = json!(format!("client-cache:{} 个缓存文件", used));
    save_catalog(&cat);
    json!({
        "ok": true,
        "count": cat["models"].as_array().map(|a| a.len()).unwrap_or(0),
        "source": cat["source"].clone(),
        "catalog": cat,
    })
}

/// 后台定时调用：开启自动更新且到点则拉取。
pub async fn auto_update_if_due() -> Value {
    let cat = load_catalog();
    if cat.get("auto_update").and_then(|v| v.as_bool()) != Some(true) {
        return json!({"skipped": "disabled"});
    }
    let interval_ms = cat
        .get("update_interval_hours")
        .and_then(|v| v.as_i64())
        .unwrap_or(24)
        .max(1)
        * 3600
        * 1000;
    let last = cat.get("updated_at").and_then(|v| v.as_i64()).unwrap_or(0);
    if now_ms() - last < interval_ms {
        return json!({"skipped": "not_due"});
    }
    refresh_catalog().await
}

/// 当前生效的模型 id 列表：目录非空用目录，否则回退代理的硬编码列表。
pub fn effective_model_ids() -> Vec<String> {
    let cat = load_catalog();
    let ids: Vec<String> = cat
        .get("models")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|m| m.get("id").and_then(|v| v.as_str()).map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();
    if !ids.is_empty() {
        return ids;
    }
    crate::modules::proxy::SUPPORTED_MODELS
        .iter()
        .map(|s| s.to_string())
        .collect()
}

/// 模型上下文长度：目录里有显式值用显式值，否则 None（调用方回退默认表）。
pub fn catalog_context_length(model: &str) -> Option<u64> {
    catalog_model(model)?.get("context_length")?.as_u64()
}

/// 按 id 取目录中的完整模型条目（标准化字段 + raw）。
pub fn catalog_model(model: &str) -> Option<Value> {
    let cat = load_catalog();
    cat.get("models")
        .and_then(|v| v.as_array())?
        .iter()
        .find(|m| m.get("id").and_then(|v| v.as_str()) == Some(model))
        .cloned()
}

/// 上游请求参数说明（2026-10 逆向实测，见会话元数据构造）：
/// 思考强度以 `effort` 字符串传给上游（minimal/low/medium/high/xhigh/max），
/// Max 模式以 `contextWindowTokens`（取该模型 contextWindow.supportedLengths 最大档）
/// 传入，`isThinking` 布尔表示是否开启思考。此说明随目录下发供前端展示。
pub fn upstream_params_doc() -> Value {
    json!({
        "effort": "思考强度：minimal / low / medium / high / xhigh / max，随请求以 effort 字段传给上游；可用档位见各模型 thinking_levels",
        "isThinking": "布尔：是否开启思考模式（only_reasoning 模型恒为开启）",
        "contextWindowTokens": "数字：上下文窗口大小；Max 模式 = 取该模型 context_lengths 的最大档位",
    })
}

// ---------------------------------------------------------------------------
// 手动编辑与实测探测
// ---------------------------------------------------------------------------

/// 积分 ↔ 人民币换算基准（与代理 /v1/models/pricing 的定价口径一致）。
pub const CREDITS_PER_YUAN: f64 = 400.0;

/// 手动新增/编辑单个模型条目（模型管理页保存行）。
///
/// 输入字段：`id`（必填）；`name` / `context_length` / `thinking_levels` /
/// `default_effort` / `max_mode` / `credits_multiplier` / `price_credits` /
/// `price_rmb` 传 null 表示清除该字段。保留原条目的 `raw` 原文与实测记录。
pub fn upsert_model(input: &Value) -> Value {
    let Some(id) = input
        .get("id")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
    else {
        return json!({"ok": false, "error": "缺少模型 id"});
    };
    let mut cat = load_catalog();
    let models = cat["models"].as_array_mut().expect("models 已保证为数组");
    let existing = models
        .iter()
        .position(|m| m.get("id").and_then(Value::as_str) == Some(id));
    let mut entry = match existing {
        Some(idx) => models[idx].clone(),
        None => json!({"id": id}),
    };
    entry["id"] = json!(id);
    // 可编辑字段：null = 删除，其余直接覆盖。
    for key in [
        "name",
        "context_length",
        "thinking_levels",
        "default_effort",
        "max_mode",
        "credits_multiplier",
        "price_credits",
        "price_rmb",
    ] {
        if let Some(v) = input.get(key) {
            if v.is_null() {
                entry.as_object_mut().unwrap().remove(key);
            } else {
                entry[key] = v.clone();
            }
        }
    }
    match existing {
        Some(idx) => models[idx] = entry,
        None => models.push(entry),
    }
    cat["updated_at"] = json!(now_ms());
    cat["source"] = json!("manual-edit");
    save_catalog(&cat);
    json!({"ok": true, "catalog": cat})
}

/// 删除指定模型条目。
pub fn remove_model(id: &str) -> Value {
    let id = id.trim();
    if id.is_empty() {
        return json!({"ok": false, "error": "缺少模型 id"});
    }
    let mut cat = load_catalog();
    let models = cat["models"].as_array_mut().expect("models 已保证为数组");
    let before = models.len();
    models.retain(|m| m.get("id").and_then(Value::as_str) != Some(id));
    if models.len() == before {
        return json!({"ok": false, "error": format!("目录中没有模型 {id}")});
    }
    save_catalog(&cat);
    json!({"ok": true, "catalog": cat})
}

/// 用指定账号对指定模型发一次真实请求，探测可用性并实测单价。
///
/// 请求体为 1-token ping（`max_tokens: 1`），消耗极小但仍会计费——
/// 这正是目的：从响应 `usage` 里的真实扣费算出「每 1M tokens 积分/人民币」，
/// 并回写目录条目的 `measured` 字段（含测量时间与所用账号）。
///
/// 返回：`{ok, status, latency_ms, error?, usage?, credits_per_1m?, rmb_per_1m?}`。
pub async fn probe_model(account_id: &str, model_id: &str) -> Value {
    let model_id = model_id.trim();
    if model_id.is_empty() {
        return json!({"ok": false, "error": "缺少模型 id"});
    }
    let Some(acc) = account::find_account(account_id) else {
        return json!({"ok": false, "error": format!("未找到账号 {account_id}")});
    };
    if let Some(err) = account::envelope_token_error(&acc) {
        return json!({"ok": false, "error": err});
    }
    // 临期 token 先刷新，避免探测因 401 误报不可用。
    let cfg = crate::modules::config::load_checkin_config();
    let acc = crate::modules::refresh::ensure_fresh_token(acc, &cfg).await;
    let headers = account::build_auth_headers(&acc);
    let url = format!(
        "{}/chat/completions",
        crate::modules::proxy::DEFAULT_UPSTREAM
    );
    // 探测请求必须与代理转发口径一致（见 chat_completions_handler）：
    // 上游只支持流式（强制 stream=true + include_usage，usage 在最后一个 SSE chunk），
    // 且要求至少 2 条 message——非流式单消息会被上游统一拒绝（业务码 11101）。
    let body = json!({
        "model": model_id,
        "messages": [
            {"role": "system", "content": "You are a helpful assistant."},
            {"role": "user", "content": "ping"},
        ],
        "max_tokens": 1,
        "stream": true,
        "stream_options": {"include_usage": true},
    });
    let started = std::time::Instant::now();
    let mut req = crate::modules::config::http_client().post(&url);
    for (k, v) in &headers {
        req = req.header(k, v);
    }
    let resp = match req
        .header("Accept", "text/event-stream")
        .json(&body)
        .send()
        .await
    {
        Ok(resp) => resp,
        Err(e) => {
            return json!({
                "ok": false,
                "status": -1,
                "latency_ms": started.elapsed().as_millis() as i64,
                "error": format!("请求失败: {e}"),
            });
        }
    };
    let http_status = resp.status().as_u16() as i64;
    // 读流：UsageScan 提取末尾 usage；原文保留（上限 256KB）用于错误解析。
    let mut scan = crate::modules::proxy::UsageScan::new();
    let mut raw = String::new();
    let mut stream = resp.bytes_stream();
    use futures_util::StreamExt;
    while let Some(chunk) = stream.next().await {
        let Ok(bytes) = chunk else { break };
        let text = String::from_utf8_lossy(&bytes);
        scan.feed(&text);
        if raw.len() < 262_144 {
            raw.push_str(&text);
        }
    }
    let latency_ms = started.elapsed().as_millis() as i64;

    if scan.usage.is_null() {
        // 无 usage：从错误响应里提取业务码与消息（普通 JSON 或 SSE error 行）。
        let (code, message) = probe_error_from_text(&raw, http_status);
        return json!({
            "ok": false,
            "status": code,
            "latency_ms": latency_ms,
            "error": message,
        });
    }
    let (input, output, total, cached, credits) = crate::modules::proxy::usage_numbers(&scan.usage);

    // 单次 ping 的 token 数太小（个位数），除法放大误差极大：单价以「消耗积分 ÷
    // 总 tokens × 100 万」计算。credits 为 0（免费/未计费）时也按 0 写回实测价，
    // 保证每个可用模型都有单价（显示为免费），不再是空缺的「—」。
    let mut result = json!({
        "ok": true,
        "status": 200,
        "latency_ms": latency_ms,
        "usage": {
            "input_tokens": input,
            "output_tokens": output,
            "cached_tokens": cached,
            "total_tokens": total,
            "credits": credits,
        },
    });
    if total > 0 {
        let credits_per_1m = credits * 1e6 / total as f64;
        let rmb_per_1m = credits_per_1m / CREDITS_PER_YUAN;
        result["credits_per_1m"] = json!((credits_per_1m * 100.0).round() / 100.0);
        result["rmb_per_1m"] = json!((rmb_per_1m * 100.0).round() / 100.0);
        // 回写目录条目实测价（供价格表与换算器使用）。
        if let Some(mut entry) = catalog_model(model_id) {
            entry["measured"] = json!({
                "credits_per_1m": result["credits_per_1m"],
                "rmb_per_1m": result["rmb_per_1m"],
                "credits": credits,
                "total_tokens": total,
                "at": now_ms(),
                "by": account::account_display_name(&acc),
            });
            let mut cat = load_catalog();
            if let Some(models) = cat["models"].as_array_mut() {
                if let Some(slot) = models
                    .iter_mut()
                    .find(|m| m.get("id").and_then(Value::as_str) == Some(model_id))
                {
                    *slot = entry;
                    save_catalog(&cat);
                }
            }
        }
        if credits == 0.0 {
            result["note"] = json!("本次请求未计费，已按免费（¥0/1M tokens）写入实测价");
        }
    } else {
        result["note"] = json!("响应未返回 token 用量，无法计算单价");
    }
    result
}

/// 从无 usage 的探测响应文本中提取业务错误码与消息。
/// 兼容普通 JSON 错误体（`{"code":11101,"message":...}` / `{"error":{"message":...}}`）
/// 与 SSE 错误行（`data: {...}`）。
fn probe_error_from_text(raw: &str, http_status: i64) -> (i64, String) {
    let extract = |v: &Value| -> Option<(i64, String)> {
        let message = v
            .pointer("/error/message")
            .or_else(|| v.get("message"))
            .and_then(Value::as_str)
            .map(str::to_string)?;
        let code = v
            .get("code")
            .and_then(Value::as_i64)
            .filter(|c| *c != 0)
            .unwrap_or(http_status);
        Some((code, message))
    };
    if let Ok(v) = serde_json::from_str::<Value>(raw.trim()) {
        if let Some(r) = extract(&v) {
            return r;
        }
    }
    for line in raw.lines() {
        let Some(data) = line.trim().strip_prefix("data: ") else {
            continue;
        };
        if data == "[DONE]" {
            continue;
        }
        if let Ok(v) = serde_json::from_str::<Value>(data) {
            let is_error = v.get("error").is_some()
                || v.get("code")
                    .and_then(Value::as_i64)
                    .is_some_and(|c| c != 0);
            if is_error {
                if let Some(r) = extract(&v) {
                    return r;
                }
            }
        }
    }
    let snippet: String = raw.trim().chars().take(120).collect();
    let message = if snippet.is_empty() {
        "无 usage 返回".to_string()
    } else {
        snippet
    };
    (http_status, message)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn probe_error_parses_json_and_sse_shapes() {
        let (code, msg) =
            probe_error_from_text(r#"{"code":11101,"message":"invalid request"}"#, 200);
        assert_eq!((code, msg.as_str()), (11101, "invalid request"));
        let (code, msg) = probe_error_from_text(
            "data: {\"choices\":[]}\n\ndata: {\"error\":{\"message\":\"model denied\"}}\n\ndata: [DONE]\n",
            200,
        );
        assert_eq!((code, msg.as_str()), (200, "model denied"));
        let (code, msg) = probe_error_from_text("", 503);
        assert_eq!((code, msg.as_str()), (503, "无 usage 返回"));
    }

    #[test]
    fn extract_models_supports_common_shapes() {
        let a = json!({"data": [{"id": "m1"}]});
        assert_eq!(extract_models(&a).unwrap().len(), 1);
        let b = json!([{"id": "m1"}, {"id": "m2"}]);
        assert_eq!(extract_models(&b).unwrap().len(), 2);
        let c = json!({"code": 401, "message": "unauthorized"});
        assert!(extract_models(&c).is_none());
    }

    #[test]
    fn normalize_model_keeps_raw_and_extracts_params() {
        let raw = json!({
            "id": "kimi-k3",
            "displayName": "Kimi K3",
            "maxInputTokens": 256000,
            "thinkingLevels": ["low", "high"],
            "maxMode": {"enabled": true, "maxTokens": 128000}
        });
        let m = normalize_model(&raw).unwrap();
        assert_eq!(m["id"], "kimi-k3");
        assert_eq!(m["name"], "Kimi K3");
        assert_eq!(m["context_length"], 256000);
        assert_eq!(m["thinking_levels"], json!(["low", "high"]));
        assert_eq!(m["max_mode"]["enabled"], true);
        assert_eq!(m["raw"]["displayName"], "Kimi K3");
        // 完全无 id 类字段的条目被丢弃而不是炸掉整批（name 是刻意的 id 回退候选）。
        assert!(normalize_model(&json!({"vendor": "x"})).is_none());
        assert!(normalize_model(&json!({})).is_none());
    }

    #[test]
    fn normalize_extracts_server_shape_fields() {
        // 与客户端产品配置缓存（acc-product-config-v3-*.json）实测结构一致。
        let raw = json!({
            "id": "hy3-preview",
            "name": "HY 3.0 Preview",
            "credits": "x0.79 credits",
            "maxInputTokens": 512000,
            "maxOutputTokens": 65536,
            "maxAllowedSize": 524288,
            "onlyReasoning": true,
            "reasoning": {
                "canDisableThinking": false,
                "defaultEffort": "high",
                "supportedEfforts": ["low", "high"],
            },
            "contextWindow": {
                "defaultLength": 131072,
                "supportedLengths": [131072, 262144, 524288],
            },
            "temperature": 1,
            "top_p": 0.95,
        });
        let m = normalize_model(&raw).unwrap();
        assert_eq!(m["credits_multiplier"], json!(0.79));
        assert_eq!(m["thinking_levels"], json!(["low", "high"]));
        assert_eq!(m["default_effort"], "high");
        assert_eq!(m["only_reasoning"], true);
        assert_eq!(m["can_disable_thinking"], false);
        assert_eq!(m["context_length"], 512000);
        assert_eq!(m["max_output_tokens"], 65536);
        assert_eq!(m["context_lengths"], json!([131072, 262144, 524288]));
        // Max 模式 = 最大上下文档位（客户端以 contextWindowTokens 传给上游）。
        assert_eq!(m["max_mode"], 524288);
        assert_eq!(m["top_p"], json!(0.95));
        // 无 reasoning/contextWindow 的旧形态不受影响。
        let simple = normalize_model(&json!({"id": "x", "credits": "x0.21"})).unwrap();
        assert_eq!(simple["credits_multiplier"], json!(0.21));
        assert!(simple.get("thinking_levels").is_none());
        assert!(simple.get("max_mode").is_none());
    }

    /// 真机冒烟：从客户端产品配置缓存刷新目录。
    /// `cargo test -p wb-switch-core client_cache_smoke -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn client_cache_smoke() {
        let res = refresh_catalog_from_client_cache();
        eprintln!(
            "ok={} count={} source={}",
            res["ok"],
            res["count"],
            res["source"].as_str().unwrap_or("")
        );
        assert_eq!(res["ok"], true);
        let models = res["catalog"]["models"].as_array().unwrap();
        let rich = models
            .iter()
            .filter(|m| m.get("thinking_levels").is_some() || m.get("credits_multiplier").is_some())
            .count();
        eprintln!("含思考强度/倍率的模型: {rich}/{}", models.len());
        for m in models.iter().take(3) {
            eprintln!(
                "  {} credits={} efforts={} max_mode={}",
                m["id"], m["credits_multiplier"], m["thinking_levels"], m["max_mode"]
            );
        }
        assert!(rich > 0, "客户端缓存应提供思考强度/倍率字段");
    }
}
