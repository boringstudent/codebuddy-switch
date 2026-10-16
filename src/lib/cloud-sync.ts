import { exportAccounts } from "@/lib/api";

/**
 * 云端账号同步：把本地账号库（含 token）通过 EO 边缘函数合并写入私有 GitHub 仓库，
 * 供 GitHub Actions 每日签到工作流拉取。
 *
 * 配置（EO 函数地址 / 访问 key）存 localStorage——它等同密码，但只在本机使用，
 * 与导出备份文件的安全等级一致；不上传任何第三方。
 */

const STORAGE_KEY = "wb_cloud_sync_config";
const REQUEST_TIMEOUT_MS = 20_000;

export interface CloudSyncConfig {
  /** EO 函数地址，如 https://xxx.eo-edgefunctions.com（允许只填域名）。 */
  url: string;
  /** 与 EO 函数环境变量 ACCESS_KEY 相同的访问 key。 */
  accessKey: string;
}

export function loadCloudSyncConfig(): CloudSyncConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { url: "", accessKey: "" };
    const parsed = JSON.parse(raw) as Partial<CloudSyncConfig>;
    return {
      url: typeof parsed.url === "string" ? parsed.url : "",
      accessKey: typeof parsed.accessKey === "string" ? parsed.accessKey : "",
    };
  } catch {
    return { url: "", accessKey: "" };
  }
}

export function saveCloudSyncConfig(config: CloudSyncConfig): void {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({ url: config.url.trim(), accessKey: config.accessKey.trim() }),
  );
}

/** 规范化函数地址：自动补 https://，去掉末尾斜杠。 */
export function normalizeEoUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

export interface CloudUploadResult {
  total: number;
  updated: number;
  added: number;
  dropped: number;
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** 探测云端函数连通性与配置（/health 公开，不校验 key）。 */
export async function probeCloud(config: CloudSyncConfig): Promise<{ ok: boolean; detail: string }> {
  const base = normalizeEoUrl(config.url);
  if (!base) return { ok: false, detail: "请先填写函数地址" };
  try {
    const resp = await fetchWithTimeout(`${base}/health`, { headers: { Accept: "application/json" } });
    const data = (await resp.json().catch(() => null)) as
      | { keyConfigured?: boolean; repoConfigured?: boolean }
      | null;
    if (!resp.ok) return { ok: false, detail: `HTTP ${resp.status}` };
    if (!data?.keyConfigured) return { ok: false, detail: "函数未配置 ACCESS_KEY 环境变量" };
    if (!data?.repoConfigured) return { ok: false, detail: "函数未配置 GITHUB_TOKEN 环境变量" };
    return { ok: true, detail: "云端函数配置正常" };
  } catch (error) {
    return { ok: false, detail: `连接失败：${error instanceof Error ? error.message : String(error)}` };
  }
}

/** 把指定账号的完整记录（含 token）上传到云端账号仓库（按 id 合并）。 */
export async function uploadAccountsToCloud(
  config: CloudSyncConfig,
  accountIds: string[],
): Promise<CloudUploadResult> {
  const base = normalizeEoUrl(config.url);
  if (!base || !config.accessKey.trim()) {
    throw new Error("请先在设置中填写云端函数地址与访问 key");
  }
  if (!accountIds.length) throw new Error("没有可上传的账号");

  const exported = await exportAccounts(accountIds);
  const accounts = (exported.accounts || []).filter(
    (acc) => acc && typeof acc.id === "string" && typeof acc.access_token === "string" && acc.access_token,
  );
  if (!accounts.length) throw new Error("账号缺少有效 token，无法上传");

  const resp = await fetchWithTimeout(`${base}/accounts/merge`, {
    method: "POST",
    headers: {
      "X-Access-Key": config.accessKey.trim(),
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(accounts),
  });
  const data = (await resp.json().catch(() => null)) as
    | { ok?: boolean; total?: number; updated?: number; added?: number; dropped?: number; error?: string }
    | null;
  if (!resp.ok || !data?.ok) {
    if (resp.status === 401) throw new Error("访问 key 不正确（401）");
    throw new Error(data?.error || `上传失败：HTTP ${resp.status}`);
  }
  return {
    total: data.total ?? accounts.length,
    updated: data.updated ?? 0,
    added: data.added ?? 0,
    dropped: data.dropped ?? 0,
  };
}
