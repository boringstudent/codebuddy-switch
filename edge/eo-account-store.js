// ============================================================================
// wb-switch 账号数据仓库 —— 腾讯云 EdgeOne（EO）边缘函数（GitHub 持久化版）
//
// 用途：安全存放 CodeBuddy / WorkBuddy / Trae / Qoder 账号凭据，
//       供 GitHub Actions 每日签到工作流通过「专用访问 key」拉取与回写。
//
// 与旧版（静态快照）的区别：
//   账号数据不再硬编码在函数里，而是存放在一个 **GitHub 私有仓库** 的 JSON 文件中，
//   函数通过 Contents API 实时读写：
//     - 新加入账号库的账号上传后立即对签到工作流可见；
//     - 工作流临期刷新得到的新 token 签到后回写，refresh_token 轮换不再失效。
//
// 多平台布局（platform 参数，缺省 codebuddy，向后兼容旧调用）：
//   codebuddy  → accounts.json            （桌面端上传的 CodeBuddy 账号库）
//   workbuddy  → workbuddy-accounts.json  （AI Work 助手 WorkBuddy 导出结构）
//   trae       → trae-accounts.json       （AI Work 助手 Trae 导出结构）
//   qoder      → qoder-accounts.json      （AI Work 助手 Qoder 解密后账号池）
//
// 部署步骤：
//   1. 准备一个 GitHub 私有仓库（如 boringstudent/cloud-sync）和一个有该仓库
//      Contents 读写权限的 token（Fine-grained PAT 勾选 Contents: Read and write，
//      或经典 PAT 勾选 repo）；
//   2. EO 控制台 → 边缘函数 → 新建函数，把本文件全文粘贴为函数代码；
//   3. EO 控制台 → 函数「环境变量」配置：
//        ACCESS_KEY    一串足够长的随机字符串（读写共用的访问 key），
//                      GitHub 仓库 secret EO_ACCESS_KEY 必须与此一致
//        GITHUB_TOKEN  上一步的 GitHub token
//        GITHUB_REPO   可选，默认 boringstudent/cloud-user
//        GITHUB_PATH   可选，codebuddy 账号文件路径，默认 accounts.json
//        GITHUB_BRANCH 可选，默认 main
//      其余平台文件路径可用 GITHUB_PATH_WORKBUDDY / GITHUB_PATH_TRAE /
//      GITHUB_PATH_QODER 单独覆盖（一般无需配置）。
//   4. 给函数绑定触发域名（如 https://xxx.eo-edgefunctions.com），
//      把该地址填到 GitHub 仓库 secret EO_ACCOUNTS_URL（不带末尾斜杠）；
//   5. 在桌面应用「设置 → 云端账号同步」填入函数地址与 ACCESS_KEY，
//      点「上传到云端」把账号库推送上去（之后账号有变动再点一次即可）。
//
// 接口（除 /health 外一律需要 X-Access-Key 或 Authorization: Bearer <key>）：
//   GET  /health          公开探活，返回配置自检状态（不泄露任何密钥与账号数细节）
//   GET  /accounts?platform=<name>        返回该平台账号数组 JSON（带 30s 缓存）
//   POST /accounts/merge?platform=<name>  body 为账号对象数组，按 id 合并后写回
//                         （同 id 覆盖字段，仓库里有而 body 没有的账号保留），
//                         供签到工作流回写刷新后的 token、桌面端上传账号库
//   GET  /platforms       各平台账号数量概览（不含任何账号内容）
//   其他路径/方法         404 / 405
//
// 安全说明：本函数本身不含任何账号数据；ACCESS_KEY 错误一律 401（不区分原因）；
//           GITHUB_TOKEN 只存在于 EO 环境变量，不会出现在任何响应里。
// ============================================================================

