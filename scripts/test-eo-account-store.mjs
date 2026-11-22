// 本地冒烟测试：edge/eo-account-store.js（多平台 + GitHub 持久化版 EO 函数）
//
// 不依赖 EO 运行时与真实 GitHub：用 addEventListener 垫片捕获 fetch handler，
// 内存 mock api.github.com 的 Contents API（按文件路径区分仓库文件），逐个接口验证。
//
// 运行：node scripts/test-eo-account-store.mjs   全部通过退出码 0，否则 1。

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EO_FILE = join(__dirname, '..', 'edge', 'eo-account-store.js');

const ACCESS_KEY = 'test-access-key';
const TOKEN = 'test-github-token';

// ---------------------------------------------------------------------------
// 内存中的假 GitHub 仓库：path -> { content(utf8), sha }
// ---------------------------------------------------------------------------
const files = new Map();

function b64encode(str) {
  return Buffer.from(str, 'utf8').toString('base64');
}
function b64decode(b64) {
  return Buffer.from(String(b64).replace(/\s+/g, ''), 'base64').toString('utf8');
}

/** 从 Contents API URL 提取仓库内文件路径。 */
function contentsPath(url) {
  const u = new URL(String(url));
  const match = u.pathname.match(/^\/repos\/[^/]+\/[^/]+\/contents\/(.+)$/);
  return match ? decodeURIComponent(match[1]) : null;
}

