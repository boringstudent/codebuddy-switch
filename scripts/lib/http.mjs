// ============================================================================
// 签到脚本公共 HTTP / 日志安全工具（零依赖，Node >= 18）
//
// 红线：任何输出都不得包含 access_token / refresh_token / jwt 等凭证。
// 响应正文只用于错误诊断，落日志前统一过 redact()（把疑似凭证的长串替换掉）。
// ============================================================================

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 长 token/JWT 特征：连续 24+ 个 base64url 字符（含 . 的 JWT 段）。 */
const SECRET_LIKE = /[A-Za-z0-9_-]{24,}(?:\.[A-Za-z0-9_-]{8,})*/g;

/** 脱敏任意文本中的疑似凭证（日志/错误消息统一入口）。 */
export function redact(value) {
  if (typeof value !== 'string') return String(value ?? '');
  return value.replace(SECRET_LIKE, (m) => `${m.slice(0, 4)}***`);
}

/** 截断响应正文用于错误消息，并脱敏。 */
export function summary(text, limit = 200) {
  const body = typeof text === 'string' ? text : '';
  const head = body.length > limit ? `${body.slice(0, limit)}…` : body;
  return redact(head);
}

/**
 * 发起一次 JSON 请求。网络错误不抛出，统一返回 { status: 0, error }，
 * 调用方按 status 分支即可（与 Rust 侧「status=0 网络不可达」口径一致）。
 */
export async function requestJson(url, options = {}) {
  const {
    method = 'POST',
    headers = {},
    body,
    timeoutMs = 30_000,
  } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const init = {
      method,
      headers: {
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      signal: controller.signal,
    };
    if (body !== undefined) {
      init.body = typeof body === 'string' ? body : JSON.stringify(body);
    }
    const resp = await fetch(url, init);
    const text = await resp.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* 非 JSON 响应：保留原文供诊断 */
    }
    return { status: resp.status, json, text, error: '' };
  } catch (error) {
    const reason = error?.name === 'AbortError' ? '请求超时' : String(error?.message || error);
    return { status: 0, json: null, text: '', error: `网络错误：${redact(reason)}` };
  } finally {
    clearTimeout(timer);
  }
}

/** 轻量 GET。 */
export function requestGet(url, options = {}) {
  return requestJson(url, { ...options, method: 'GET' });
}

/** 从任意 JSON 结构中取字符串字段（宽容：大小写与 snake/camel 混用）。 */
export function pickString(source, keys) {
  if (!source || typeof source !== 'object') return '';
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value) return value;
    if (typeof value === 'number') return String(value);
  }
  return '';
}

/** 从任意 JSON 结构中取数值字段（宽容：数字字符串也算）。 */
export function pickNumber(source, keys) {
  if (!source || typeof source !== 'object') return undefined;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
      return Number(value);
    }
  }
  return undefined;
}

/** 信封下钻（data/result/resp/response/info），返回 [最外层…最内层]。 */
const WRAPPER_KEYS = ['data', 'result', 'resp', 'response', 'info'];
export function unwrapScopes(root) {
  const scopes = [];
  const walk = (node, depth) => {
    if (!node || typeof node !== 'object' || Array.isArray(node) || depth > 8) return;
    scopes.push(node);
    for (const key of WRAPPER_KEYS) {
      const child = node[key];
      if (child && typeof child === 'object' && !Array.isArray(child)) walk(child, depth + 1);
    }
  };
  walk(root, 0);
  return scopes;
}

/** 在各信封层查找字段（外层优先）。 */
export function findField(root, keys) {
  for (const scope of unwrapScopes(root)) {
    for (const key of keys) {
      if (scope[key] !== undefined) return scope[key];
    }
  }
  return undefined;
}

/** 粗粒度鉴权失败判定（网络层 401/403 或业务码/文案）。 */
export function isUnauthorized(status, json) {
  if (status === 401 || status === 403) return true;
  const code = Number(json?.code);
  if (code === 401 || code === 403) return true;
  const message = String(json?.message ?? json?.msg ?? '').toLowerCase();
  return ['unauthorized', '登录', '失效', '过期', 'token expired', 'not able to authenticate'].some(
    (k) => message.includes(k),
  );
}

/** 从响应中提取业务提示文案。 */
export function messageOf(status, json, text) {
  const message = json?.message ?? json?.msg ?? json?.error?.message ?? json?.error;
  if (typeof message === 'string' && message) return redact(message);
  if (status === 0) return '网络不可达';
  if (status) return `HTTP ${status}：${summary(text)}`;
  return '未知错误';
}

/** 32 位随机 hex（对齐 Trae 客户端 x-request-id 形态）。 */
export function randomHex(length = 32) {
  const chars = '0123456789abcdef';
  let out = '';
  for (let i = 0; i < length; i += 1) out += chars[Math.floor(Math.random() * 16)];
  return out;
}