const DEFAULT_REPO = 'boringstudent/cloud-user';
const DEFAULT_BRANCH = 'main';
const CACHE_TTL_MS = 30_000; // 仓库读缓存，避免频繁打 GitHub API
const GITHUB_API = 'https://api.github.com';
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * 平台定义：文件路径 + 有效账号判定（签到工作流只消费通过校验的账号）。
 * 判定必须是「能支撑一次签到请求」的最小字段集合：
 *   codebuddy  顶层 access_token
 *   workbuddy  credential.access_token（AI Work 助手导出）或顶层 access_token
 *   trae       cloudIdeJwt（Trae 的鉴权头是 Cloud-IDE-JWT <jwt>）
 *   qoder      credential.access_token（dt- 设备令牌 / jt- 作业令牌）
 */
const PLATFORMS = {
  codebuddy: {
    defaultPath: 'accounts.json',
    pathEnv: 'GITHUB_PATH',
    hasCredential: (acc) => Boolean(acc.access_token),
  },
  workbuddy: {
    defaultPath: 'workbuddy-accounts.json',
    pathEnv: 'GITHUB_PATH_WORKBUDDY',
    hasCredential: (acc) => Boolean(acc.access_token || (acc.credential && acc.credential.access_token)),
  },
  trae: {
    defaultPath: 'trae-accounts.json',
    pathEnv: 'GITHUB_PATH_TRAE',
    hasCredential: (acc) => Boolean(acc.cloudIdeJwt),
  },
  qoder: {
    defaultPath: 'qoder-accounts.json',
    pathEnv: 'GITHUB_PATH_QODER',
    hasCredential: (acc) => Boolean(acc.access_token || (acc.credential && acc.credential.access_token)),
  },
};

// 实例级缓存：EO 函数实例会复用，按平台缓存账号内容与对应 sha。
const cache = new Map();

/** 读取环境变量（兼容 EO 多种注入形态：全局变量 / globalThis.env / fetch event.env）。 */
function getEnv(name, event) {
  if (event && event.env && typeof event.env[name] === 'string' && event.env[name]) {
    return event.env[name];
  }
  if (typeof globalThis !== 'undefined') {
    if (typeof globalThis[name] === 'string' && globalThis[name]) return globalThis[name];
    if (globalThis.env && typeof globalThis.env[name] === 'string' && globalThis.env[name]) {
      return globalThis.env[name];
    }
  }
  return '';
}

function platformConfig(platform, event) {
  const def = PLATFORMS[platform];
  return {
    platform,
    path: getEnv(def.pathEnv, event) || def.defaultPath,
    hasCredential: def.hasCredential,
  };
}

function config(event) {
  return {
    accessKey: getEnv('ACCESS_KEY', event),
    token: getEnv('GITHUB_TOKEN', event),
    repo: getEnv('GITHUB_REPO', event) || DEFAULT_REPO,
    branch: getEnv('GITHUB_BRANCH', event) || DEFAULT_BRANCH,
  };
}

// 桌面端（Tauri webview）跨域调用需要 CORS；数据接口仍强制 X-Access-Key 鉴权。
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'X-Access-Key, Authorization, Content-Type, Accept',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
};

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...CORS_HEADERS,
      ...extraHeaders,
    },
  });
}

