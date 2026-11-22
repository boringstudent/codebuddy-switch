// ============================================================================
// WorkBuddy（国内版）签到。
//
// 与 CodeBuddy 共用腾讯计费接口（www.codebuddy.cn/v2/billing/meter/*），
// 差异只在账号结构与客户端指纹头：
//   - 账号来自 AI Work 助手导出：credential.{access_token, refresh_token, expires_at_ms}
//   - 桌面端 UA 为 WorkBuddy/<版本>（裸 WorkBuddy 会被个人中心识别为未知客户端）
// 刷新端点同 CodeBuddy（/v2/plugin/auth/token/refresh）。
// ============================================================================

import {
  requestJson,
  messageOf,
  isUnauthorized,
  sleep,
  redact,
} from '../lib/http.mjs';

const API_BASE = 'https://www.codebuddy.cn';
const BILLING_PREFIX = '/v2/billing/meter';
const REFRESH_PATH = '/v2/plugin/auth/token/refresh';
const REFRESH_WITHIN_MS = 24 * 3600 * 1000;
const DESKTOP_UA = 'WorkBuddy/5.5.6';

export const platform = 'workbuddy';

/** 取账号当前凭证（AI Work 助手导出把 token 放在 credential 里）。 */
function credsOf(account) {
  const cred = account.credential && typeof account.credential === 'object' ? account.credential : {};
  return {
    accessToken: cred.access_token || account.access_token || '',
    refreshToken: cred.refresh_token || account.refresh_token || '',
    expiresAt: Number(cred.expires_at_ms ?? account.expiresAt ?? 0),
  };
}

export function isUsable(account) {
  return Boolean(account && account.id && credsOf(account).accessToken);
}

export function displayName(account) {
  return account.nickname || account.phone_masked || account.uid || account.id || '未知账号';
}

function authHeaders(account) {
  const headers = {
    Authorization: `Bearer ${credsOf(account).accessToken}`,
    'User-Agent': DESKTOP_UA,
  };
  if (account.uid) headers['X-User-Id'] = account.uid;
  return headers;
}

function messageOfResponse(resp) {
  return messageOf(resp.status, resp.json, resp.text);
}

/**
 * 刷新 token。返回写回 credential 后的账号副本；失败返回 null。
 * 注意：refresh_token 可能轮换，必须一并写回，否则下次刷新失败。
 */
async function refreshAccountToken(account) {
  const creds = credsOf(account);
  if (!creds.refreshToken) return null;
  const resp = await requestJson(`${API_BASE}${REFRESH_PATH}`, {
    headers: {
      ...authHeaders(account),
      'X-Refresh-Token': creds.refreshToken,
      'X-Auth-Refresh-Source': 'plugin',
    },
    body: {},
  });
  const data = resp.json?.data ?? resp.json;
  const newAccess = data?.accessToken ?? data?.access_token;
  if (!newAccess) return null;
  const newRefresh = data?.refreshToken ?? data?.refresh_token ?? creds.refreshToken;
  const expiresIn = Number(data?.expiresIn ?? data?.expires_in);
  const now = Date.now();
  const cred = { ...(account.credential || {}) };
  cred.access_token = newAccess;
  cred.refresh_token = newRefresh;
  if (Number.isFinite(expiresIn) && expiresIn > 0) cred.expires_at_ms = now + expiresIn * 1000;
  cred.updated_at = new Date(now).toISOString();
  return {
    ...account,
    access_token: newAccess,
    refresh_token: newRefresh,
    credential: cred,
  };
}

/** 查今日签到状态（新接口优先，旧接口兜底）。 */
async function getCheckinStatus(account) {
  for (const suffix of ['/checkin-activity-status', '/checkin-status']) {
    const resp = await requestJson(`${API_BASE}${BILLING_PREFIX}${suffix}`, {
      headers: authHeaders(account),
      body: {},
    });
    const code = Number(resp.json?.code ?? -1);
    if (code === 0 || code === 200) {
      const data = resp.json?.data ?? {};
      if (suffix === '/checkin-status' && data.active === false) {
        return { ok: false, error: '签到状态不可用（旧活动接口未激活）' };
      }
      return {
        ok: true,
        todayCheckedIn: Boolean(data.today_checked_in ?? data.todayCheckedIn),
      };
    }
    if (isUnauthorized(resp.status, resp.json)) {
      return { ok: false, error: messageOfResponse(resp), unauthorized: true };
    }
  }
  return { ok: false, error: '查询签到状态失败' };
}

async function verifyCheckedIn(account) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt > 0) await sleep(2000);
    const resp = await requestJson(`${API_BASE}${BILLING_PREFIX}/checkin-activity-status`, {
      headers: authHeaders(account),
      body: {},
    });
    const code = Number(resp.json?.code ?? -1);
    if (code === 0 || code === 200) {
      const data = resp.json?.data ?? {};
      return { confirmed: Boolean(data.today_checked_in ?? data.todayCheckedIn) };
    }
  }
  return { confirmed: null };
}

async function performCheckin(account) {
  const resp = await requestJson(`${API_BASE}${BILLING_PREFIX}/daily-checkin`, {
    headers: authHeaders(account),
    body: {},
  });
  const code = Number(resp.json?.code ?? -1);
  if (code === 0 || code === 200) return { result: 'success' };
  const msg = messageOfResponse(resp);
  if (msg.includes('已签到') || msg.toLowerCase().includes('repeat')) {
    return { result: 'already', message: msg };
  }
  return { result: 'error', error: msg, unauthorized: isUnauthorized(resp.status, resp.json) };
}

/** 单账号流程：临期刷新 → 查状态 → 未签提交 → 401 刷新重试 → 提交后复核。 */
export async function checkinAccount(rawAccount) {
  let account = rawAccount;
  const name = displayName(account);
  let tokensChanged = false;

  const applyRefresh = (refreshed) => {
    if (!refreshed) return false;
    const before = credsOf(account);
    const after = credsOf(refreshed);
    if (before.accessToken !== after.accessToken || before.refreshToken !== after.refreshToken) {
      tokensChanged = true;
    }
    account = refreshed;
    return true;
  };

  const creds = credsOf(account);
  const stale = !Number.isFinite(creds.expiresAt) || creds.expiresAt <= Date.now() + REFRESH_WITHIN_MS;
  if (stale && creds.refreshToken) {
    applyRefresh(await refreshAccountToken(account));
  }

  let status = await getCheckinStatus(account);
  if (status.unauthorized) {
    if (applyRefresh(await refreshAccountToken(account))) {
      status = await getCheckinStatus(account);
    }
  }
  if (status.ok && status.todayCheckedIn) {
    return { name, result: 'already', account, tokensChanged };
  }

  let outcome = await performCheckin(account);
  if (outcome.unauthorized) {
    if (applyRefresh(await refreshAccountToken(account))) {
      outcome = await performCheckin(account);
    }
  }

  if (outcome.result === 'success' || outcome.result === 'already') {
    const verify = await verifyCheckedIn(account);
    if (verify.confirmed === false) {
      return {
        name,
        result: 'error',
        error: '提交后复核未生效（真实活动仍未签到）',
        account,
        tokensChanged,
      };
    }
    if (verify.confirmed === null) {
      outcome = {
        ...outcome,
        message: `${outcome.message || ''}（复核接口不可达，结果未二次确认）`.trim(),
      };
    }
  }
  return { name, ...outcome, account, tokensChanged };
}

export const redactError = (value) => redact(String(value ?? ''));
