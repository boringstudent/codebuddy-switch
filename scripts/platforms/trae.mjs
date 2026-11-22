// ============================================================================
// Trae CN 签到：status 预检（已签跳过）→ claim。
//
// 接口（api.trae.cn）：
//   POST /trae/api/v2/ug/checkin_credits/status   今日签到状态
//   POST /trae/api/v2/ug/checkin_credits/claim    领取签到积分
//
// 鉴权：Authorization: Cloud-IDE-JWT <jwt>，设备头 x-device-id 必带。
// 注意：服务端按 **设备** 每日去重一次，多账号共用同一 deviceId 时只有首个能签；
//       导出账号各自有独立 deviceId（AI Work 助手 OAuth 登录时生成）。
// 凭证不会自动续期（Trae 无 refresh 接口），登录态失效需重新 OAuth。
// ============================================================================

import {
  requestJson,
  findField,
  messageOf,
  randomHex,
  redact,
  summary,
} from '../lib/http.mjs';

const STATUS_URL = 'https://api.trae.cn/trae/api/v2/ug/checkin_credits/status';
const CLAIM_URL = 'https://api.trae.cn/trae/api/v2/ug/checkin_credits/claim';

export const platform = 'trae';

export function isUsable(account) {
  // AI Work 助手导出可能没有 id 字段（只有 userId），两者取其一即可。
  return Boolean(account && (account.id || account.userId) && account.cloudIdeJwt);
}

export function displayName(account) {
  return account.name || account.nickname || account.userId || account.id || '未知账号';
}

/** 从 JWT payload 解析用户 id（账号未保存 userId 时兜底）。 */
function userIdFromJwt(jwt) {
  const parts = String(jwt).split('.');
  if (parts.length < 2) return '';
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return payload.user_id || payload.uid || payload.sub || '';
  } catch {
    return '';
  }
}

function buildHeaders(account) {
  const jwt = String(account.cloudIdeJwt || '').trim();
  const auth = jwt.startsWith('Cloud-IDE-JWT ') ? jwt : `Cloud-IDE-JWT ${jwt}`;
  const userId = account.userId || account.user_id || userIdFromJwt(jwt);
  return {
    authorization: auth,
    'user-agent': 'VSCode 1.107.1 (TRAE SOLO CN)',
    'x-market-client-id': 'VSCode 1.107.1',
    'x-market-user-id': userId,
    'x-user-region': 'CN',
    'x-device-id': account.deviceId || account.device_id || '',
    'x-lgw-req-sdk-type': '3',
    'package-type': 'stable_cn',
    'x-request-id': randomHex(32),
    'x-lscbd-aid': '787976',
    'x-lscbd-platform': 'windows',
    'app-version': '0.1.45',
    'x-tt-trace-id': `00-${randomHex(16)}-01`,
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'no-cors',
    'sec-fetch-site': 'none',
  };
}

function isDeviceSigned(message) {
  const text = String(message || '').toLowerCase();
  return (
    text.includes('今日已经签到') ||
    text.includes('设备已签到') ||
    text.includes('already checked in')
  );
}

function isDeviceLimit(message) {
  const text = String(message || '').toLowerCase();
  return (
    text.includes('绑定的账户数量已达上限') ||
    text.includes('device limit') ||
    text.includes('bound to this device')
  );
}

function isAuthRejected(message) {
  return String(message || '').toLowerCase().includes('not able to authenticate you');
}

/** 业务提示统一转译（设备上限 / 设备已签 / 服务端拒绝认证）。 */
function humanize(message) {
  const text = String(message || '');
  if (isDeviceLimit(text)) {
    return `${text} —— 设备绑定数已达服务端上限：需对该账号重新 OAuth 登录换设备凭证`;
  }
  if (isDeviceSigned(text)) {
    return `${text} —— Trae 按设备每日仅计一次签到，同设备多账号时先签者消耗当日额度`;
  }
  if (isAuthRejected(text)) {
    return `${text} —— 该账号登录凭证被 Trae 拒绝认证，需重新 OAuth 登录`;
  }
  return text;
}

async function request(url, account) {
  return requestJson(url, {
    headers: buildHeaders(account),
    body: {},
  });
}

/** 状态预检：返回 { ok, checkedIn, message, unauthorized }。 */
async function statusCheck(account) {
  if (!account.deviceId) {
    return { ok: false, checkedIn: null, message: '账号缺少 deviceId，无法签到', unauthorized: false };
  }
  const resp = await request(STATUS_URL, account);
  if (resp.status === 0) {
    return { ok: false, checkedIn: null, message: resp.error, unauthorized: false };
  }
  if (resp.status === 401) {
    return { ok: false, checkedIn: null, message: '登录态失效（HTTP 401）', unauthorized: true };
  }
  const data = resp.json;
  if (!data || typeof data !== 'object') {
    return {
      ok: false,
      checkedIn: null,
      message: `状态接口返回非 JSON：${summary(resp.text)}`,
      unauthorized: false,
    };
  }
  const code = Number(data.code ?? -1);
  const checked = findField(data, ['checked_in', 'checkedIn']);
  const credits = findField(data, ['credits']);
  const message = humanize(String(data.message ?? ''));
  if (code !== 0) {
    return { ok: false, checkedIn: null, message: message || messageOf(resp.status, data, resp.text), unauthorized: false };
  }
  return {
    ok: true,
    checkedIn: checked === true || checked === 1 || checked === 'true',
    credits: typeof credits === 'number' ? credits : undefined,
    message,
    unauthorized: false,
  };
}

/** 领取签到积分：返回 { result, message?, error? }。 */
async function claim(account) {
  const resp = await request(CLAIM_URL, account);
  if (resp.status === 0) return { result: 'error', error: resp.error };
  if (resp.status === 401) {
    return { result: 'error', error: '登录态失效（HTTP 401），需重新 OAuth 登录' };
  }
  const data = resp.json;
  if (!data || typeof data !== 'object') {
    return { result: 'error', error: `签到接口返回非 JSON：${summary(resp.text)}` };
  }
  const code = Number(data.code ?? -1);
  const message = humanize(String(data.message ?? ''));
  if (code === 0) {
    const reward = findField(data, ['reward', 'credits', 'delta', 'amount']);
    return {
      result: 'success',
      message: typeof reward === 'number' && reward > 0 ? `+${reward}` : 'ok',
    };
  }
  if (isDeviceSigned(message)) {
    return { result: 'already', message: message || '设备今日已签到' };
  }
  return { result: 'error', error: message || messageOf(resp.status, data, resp.text) };
}

/** 单账号流程：状态预检 → 未签 claim。 */
export async function checkinAccount(account) {
  const name = displayName(account);
  const pre = await statusCheck(account);
  if (pre.unauthorized) {
    return { name, result: 'error', error: pre.message };
  }
  if (pre.ok && pre.checkedIn) {
    return { name, result: 'already' };
  }
  const outcome = await claim(account);
  if (outcome.result === 'error' && pre.ok === false && pre.message) {
    // claim 失败时把预检提示一并带上，便于区分网络/凭证/设备问题
    outcome.error = `${outcome.error}（预检：${pre.message}）`;
  }
  return { name, ...outcome };
}

export const redactError = (value) => redact(String(value ?? ''));
