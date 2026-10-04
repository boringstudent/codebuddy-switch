#!/usr/bin/env node
// ============================================================================
// 每日自动签到脚本（GitHub Actions 用，Node >= 18，零依赖）
//
// 流程：
//   1. 用专用访问 key 从 EO 边缘函数拉取账号数据（accounts 数组）；
//   2. 逐账号：token 临期（< 24h）先走官方刷新接口换新；
//   3. 查询今日签到状态（checkin-activity-status，失败回退 checkin-status）；
//   4. 未签到则提交 daily-checkin；遇到 401/403 刷新一次并重试；
//   5. 只输出「昵称 + 结果」，绝不打印任何 token / key（请求失败也先脱敏）。
//
// 环境变量（都在 GitHub 仓库 Secrets 配置）：
//   EO_ACCOUNTS_URL  EO 边缘函数地址，如 https://xxx.eo-edgefunctions.com
//   EO_ACCESS_KEY    与 EO 函数环境变量 ACCESS_KEY 相同的访问 key
//
// 退出码：任一账号硬失败 → 1（让工作流标红便于发现）；全部成功/已签到 → 0。
// ============================================================================

import { sendMail } from './send-mail.mjs';

const API_BASE = 'https://www.codebuddy.cn';
const BILLING_PREFIX = '/v2/billing/meter';
const REFRESH_PATH = '/v2/plugin/auth/token/refresh';
const REFRESH_WITHIN_MS = 24 * 3600 * 1000; // 剩余不足 24h 先刷新
const REQUEST_TIMEOUT_MS = 30_000;
const ACCOUNT_GAP_MS = 1500; // 账号间隔，避免触发网关频控

// 签到完成后向该地址发送报告邮件（自发自收）；授权码读环境变量 QQ。
const MAIL_ADDRESS = 'boring_student@qq.com';

const EO_ACCOUNTS_URL = (process.env.EO_ACCOUNTS_URL || '').replace(/\/+$/, '');
const EO_ACCESS_KEY = process.env.EO_ACCESS_KEY || '';

if (!EO_ACCOUNTS_URL || !EO_ACCESS_KEY) {
  console.error('缺少环境变量 EO_ACCOUNTS_URL / EO_ACCESS_KEY（请在仓库 Secrets 配置）');
  process.exit(2);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 发起请求并解析 JSON；超时/网络错误/非 JSON 统一成 { code: -1, message }。 */
async function apiPost(url, headers, body = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await resp.text();
    try {
      return JSON.parse(text);
    } catch {
      return { code: -1, message: `HTTP ${resp.status}：响应非 JSON` };
    }
  } catch (error) {
    const reason = error?.name === 'AbortError' ? '请求超时' : String(error?.message || error);
    return { code: -1, message: `网络错误：${reason}` };
  } finally {
    clearTimeout(timer);
  }
}

