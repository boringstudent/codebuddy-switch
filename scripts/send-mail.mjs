#!/usr/bin/env node
// ============================================================================
// 极简 SMTP 发信模块（Node >= 18，零依赖，隐式 TLS 465）
//
// 为 QQ 邮箱设计（smtp.qq.com:465，授权码登录），也可用于其他 SSL SMTP。
// 用法：
//   import { sendMail } from './send-mail.mjs';
//   await sendMail({
//     host: 'smtp.qq.com',
//     user: 'boring_student@qq.com',
//     pass: process.env.QQ,           // 邮箱授权码（非登录密码）
//     to: 'boring_student@qq.com',
//     subject: '主题',
//     text: '纯文本正文',
//   });
// ============================================================================

import tls from 'node:tls';

const b64 = (value) => Buffer.from(String(value), 'utf8').toString('base64');

/** UTF-8 邮件头编码（主题等非 ASCII 场景必须）。 */
const encodeHeader = (value) => `=?UTF-8?B?${b64(value)}?=`;

class SmtpClient {
  constructor(socket) {
    this.socket = socket;
    this.buffer = '';
    this.waiters = [];
    socket.on('data', (chunk) => {
      this.buffer += chunk.toString('utf8');
      this.pump();
    });
  }

  pump() {
    // SMTP 应答以「代码 + 空格」的单行结束（多行应答的中间行是「代码-」）。
    for (;;) {
      const match = this.buffer.match(/(?:^|\r\n)(\d{3}) [^\r\n]*\r\n/);
      if (!match || match.index === undefined) return;
      const end = match.index + match[0].length;
      const reply = this.buffer.slice(0, end).trim();
      this.buffer = this.buffer.slice(end);
      const waiter = this.waiters.shift();
      if (waiter) waiter(reply);
      else return;
    }
  }

  expect() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('SMTP 应答超时')), 30_000);
      this.waiters.push((reply) => {
        clearTimeout(timer);
        resolve(reply);
      });
    });
  }

  async command(line, expectCodes, { silent = false } = {}) {
    const waiting = this.expect();
    this.socket.write(line + '\r\n');
    const reply = await waiting;
    const code = Number(reply.slice(0, 3));
    const ok = expectCodes.some((prefix) => String(code).startsWith(prefix));
    if (!ok) {
      // 报错不含命令原文（AUTH 命令带凭据，绝不进日志）。
      throw new Error(`SMTP 命令被拒绝（${silent ? '***' : line.split(' ')[0]}）：${reply}`);
    }
    return reply;
  }
}

export async function sendMail({ host = 'smtp.qq.com', port = 465, user, pass, to, subject, text }) {
  if (!user || !pass) throw new Error('缺少邮箱账号或授权码');
  const from = user;
  const recipients = Array.isArray(to) ? to : [to];

  const socket = await new Promise((resolve, reject) => {
    const s = tls.connect(port, host, { servername: host }, () => resolve(s));
    s.once('error', reject);
    s.setTimeout(30_000, () => {
      s.destroy(new Error('SMTP 连接超时'));
    });
  });

  const client = new SmtpClient(socket);
  try {
    const greeting = await client.expect();
    if (!greeting.startsWith('220')) throw new Error(`SMTP 握手失败：${greeting}`);

    await client.command(`EHLO wb-switch-checkin`, ['250']);
    await client.command('AUTH LOGIN', ['334'], { silent: true });
    await client.command(b64(user), ['334'], { silent: true });
    await client.command(b64(pass), ['235'], { silent: true });
    await client.command(`MAIL FROM:<${from}>`, ['250']);
    for (const rcpt of recipients) {
      await client.command(`RCPT TO:<${rcpt}>`, ['250', '251']);
    }
    await client.command('DATA', ['354']);

    const date = new Date().toUTCString();
    // 正文走 base64：天然规避 dot-stuffing 与编码问题。
    const message = [
      `From: ${encodeHeader('wb-switch 签到')} <${from}>`,
      `To: ${recipients.map((r) => `<${r}>`).join(', ')}`,
      `Subject: ${encodeHeader(subject)}`,
      `Date: ${date}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      b64(text),
      '.',
    ].join('\r\n');
    await client.command(message, ['250']);
    await client.command('QUIT', ['221']).catch(() => {});
  } finally {
    socket.end();
    socket.destroySoon?.();
  }
}
