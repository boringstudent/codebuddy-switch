// ============================================================================
// wb-switch 账号数据仓库 —— 腾讯云 EdgeOne（EO）边缘函数
//
// 用途：安全存放 CodeBuddy / WorkBuddy 账号凭据（access_token / refresh_token），
//       供 GitHub Actions 每日签到工作流通过「专用访问 key」拉取。
//
// 部署步骤：
//   1. EO 控制台 → 边缘函数 → 新建函数，把本文件全文粘贴为函数代码；
//   2. 把下方 ACCOUNTS_JSON 占位数组替换为你的账号数据（格式与桌面端
//      ~/.wb-switch/accounts.json 相同，即账号对象数组）；
//      ⚠️ 填入真实 token 后本文件等同密码本：不要提交到公开仓库、不要外发；
//   3. EO 控制台 → 函数「环境变量」配置：
//        ACCESS_KEY = 一串足够长的随机字符串（读写共用的访问 key）
//      GitHub 仓库侧同名 secret（EO_ACCESS_KEY）必须与此一致；
//   4. 给函数绑定触发域名（如 https://xxx.eo-edgefunctions.com），
//      把该地址填到 GitHub 仓库 secret EO_ACCOUNTS_URL（不带末尾斜杠）。
//
// 接口：
//   GET  /health    公开探活，返回 { ok: true }
//   GET  /accounts  需请求头 X-Access-Key（或 Authorization: Bearer <key>），
//                   返回账号数组 JSON；key 错误一律 401（不区分原因，防探测）
//   其他路径/方法   404 / 405
//
// 说明：token 需要更新时（refresh 轮换后旧 refresh_token 失效），重新编辑
//       ACCOUNTS_JSON 并重新部署即可。函数本身不持久化写操作，避免多实例
//       间数据不一致。
// ============================================================================

// ▼▼▼ 部署时替换为你的账号数据（账号对象数组，见文件头说明） ▼▼▼
const ACCOUNTS_JSON = [];
// ▲▲▲ 部署时替换为你的账号数据 ▲▲▲

/** 读取环境变量（兼容 EO 多种注入形态：全局变量 / globalThis.env）。 */
function getEnv(name) {
  if (typeof globalThis !== 'undefined') {
    if (typeof globalThis[name] === 'string' && globalThis[name]) return globalThis[name];
    if (globalThis.env && typeof globalThis.env[name] === 'string' && globalThis.env[name]) {
      return globalThis.env[name];
    }
  }
  return '';
}

const ACCESS_KEY = getEnv('ACCESS_KEY');

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
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
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function handleRequest(request) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (request.method === 'GET' && path === '/health') {
    return json({ ok: true, accounts: ACCOUNTS_JSON.length, keyConfigured: Boolean(ACCESS_KEY) });
  }

  if (path === '/accounts') {
    if (request.method !== 'GET') {
      return json({ error: 'method not allowed' }, 405, { Allow: 'GET' });
    }
    if (!ACCESS_KEY) {
      // 未配置 ACCESS_KEY 时一律拒绝（默认安全，绝不匿名放行）。
      return json({ error: 'server not configured' }, 500);
    }
    if (!safeEqual(requestKey(request), ACCESS_KEY)) {
      return json({ error: 'unauthorized' }, 401);
    }
    return new Response(JSON.stringify(ACCOUNTS_JSON), {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    });
  }

  return json({ error: 'not found' }, 404);
}

addEventListener('fetch', (event) => {
  event.respondWith(handleRequest(event.request));
});
