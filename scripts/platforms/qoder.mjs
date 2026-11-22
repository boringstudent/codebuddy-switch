// ============================================================================
// Qoder CN 签到：活动列表（sash campaigns）→ 领取 CLAIMABLE 的权益。
//
// 接口（openapi.qoder.com.cn）：
//   GET  /sash/api/v1/me/campaigns                     活动列表（含 claimStatus）
//   POST /sash/api/v1/me/campaigns/{campaignId}/claim  领取（幂等，空 body）
//   POST /api/v1/deviceToken/refresh                   设备令牌刷新（drt- 前缀）
//
// 关键请求形态（对齐 AI Work 助手逆向结论）：
//   - Cosy-ClientType 必带，缺失时服务端静默返回空活动列表；
//   - 列表请求优先携带完整设备指纹头，空表时用「最小头」复取（上游按请求形态分桶投放）；
//   - claim 一律用最小头（带设备指纹头族会被风控前置拦截）；
//   - claim 响应 data.status=BLOCKED 表示「账号×设备」信任未建立，需客户端登录一次。
// ============================================================================

import {
  requestGet,
  requestJson,
  findField,
  messageOf,
  redact,
  sleep,
  summary,
} from '../lib/http.mjs';

const OPEN_API = 'https://openapi.qoder.com.cn';
const CAMPAIGNS_URL = `${OPEN_API}/sash/api/v1/me/campaigns`;
const REFRESH_URL = `${OPEN_API}/api/v1/deviceToken/refresh`;
const COSY_CLIENT_TYPE = '10';
const CLIENT_UA = 'Qoder';
const COSY_VERSION = '0.4.3';
const MACHINE_OS = 'x86_64_win32';
const CLAIM_GAP_MS = 900; // 领取间隔（风控合规：不连续轰炸）

export const platform = 'qoder';

function credsOf(account) {
  const cred = account.credential && typeof account.credential === 'object' ? account.credential : {};
  return {
    accessToken: cred.access_token || account.access_token || '',
    refreshToken: cred.refresh_token || account.refresh_token || '',
    expiresAt: Number(cred.expires_at_ms ?? account.token_expires_at ?? 0),
  };
}

export function isUsable(account) {
  return Boolean(account && account.id && credsOf(account).accessToken);
}

export function displayName(account) {
  return account.nickname || account.phone_masked || account.uid || account.id || '未知账号';
}

function machineIdOf(account) {
  const profile = account.device_profile || {};
  return String(profile.machine_id || account.machine_id || '');
}

function baseHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    'Cosy-ClientType': COSY_CLIENT_TYPE,
    'User-Agent': CLIENT_UA,
    'Content-Type': 'application/json',
  };
}

/** 完整设备头（列表请求用；claim 不用）。 */
function deviceHeaders(account, token) {
  const headers = baseHeaders(token);
  const machineId = machineIdOf(account);
  headers['Cosy-Version'] = COSY_VERSION;
  headers['Cosy-MachineOS'] = MACHINE_OS;
  headers['Cosy-MachineHostname'] = 'PC';
  if (machineId) {
    headers['Cosy-MachineId'] = machineId;
    headers['Cosy-MachineCode'] = machineId.slice(0, 18);
    headers['Cosy-MachineType'] = machineId.slice(0, 17);
  }
  return headers;
}

function claimedStatusOf(campaign) {
  return String(findField(campaign, ['claimStatus', 'claim_status']) ?? '').toUpperCase();
}

function campaignIdOf(campaign) {
  return String(findField(campaign, ['campaignId', 'campaign_id']) ?? '');
}

function isDailyCredits(campaign) {
  const action = String(campaign?.actionType ?? '').toUpperCase();
  const kind = String(findField(campaign?.benefit ?? {}, ['kind']) ?? '').toUpperCase();
  return action === 'CLAIM_BENEFIT' && kind === 'CREDITS';
}

