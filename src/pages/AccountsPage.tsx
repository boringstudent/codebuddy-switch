import { useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";
import {
  FileDown,
  FileUp,
  Loader2,
  QrCode,
  RefreshCw,
} from "lucide-react";

import { AccountCard } from "@/components/account-card";
import { AccountInfoDialog } from "@/components/account-info-dialog";
import { CodebuddyIdeSwitchAccountDialog } from "@/components/codebuddy-ide-switch-account-dialog";
import { DemoAction } from "@/components/demo-action";
import {
  CodeBuddyCnIdeMark,
  WorkBuddyMark,
} from "@/components/product-marks";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ExportAccountsDialog } from "@/components/export-accounts-dialog";
import { ImportAccountsDialog } from "@/components/import-accounts-dialog";
import { OAuthLoginDialog } from "@/components/oauth-login-dialog";
import { SwitchAccountDialog } from "@/components/switch-account-dialog";
import * as api from "@/lib/api";
import { useVisibleInterval } from "@/lib/use-visible-interval";
import {
  accountVariant,
  variantAppName,
  variantCodebuddyIdeName,
  variantLabel,
  variantSupportsCheckin,
  variantSupportsTravel,
  variantUsesIntlCodebuddyIde,
} from "@/lib/variant";
import { useSupportedTools } from "@/lib/supported-tools";
import type { AccountMeta, AppStatus, CheckinConfig, CreditExpiry, RateLimitEntry, TravelConfig, TravelStatus } from "@/lib/types";
import { displayName } from "@/lib/account-display";
import { useAccountsStore } from "@/stores/accounts";

/**
 * 账号页两个轮询的间隔（都经 `useVisibleInterval` 门控，仅主窗口可见时执行）。
 *
 * - 旅行：后台派发/领取循环最快 15 分钟变一次状态，1 分钟用于及时反映"到期领取"后的显示；
 * - 限额：CLI / WorkBuddy 由后端 hook 信号实时入账并推送（`rate-limits-updated`），
 *   这里只兜底 IDE 日志扫描；后端按同一间隔节流扫描，前端再按 payload 的 `scannedAt`
 *   判断「距上次扫描 ≥ 5 分钟」才发起，避免可见性切换/页面重挂载把扫描打散。
 */
const TRAVEL_REFRESH_INTERVAL_MS = 60 * 1000;
const RATE_LIMIT_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

function expiringSoonAmount(credit?: CreditExpiry): number {
  return credit?.ok ? credit.expiringSoonRemaining ?? 0 : 0;
}

function hasExpiringSoonCredits(credit?: CreditExpiry): boolean {
  return credit?.ok === true && expiringSoonAmount(credit) > 0;
}

function soonestRelevantExpiry(credit?: CreditExpiry): number {
  const soonestExpiringCredit = (credit?.resources ?? [])
    .filter((resource) => resource.remaining > 0 && resource.expiringSoon && resource.expireAt != null)
    .map((resource) => resource.expireAt as number)
    .reduce((soonest, expireAt) => Math.min(soonest, expireAt), Number.POSITIVE_INFINITY);
  return Number.isFinite(soonestExpiringCredit)
    ? soonestExpiringCredit
    : credit?.soonestExpireAt ?? Number.POSITIVE_INFINITY;
}

function creditPriorityRank(credit?: CreditExpiry): number {
  if (!credit?.ok) return 3;
  if (hasExpiringSoonCredits(credit)) return 0;
  if (credit.expired) return 1;
  return 2;
}

function isWorkbuddyCurrent(account: AccountMeta, current: AppStatus["current"] | undefined): boolean {
  if (!current) return false;
  return Boolean(
    (current.uid && (account.uid === current.uid || account.id === current.uid)) ||
      (current.email && account.email === current.email),
  );
}

/** 并行查询今日签到；失败的账号不写入，由调用方保留原值。 */
async function fetchTodayCheckinMap(
  accountIds: string[],
  isStale?: () => boolean,
): Promise<Record<string, boolean>> {
  const entries = await Promise.all(
    accountIds.map(async (id) => {
      try {
        const res = await api.getCheckinStatus(id);
        if (isStale?.() || !res.ok || typeof res.todayCheckedIn !== "boolean") return null;
        return [id, res.todayCheckedIn] as const;
      } catch {
        return null;
      }
    }),
  );
  const next: Record<string, boolean> = {};
  for (const entry of entries) {
    if (entry) next[entry[0]] = entry[1];
  }
  return next;
}

