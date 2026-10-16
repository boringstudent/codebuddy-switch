/**
 * 积分 ↔ 人民币换算。官方充值口径：4000 积分 = 10 元，即 1 元 = 400 积分。
 */

export const CREDITS_PER_YUAN = 400;

export function creditsToYuan(credits: number): number {
  return credits / CREDITS_PER_YUAN;
}

export function yuanToCredits(yuan: number): number {
  return yuan * CREDITS_PER_YUAN;
}

/** 人民币展示：保留两位小数。 */
export function fmtYuan(yuan: number): string {
  return `¥${yuan.toFixed(2)}`;
}

/** 每千 Token 积分单价（数据不足时返回 null）。 */
export function creditsPerKToken(credits: number, totalTokens: number): number | null {
  if (!Number.isFinite(credits) || !Number.isFinite(totalTokens) || totalTokens <= 0) return null;
  return (credits / totalTokens) * 1000;
}