function inWindow(campaign, nowSecs) {
  const start = Number(findField(campaign, ['startAt', 'start_at']));
  const end = Number(findField(campaign, ['endAt', 'end_at']));
  if (!Number.isFinite(start) || !Number.isFinite(end) || start <= 0) return false;
  return start <= nowSecs && nowSecs <= end;
}

function extractCampaigns(json) {
  const list = findField(json, ['campaigns']);
  return Array.isArray(list) ? list : [];
}

/** 拉活动列表：完整头 → 空表则最小头复取。返回 { campaigns, minimal }。 */
async function fetchCampaigns(account) {
  const token = credsOf(account).accessToken;
  let resp = await requestGet(CAMPAIGNS_URL, { headers: deviceHeaders(account, token) });
  if (resp.status === 401) return { unauthorized: true };
  if (resp.status === 0) return { error: resp.error };
  if (resp.status < 200 || resp.status > 299) {
    return { error: messageOf(resp.status, resp.json, resp.text) };
  }
  let campaigns = extractCampaigns(resp.json);
  if (campaigns.length > 0) return { campaigns, minimal: false };
  // 空表兜底：最小头形态（不带设备指纹头族）
  resp = await requestGet(CAMPAIGNS_URL, { headers: baseHeaders(token) });
  if (resp.status === 401) return { unauthorized: true };
  if (resp.status === 0) return { error: resp.error };
  campaigns = extractCampaigns(resp.json);
  return { campaigns, minimal: campaigns.length > 0 };
}

/** 刷新设备令牌：返回写回 credential 后的账号副本，失败返回 null。 */
async function refreshAccountToken(account) {
  const creds = credsOf(account);
  if (!creds.refreshToken) return null;
  // 刷新端点不带 Authorization（鉴权完全靠 body 中的 refresh_token），只保留 Cosy 头
  const headers = baseHeaders('');
  delete headers.Authorization;
  const resp = await requestJson(REFRESH_URL, {
    headers,
    body: { refresh_token: creds.refreshToken },
  });
  const data = resp.json?.data ?? resp.json;
  const newAccess = data?.access_token ?? data?.accessToken;
  if (!newAccess) return null;
  const newRefresh = data?.refresh_token ?? data?.refreshToken ?? creds.refreshToken;
  const now = Date.now();
  const cred = { ...(account.credential || {}) };
  cred.access_token = newAccess;
  cred.refresh_token = newRefresh;
  const expiresIn = Number(data?.expires_in ?? data?.expiresIn);
  if (Number.isFinite(expiresIn) && expiresIn > 0) cred.expires_at_ms = now + expiresIn * 1000;
  return {
    ...account,
    access_token: newAccess,
    refresh_token: newRefresh,
    credential: cred,
  };
}

/** 领取单个活动：最小头 + 空 body。 */
async function claimCampaign(account, campaign) {
  const campaignId = campaignIdOf(campaign);
  // 路径段白名单（id 来自服务端，异常字符会改变路径语义）
  if (!campaignId || !/^[A-Za-z0-9_-]+$/.test(campaignId)) {
    return { result: 'error', error: 'campaignId 非法，已跳过' };
  }
  const token = credsOf(account).accessToken;
  await sleep(CLAIM_GAP_MS);
  const resp = await requestJson(`${CAMPAIGNS_URL}/${campaignId}/claim`, {
    headers: baseHeaders(token),
    body: '',
  });
  if (resp.status === 401) return { result: 'error', unauthorized: true, error: '登录态失效（401）' };
  if (resp.status === 0) return { result: 'error', error: resp.error };
  const data = resp.json;
  const status = String(findField(data ?? {}, ['status']) ?? '').toUpperCase();
  const replayed = Boolean(findField(data ?? {}, ['replayed']));
  if (status === 'BLOCKED') {
    return {
      result: 'error',
      error:
        '领取被风控拦截（status=BLOCKED）：需在 Qoder 客户端使用一次该账号以建立设备信任',
    };
  }
  if (resp.status >= 200 && resp.status <= 299) {
    if (replayed) return { result: 'already', message: '今日已领取（幂等回放）' };
    const benefit = data?.benefit?.amount ?? findField(data ?? {}, ['amount']);
    const reward = typeof benefit === 'number' && benefit > 0 ? `+${benefit}` : 'ok';
    return { result: 'success', message: reward };
  }
  return { result: 'error', error: messageOf(resp.status, data, resp.text) };
}

