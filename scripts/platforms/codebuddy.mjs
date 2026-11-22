// ============================================================================
// CodeBuddy（国内版）签到：签到状态查询 → 未签提交 → 提交后复核。
//
// 接口（www.codebuddy.cn）：
//   POST /v2/billing/meter/checkin-activity-status  权威签到状态（Buddy 加油站）
//   POST /v2/billing/meter/checkin-status           旧活动接口（active=false 时不可用）
//   POST /v2/billing/meter/daily-checkin            提交签到（幂等）
//   POST /v2/plugin/auth/token/refresh              刷新 access_token
// ============================================================================

import { requestJson, messageOf, isUnauthorized, sleep, redact } from '../lib/http.mjs';

const API_BASE = 'https://www.codebuddy.cn';
const BILLING_PREFIX = '/v2/billing/meter';
const REFRESH_PATH = '/v2/plugin/auth/token/refresh';
const REFRESH_WITHIN_MS = 24 * 3600 * 1000; // 剩余不足 24h 先刷新

export const platform = 'codebuddy';

/** 只有带 access_token 的国内版账号参与签到。 */
export function isUsable(account) {
  return Boolean(account && (account.variant ?? 'cn') === 'cn' && account.access_token);
}

export function displayName(account) {
  return account.nickname || account.phone || account.uid || account.id || '未知账号';
}

/** 与桌面端 build_auth_headers 同口径的请求头。 */
export function authHeaders(account) {
  const headers = { Authorization: `Bearer ${account.access_token || ''}` };
  if (account.uid) headers['X-User-Id'] = account.uid;
  const enterpriseId = account.enterpriseId || account.enterprise_id;
  if (enterpriseId) {
    headers['X-Enterprise-Id'] = enterpriseId;
    headers['X-Tenant-Id'] = enterpriseId;
  }
  if (account.domain) headers['X-Domain'] = account.domain;
  return headers;
}

function messageOfResponse(resp) {
  return messageOf(resp.status, resp.json, resp.text);
}

/** 刷新 token（POST /v2/plugin/auth/token/refresh）。成功返回更新后的账号副本。 */
export async function refreshAccountToken(account) {
  if (!account.refresh_token) return null;
  const resp = await requestJson(`${API_BASE}${REFRESH_PATH}`, {
    headers: {
      ...authHeaders(account),
      'X-Refresh-Token': account.refresh_token,
      'X-Auth-Refresh-Source': 'plugin', // 网关按 client 来源校验，缺失会 invalid_grant
    },
    body: {},
  });
  const data = resp.json?.data ?? resp.json;
  const newAccess = data?.accessToken ?? data?.access_token;
  if (!newAccess) return null;
  const next = { ...account, access_token: newAccess };
  const newRefresh = data?.refreshToken ?? data?.refresh_token;
  if (newRefresh) next.refresh_token = newRefresh;
  const expiresIn = Number(data?.expiresIn ?? data?.expires_in);
  if (Number.isFinite(expiresIn) && expiresIn > 0) next.expiresAt = Date.now() + expiresIn * 1000;
  return next;
}

/** 查询今日签到状态：新接口失败回退旧接口。返回 { ok, todayCheckedIn?, error?, unauthorized? }。 */
async function getCheckinStatus(account) {
  for (const suffix of ['/checkin-activity-status', '/checkin-status']) {
    const resp = await requestJson(`${API_BASE}${BILLING_PREFIX}${suffix}`, {
      headers: authHeaders(account),
      body: {},
    });
    const code = Number(resp.json?.code ?? -1);
    if (code === 0 || code === 200) {
      const data = resp.json?.data ?? {};
      // /checkin-status 是旧活动接口：active=false 时数据全零且与真实活动无关，
      // 不能据此判定「未签到」，否则提交后的假成功会漏签真实活动（Buddy加油站）。
      if (suffix === '/checkin-status' && data.active === false) {
        return { ok: false, error: '签到状态不可用（旧活动接口未激活）' };
      }
      return { ok: true, todayCheckedIn: Boolean(data.today_checked_in ?? data.todayCheckedIn) };
    }
    if (isUnauthorized(resp.status, resp.json)) {
      return { ok: false, error: messageOfResponse(resp), unauthorized: true };
    }
    // 其他失败继续尝试下一个候选路径
  }
  return { ok: false, error: '查询签到状态失败' };
}

/**
 * 提交后复核：daily-checkin 返回成功不代表真实活动已记录（旧接口会对未激活活动
 * 也返回 code:0）。用权威接口 checkin-activity-status 再查一次，确认 today_checked_in。
 * 网络抖动允许重查一次；复核接口本身失败时不推翻原结果（避免误报失败），只附注。
 */
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
      return {
        confirmed: Boolean(data.today_checked_in ?? data.todayCheckedIn),
        reachable: true,
      };
    }
  }
  return { confirmed: null, reachable: false };
}

/** 提交签到（POST /daily-checkin）。「已签到」幂等提示按成功处理。 */
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

/** 单账号完整流程：临期刷新 → 查状态 → 未签则提交 → 401 刷新重试一次。 */
export async function checkinAccount(rawAccount) {
  let account = rawAccount;
  const name = displayName(account);
  let tokensChanged = false;
  const applyRefresh = (refreshed) => {
    if (!refreshed) return false;
    // refresh_token 可能轮换：任何 token 变化都标记，流程末尾统一回写 EO 持久化，
    // 否则下次运行仍用旧 refresh_token，轮换失效后该账号会永久签到失败。
    if (
      refreshed.access_token !== account.access_token ||
      refreshed.refresh_token !== account.refresh_token
    ) {
      tokensChanged = true;
    }
    account = refreshed;
    return true;
  };

  // 1) 临期（或无 expiresAt）且有 refresh_token：先刷新，避免拿过期 token 签到。
  const exp = Number(account.expiresAt);
  const stale = !Number.isFinite(exp) || exp <= Date.now() + REFRESH_WITHIN_MS;
  if (stale && account.refresh_token) {
    applyRefresh(await refreshAccountToken(account));
  }

  // 2) 查状态 → 决定 已签 / 提交；401 时刷新一次重试。
  let status = await getCheckinStatus(account);
  if (status.unauthorized) {
    if (applyRefresh(await refreshAccountToken(account))) {
      status = await getCheckinStatus(account);
    }
  }
  if (status.ok && status.todayCheckedIn) {
    return { name, result: 'already', account, tokensChanged };
  }
  // 状态查询失败不一定是鉴权问题：保守起见仍尝试提交一次（daily-checkin 幂等）。
  // 与桌面端 decide_from_status 的 statusUnsupported 分支同策略。

  // 3) 提交签到；401 刷新重试一次。
  let outcome = await performCheckin(account);
  if (outcome.unauthorized) {
    if (applyRefresh(await refreshAccountToken(account))) {
      outcome = await performCheckin(account);
    }
  }

  // 4) 提交返回成功/已签到后复核真实活动状态，杜绝「显示成功但实际未签到」。
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

/** 导出给统一日志使用（保持与原脚本一致的错误文案脱敏）。 */
export const redactError = (value) => redact(String(value ?? ''));
