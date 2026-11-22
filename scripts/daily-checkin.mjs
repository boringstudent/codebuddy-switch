#!/usr/bin/env node
// ============================================================================
// 每日自动签到脚本（GitHub Actions 用，Node >= 18，零依赖）
//
// 平台（可各自独立失败，互不阻塞）：
//   codebuddy  腾讯 CodeBuddy 国内版  凭据在账号顶层 access_token
//   workbuddy  WorkBuddy 国内版       凭据在 credential.access_token（AI Work 助手导出）
//   trae       Trae CN                凭据为 cloudIdeJwt（Cloud-IDE-JWT）
//   qoder      Qoder CN               凭据为 credential.access_token（dt- 设备令牌）
//
// 流程：
//   1. 用专用访问 key 从 EO 边缘函数按平台拉取账号数据（accounts 数组）；
//   2. 逐账号：临期（< 24h）先走官方刷新接口换新（Trae 无刷新接口）；
//   3. 查询今日签到状态（已签跳过）；
//   4. 未签则提交签到；遇到 401 刷新一次并重试；
//   5. 只输出「平台 + 昵称 + 结果」，绝不打印任何 token / key（失败信息统一脱敏）。
//
// 环境变量（都在 GitHub 仓库 Secrets 配置）：
//   EO_ACCOUNTS_URL  EO 边缘函数地址，如 https://xxx.eo-edgefunctions.com
//   EO_ACCESS_KEY    与 EO 函数环境变量 ACCESS_KEY 相同的访问 key
//   QQ               QQ 邮箱授权码（可选，签到完成后发汇总报告）
//   CHECKIN_PLATFORMS 可选，逗号分隔（如 "codebuddy,trae"），默认全部平台
//
// 退出码：任一账号硬失败 → 1（让工作流标红便于发现）；全部成功/已签到 → 0。
// 说明：EO 函数需为多平台版本（GET /accounts?platform=<name>）。
//       旧版函数只会返回 CodeBuddy 账号库，新增平台会提示「需部署新版函数」。
// ============================================================================

import { sendMail } from './send-mail.mjs';
import { fetchPlatformAccounts, mergePlatformAccounts, ensureCloudConfig } from './lib/cloud.mjs';
import { sleep, redact } from './lib/http.mjs';
import * as codebuddy from './platforms/codebuddy.mjs';
import * as workbuddy from './platforms/workbuddy.mjs';
import * as trae from './platforms/trae.mjs';
import * as qoder from './platforms/qoder.mjs';

// 签到完成后向该地址发送报告邮件（自发自收）；授权码读环境变量 QQ。
const MAIL_ADDRESS = 'boring_student@qq.com';

const RUNNERS = [
  { key: 'codebuddy', label: 'CodeBuddy', module: codebuddy, gapMs: 1500 },
  { key: 'workbuddy', label: 'WorkBuddy', module: workbuddy, gapMs: 1500 },
  { key: 'trae', label: 'Trae', module: trae, gapMs: 3000 },
  { key: 'qoder', label: 'Qoder', module: qoder, gapMs: 1500 },
];

function selectedRunners() {
  const raw = (process.env.CHECKIN_PLATFORMS || '').trim();
  if (!raw) return RUNNERS;
  const wanted = new Set(
    raw
      .split(',')
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
  );
  return RUNNERS.filter((runner) => wanted.has(runner.key));
}

