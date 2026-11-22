#!/usr/bin/env node
// ============================================================================
// 本地上传平台账号到云端账号仓库（Node >= 18）
//
// 支持直接吃各客户端导出的原始文件：
//   - WorkBuddy：kind=aiwork-workbuddy-pool 的导出 JSON
//   - Trae：AI Work 助手账号导出 JSON（accounts[].cloudIdeJwt）
//   - Qoder：kind=aiwork-qoder-pool（明文，或含凭证的加密导出）
//   - CodeBuddy：桌面端导出的账号数组（accounts.json 结构）
//
// 用法：
//   node scripts/upload-platform-accounts.mjs <导出文件> [选项]
//
// 选项：
//   --platform=<codebuddy|workbuddy|trae|qoder>  强制平台（默认自动识别）
//   --url=<EO 函数地址>                          默认读环境变量 EO_ACCOUNTS_URL
//   --key=<访问 key>                             默认读环境变量 EO_ACCESS_KEY
//   --dry-run                                    只解析与统计，不上传
//
// Qoder 加密导出：设置环境变量 QODER_EXPORT_PASSWORD（推荐，避免命令行留痕），
// 或传 --password。解密依赖本机 python + argon2-cffi（pip install argon2-cffi cryptography），
// 明文只在内存与管道中流转，不落盘。
//
// 安全：全程不打印任何 token / key；错误信息统一脱敏。
// ============================================================================

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const PLATFORMS = new Set(['codebuddy', 'workbuddy', 'trae', 'qoder']);

/** 长 token/JWT 特征（与 lib/http.mjs 同口径）。 */
const SECRET_LIKE = /[A-Za-z0-9_-]{24,}(?:\.[A-Za-z0-9_-]{8,})*/g;
const redact = (value) => String(value ?? '').replace(SECRET_LIKE, (m) => `${m.slice(0, 4)}***`);

function usage(message) {
  if (message) console.error(`错误：${message}\n`);
  console.error(
    [
      '用法：node scripts/upload-platform-accounts.mjs <导出文件> [--platform=<name>] [--url=<EO地址>] [--key=<key>] [--dry-run]',
      'Qoder 加密导出：设置环境变量 QODER_EXPORT_PASSWORD 或传 --password=<密码>',
    ].join('\n'),
  );
  process.exit(2);
}

function parseArgs(argv) {
  const options = { file: '', platform: '', url: '', key: '', password: '', dryRun: false };
  for (const arg of argv) {
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg.startsWith('--platform=')) options.platform = arg.slice(11).trim().toLowerCase();
    else if (arg.startsWith('--url=')) options.url = arg.slice(6).trim();
    else if (arg.startsWith('--key=')) options.key = arg.slice(6).trim();
    else if (arg.startsWith('--password=')) options.password = arg.slice(11);
    else if (arg.startsWith('--')) usage(`未知选项 ${arg}`);
    else if (!options.file) options.file = arg;
    else usage(`多余参数 ${arg}`);
  }
  if (!options.file) usage('缺少导出文件路径');
  if (options.platform && !PLATFORMS.has(options.platform)) {
    usage(`--platform 只能是 ${[...PLATFORMS].join(' / ')}`);
  }
  return options;
}

/** 识别导出文件属于哪个平台（只看结构与 kind，不依赖文件名）。 */
function detectPlatform(payload, accounts) {
  if (payload?.kind === 'aiwork-workbuddy-pool') return 'workbuddy';
  if (payload?.kind === 'aiwork-qoder-pool') return 'qoder';
  if (!Array.isArray(accounts) || accounts.length === 0) {
    usage('文件里没有 accounts 数组，无法识别平台');
  }
  if (accounts.some((acc) => acc && acc.cloudIdeJwt)) return 'trae';
  if (accounts.some((acc) => acc && acc.credential?.access_token && acc.device_profile)) return 'qoder';
  if (accounts.some((acc) => acc && acc.credential?.access_token)) return 'workbuddy';
  return 'codebuddy';
}