/** 与桌面端 build_auth_headers 同口径的请求头。 */
function authHeaders(account) {
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

function isUnauthorized(resp) {
  const code = Number(resp?.code ?? -1);
  if (code === 401 || code === 403) return true;
  const msg = String(resp?.message ?? resp?.msg ?? '').toLowerCase();
  return ['unauthorized', '401', '登录', '失效', '过期', 'token'].some((k) => msg.includes(k));
}

function messageOf(resp) {
  const code = Number(resp?.code ?? -1);
  return String(resp?.message ?? resp?.msg ?? `code=${code}`);
}

/** 刷新 token（POST /v2/plugin/auth/token/refresh）。成功返回更新后的账号副本。 */
async function refreshAccountToken(account) {
  if (!account.refresh_token) return null;
  const resp = await apiPost(`${API_BASE}${REFRESH_PATH}`, {
    ...authHeaders(account),
    'X-Refresh-Token': account.refresh_token,
    'X-Auth-Refresh-Source': 'plugin', // 网关按 client 来源校验，缺失会 invalid_grant
  });
  const data = resp?.data ?? resp;
  const newAccess = data?.accessToken ?? data?.access_token;
  if (!newAccess) return null;
  const next = { ...account, access_token: newAccess };
  const newRefresh = data?.refreshToken ?? data?.refresh_token;
  if (newRefresh) next.refresh_token = newRefresh;
  const expiresIn = Number(data?.expiresIn ?? data?.expires_in);
  if (Number.isFinite(expiresIn) && expiresIn > 0) next.expiresAt = Date.now() + expiresIn * 1000;
  return next;
}

/** 查询今日签到状态：新接口失败回退旧接口。返回 { ok, todayCheckedIn?, error? }。 */
async function getCheckinStatus(account) {
  for (const suffix of ['/checkin-activity-status', '/checkin-status']) {
    const resp = await apiPost(`${API_BASE}${BILLING_PREFIX}${suffix}`, authHeaders(account));
    const code = Number(resp?.code ?? -1);
    if (code === 0 || code === 200) {
      const data = resp.data ?? {};
      return { ok: true, todayCheckedIn: Boolean(data.today_checked_in ?? data.todayCheckedIn) };
    }
    if (isUnauthorized(resp)) return { ok: false, error: messageOf(resp), unauthorized: true };
    // 其他失败继续尝试下一个候选路径
  }
  return { ok: false, error: '查询签到状态失败' };
}

/** 提交签到（POST /daily-checkin）。「已签到」幂等提示按成功处理。 */
async function performCheckin(account) {
  const resp = await apiPost(`${API_BASE}${BILLING_PREFIX}/daily-checkin`, authHeaders(account));
  const code = Number(resp?.code ?? -1);
  if (code === 0 || code === 200) return { result: 'success' };
  const msg = messageOf(resp);
  if (msg.includes('已签到') || msg.toLowerCase().includes('repeat')) {
    return { result: 'already', message: msg };
  }
  return { result: 'error', error: msg, unauthorized: isUnauthorized(resp) };
}

/** 单账号完整流程：临期刷新 → 查状态 → 未签则提交 → 401 刷新重试一次。 */
async function checkinAccount(rawAccount) {
  let account = rawAccount;
  const name = account.nickname || account.phone || account.uid || account.id || '未知账号';

  // 1) 临期（或无 expiresAt）且有 refresh_token：先刷新，避免拿过期 token 签到。
  const exp = Number(account.expiresAt);
  const stale = !Number.isFinite(exp) || exp <= Date.now() + REFRESH_WITHIN_MS;
  if (stale && account.refresh_token) {
    const refreshed = await refreshAccountToken(account);
    if (refreshed) account = refreshed;
  }

  // 2) 查状态 → 决定 已签 / 提交；401 时刷新一次重试。
  let status = await getCheckinStatus(account);
  if (status.unauthorized) {
    const refreshed = await refreshAccountToken(account);
    if (refreshed) {
      account = refreshed;
      status = await getCheckinStatus(account);
    }
  }
  if (status.ok && status.todayCheckedIn) return { name, result: 'already' };
  if (!status.ok && !status.unauthorized) {
    // 状态查询失败不一定是鉴权问题：保守起见仍尝试提交一次（daily-checkin 幂等）。
    // 与桌面端 decide_from_status 的 statusUnsupported 分支同策略。
  }

  // 3) 提交签到；401 刷新重试一次。
  let outcome = await performCheckin(account);
  if (outcome.unauthorized) {
    const refreshed = await refreshAccountToken(account);
    if (refreshed) {
      account = refreshed;
      outcome = await performCheckin(account);
    }
  }
  return { name, ...outcome };
}

async function fetchAccounts() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const resp = await fetch(`${EO_ACCOUNTS_URL}/accounts`, {
      headers: { 'X-Access-Key': EO_ACCESS_KEY, Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!resp.ok) throw new Error(`EO 返回 HTTP ${resp.status}`);
    const data = await resp.json();
    if (!Array.isArray(data)) throw new Error('EO 返回数据不是账号数组');
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const accounts = (await fetchAccounts()).filter(
    (account) => account && (account.variant ?? 'cn') === 'cn' && account.access_token,
  );
  console.log(`共读取 ${accounts.length} 个国内版账号，开始签到…`);

  let success = 0;
  let already = 0;
  let failed = 0;
  const report = [];
  for (const account of accounts) {
    try {
      const outcome = await checkinAccount(account);
      if (outcome.result === 'success') {
        success += 1;
        console.log(`[成功] ${outcome.name}`);
        report.push({ name: outcome.name, result: '签到成功' });
      } else if (outcome.result === 'already') {
        already += 1;
        console.log(`[已签] ${outcome.name}`);
        report.push({ name: outcome.name, result: '今日已签到' });
      } else {
        failed += 1;
        console.error(`[失败] ${outcome.name}：${outcome.error || '未知错误'}`);
        report.push({ name: outcome.name, result: `签到失败：${outcome.error || '未知错误'}` });
      }
    } catch (error) {
      failed += 1;
      const name = account.nickname || account.uid || '未知账号';
      console.error(`[失败] ${name}：${String(error?.message || error)}`);
      report.push({ name, result: `签到失败：${String(error?.message || error)}` });
    }
    await sleep(ACCOUNT_GAP_MS);
  }

  console.log(`签到完成：成功 ${success}，已签 ${already}，失败 ${failed}`);
  await sendReportMail({ success, already, failed, report });
  if (failed > 0) process.exit(1);
}

/** 发送签到报告邮件（自发自收）。邮件失败只记日志，不影响签到结果与退出码。 */
async function sendReportMail({ success, already, failed, report }) {
  if (!process.env.QQ) {
    console.log('未配置 QQ 邮箱授权码（环境变量 QQ），跳过邮件通知');
    return;
  }
  const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  const summary = `成功 ${success}，已签 ${already}，失败 ${failed}（共 ${report.length} 个账号）`;
  const lines = report.map((item) => `${item.name}：${item.result}`);
  const text = [`签到时间（北京时间）：${now}`, `结果汇总：${summary}`, '', '明细：', ...lines].join('\n');
  try {
    await sendMail({
      user: MAIL_ADDRESS,
      pass: process.env.QQ,
      to: MAIL_ADDRESS,
      subject: `wb-switch 每日签到：${summary}`,
      text,
    });
    console.log(`签到报告邮件已发送至 ${MAIL_ADDRESS}`);
  } catch (error) {
    console.error(`签到报告邮件发送失败：${String(error?.message || error)}`);
  }
}

main().catch((error) => {
  console.error(`签到任务异常中止：${String(error?.message || error)}`);
  process.exit(1);
});
