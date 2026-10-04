import { useEffect, useMemo, useState } from "react";
import { CircleCheck, Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { buildGroups, SessionCopyTab } from "@/components/session-copy-tab";
import * as api from "@/lib/api";
import { displayName } from "@/lib/account-display";
import type {
  AccountMeta,
  CodeBuddyCnIdeStatus,
  VscodeSession,
  VscodeSessionRef,
  WbVariant,
} from "@/lib/types";
import { cn } from "@/lib/utils";
import { variantUsesIntlCodebuddyIde } from "@/lib/variant";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 目标账号 */
  account: AccountMeta | null;
  /**
   * 当前档位：决定会话列表 / 关联预览 / 切换走哪条通道。
   *
   * 国内版（`CodeBuddy CN.app`）与国际版（`CodeBuddy.app`）共用同一套会话存储与后端语义，
   * 因此组件只做这一处分流，两个 tab、摘要与空态保持一份。
   */
  variant: WbVariant;
  /** CodeBuddy IDE 状态（用于渲染空态与运行中提示）。 */
  ideStatus?: CodeBuddyCnIdeStatus | null;
  /** 切换完成后刷新列表 */
  onDone?: () => void;
}

/**
 * CodeBuddy IDE 会话切换弹窗：可勾选「当前 IDE 账号」的会话复制到目标账号。
 *
 * 国内版与国际版共用本组件（差异只有 API 通道，按 `variant` 分流）：
 * - 切换固定走「关闭并重开 IDE」（`restart = true`），不提供自动关闭开关；
 * - 复制默认沿用会话 id，仅目标已有同 id 时改用新 id（后端决定，前端只提交引用）。
 */