/** 从请求头取访问 key：优先 X-Access-Key，其次 Authorization: Bearer。 */
function requestKey(request) {
  const direct = request.headers.get('X-Access-Key');
  if (direct) return direct.trim();
  const auth = request.headers.get('Authorization') || '';
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

/** 常量时间比较，防时序侧信道。 */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < b.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** 调 GitHub REST API；超时/网络错误抛出带状态的错误。 */
async function githubApi(url, token, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      ...options,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'User-Agent': 'wb-switch-eo-account-store',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(options.headers || {}),
      },
      signal: controller.signal,
    });
    const text = await resp.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }
    if (!resp.ok) {
      const msg = (body && (body.message || body.error)) || `HTTP ${resp.status}`;
      // GitHub 对无权限的私有仓库一律回 404，附一句可读提示。
      const hint = resp.status === 404 ? '（仓库不存在或 token 无访问权限）' : '';
      throw new Error(`GitHub API ${resp.status}: ${msg}${hint}`);
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

/** Base64 编解码（EO 运行时无 Buffer，用 atob/btoa + UTF-8 处理中文）。 */
function b64encode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
function b64decode(b64) {
  const bin = atob(String(b64).replace(/\s+/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function contentsUrl(cfg, platformCfg) {
  return `${GITHUB_API}/repos/${cfg.repo}/contents/${encodeURIComponent(platformCfg.path).replace(/%2F/g, '/')}`;
}

/** 从仓库读取某平台账号数组（带缓存）。返回 { accounts, sha }；文件不存在返回空数组。 */
async function readAccounts(cfg, platformCfg, force = false) {
  const key = `${cfg.repo}/${platformCfg.path}@${cfg.branch}`;
  const hit = cache.get(key);
  if (!force && hit && hit.accounts && Date.now() - hit.at < CACHE_TTL_MS) {
    return { accounts: hit.accounts, sha: hit.sha };
  }
  const url = `${contentsUrl(cfg, platformCfg)}?ref=${encodeURIComponent(cfg.branch)}`;
  try {
    const body = await githubApi(url, cfg.token);
    const content = b64decode(body.content || '');
    const parsed = JSON.parse(content);
    if (!Array.isArray(parsed)) throw new Error('仓库中的账号文件不是 JSON 数组');
    cache.set(key, { at: Date.now(), accounts: parsed, sha: body.sha || null });
    return { accounts: parsed, sha: body.sha || null };
  } catch (error) {
    if (String(error?.message || '').includes('404')) {
      // 文件还没建过：视为空账号库。
      cache.set(key, { at: Date.now(), accounts: [], sha: null });
      return { accounts: [], sha: null };
    }
    throw error;
  }
}

/** 把账号数组写回仓库（需要先拿到最新 sha，防并发覆盖）。 */
async function writeAccounts(cfg, platformCfg, accounts, message) {
  const key = `${cfg.repo}/${platformCfg.path}@${cfg.branch}`;
  const { sha } = await readAccounts(cfg, platformCfg, true); // 写前强制取最新 sha
  const body = {
    message,
    content: b64encode(JSON.stringify(accounts, null, 2)),
    branch: cfg.branch,
  };
  if (sha) body.sha = sha;
  const result = await githubApi(contentsUrl(cfg, platformCfg), cfg.token, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
  const newSha = result && result.content && result.content.sha ? result.content.sha : null;
  cache.set(key, { at: Date.now(), accounts, sha: newSha });
  return newSha;
}

/** 按 id 合并：body 中同 id 账号覆盖仓库字段，仓库独有的账号保留，body 新增的追加。 */
function mergeAccounts(remote, incoming) {
  const byId = new Map();
  for (const acc of remote) {
    if (acc && acc.id) byId.set(acc.id, acc);
  }
  let updated = 0;
  let added = 0;
  const result = [];
  for (const acc of remote) {
    if (!acc || !acc.id) continue;
    result.push(acc);
  }
  for (const acc of incoming) {
    if (!acc || typeof acc !== 'object' || !acc.id) continue;
    if (byId.has(acc.id)) {
      const idx = result.findIndex((item) => item.id === acc.id);
      if (idx >= 0) {
        result[idx] = { ...result[idx], ...acc };
        updated += 1;
      }
    } else {
      result.push(acc);
      added += 1;
    }
  }
  return { merged: result, updated, added };
}

/** 校验请求体是账号对象数组，且每条至少有 id 与该平台的可用凭证。 */
function parseAccountsBody(text, platformCfg) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { error: '请求体不是合法 JSON' };
  }
  if (!Array.isArray(parsed)) return { error: '请求体必须是账号对象数组' };
  if (parsed.length > 500) return { error: '单次最多提交 500 个账号' };
  const valid = parsed.filter(
    (acc) => acc && typeof acc === 'object' && acc.id && platformCfg.hasCredential(acc),
  );
  return { accounts: valid, dropped: parsed.length - valid.length };
}

async function handleRequest(request, event) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const cfg = config(event);

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (request.method === 'GET' && path === '/health') {
    return json({
      ok: true,
      keyConfigured: Boolean(cfg.accessKey),
      repoConfigured: Boolean(cfg.token),
      platforms: Object.keys(PLATFORMS),
    });
  }

  // 除 /health 外的接口一律先校验访问 key（默认安全，绝不匿名放行）。
  if (!cfg.accessKey) {
    return json({ error: 'server not configured' }, 500);
  }
  if (!safeEqual(requestKey(request), cfg.accessKey)) {
    return json({ error: 'unauthorized' }, 401);
  }

  if (path === '/accounts' && request.method === 'GET') {
    const platform = (url.searchParams.get('platform') || 'codebuddy').trim().toLowerCase();
    if (!PLATFORMS[platform]) return json({ error: `未知平台：${platform}` }, 400);
    if (!cfg.token) return json({ error: 'GITHUB_TOKEN 未配置' }, 500);
    try {
      const { accounts } = await readAccounts(cfg, platformConfig(platform, event));
      return new Response(JSON.stringify(accounts), {
        status: 200,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS_HEADERS },
      });
    } catch (error) {
      return json({ error: `读取账号仓库失败：${String(error?.message || error)}` }, 502);
    }
  }

  if (path === '/accounts/merge' && request.method === 'POST') {
    const platform = (url.searchParams.get('platform') || 'codebuddy').trim().toLowerCase();
    if (!PLATFORMS[platform]) return json({ error: `未知平台：${platform}` }, 400);
    if (!cfg.token) return json({ error: 'GITHUB_TOKEN 未配置' }, 500);
    const platformCfg = platformConfig(platform, event);
    const text = await request.text();
    if (text.length > 4 * 1024 * 1024) return json({ error: '请求体过大' }, 413);
    const { accounts: incoming, dropped, error } = parseAccountsBody(text, platformCfg);
    if (error) return json({ error }, 400);
    if (!incoming.length) {
      return json({ error: '没有可合并的有效账号（需含 id 与该平台凭证字段）' }, 400);
    }
    try {
      const { accounts: remote } = await readAccounts(cfg, platformCfg);
      const { merged, updated, added } = mergeAccounts(remote, incoming);
      await writeAccounts(
        cfg,
        platformCfg,
        merged,
        `chore: 同步 ${platform} 账号库（更新 ${updated}，新增 ${added}）`,
      );
      return json({ ok: true, platform, total: merged.length, updated, added, dropped });
    } catch (err) {
      return json({ error: `写入账号仓库失败：${String(err?.message || err)}` }, 502);
    }
  }

  if (path === '/platforms' && request.method === 'GET') {
    if (!cfg.token) return json({ error: 'GITHUB_TOKEN 未配置' }, 500);
    const summary = {};
    for (const platform of Object.keys(PLATFORMS)) {
      const platformCfg = platformConfig(platform, event);
      try {
        const { accounts } = await readAccounts(cfg, platformCfg);
        const usable = accounts.filter(
          (acc) => acc && acc.id && platformCfg.hasCredential(acc),
        ).length;
        summary[platform] = { total: accounts.length, usable, file: platformCfg.path };
      } catch (error) {
        summary[platform] = { error: String(error?.message || error), file: platformCfg.path };
      }
    }
    return json({ ok: true, platforms: summary });
  }

  if (path === '/accounts' || path === '/accounts/merge' || path === '/platforms') {
    return json({ error: 'method not allowed' }, 405, { Allow: 'GET, POST' });
  }
  return json({ error: 'not found' }, 404);
}

addEventListener('fetch', (event) => {
  event.respondWith(handleRequest(event.request, event));
});