/** 无 CLAIMABLE 时判断今日是否已领（列表 CLAIMED grant + 重发 claim 复核）。 */
async function alreadyClaimedToday(account, campaigns, nowSecs) {
  const claimed = campaigns.find(
    (c) => isDailyCredits(c) && claimedStatusOf(c) === 'CLAIMED' && inWindow(c, nowSecs),
  );
  if (!claimed) return false;
  // 幂等复核：列表 CLAIMED 可能是批次窗口内的旧记录，重发 claim 回放才作数。
  const replay = await claimCampaign(account, claimed);
  return replay.result === 'already';
}

/** 单账号流程：列活动 → 领取可领项 → 无则判断已领。 */
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

  let list = await fetchCampaigns(account);
  if (list.unauthorized) {
    if (applyRefresh(await refreshAccountToken(account))) {
      list = await fetchCampaigns(account);
    }
  }
  if (list.unauthorized) {
    return { name, result: 'error', error: '登录态失效（401），需重新登录 Qoder', account, tokensChanged };
  }
  if (list.error) {
    return { name, result: 'error', error: list.error, account, tokensChanged };
  }
  if (!list.campaigns || list.campaigns.length === 0) {
    return {
      name,
      result: 'error',
      error: '活动列表为空（活动未开始、登录态或设备指纹不被识别）',
      account,
      tokensChanged,
    };
  }

  const nowSecs = Math.floor(Date.now() / 1000);
  const claimable = list.campaigns.filter(
    (c) => claimedStatusOf(c) === 'CLAIMABLE' && inWindow(c, nowSecs),
  );

  if (claimable.length === 0) {
    const already = await alreadyClaimedToday(account, list.campaigns, nowSecs);
    if (already) return { name, result: 'already', account, tokensChanged };
    const hasDaily = list.campaigns.some((c) => isDailyCredits(c) && inWindow(c, nowSecs));
    if (!hasDaily) {
      // 活动未开档不是签到失败：服务端当天确实没有可领权益，报跳过避免工作流每天标红。
      return {
        name,
        result: 'skip',
        message: '当前无每日积分活动（只有浏览类活动，等待官方开档）',
        account,
        tokensChanged,
      };
    }
    return {
      name,
      result: 'error',
      error: '每日积分活动已结束或本账号无领取资格',
      account,
      tokensChanged,
    };
  }

  let success = 0;
  let already = 0;
  const failures = [];
  for (const campaign of claimable) {
    let outcome = await claimCampaign(account, campaign);
    if (outcome.unauthorized) {
      if (applyRefresh(await refreshAccountToken(account))) {
        outcome = await claimCampaign(account, campaign);
      }
    }
    if (outcome.result === 'success') success += 1;
    else if (outcome.result === 'already') already += 1;
    else failures.push(outcome.error || '领取失败');
  }

  if (success > 0) {
    return {
      name,
      result: 'success',
      message: `领取 ${success} 项${already ? `，${already} 项已领` : ''}`,
      account,
      tokensChanged,
    };
  }
  if (already > 0 && failures.length === 0) {
    return { name, result: 'already', message: '今日已领取', account, tokensChanged };
  }
  return {
    name,
    result: 'error',
    error: failures[0] || '领取失败',
    account,
    tokensChanged,
  };
}

export const redactError = (value) => redact(String(value ?? ''));