/** 并行查询各账号今日旅行状态；失败的账号不写入，由调用方保留原值。 */
async function fetchTravelMap(
  accountIds: string[],
  isStale?: () => boolean,
): Promise<Record<string, TravelStatus>> {
  const entries = await Promise.all(
    accountIds.map(async (id) => {
      try {
        const res = await api.getTravelStatus(id);
        if (isStale?.()) return null;
        return [id, res] as const;
      } catch {
        return null;
      }
    }),
  );
  const next: Record<string, TravelStatus> = {};
  for (const entry of entries) {
    if (entry) next[entry[0]] = entry[1];
  }
  return next;
}

export default function AccountsPage() {
  const {
    accounts,
    variant,
    status,
    loading,
    error,
    fetchAll,
    deleteAccount,
    creditMap,
    creditLoadingMap,
    creditUpdatedAtMap,
    refreshingCredits,
    ensureCredits,
    refreshCredits,
    clientStatus,
    setClientStatus,
  } = useAccountsStore();
  const [oauthOpen, setOauthOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [switchAccount, setSwitchAccount] = useState<AccountMeta | null>(null);
  /** 「账号信息」弹框目标账号（查看信息 / 编辑备注 / 选择显示字段）。 */
  const [infoTarget, setInfoTarget] = useState<AccountMeta | null>(null);
  /**
   * 自动签到配置（只读）：只用于决定账号卡片是否展示「自动签到已关闭」chip，
   * 以及状态查询、刷新时跳过哪些账号。控制入口在设置页。
   */
  const [autoCheckinConfig, setAutoCheckinConfig] = useState<CheckinConfig | null>(null);
  /** 配置是否已读取完毕（成功或失败）：区分「尚未读到」与「读取失败」。 */
  const [autoCheckinSettled, setAutoCheckinSettled] = useState(false);
  /** 账号 id -> 今日是否已签到（undefined=查询中/未知） */
  const [checkinMap, setCheckinMap] = useState<Record<string, boolean>>({});
  /** 账号 id -> 今日旅行状态（undefined=查询中/未知） */
  const [travelMap, setTravelMap] = useState<Record<string, TravelStatus>>({});
  /**
   * 自动旅行配置（只读）：未开启时不渲染账号卡片的旅行 chip、也不轮询旅行状态。
   * `null` = 配置尚未读到，按未开启处理。
   */
  const [autoTravelConfig, setAutoTravelConfig] = useState<TravelConfig | null>(null);
  /** 账号 id -> 当前受限的模型（数据源 = 后端限额台账：hook 信号 + 日志扫描） */
  const [rateLimitMap, setRateLimitMap] = useState<Record<string, RateLimitEntry[]>>({});
  /**
   * 「限额监听」开关（设置页）：关闭后不扫描、不渲染限额 chip。
   * `null` = 配置尚未读到，不得按默认 true 先扫一轮（关闭开关后进账号页会闪 chip / 误请求）。
   */
  const [rateLimitEnabled, setRateLimitEnabled] = useState<boolean | null>(null);
  /**
   * CodeBuddy IDE 状态放在 store 里：
   * 账号页每次进入都会重挂载，局部 state 会被重置为 `null`，界面先按「未接入」
   * 渲染、等状态探测回来才改口（issue #84）。store 里则先按上次结果渲染。
   */
  const { codebuddyCnIde } = clientStatus;
  /** CodeBuddy IDE 切换弹窗目标（null=关闭）；切换与可选会话复制/同步在弹窗内完成（国内版 / 国际版共用）。 */
  const [codebuddyIdeSwitchAccount, setCodebuddyIdeSwitchAccount] = useState<AccountMeta | null>(null);
  /** 刷新按钮触发的批量签到进行中 */
  const [checkinAllRunning, setCheckinAllRunning] = useState(false);
  /** 删除账号确认目标（null=关闭） */
  const [deleteTarget, setDeleteTarget] = useState<AccountMeta | null>(null);
  /** 当前档位下的账号：列表、计数、签到、积分等一律只作用于当前档位。 */
  const visibleAccounts = useMemo(
    () => accounts.filter((account) => accountVariant(account) === variant),
    [accounts, variant],
  );
  const appName = variantAppName(variant);
  const travelAvailable = variantSupportsTravel(variant);
  const checkinAvailable = variantSupportsCheckin(variant);
  /** 旅行 chip 与旅行状态轮询只在自动旅行开启后生效（配置未读到 = 未开启）。 */
  const autoTravelEnabled = travelAvailable && autoTravelConfig?.enabled === true;
  /** 刷新按钮文案：国际版没有签到接口，只刷新积分。 */
  const refreshCreditsLabel = checkinAvailable ? "刷新全部账号积分并签到（仅在签到时间段内签到；忽略已关闭自动签到的账号）" : "刷新全部账号积分";
  /** 关闭自动签到的账号 id（配置未读到/读取失败 = 空名单）。 */
  const excludedCheckinIds = useMemo(
    () => new Set(autoCheckinConfig?.excluded_account_ids ?? []),
    [autoCheckinConfig],
  );
  /** 今日签到状态只查未关闭自动签到的账号；配置就绪前不发请求。 */
  const autoCheckinAccountIds = useMemo(() => {
    if (!checkinAvailable || !autoCheckinSettled) return [];
    return visibleAccounts
      .filter((account) => !excludedCheckinIds.has(account.id))
      .map((account) => account.id);
  }, [visibleAccounts, checkinAvailable, autoCheckinSettled, excludedCheckinIds]);
  /** 账号列表固定紧凑模式（卡片更小、同屏更多列）。 */
  const compact = true;

  /**
   * 支持工具开关（设置页）：关闭的端不渲染入口、不轮询状态。
   * 缺省 = WorkBuddy 与 CodeBuddy IDE 两端开（与 `src/lib/supported-tools.ts` 的默认值一致）。
   */
  const enabledTools = useSupportedTools();

  useEffect(() => {
    void fetchAll();
  }, [fetchAll]);

  // 自动签到配置（只读）：读取失败静默回落为空名单（照常查询状态），不打扰用户。
  useEffect(() => {
    let cancelled = false;
    void api
      .getAutoCheckinConfig()
      .then((config) => {
        if (!cancelled) setAutoCheckinConfig(config);
      })
      .catch(() => {
        /* 配置读取失败：按空名单处理 */
      })
      .finally(() => {
        if (!cancelled) setAutoCheckinSettled(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function refreshCodebuddyCnIdeStatus() {
    try {
      setClientStatus({
        codebuddyCnIde: variantUsesIntlCodebuddyIde(variant)
          ? await api.getCodebuddyIdeStatus()
          : await api.getCodebuddyCnIdeStatus(),
      });
    } catch {
      setClientStatus({ codebuddyCnIde: null });
    }
  }

  useEffect(() => {
    let cancelled = false;

    /**
     * 读 IDE 状态（安装 / 运行 / 当前账号）：只读本地状态文件与进程，不碰钥匙串，
     * 因此不必等下面的本机登录探测。
     */
    async function refreshClientStatuses() {
      if (cancelled) return;
      if (enabledTools.codebuddyIde) await refreshCodebuddyCnIdeStatus();
    }

    void (async () => {
      // 状态刷新与登录探测并行起跑：探测要读钥匙串 / Safe Storage / 注册表 / 进程
      // （macOS 可能等待系统授权、Windows 走 PowerShell，耗时可达数秒），排在状态
      // 前面会让「已接入」迟迟不显示（issue #84）。
      const statuses = refreshClientStatuses();
      if (!api.isDemoMode()) {
        if (enabledTools.codebuddyIde) {
          try {
            // 国际版探测 CodeBuddy.app 钥匙串；国内版探测 CodeBuddy CN。不要交叉读。
            if (variantUsesIntlCodebuddyIde(variant)) {
              await api.detectCodebuddyIdeAccount();
            } else {
              await api.detectCodebuddyCnIdeAccount();
            }
          } catch {
            /* 未登录或钥匙串拒绝时静默，下面仍拉安装/运行状态 */
          }
        }
      }
      await statuses;
      // 探测命中账号时后端会把「当前账号」写回本地状态，再读一次让高亮跟上。
      if (!cancelled) await refreshClientStatuses();
    })();
    return () => {
      cancelled = true;
    };
  }, [accounts.length, variant, enabledTools]);

  // 配置就绪后查询未关闭自动签到的账号；国际版没有签到接口，不查询状态。
  useEffect(() => {
    if (!autoCheckinAccountIds.length) return;
    let cancelled = false;
    void fetchTodayCheckinMap(
      autoCheckinAccountIds,
      () => cancelled,
    ).then((next) => {
      if (!cancelled && Object.keys(next).length > 0) {
        setCheckinMap((prev) => ({ ...prev, ...next }));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [autoCheckinAccountIds]);

  // 自动旅行配置（只读）：只用于决定账号卡片是否展示旅行 chip、是否轮询旅行状态。
  // 读取失败静默按未开启处理（不展示 chip、不发状态请求），不打扰用户。
  useEffect(() => {
    let cancelled = false;
    void api
      .getAutoTravelConfig()
      .then((config) => {
        if (!cancelled) setAutoTravelConfig(config);
      })
      .catch(() => {
        /* 配置读取失败：按未开启处理 */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function loadTravelMap(accountIds: string[], isStale?: () => boolean) {
    const next = await fetchTravelMap(accountIds, isStale);
    if (!isStale?.() && Object.keys(next).length > 0) {
      setTravelMap((prev) => ({ ...prev, ...next }));
    }
  }

  // 当前档位账号列表变化后并行查询旅行状态；之后按 TRAVEL_REFRESH_INTERVAL_MS 周期刷新，
  // 以反映后台派发/领取循环带来的状态变化。仅主窗口可见时轮询，隐藏时暂停。
  // 成长中心仅国内版开放，国际版不发请求也不展示标签；自动旅行关闭时不展示状态、不查询。
  const travelAccountIds = useMemo(
    () => visibleAccounts.map((account) => account.id),
    [visibleAccounts],
  );
  useVisibleInterval(
    () => void loadTravelMap(travelAccountIds),
    TRAVEL_REFRESH_INTERVAL_MS,
    autoTravelEnabled && travelAccountIds.length > 0,
  );

  /**
   * 模型限额台账（后端合并两条通路）：一次返回全部账号，这里转成「账号 id -> 受限模型」。
   *
   * 容错：老版本后端没有该命令、或扫描失败时按「无受限模型」处理（清空映射），
   * 不弹错误、不影响账号页其它功能。
   */
  const lastRateLimitScanRef = useRef(0);

  async function loadRateLimits(options?: { force?: boolean }) {
    if (rateLimitEnabled !== true) return;
    const scannedAt = lastRateLimitScanRef.current;
    if (
      !options?.force &&
      scannedAt > 0 &&
      Date.now() - scannedAt < RATE_LIMIT_REFRESH_INTERVAL_MS
    ) {
      return;
    }
    try {
      const payload = await api.getRateLimits();
      // `scannedAt` 是后端最近一次真实日志扫描的时刻：下一次扫描要等它满 5 分钟。
      lastRateLimitScanRef.current = payload.scannedAt || Date.now();
      const next: Record<string, RateLimitEntry[]> = {};
      for (const entry of payload.accounts ?? []) {
        if (entry.limited?.length) next[entry.accountId] = entry.limited;
      }
      setRateLimitMap(next);
    } catch {
      setRateLimitMap({});
    }
  }

  const loadRateLimitsRef = useRef(loadRateLimits);
  loadRateLimitsRef.current = loadRateLimits;

  // 兜底轮询：页面可见且距上次扫描 ≥ 5 分钟时拉一次（IDE 日志扫描在后端按同一间隔节流）。
  // 图标何时消失由卡片本地按 `resetAt` 每秒判定（跨过官方重置时刻自动消失），不依赖这里的轮询。
  useVisibleInterval(
    () => void loadRateLimits(),
    RATE_LIMIT_REFRESH_INTERVAL_MS,
    rateLimitEnabled === true,
  );

  // 后端入账 hook 事件（CLI / WorkBuddy 的 429 当轮）后推送 → 立即拉取，秒级更新。
  // 这一路不看节流：新状态已经在后端，前端只做拉取。
  useEffect(() => {
    if (api.isWebui()) return;
    let unlisten: (() => void) | undefined;
    void listen("rate-limits-updated", () => {
      void loadRateLimitsRef.current({ force: true });
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, []);

  // 「限额监听」开关（设置页）：关闭后不再发起扫描；开关状态来自后端配置文件，
  // 设置页改完返回账号页会重新挂载并读到新值。
  useEffect(() => {
    let cancelled = false;
    void api
      .getRateLimitConfig()
      .then((config) => {
        if (!cancelled) setRateLimitEnabled(config.enabled);
      })
      .catch(() => {
        // 旧版本后端没有该命令：按默认开启，不影响账号页其它功能。
        if (!cancelled) setRateLimitEnabled(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 只给尚未缓存的账号拉积分；切回首页不重复请求。点「刷新积分」才强制更新。
  useEffect(() => {
    if (!visibleAccounts.length) return;
    void ensureCredits(visibleAccounts.map((account) => account.id));
  }, [visibleAccounts, ensureCredits]);

  /** 导出完成提示（含安全提醒）。 */
  function onExported(count: number) {
    const text = `已导出 ${count} 个账号。文件含登录 token，等同密码，请勿上传网盘或发送给他人。`;
    toast.success("导出成功", { description: text });
  }

  /** 导入完成提示：计数 + token 可能过期提醒（含加密凭据能力限制），并刷新列表。 */
  function onImported(result: {
    imported: number;
    skipped: number;
    overwritten: number;
    encrypted: number;
  }) {
    void fetchAll();
    const overwriteText = result.overwritten > 0 ? `（覆盖 ${result.overwritten} 个）` : "";
    const encryptedText =
      result.encrypted > 0
        ? `其中 ${result.encrypted} 个为加密凭据，仅可用于切换，签到/积分不可用。`
        : "";
    const text = `已导入 ${result.imported} 个${overwriteText}，跳过 ${result.skipped} 个。${encryptedText}token 可能已过期，切换后可能需要重新登录。`;
    toast.success("导入成功", { description: text });
  }

  async function onDelete(a: AccountMeta) {
    // 桌面 App（Tauri WebView）不支持 window.confirm，改用 Dialog 确认
    setDeleteTarget(a);
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    const a = deleteTarget;
    setDeleteTarget(null);
    try {
      await deleteAccount(a.id);
      toast.success("账号已删除");
    } catch (e) {
      toast.error("删除失败", { description: api.asError(e) });
    }
  }

  async function onCheckin(a: AccountMeta) {
    try {
      const res = await api.checkin(a.id);
      const label =
        res.result === "success"
          ? "签到成功"
          : res.result === "already"
            ? "今天已签到"
            : "签到失败";
      const description = `${displayName(a)}${res.error ? `：${res.error}` : ""}`;
      if (res.result === "error") toast.error(label, { description });
      else toast.success(label, { description });
      // 手动签到已完成状态核验，直接使用回执，避免为已关闭账号再触发展示查询。
      if (res.result === "success" || res.result === "already") {
        setCheckinMap((prev) => ({ ...prev, [a.id]: true }));
      }
      void fetchAll();
      // 签到成功/已签到会带来积分变动，force 刷新该账号积分
      if (res.result !== "error") void refreshCredits([a.id]);
    } catch (e) {
      toast.error("签到失败", { description: api.asError(e) });
    }
  }

  async function onRefresh(a: AccountMeta) {
    try {
      const res = await api.refreshAccountToken(a.id);
      const label = displayName(a);
      if (res.needsRelogin) {
        toast.error("Token 刷新失败", { description: `${label}：需重新登录${res.needsReloginReason ? `（${res.needsReloginReason}）` : ""}` });
      } else {
        toast.success("Token 已刷新", { description: label });
      }
      void fetchAll();
    } catch (e) {
      toast.error("Token 刷新失败", { description: api.asError(e) });
    }
  }

  /** 刷新附带的签到遵守账号开关与签到时间段；所有账号照常刷新积分，提示实际忽略/未到时间段数量。 */
  async function onRefreshCredits() {
    if (!visibleAccounts.length || refreshingCredits || checkinAllRunning) return;
    setCheckinAllRunning(true);
    const ids = visibleAccounts.map((account) => account.id);
    let summary = "";
    let notify = toast.success;
    let title = "积分到期情况已刷新";
    try {
      if (checkinAvailable) {
        try {
          const res = await api.checkinAll(variant, true);
          const entries = res.accounts ?? [];
          const success = entries.filter((e) => e.result === "success").length;
          const already = entries.filter((e) => e.result === "already").length;
          const failed = entries.filter((e) => e.result === "error").length;
          const inactive = entries.filter((e) => e.inactive === true || e.result === "inactive").length;
          const skipped = entries.filter((e) => e.result === "skipped" && e.reason === "auto_checkin_disabled").length;
          const outsideWindow = entries.filter((e) => e.result === "skipped" && e.reason === "outside_checkin_window").length;
          const parts: string[] = [];
          if (success > 0) parts.push(`${success} 个签到成功`);
          if (already > 0) parts.push(`${already} 个已签到`);
          if (inactive > 0) parts.push(`${inactive} 个未开放签到`);
          if (failed > 0) parts.push(`${failed} 个失败`);
          if (skipped > 0) parts.push(`已忽略 ${skipped} 个关闭自动签到的账号`);
          if (outsideWindow > 0) parts.push(`${outsideWindow} 个未到签到时间段`);
          summary = res.status === "skipped" && res.reason === "already_running"
            ? "签到任务正在进行，本次仅刷新积分"
            : parts.length > 0 ? parts.join("，") : "无账号需要签到";
          const allFailed = entries.length > 0 && failed === entries.length;
          const allSkippedOrInactive =
            res.status === "skipped" ||
            entries.length === 0 ||
            (success === 0 && already === 0 && failed === 0);
          if (allFailed) {
            // 全部失败：没有成功、已签、未开放或忽略的账号。
            notify = toast.error;
            title = "积分已刷新，签到出现错误";
          } else if (allSkippedOrInactive) {
            // 全部被跳过或官方未开放签到活动：既不算成功也不算失败，不呈现为绿色成功。
            notify = toast.info;
          }
          // 只重查实际处理过的账号状态；被跳过的账号本次未发请求，状态保持未知。
          const next = await fetchTodayCheckinMap(entries.filter((e) => e.result !== "skipped").map((e) => e.accountId));
          if (Object.keys(next).length > 0) {
            setCheckinMap((prev) => ({ ...prev, ...next }));
          }
        } catch (e) {
          notify = toast.error;
          title = "积分已刷新，签到出现错误";
          summary = api.asError(e);
        }
      }
      await refreshCredits(ids);
      if (autoTravelEnabled) await loadTravelMap(ids);
      notify(title, { description: summary || undefined });
    } finally {
      setCheckinAllRunning(false);
    }
  }

  async function onSwitchCodebuddyCnIde(account: AccountMeta) {
    if (codebuddyIdeSwitchAccount !== null) return;
    // 国内版与国际版共用同一弹窗（关联会话 / 复制会话两个 tab），只有数据源与切换接口按档位分流；
    // 弹窗本身承担确认职责（不勾选时行为与一键切换一致），不再另设轻量确认框。
    setCodebuddyIdeSwitchAccount(account);
  }

  const current = status?.current;
  const creditOrderingReady =
    visibleAccounts.length > 0 &&
    visibleAccounts.every((account) => Boolean(creditMap[account.id]) && !creditLoadingMap[account.id]);
  const orderedAccounts = creditOrderingReady
    ? visibleAccounts
        .map((account, index) => ({ account, index }))
        .sort((left, right) => {
          const leftCredit = creditMap[left.account.id];
          const rightCredit = creditMap[right.account.id];
          const rankDifference = creditPriorityRank(leftCredit) - creditPriorityRank(rightCredit);
          if (rankDifference !== 0) return rankDifference;

          const leftExpiry = soonestRelevantExpiry(leftCredit);
          const rightExpiry = soonestRelevantExpiry(rightCredit);
          if (leftExpiry !== rightExpiry) return leftExpiry - rightExpiry;

          const amountDifference = expiringSoonAmount(rightCredit) - expiringSoonAmount(leftCredit);
          if (amountDifference !== 0) return amountDifference;
          return left.index - right.index;
        })
        .map(({ account }) => account)
    : visibleAccounts;
  const priorityAccountId =
    creditOrderingReady
      ? orderedAccounts.find((account) => hasExpiringSoonCredits(creditMap[account.id]))?.id
      : undefined;
  const workbuddyCurrentName = current ? displayName(current) : "未登录";
  const cnIdeCurrentAccountId = codebuddyCnIde?.activeAccountId;
  const cnIdeCurrentName = codebuddyCnIde?.installed
    ? codebuddyCnIde.activeAccountName || "未检测到"
    : "未安装";
  return (
    <div className="mx-auto w-full max-w-[1180px] px-6 py-8 sm:px-8 sm:py-9">
      <header className="mb-6">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-[28px] font-semibold tracking-tight">账号管理</h1>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              统一管理 WorkBuddy 与 CodeBuddy IDE 账号、积分和签到状态。
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-4 pt-1">
            <div className="flex items-center gap-2.5">
{enabledTools.workbuddy && (
              <span className="group relative inline-flex cursor-default">
                <span
                  className={
                    status?.running
                      ? "inline-flex rounded-[22%] bg-primary p-[2px] shadow-sm shadow-primary/40"
                      : "inline-flex rounded-[22%] bg-muted-foreground/30 p-[2px]"
                  }
                >
                  <WorkBuddyMark size={28} />
                </span>
                <span className="pointer-events-none absolute right-0 top-full z-50 mt-2 hidden whitespace-nowrap rounded-md bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-lg ring-1 ring-black/5 group-hover:block">
                  {appName}：{status?.running ? "运行中" : "未运行"} · 当前账号：{workbuddyCurrentName}
                </span>
              </span>
            )}
{enabledTools.codebuddyIde && (
              <span className="group relative inline-flex cursor-default">
                <span
                  className={
                    codebuddyCnIde?.installed
                      ? "inline-flex rounded-[22%] bg-primary p-[2px] shadow-sm shadow-primary/40"
                      : "inline-flex rounded-[22%] bg-muted-foreground/30 p-[2px]"
                  }
                >
                  <CodeBuddyCnIdeMark size={28} />
                </span>
                <span className="pointer-events-none absolute right-0 top-full z-50 mt-2 hidden whitespace-nowrap rounded-md bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-lg ring-1 ring-black/5 group-hover:block">
                  {variantCodebuddyIdeName(variant)}：{codebuddyCnIde?.installed ? (codebuddyCnIde.running ? "运行中" : "已接入") : "未接入"} · 当前账号：{cnIdeCurrentName}
                </span>
              </span>
            )}
            </div>
          </div>
        </div>
      </header>

      <div className="relative mb-6 overflow-visible rounded-2xl border border-border bg-muted/30 px-5 py-5 shadow-[0_6px_20px_rgba(15,23,42,.025)]">
        <div className="pointer-events-none absolute inset-0 overflow-hidden rounded-2xl">
          <div className="absolute -right-12 -top-20 size-44 rounded-full border-[28px] border-slate-400/[0.035]" />
        </div>
        <div className="relative flex flex-wrap items-center gap-x-5 gap-y-4">
          <div className="min-w-[190px] flex-1">
            <h2 className="text-sm font-semibold text-foreground">添加与迁移账号</h2>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              快速接入新账号，或从已有环境恢复
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2.5">
            <DemoAction>
              <Button
                className="h-10 bg-primary px-4 text-primary-foreground shadow-sm hover:bg-primary/90"
                onClick={() => setOauthOpen(true)}
              >
                <QrCode />OAuth 扫码添加
              </Button>
            </DemoAction>
          </div>
          <div className="flex items-center gap-1">
            <DemoAction>
              <Button variant="ghost" size="sm" className="h-9 px-2.5" onClick={() => setImportOpen(true)} title="从备份文件导入账号">
                <FileUp />导入备份
              </Button>
            </DemoAction>
            <DemoAction>
              <Button variant="ghost" size="sm" className="h-9 px-2.5" onClick={() => setExportOpen(true)} disabled={visibleAccounts.length === 0} title="导出账号备份">
                <FileDown />导出
              </Button>
            </DemoAction>
          </div>
        </div>
      </div>

      {error && (
        <Alert variant="destructive" className="mb-4">
          <AlertTitle>加载失败</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <section className="mt-7 min-w-0" aria-labelledby="accounts-list-title">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <h2 id="accounts-list-title" className="text-base font-semibold tracking-tight">账号</h2>
            <Badge
              variant="secondary"
              className="h-6 min-w-6 rounded-full border-0 px-1.5 text-[11px] tabular-nums text-muted-foreground shadow-none"
              aria-label={`${visibleAccounts.length} 个${variantLabel(variant)}账号`}
            >
              {visibleAccounts.length}
            </Badge>
          </div>
          <TooltipProvider delayDuration={400}>
            <div className="ml-auto flex items-center gap-1">
              <Tooltip>
                <TooltipTrigger asChild>
                  <span>
                    <DemoAction>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-9 rounded-lg"
                        disabled={refreshingCredits || checkinAllRunning || visibleAccounts.length === 0}
                        onClick={() => void onRefreshCredits()}
                        aria-label={refreshCreditsLabel}
                      >
                        <RefreshCw className={refreshingCredits || checkinAllRunning ? "animate-spin" : undefined} />
                      </Button>
                    </DemoAction>
                  </span>
                </TooltipTrigger>
                <TooltipContent side="top">{api.isDemoMode() ? "演示模式下不可操作" : refreshCreditsLabel}</TooltipContent>
              </Tooltip>
            </div>
          </TooltipProvider>
        </div>
        {loading && visibleAccounts.length === 0 ? (
          <div className="flex items-center gap-2 py-16 text-sm text-muted-foreground">
            <Loader2 className="animate-spin" />
            加载账号…
          </div>
        ) : visibleAccounts.length === 0 ? (
          <div className="rounded-xl border border-dashed px-4 py-16 text-center text-sm text-muted-foreground">
            暂无账号。点击上方「OAuth 扫码添加」接入账号；本机已登录的账号也请一并添加，以便随时切回。
          </div>
        ) : (
          <div className="grid min-w-0 grid-cols-[repeat(auto-fit,minmax(min(100%,300px),1fr))] gap-5">
            {/* 不要给这个网格加 items-start：它会覆盖 Grid 默认的 stretch，让同排卡片因内容长度不同而
                高低参差。卡片内部 article 是 flex-col、内容区是 flex-1，会自动吸收差额、footer 自动贴底对齐。 */}
            {orderedAccounts.map((a) => (
              <AccountCard
                key={a.id}
                account={a}
                compact={compact}
                onDelete={onDelete}
                onSwitch={setSwitchAccount}
                onShowInfo={setInfoTarget}
                onCheckin={checkinAvailable ? onCheckin : undefined}
                onRefresh={onRefresh}
                todayCheckedIn={checkinMap[a.id]}
                autoCheckinAllowed={checkinAvailable && autoCheckinSettled ? !excludedCheckinIds.has(a.id) : undefined}
                travelStatus={autoTravelEnabled ? travelMap[a.id] : undefined}
                rateLimits={rateLimitEnabled ? rateLimitMap[a.id] : undefined}
                credit={creditMap[a.id]}
                creditLoading={creditLoadingMap[a.id]}
                creditUpdatedAt={creditUpdatedAtMap[a.id]}
                creditPriority={a.id === priorityAccountId}
                workbuddyActive={enabledTools.workbuddy && isWorkbuddyCurrent(a, current)}
                codebuddyCnIdeAvailable={Boolean(codebuddyCnIde?.installed)}
                codebuddyCnIdeActive={enabledTools.codebuddyIde && a.id === cnIdeCurrentAccountId}
                codebuddyCnIdeBusy={codebuddyIdeSwitchAccount !== null}
                onSwitchCodebuddyCnIde={onSwitchCodebuddyCnIde}
                enabledTools={enabledTools}
                featuresDisabled={false}
              />
            ))}
          </div>
        )}
      </section>

      <OAuthLoginDialog open={oauthOpen} onOpenChange={setOauthOpen} variant={variant} />
      <ExportAccountsDialog
        open={exportOpen}
        onOpenChange={setExportOpen}
        accounts={visibleAccounts}
        onExported={onExported}
      />
      <ImportAccountsDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        onImported={onImported}
        variant={variant}
      />
      <SwitchAccountDialog
        open={switchAccount !== null}
        onOpenChange={(o) => {
          if (!o) setSwitchAccount(null);
        }}
        account={switchAccount}
        onDone={() => {
          void fetchAll();
          void refreshCodebuddyCnIdeStatus();
        }}
      />
      <AccountInfoDialog
        open={infoTarget !== null}
        onOpenChange={(o) => {
          if (!o) setInfoTarget(null);
        }}
        account={infoTarget}
        onSaved={() => {
          void fetchAll();
        }}
      />
      <CodebuddyIdeSwitchAccountDialog
        open={codebuddyIdeSwitchAccount !== null}
        onOpenChange={(o) => {
          if (!o) setCodebuddyIdeSwitchAccount(null);
        }}
        account={codebuddyIdeSwitchAccount}
        variant={variant}
        ideStatus={codebuddyCnIde}
        onDone={() => {
          void refreshCodebuddyCnIdeStatus();
        }}
      />
      {/* 删除账号确认 */}
      <Dialog open={deleteTarget !== null} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除账号</DialogTitle>
            <DialogDescription>
              确定删除账号「{deleteTarget ? displayName(deleteTarget) : ""}」？
              此操作不可撤销。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>
              取消
            </Button>
            <Button variant="destructive" onClick={() => void confirmDelete()}>
              删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