/** Qoder 加密导出：用 python 解密（明文经 stdout 回传，不落盘）。 */
function decryptQoderEnvelope(payload, password) {
  if (!password) {
    usage('Qoder 导出是加密的：请设置环境变量 QODER_EXPORT_PASSWORD 或传 --password');
  }
  const script = [
    'import base64,json,os,sys',
    'from argon2.low_level import Type, hash_secret_raw',
    'from cryptography.hazmat.primitives.ciphers.aead import AESGCM',
    'p=os.environ["QODER_FILE"]',
    'raw=base64.b64decode(json.load(open(p,encoding="utf-8"))["data"])',
    'salt,nonce,ct=raw[8:24],raw[24:36],raw[36:]',
    'key=hash_secret_raw(os.environ["QODER_PWD"].encode(),salt,2,19456,1,32,Type.ID,19)',
    'sys.stdout.write(AESGCM(key).decrypt(nonce,ct,None).decode("utf-8"))',
  ].join('\n');
  try {
    const output = execFileSync(process.env.PYTHON || 'python', ['-c', script], {
      env: { ...process.env, QODER_FILE: payload.__file, QODER_PWD: password },
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return JSON.parse(output.toString('utf8'));
  } catch (error) {
    throw new Error(
      `Qoder 解密失败（密码错误或缺少 argon2-cffi / cryptography）：${redact(error?.stderr?.toString?.() || error?.message || error)}`,
    );
  }
}

/** 该平台的「可用账号」判定（与 EO 函数同口径）。 */
const hasCredential = {
  codebuddy: (acc) => Boolean(acc.access_token),
  workbuddy: (acc) => Boolean(acc.access_token || acc.credential?.access_token),
  trae: (acc) => Boolean(acc.cloudIdeJwt),
  qoder: (acc) => Boolean(acc.access_token || acc.credential?.access_token),
};

/** 上传前规范化：Trae 导出没有 id，按 userId 补稳定 id（EO 按 id 合并）。 */
function normalize(platform, accounts) {
  if (platform !== 'trae') return accounts;
  return accounts.map((acc) => ({
    ...acc,
    id: acc.id || (acc.userId ? `trae-${acc.userId}` : ''),
  }));
}

function endpoint(base, platform, action) {
  const path = action === 'merge' ? '/accounts/merge' : '/accounts';
  const query = platform === 'codebuddy' ? '' : `?platform=${encodeURIComponent(platform)}`;
  return `${base}${path}${query}`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const url = (options.url || process.env.EO_ACCOUNTS_URL || '').trim();
  const key = (options.key || process.env.EO_ACCESS_KEY || '').trim();
  const password = process.env.QODER_EXPORT_PASSWORD || options.password;

  const rawText = readFileSync(options.file, 'utf8');
  let payload;
  try {
    payload = JSON.parse(rawText);
  } catch {
    usage('导出文件不是合法 JSON');
  }

  // 加密 Qoder：先解密（python 直接读原文件，明文经管道回传，不落盘）
  if (payload?.kind === 'aiwork-qoder-pool' && payload.encrypted === true) {
    payload = decryptQoderEnvelope({ ...payload, __file: options.file }, password);
    console.log('Qoder 加密导出已解密（明文仅内存流转）');
  }

  const accounts = Array.isArray(payload) ? payload : payload?.accounts;
  if (!Array.isArray(accounts)) usage('文件里没有 accounts 数组');
  const platform = options.platform || detectPlatform(payload, accounts);
  const normalized = normalize(platform, accounts);
  const valid = normalized.filter((acc) => acc && acc.id && hasCredential[platform](acc));

  console.log(`平台：${platform}`);
  console.log(`账号：共 ${normalized.length} 个，可用 ${valid.length} 个`);
  const dropped = normalized.length - valid.length;
  if (dropped > 0) console.log(`已过滤 ${dropped} 个缺少 id 或凭证的账号`);
  if (valid.length === 0) {
    console.error('没有可上传的有效账号（需要 id + 该平台凭证字段）');
    process.exit(1);
  }
  if (options.dryRun) {
    console.log('--dry-run：跳过上传');
    return;
  }
  if (!url) usage('缺少 EO 函数地址（--url 或环境变量 EO_ACCOUNTS_URL）');
  if (!key) usage('缺少访问 key（--key 或环境变量 EO_ACCESS_KEY）');
  const base = (/^https?:\/\//i.test(url) ? url : `https://${url}`).replace(/\/+$/, '');

  // 分片上传（EO 单次上限 500）
  let updated = 0;
  let added = 0;
  let total = 0;
  for (let i = 0; i < valid.length; i += 500) {
    const chunk = valid.slice(i, i + 500);
    const resp = await fetch(endpoint(base, platform, 'merge'), {
      method: 'POST',
      headers: {
        'X-Access-Key': key,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(chunk),
    });
    const data = await resp.json().catch(() => null);
    if (!resp.ok || !data?.ok) {
      console.error(`上传失败：HTTP ${resp.status} ${redact(data?.error || '')}`.trim());
      process.exit(1);
    }
    updated += Number(data.updated || 0);
    added += Number(data.added || 0);
    total = Number(data.total || total);
    if (Number(data.dropped || 0) > 0) {
      console.log(`服务端过滤了 ${data.dropped} 个无效账号`);
    }
  }
  console.log(`上传完成：更新 ${updated}，新增 ${added}，云端现有 ${total} 个 ${platform} 账号`);
}

main().catch((error) => {
  console.error(`上传异常：${redact(error?.message || error)}`);
  process.exit(1);
});