export function CodebuddyIdeSwitchAccountDialog({ open, onOpenChange, account, variant, ideStatus, onDone }: Props) {
  /** 国际版档位：会话列表 / 关联预览 / 切换接口都走 `codebuddy-ide` 通道。 */
  const intl = variantUsesIntlCodebuddyIde(variant);
  const [sessions, setSessions] = useState<VscodeSession[]>([]);
  const [sourceUid, setSourceUid] = useState<string | null>(null);
  /** IDE 数据根目录：`null` = 未找到（与「有目录但无会话」区分）；`undefined` = 后端未返回该字段。 */
  const [dataRoot, setDataRoot] = useState<string | null | undefined>(undefined);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [copyEnabled, setCopyEnabled] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  /** 展开的工作区分组（默认全部展开，会话较少）。 */
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // 打开时加载「当前 IDE 账号」可复制的会话。
  useEffect(() => {
    if (!open || !account) return;
    setCopyEnabled(false);
    setSelected(new Set());
    setCollapsed(new Set());
    setDataRoot(undefined);
    setError("");
    setLoadingSessions(true);
    const fetchSessions = intl ? api.listCodebuddyIntlIdeSessions : api.listCodebuddyIdeSessions;
    fetchSessions()
      .then((res) => {
        setSessions(res.sessions);
        setSourceUid(res.sourceUid);
        setDataRoot(res.dataRoot);
      })
      .catch(() => {
        setSessions([]);
        setSourceUid(null);
        setDataRoot(undefined);
      })
      .finally(() => setLoadingSessions(false));
  }, [open, account, intl]);

  const groups = useMemo(() => buildGroups(sessions), [sessions]);
  const sessionById = useMemo(() => {
    const map = new Map<string, VscodeSession>();
    for (const session of sessions) map.set(session.id, session);
    return map;
  }, [sessions]);

  function toggleSession(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleGroup(ids: string[]) {
    setSelected((prev) => {
      const next = new Set(prev);
      const allOn = ids.length > 0 && ids.every((id) => next.has(id));
      if (allOn) ids.forEach((id) => next.delete(id));
      else ids.forEach((id) => next.add(id));
      return next;
    });
  }

  function toggleCollapsed(key: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function doSwitch() {
    if (!account) return;
    setBusy(true);
    setError("");
    try {
      const refs: VscodeSessionRef[] | undefined = copyEnabled
        ? [...selected]
            .map((id) => {
              const session = sessionById.get(id);
              return session
                ? { workspaceHash: session.workspaceHash, conversationId: session.id }
                : null;
            })
            .filter((ref): ref is VscodeSessionRef => ref !== null)
        : undefined;

      // IDE 切换固定「关闭 + 写入 + 重开」。
      const res = intl
        ? await api.switchCodebuddyIdeAccount(account.id, true, refs)
        : await api.switchCodebuddyCnIdeAccount(account.id, true, refs);
      const nickname = displayName(account);
      const copied = res.sessionCopy?.copied.length ?? 0;
      const errors = res.sessionCopy?.errors ?? [];
      const restartHint = res.message || "已重启 CodeBuddy IDE";
      const copiedHint = copied > 0 ? `已复制 ${copied} 个会话` : null;

      if (errors.length > 0) {
        toast.warning(`已切换至「${nickname}」，但部分会话未复制`, {
          description: [
            `已复制 ${copied} 个会话`,
            `${errors.length} 个失败：${errors.map((e) => e.error).join("；")}`,
            restartHint,
          ].join("；"),
        });
      } else {
        toast.success(`已切换至「${nickname}」`, {
          description: [copiedHint, restartHint].filter(Boolean).join("；"),
        });
      }
      onOpenChange(false);
      onDone?.();
    } catch (e) {
      setError(api.asError(e));
    } finally {
      setBusy(false);
    }
  }

  const copyCount = copyEnabled ? selected.size : 0;
  const hasCopyable = groups.length > 0;
  const running = ideStatus?.running === true;
  const summaryMain =
    copyCount > 0
      ? `将复制 ${copyCount} 个会话`
      : "本次仅切换账号";
  // 国际版不再有独立确认框，不勾选时由底部摘要承担「将重启 IDE」的说明。
  // 国内版文案保持原句，不在这里改。
  const summarySub =
    copyCount === 0
      ? intl
        ? running
          ? "未选择复制会话，确认后将关闭并重启 IDE"
          : "未选择复制会话，确认后将打开 IDE"
        : "未选择复制会话"
      : null;
  /** IDE 未登录（`loggedIn === false`）：按新登录写入，仅影响提示文案。 */
  const notLoggedIn = ideStatus?.loggedIn === false;
  /** 未登录时的追加说明（tooltip 第二段）。 */
  const notLoggedInHint = notLoggedIn
    ? "未检测到 CodeBuddy IDE 登录态，将按新登录写入；切换后打开 IDE 即登录为目标账号。"
    : undefined;
  const emptyHint = emptyStateHint(ideStatus, loadingSessions, sourceUid, dataRoot, hasCopyable);
  /** 标题行状态图标：三态提示收进 tooltip，仅以图标色调区分正常/警告。 */
  const statusNotice = running
    ? {
        icon: <RefreshCw className="size-4" />,
        title: "将自动关闭并重开 CodeBuddy IDE",
        description:
          "将先关闭 CodeBuddy IDE（未保存内容由 IDE 自身提示保护），写入凭证后自动重新打开。",
        warning: false,
      }
    : {
        icon: <CircleCheck className="size-4" />,
        title: "CodeBuddy IDE 未运行，可直接切换",
        description: "写入凭证后自动打开 CodeBuddy IDE，即为目标账号。",
        warning: false,
      };

  // 「复制会话」内容：勾选即意图，提交结果由底部摘要兜底确认。
  const copyTabContent = (
    <SessionCopyTab
      loading={loadingSessions}
      hint={emptyHint}
      hasCopyable={hasCopyable}
      enabled={copyEnabled}
      onEnabledChange={setCopyEnabled}
      groups={groups}
      selected={selected}
      onToggleSession={toggleSession}
      onToggleGroup={toggleGroup}
      collapsed={collapsed}
      onToggleCollapsed={toggleCollapsed}
    />
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={!busy}
        className="flex max-h-[min(90vh,calc(100vh-2rem))] min-w-0 flex-col overflow-hidden"
        tabIndex={-1}
        onOpenAutoFocus={(event) => {
          // Radix 默认把焦点交给第一个可聚焦元素（状态图标 / 关闭按钮），
          // 其 Tooltip 会因 focus 常驻在弹窗上；改为聚焦弹窗容器本身。
          event.preventDefault();
          const container = event.target as HTMLElement | null;
          window.requestAnimationFrame(() => container?.focus());
        }}
      >
        <DialogHeader className="shrink-0">
          <div className="flex items-center gap-3">
            <DialogTitle className="min-w-0 flex-1">
              切换到「{account ? displayName(account) : "该账号"}」
            </DialogTitle>
            {/* 提示收进图标 tooltip；mr-6 为右上角关闭按钮留空位。 */}
            <div className="mr-6 flex shrink-0 items-center gap-2">
              <Tooltip>
                <TooltipTrigger asChild>
                  {/* 仅悬停出提示：不加 tabIndex，避免点击/自动聚焦后 Tooltip 常驻不消失。 */}
                  <span
                    className={cn(
                      "flex size-5 cursor-help items-center justify-center",
                      statusNotice.warning
                        ? "text-amber-600 dark:text-amber-400"
                        : "text-muted-foreground",
                    )}
                    aria-label={statusNotice.title}
                  >
                    {statusNotice.icon}
                  </span>
                </TooltipTrigger>
                <TooltipContent side="bottom" align="end" className="max-w-xs space-y-1">
                  <div className="font-medium">{statusNotice.title}</div>
                  <p className="text-muted-foreground">{statusNotice.description}</p>
                  {notLoggedInHint && <p className="text-muted-foreground">{notLoggedInHint}</p>}
                </TooltipContent>
              </Tooltip>
            </div>
          </div>
          <DialogDescription>
            将把所选账号写入 CodeBuddy IDE；可选把当前账号的会话复制过去。
          </DialogDescription>
        </DialogHeader>

        {busy && (
          <div className="absolute inset-0 z-50 flex flex-col items-center justify-center gap-3 rounded-lg bg-background/85 backdrop-blur-sm">
            <Loader2 className="size-8 animate-spin text-primary" />
            <p className="text-sm font-medium">
              {copyCount > 0
                ? "正在关闭 CodeBuddy IDE 并复制会话…"
                : "正在关闭 CodeBuddy IDE 并写入凭证…"}
            </p>
            <p className="max-w-xs text-center text-xs text-muted-foreground">
              若 IDE 弹出保存提示请先处理（最长等待 60 秒）
            </p>
          </div>
        )}

        <div className="min-h-0 space-y-3 overflow-x-hidden overflow-y-auto">
          <div className="min-h-0 space-y-3 overflow-y-auto">{copyTabContent}</div>

          {error && (
            <Alert variant="destructive" className="min-w-0 break-all">
              <AlertDescription className="min-w-0 break-all">{error}</AlertDescription>
            </Alert>
          )}
        </div>

        <DialogFooter className="shrink-0 sm:justify-between">
          <div className="min-w-0 space-y-0.5">
            <div className="text-sm font-medium">{summaryMain}</div>
            {summarySub && <div className="text-xs text-muted-foreground">{summarySub}</div>}
          </div>
          <div className="flex shrink-0 gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
              取消
            </Button>
            {/* 勾了复制却没选会话时仍然拦住。 */}
            <Button
              onClick={doSwitch}
              disabled={busy || (copyEnabled && copyCount === 0)}
            >
              {busy ? "切换中…" : "确认切换"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 统一空态文案：区分未装 IDE / 未找到数据目录 / 未登录 / 无会话。 */
function emptyStateHint(
  status: CodeBuddyCnIdeStatus | null | undefined,
  loading: boolean,
  sourceUid: string | null,
  dataRoot: string | null | undefined,
  hasCopyable: boolean,
): string {
  if (loading) return "正在加载会话…";
  if (status && !status.installed) return "未检测到 CodeBuddy IDE，请先安装并登录";
  if (dataRoot === null) return "未找到 CodeBuddy IDE 数据目录，请先打开 IDE 并登录一次";
  if (!sourceUid) return "未检测到 CodeBuddy IDE 当前登录账号，请先在 IDE 中登录";
  if (!hasCopyable) return "当前账号暂无可复制的会话（无含正文的历史）";
  return "将当前账号勾选的会话复制给目标账号（沿用会话 id，目标已有同 id 时自动改用新 id）";
}