/** mock fetch：只接管 api.github.com 的 Contents API，其余一律报错。 */
globalThis.fetch = async (url, options = {}) => {
  const u = new URL(String(url));
  if (!u.hostname.endsWith('github.com')) {
    throw new Error(`未 mock 的请求：${u}`);
  }
  const auth = options.headers?.Authorization || options.headers?.authorization || '';
  if (auth !== `Bearer ${TOKEN}`) {
    return new Response(JSON.stringify({ message: 'Bad credentials' }), { status: 401 });
  }
  const filePath = contentsPath(url);
  if (!filePath) {
    return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
  }
  const existing = files.get(filePath) || { content: null, sha: null };
  if (options.method === 'PUT') {
    const body = JSON.parse(options.body);
    if (existing.sha && body.sha !== existing.sha) {
      return new Response(JSON.stringify({ message: 'sha mismatch' }), { status: 409 });
    }
    const sha = `sha-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    files.set(filePath, { content: b64decode(body.content), sha });
    return new Response(JSON.stringify({ content: { sha } }), { status: 200 });
  }
  // GET contents
  if (existing.content === null) {
    return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
  }
  return new Response(
    JSON.stringify({ content: b64encode(existing.content), sha: existing.sha }),
    { status: 200 },
  );
};

// ---------------------------------------------------------------------------
// 加载 EO 函数：垫 addEventListener，注入环境变量
// ---------------------------------------------------------------------------
let handler = null;
globalThis.addEventListener = (type, fn) => {
  if (type === 'fetch') handler = fn;
};
globalThis.ACCESS_KEY = ACCESS_KEY;
globalThis.GITHUB_TOKEN = TOKEN;

const source = readFileSync(EO_FILE, 'utf8');
// 用 eval 在当前上下文执行（文件是经典脚本，最后注册 fetch listener）。
eval(source);
if (!handler) {
  console.error('EO 函数未注册 fetch listener');
  process.exit(1);
}

async function callEo(path, { method = 'GET', key = ACCESS_KEY, body } = {}) {
  const headers = { Accept: 'application/json' };
  if (key !== null) headers['X-Access-Key'] = key;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const request = new Request(`https://eo.test${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let response;
  const event = { request, respondWith: (r) => { response = r; } };
  await handler(event);
  return response;
}

// ---------------------------------------------------------------------------
// 断言
// ---------------------------------------------------------------------------
let passed = 0;
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`);
  }
}

const ACC_A = { id: 'a1', uid: 'u1', nickname: '账号甲', access_token: 'tok-a', refresh_token: 'ref-a', expiresAt: 1 };
const ACC_B = { id: 'b2', uid: 'u2', nickname: '账号乙', access_token: 'tok-b', refresh_token: 'ref-b', expiresAt: 2 };

console.log('health / 鉴权 / CORS');
{
  const resp = await callEo('/health', { key: null });
  const data = await resp.json();
  check('GET /health 无需 key', resp.status === 200 && data.ok === true);
  check('health 报告配置齐全', data.keyConfigured === true && data.repoConfigured === true);
  check('health 列出四个平台', Array.isArray(data.platforms) && data.platforms.length === 4);

  const cors = await callEo('/accounts', { method: 'OPTIONS', key: null });
  check('OPTIONS 预检 204', cors.status === 204);
  check('预检带 CORS 头', cors.headers.get('access-control-allow-origin') === '*');

  const noKey = await callEo('/accounts', { key: null });
  check('无 key 401', noKey.status === 401);
  const badKey = await callEo('/accounts', { key: 'wrong' });
  check('错 key 401', badKey.status === 401);
}

console.log('空仓库读取与首次上传（codebuddy 默认平台）');
{
  const resp = await callEo('/accounts');
  const data = await resp.json();
  check('空仓库返回空数组', resp.status === 200 && Array.isArray(data) && data.length === 0);

  const merge = await callEo('/accounts/merge', { method: 'POST', body: [ACC_A, ACC_B] });
  const result = await merge.json();
  check('首次合并成功', merge.status === 200 && result.ok === true, JSON.stringify(result));
  check('新增 2 个', result.added === 2 && result.total === 2);
  check('写入默认文件', files.has('accounts.json'));

  const after = await callEo('/accounts');
  const accounts = await after.json();
  check('读回 2 个账号', accounts.length === 2);
  check('token 完整保留', accounts.find((a) => a.id === 'a1')?.access_token === 'tok-a');
  check('响应带 CORS 头', after.headers.get('access-control-allow-origin') === '*');
}

console.log('按 id 合并（工作流回写场景）');
{
  const rotated = { ...ACC_A, access_token: 'tok-a-NEW', refresh_token: 'ref-a-NEW' };
  const merge = await callEo('/accounts/merge', { method: 'POST', body: [rotated] });
  const result = await merge.json();
  check('回写成功', result.ok === true && result.updated === 1 && result.added === 0);

  const accounts = await (await callEo('/accounts')).json();
  const a = accounts.find((x) => x.id === 'a1');
  const b = accounts.find((x) => x.id === 'b2');
  check('a1 token 已轮换', a?.access_token === 'tok-a-NEW' && a?.refresh_token === 'ref-a-NEW');
  check('b2 原样保留', b?.access_token === 'tok-b');
  check('总数不变', accounts.length === 2);
}

console.log('多平台：WorkBuddy / Trae / Qoder');
{
  // WorkBuddy：凭证在 credential.access_token
  const wb = { id: 'wb-1', uid: 'u-wb', credential: { access_token: 'wb-tok', refresh_token: 'wb-ref' } };
  const wbMerge = await callEo('/accounts/merge?platform=workbuddy', { method: 'POST', body: [wb] });
  const wbResult = await wbMerge.json();
  check('WorkBuddy 合并成功', wbMerge.status === 200 && wbResult.platform === 'workbuddy');
  check('WorkBuddy 写入独立文件', files.has('workbuddy-accounts.json'));
  const wbBack = await (await callEo('/accounts?platform=workbuddy')).json();
  check('WorkBuddy 读回 credential', wbBack[0]?.credential?.access_token === 'wb-tok');
  check('WorkBuddy 不污染 codebuddy', (await (await callEo('/accounts')).json()).length === 2);

  // WorkBuddy 缺凭证：请求体被判定无效
  const wbBad = await callEo('/accounts/merge?platform=workbuddy', {
    method: 'POST',
    body: [{ id: 'wb-2', nickname: 'no-token' }],
  });
  check('WorkBuddy 缺凭证 400', wbBad.status === 400);

  // Trae：凭证字段 cloudIdeJwt
  const trae = { id: 'trae-1', userId: 'tu-1', cloudIdeJwt: 'jwt-token' };
  const traeMerge = await callEo('/accounts/merge?platform=trae', { method: 'POST', body: [trae] });
  check('Trae 合并成功', traeMerge.status === 200 && (await traeMerge.json()).platform === 'trae');
  check('Trae 写入独立文件', files.has('trae-accounts.json'));
  const traeBad = await callEo('/accounts/merge?platform=trae', {
    method: 'POST',
    body: [{ id: 'trae-2' }],
  });
  check('Trae 缺 cloudIdeJwt 400', traeBad.status === 400);

  // Qoder：凭证在 credential.access_token
  const qoder = { id: 'qd-1', credential: { access_token: 'dt-token' } };
  const qoderMerge = await callEo('/accounts/merge?platform=qoder', { method: 'POST', body: [qoder] });
  check('Qoder 合并成功', qoderMerge.status === 200 && (await qoderMerge.json()).platform === 'qoder');
  check('Qoder 写入独立文件', files.has('qoder-accounts.json'));

  // 平台概览
  const overview = await (await callEo('/platforms')).json();
  check('平台概览：codebuddy 2 个', overview.platforms.codebuddy.total === 2);
  check('平台概览：workbuddy 1 个', overview.platforms.workbuddy.total === 1);
  check('平台概览：trae 1 个', overview.platforms.trae.total === 1);
  check('平台概览：qoder 1 个', overview.platforms.qoder.total === 1);
  check('平台概览：可用计数', overview.platforms.trae.usable === 1);

  // 未知平台
  const unknown = await callEo('/accounts?platform=nope');
  check('未知平台 400', unknown.status === 400);
  const unknownMerge = await callEo('/accounts/merge?platform=nope', { method: 'POST', body: [ACC_A] });
  check('未知平台合并 400', unknownMerge.status === 400);
}

console.log('异常输入');
{
  const bad = await callEo('/accounts/merge', { method: 'POST', body: { not: 'array' } });
  check('非数组 400', bad.status === 400);
  const empty = await callEo('/accounts/merge', { method: 'POST', body: [] });
  check('空数组 400', empty.status === 400);
  const noToken = await callEo('/accounts/merge', { method: 'POST', body: [{ id: 'x' }] });
  check('缺 access_token 400', noToken.status === 400);
  const notFound = await callEo('/nope');
  check('未知路径 404', notFound.status === 404);
  const wrongMethod = await callEo('/accounts', { method: 'DELETE' });
  check('错误方法 405', wrongMethod.status === 405);
}

console.log(`\n结果：通过 ${passed}，失败 ${failed}`);
process.exit(failed > 0 ? 1 : 0);
