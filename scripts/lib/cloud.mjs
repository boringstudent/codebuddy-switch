// ============================================================================
// 云端账号仓库客户端（EO 边缘函数 → 私有 GitHub 仓库）
//
// 环境变量（GitHub Actions Secrets 配置）：
//   EO_ACCOUNTS_URL  EO 边缘函数地址（可省略 https://）
//   EO_ACCESS_KEY    与 EO 函数环境变量 ACCESS_KEY 相同的访问 key
//
// 接口：GET /accounts?platform=<name>、POST /accounts/merge?platform=<name>
// 兼容旧版函数（不识别 platform 参数时仍返回 codebuddy 账号库）。
// ============================================================================

const rawEoUrl = (process.env.EO_ACCOUNTS_URL || '').trim();
export const EO_ACCOUNTS_URL = (
  /^https?:\/\//i.test(rawEoUrl) ? rawEoUrl : `https://${rawEoUrl}`
).replace(/\/+$/, '');
const EO_ACCESS_KEY = process.env.EO_ACCESS_KEY || '';
const REQUEST_TIMEOUT_MS = 30_000;

export function ensureCloudConfig() {
  if (!rawEoUrl || !EO_ACCESS_KEY) {
    throw new Error('缺少环境变量 EO_ACCOUNTS_URL / EO_ACCESS_KEY（请在仓库 Secrets 配置）');
  }
}

function platformQuery(platform) {
  return platform && platform !== 'codebuddy'
    ? `?platform=${encodeURIComponent(platform)}`
    : '';
}

async function withTimeout(run) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

/** 拉取指定平台账号数组；失败抛错（错误信息不含凭证）。 */
export async function fetchPlatformAccounts(platform) {
  ensureCloudConfig();
  const resp = await withTimeout((signal) =>
    fetch(`${EO_ACCOUNTS_URL}/accounts${platformQuery(platform)}`, {
      headers: { 'X-Access-Key': EO_ACCESS_KEY, Accept: 'application/json' },
      signal,
    }),
  );
  if (!resp.ok) {
    // 旧版函数收到未知查询参数不影响 codebuddy；但 4xx/5xx 一律视为失败。
    throw new Error(`EO 返回 HTTP ${resp.status}`);
  }
  const data = await resp.json();
  if (!Array.isArray(data)) throw new Error('EO 返回数据不是账号数组');
  return data;
}

/** 把刷新过 token 的账号按 id 合并回该平台账号库；失败只记日志。 */
export async function mergePlatformAccounts(platform, accounts) {
  if (!accounts.length) return true;
  ensureCloudConfig();
  try {
    const resp = await withTimeout((signal) =>
      fetch(`${EO_ACCOUNTS_URL}/accounts/merge${platformQuery(platform)}`, {
        method: 'POST',
        headers: {
          'X-Access-Key': EO_ACCESS_KEY,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(accounts),
        signal,
      }),
    );
    const data = await resp.json().catch(() => null);
    if (resp.ok && data?.ok) {
      console.log(`[${platform}] 已回写 ${accounts.length} 个账号的新 token 到云端账号仓库`);
      return true;
    }
    console.error(
      `[${platform}] 回写云端账号仓库失败：HTTP ${resp.status} ${data?.error || ''}`.trim(),
    );
    return false;
  } catch (error) {
    console.error(`[${platform}] 回写云端账号仓库失败：${String(error?.message || error)}`);
    return false;
  }
}