/** 单平台执行：拉取 → 过滤可用账号 → 逐账号签到 → 回写刷新后的 token。 */
async function runPlatform(runner) {
  const label = runner.label;
  const summary = {
    key: runner.key,
    label,
    total: 0,
    success: 0,
    already: 0,
    skipped: 0,
    failed: 0,
    error: '',
    rows: [],
  };

  let accounts;
  try {
    accounts = await fetchPlatformAccounts(runner.key);
  } catch (error) {
    summary.error = redact(String(error?.message || error));
    console.error(`[${label}] 读取云端账号失败：${summary.error}`);
    return summary;
  }

  const usable = accounts.filter((account) => runner.module.isUsable(account));
  summary.total = usable.length;
  if (accounts.length > 0 && usable.length === 0) {
    // 典型场景：EO 函数还是旧版，?platform= 被忽略，返回的是 CodeBuddy 账号库。
    summary.error = '云端账号库里没有该平台可用凭证（若刚接入，请先部署多平台版 EO 函数并上传账号）';
    console.error(`[${label}] ${summary.error}`);
    return summary;
  }
  if (usable.length === 0) {
    console.log(`[${label}] 云端无账号，跳过`);
    return summary;
  }

  console.log(`[${label}] 共读取 ${usable.length} 个账号，开始签到…`);
  const changedAccounts = [];
  for (const account of usable) {
    try {
      const outcome = await runner.module.checkinAccount(account);
      if (outcome.tokensChanged && outcome.account) changedAccounts.push(outcome.account);
      if (outcome.result === 'success') {
        summary.success += 1;
        const extra = outcome.message && outcome.message !== 'ok' ? `（${outcome.message}）` : '';
        console.log(`[成功] ${label} · ${outcome.name}${extra}`);
        summary.rows.push({ name: outcome.name, result: `签到成功${extra}` });
      } else if (outcome.result === 'already') {
        summary.already += 1;
        console.log(`[已签] ${label} · ${outcome.name}`);
        summary.rows.push({ name: outcome.name, result: '今日已签到' });
      } else if (outcome.result === 'skip') {
        summary.skipped += 1;
        const reason = redact(outcome.message || '无可参与活动');
        console.log(`[跳过] ${label} · ${outcome.name}：${reason}`);
        summary.rows.push({ name: outcome.name, result: `跳过：${reason}` });
      } else {
        summary.failed += 1;
        const reason = redact(outcome.error || '未知错误');
        console.error(`[失败] ${label} · ${outcome.name}：${reason}`);
        summary.rows.push({ name: outcome.name, result: `签到失败：${reason}` });
      }
    } catch (error) {
      summary.failed += 1;
      const name = runner.module.displayName(account);
      const reason = redact(String(error?.message || error));
      console.error(`[失败] ${label} · ${name}：${reason}`);
      summary.rows.push({ name, result: `签到失败：${reason}` });
    }
    await sleep(runner.gapMs);
  }

  // 回写本次刷新出的新 token，避免 refresh_token 轮换后下次失效。
  if (changedAccounts.length) {
    await mergePlatformAccounts(runner.key, changedAccounts);
  }
  return summary;
}

async function main() {
  ensureCloudConfig();
  const runners = selectedRunners();
  if (runners.length === 0) {
    console.error('CHECKIN_PLATFORMS 未匹配到任何平台（可选：codebuddy,workbuddy,trae,qoder）');
    process.exit(2);
  }

  const summaries = [];
  for (const runner of runners) {
    summaries.push(await runPlatform(runner));
  }

  const totals = summaries.reduce(
    (acc, item) => ({
      success: acc.success + item.success,
      already: acc.already + item.already,
      skipped: acc.skipped + item.skipped,
      failed: acc.failed + item.failed + (item.error && item.total === 0 ? 1 : 0),
    }),
    { success: 0, already: 0, skipped: 0, failed: 0 },
  );

  console.log(
    `签到完成：成功 ${totals.success}，已签 ${totals.already}，跳过 ${totals.skipped}，失败 ${totals.failed}（${summaries
      .map((s) => `${s.label}:${s.total}`)
      .join(' / ')}）`,
  );
  await sendReportMail(summaries, totals);
  if (totals.failed > 0) process.exit(1);
}

/** 发送签到报告邮件（自发自收）。邮件失败只记日志，不影响签到结果与退出码。 */
async function sendReportMail(summaries, totals) {
  if (!process.env.QQ) {
    console.log('未配置 QQ 邮箱授权码（环境变量 QQ），跳过邮件通知');
    return;
  }
  const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  const summary = `成功 ${totals.success}，已签 ${totals.already}，跳过 ${totals.skipped}，失败 ${totals.failed}`;
  const lines = [];
  for (const platform of summaries) {
    const head = `${platform.label}（${platform.total} 个账号：成功 ${platform.success}，已签 ${platform.already}，跳过 ${platform.skipped}，失败 ${platform.failed}）`;
    lines.push(head);
    if (platform.error) lines.push(`  云端读取：${platform.error}`);
    for (const row of platform.rows) lines.push(`  ${row.name}：${row.result}`);
    lines.push('');
  }
  const text = [`签到时间（北京时间）：${now}`, `结果汇总：${summary}`, '', ...lines].join('\n');
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
    console.error(`签到报告邮件发送失败：${redact(String(error?.message || error))}`);
  }
}

main().catch((error) => {
  console.error(`签到任务异常中止：${redact(String(error?.message || error))}`);
  process.exit(1);
});
