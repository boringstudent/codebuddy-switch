import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  CircleAlert,
  Copy,
  Download,
  Loader2,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  ScrollText,
  SearchCheck,
  Square,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

import * as api from "@/lib/api";
import type {
  ProxyDailyStat,
  ProxyImportableAccount,
  ProxyOverview,
  ProxyRequestLog,
  ProxyServerStatus,
  ProxySubKey,
  ProxyUpstreamKey,
} from "@/lib/types";
import { cn } from "@/lib/utils";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

/** 与后端 SUPPORTED_MODELS 保持一致。 */
const SUPPORTED_MODELS = [
  "auto",
  "deepseek-v4-pro",
  "deepseek-v4.1-flash",
  "deepseek-v4-flash",
  "deepseek-v3-2-volc",
  "deepseek-v3-0324",
  "deepseek-r1",
  "glm-5.3",
  "glm-5.3-flash",
  "glm-5.2",
  "glm-5.1",
  "glm-5.0-turbo",
  "glm-5v-turbo",
  "minimax-m3",
  "minimax-m2.7",
  "kimi-k3",
  "kimi-k2.6",
  "kimi-k2.5",
  "hy3",
  "hy4-preview",
  "hy3-preview",
  "hunyuan-chat",
  "hunyuan-2.0-thinking",
];

const KEY_MODES = [
  { value: 1, label: "1 - 专一模式", tip: "粘住一个 Key 用到不可用才换下一个" },
  { value: 2, label: "2 - 临期优先", tip: "优先调用积分最快过期的 Key" },
  { value: 3, label: "3 - 轮询模式", tip: "每次请求轮换到下一个 Key" },
  { value: 4, label: "4 - 会话亲和", tip: "同一会话绑定同一上游 Key（TTL 1 小时）" },
] as const;

function fmtTokens(n: number | undefined): string {
  const value = n ?? 0;
  if (value <= 0) return "0";
  if (value >= 100_000_000) return `${(value / 100_000_000).toFixed(2)}亿`;
  if (value >= 10_000) return `${(value / 10_000).toFixed(2)}万`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
}

function fmtCredits(c: number | undefined): string {
  const value = c ?? 0;
  if (value <= 0) return "0";
  if (value >= 10_000) return `${(value / 10_000).toFixed(2)}万`;
  return value.toFixed(2);
}

function fmtLogTime(ts: number): string {
  const d = new Date(ts * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

const UPSTREAM_STATUS_LABEL: Record<string, { text: string; className: string }> = {
  active: { text: "活跃", className: "text-emerald-600" },
  exhausted: { text: "已耗尽", className: "text-red-600" },
  disabled: { text: "已禁用", className: "text-amber-600" },
  rate_limited: { text: "限流中", className: "text-amber-600" },
  cooldown: { text: "冷却中", className: "text-sky-600" },
  abnormal: { text: "异常", className: "text-red-600" },
};

function upstreamStatusBadge(status: string) {
  const meta = UPSTREAM_STATUS_LABEL[status] ?? { text: status, className: "text-muted-foreground" };
  return <span className={cn("text-xs font-medium", meta.className)}>{meta.text}</span>;
}

function keyModeLabel(mode: number): string {
  return KEY_MODES.find((m) => m.value === mode)?.label ?? KEY_MODES[0].label;
}

function asError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** 用量占比着色：≥100% 红、≥80% 黄，其余默认。未设上限不着色。 */
function usageTone(used: number, max: number | undefined): string {
  if (!max || max <= 0) return "";
  const ratio = used / max;
  if (ratio >= 1) return "font-medium text-red-600";
  if (ratio >= 0.8) return "text-amber-600";
  return "";
}

// ---------------------------------------------------------------------------
// 从账号导入对话框
// ---------------------------------------------------------------------------

function ImportAccountsDialog({
  open,
  onOpenChange,
  onImported,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported: () => void;
}) {
  const [accounts, setAccounts] = useState<ProxyImportableAccount[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    void (async () => {
      try {
        const [{ accounts }, { keys }] = await Promise.all([
          api.listProxyImportableAccounts(),
          api.listProxyUpstreamKeys(),
        ]);
        setAccounts(accounts);
        // 未导入过的默认勾选。
        const importedAccountIds = new Set(keys.map((k) => k.account_id).filter(Boolean));
        setSelected(new Set(accounts.filter((a) => !importedAccountIds.has(a.id)).map((a) => a.id)));
      } catch (cause) {
        toast.error(`加载账号失败: ${asError(cause)}`);
      } finally {
        setLoading(false);
      }
    })();
  }, [open]);

  const toggle = (id: string, checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const doImport = async () => {
    if (selected.size === 0) {
      toast.warning("请选择要导入的账号");
      return;
    }
    setImporting(true);
    try {
      const { imported } = await api.importProxyAccounts([...selected]);
      toast.success(imported > 0 ? `成功导入 ${imported} 个 Key 到上游 Key 池` : "没有新的 Key 需要导入（可能已存在）");
      onOpenChange(false);
      onImported();
    } catch (cause) {
      toast.error(`导入失败: ${asError(cause)}`);
    } finally {
      setImporting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>从账号导入到 Key 池</DialogTitle>
          <DialogDescription>
            只有持有明文调用凭据的账号才可导入；已导入过的账号不再重复导入。
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-72 overflow-y-auto rounded-md border">
          {loading ? (
            <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> 加载中…
            </div>
          ) : accounts.length === 0 ? (
            <div className="p-4 text-sm text-muted-foreground">没有可导入的账号</div>
          ) : (
            accounts.map((account) => (
              <label
                key={account.id}
                className="flex cursor-pointer items-center gap-3 border-b px-3 py-2.5 last:border-b-0 hover:bg-foreground/[0.03]"
              >
                <Checkbox
                  checked={selected.has(account.id)}
                  onCheckedChange={(v) => toggle(account.id, v === true)}
                />
                <span className="min-w-0 flex-1 truncate text-sm">{account.name}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{account.uid}</span>
              </label>
            ))
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={() => void doImport()} disabled={importing || loading}>
            {importing ? <Loader2 className="animate-spin" /> : <Download />}
            导入选中
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// 创建 / 编辑子 Key 对话框
// ---------------------------------------------------------------------------

export interface SubKeyFormData {
  label: string;
  allowed_models: string[];
  allowed_key_ids: string[];
  max_usage: number;
  max_tokens: number;
  max_credits: number;
  rate_limit_rpm: number;
  key_mode: number;
}

function SubKeyDialog({
  open,
  onOpenChange,
  upstreamKeys,
  editKey,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  upstreamKeys: ProxyUpstreamKey[];
  editKey: ProxySubKey | null;
  onSubmit: (data: SubKeyFormData) => Promise<void>;
}) {
  const [label, setLabel] = useState("");
  const [models, setModels] = useState<Set<string>>(new Set());
  const [keyIds, setKeyIds] = useState<Set<string>>(new Set());
  const [maxUsage, setMaxUsage] = useState(0);
  // Token 上限以「万」为单位输入，避免手填一长串 0。
  const [maxTokensWan, setMaxTokensWan] = useState(0);
  const [maxCredits, setMaxCredits] = useState(0);
  const [rpm, setRpm] = useState(1000);
  const [keyMode, setKeyMode] = useState(1);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLabel(editKey?.label ?? "");
    setModels(new Set(editKey?.allowed_models ?? []));
    setKeyIds(new Set(editKey?.allowed_key_ids ?? []));
    setMaxUsage(editKey?.max_usage ?? 0);
    setMaxTokensWan((editKey?.max_tokens ?? 0) / 10000);
    setMaxCredits(editKey?.max_credits ?? 0);
    setRpm(editKey?.rate_limit_rpm ?? 1000);
    setKeyMode(editKey?.key_mode ?? 1);
  }, [open, editKey]);

  const toggleSet = (set: Set<string>, value: string, checked: boolean) => {
    const next = new Set(set);
    if (checked) next.add(value);
    else next.delete(value);
    return next;
  };

  const submit = async () => {
    setSaving(true);
    try {
      await onSubmit({
        label: label.trim(),
        allowed_models: [...models],
        allowed_key_ids: [...keyIds],
        max_usage: Math.max(0, maxUsage),
        max_tokens: Math.max(0, Math.round(maxTokensWan * 10000)),
        max_credits: Math.max(0, maxCredits),
        rate_limit_rpm: Math.max(1, rpm),
        key_mode: keyMode,
      });
      onOpenChange(false);
    } catch (cause) {
      toast.error(`保存失败: ${asError(cause)}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{editKey ? "编辑子 API Key" : "创建子 API Key"}</DialogTitle>
          <DialogDescription>模型与上游 Key 均不勾选表示「全部允许」。</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-1.5">
            <Label>标签</Label>
            <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="子 Key 标签（如用户名）" />
          </div>
          <div className="grid gap-1.5">
            <Label>限制模型（不选 = 全部模型）</Label>
            <div className="grid max-h-36 grid-cols-2 gap-x-3 overflow-y-auto rounded-md border p-2 sm:grid-cols-3">
              {SUPPORTED_MODELS.map((m) => (
                <label key={m} className="flex cursor-pointer items-center gap-1.5 py-0.5 text-xs">
                  <Checkbox
                    checked={models.has(m)}
                    onCheckedChange={(v) => setModels((prev) => toggleSet(prev, m, v === true))}
                  />
                  {m}
                </label>
              ))}
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label>上游 Key（不选 = 全部上游 Key）</Label>
            <div className="max-h-28 overflow-y-auto rounded-md border p-2">
              {upstreamKeys.length === 0 ? (
                <div className="text-xs text-muted-foreground">上游 Key 池为空</div>
              ) : (
                upstreamKeys.map((k) => (
                  <label key={k.key_id} className="flex cursor-pointer items-center gap-1.5 py-0.5 text-xs">
                    <Checkbox
                      checked={keyIds.has(k.key_id)}
                      onCheckedChange={(v) => setKeyIds((prev) => toggleSet(prev, k.key_id, v === true))}
                    />
                    <span className="truncate">{k.label || k.key_id}</span>
                  </label>
                ))
              )}
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label>最大使用次数</Label>
              <Input
                type="number"
                min={0}
                value={maxUsage}
                onChange={(e) => setMaxUsage(Number(e.target.value) || 0)}
              />
              <p className="text-[11px] text-muted-foreground">0 = 无限</p>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Token 上限（万）</Label>
              <Input
                type="number"
                min={0}
                step="any"
                value={maxTokensWan}
                onChange={(e) => setMaxTokensWan(Number(e.target.value) || 0)}
              />
              <p className="text-[11px] text-muted-foreground">累计 Token，0 = 不限</p>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>积分上限</Label>
              <Input
                type="number"
                min={0}
                step="any"
                value={maxCredits}
                onChange={(e) => setMaxCredits(Number(e.target.value) || 0)}
              />
              <p className="text-[11px] text-muted-foreground">累计积分消耗，0 = 不限</p>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>限流 RPM</Label>
              <Input
                type="number"
                min={1}
                value={rpm}
                onChange={(e) => setRpm(Number(e.target.value) || 1000)}
              />
              <p className="text-[11px] text-muted-foreground">每分钟请求数</p>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>调用模式</Label>
              <Select value={String(keyMode)} onValueChange={(v) => setKeyMode(Number(v))}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {KEY_MODES.map((m) => (
                    <SelectItem key={m.value} value={String(m.value)} title={m.tip}>
                      {m.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground">
                {KEY_MODES.find((m) => m.value === keyMode)?.tip}
              </p>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={() => void submit()} disabled={saving}>
            {saving ? <Loader2 className="animate-spin" /> : null}
            {editKey ? "保存" : "创建"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// 每日消耗明细对话框
// ---------------------------------------------------------------------------

function DailyDetailDialog({
  open,
  onOpenChange,
  title,
  category,
  keyId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  category: "upstream" | "sub";
  keyId: string;
}) {
  const [stats, setStats] = useState<Record<string, ProxyDailyStat>>({});
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open || !keyId) return;
    setLoading(true);
    api
      .getProxyDailyStats(category, keyId)
      .then(setStats)
      .catch((cause) => toast.error(`加载明细失败: ${asError(cause)}`))
      .finally(() => setLoading(false));
  }, [open, category, keyId]);

  const dates = Object.keys(stats).sort().reverse();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title} · 每日消耗明细</DialogTitle>
        </DialogHeader>
        {loading ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> 加载中…
          </div>
        ) : dates.length === 0 ? (
          <div className="py-6 text-sm text-muted-foreground">暂无历史数据</div>
        ) : (
          <div className="max-h-80 overflow-y-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>日期</TableHead>
                  <TableHead>调用次数</TableHead>
                  <TableHead>Token（输入+输出）</TableHead>
                  <TableHead>积分消耗</TableHead>
                  <TableHead>缓存命中</TableHead>
                  <TableHead>缓存率</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {dates.map((date) => {
                  const d = stats[date];
                  const cacheRate = d.total_tokens > 0 ? `${((d.cached_tokens / d.total_tokens) * 100).toFixed(1)}%` : "-";
                  return (
                    <TableRow key={date}>
                      <TableCell>{date}</TableCell>
                      <TableCell>{d.count}</TableCell>
                      <TableCell title={`输入: ${d.prompt_tokens} 输出: ${d.completion_tokens} 总计: ${d.total_tokens}`}>
                        {fmtTokens(d.prompt_tokens)}+{fmtTokens(d.completion_tokens)}
                      </TableCell>
                      <TableCell>{d.credits.toFixed(2)}</TableCell>
                      <TableCell>{fmtTokens(d.cached_tokens)}</TableCell>
                      <TableCell>{cacheRate}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// 页面主体
// ---------------------------------------------------------------------------

export default function ApiProxyPage() {
  const [status, setStatus] = useState<ProxyServerStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [port, setPort] = useState(8002);
  const [mode, setMode] = useState("local");
  const [autoStart, setAutoStart] = useState(false);
  const [upstreamProxy, setUpstreamProxy] = useState("");
  const [toggling, setToggling] = useState(false);

  const [upstreamKeys, setUpstreamKeys] = useState<ProxyUpstreamKey[]>([]);
  const [subKeys, setSubKeys] = useState<ProxySubKey[]>([]);
  const [logs, setLogs] = useState<ProxyRequestLog[]>([]);
  const [overview, setOverview] = useState<ProxyOverview | null>(null);
  const [refreshingPoints, setRefreshingPoints] = useState(false);
  const [checkingStatus, setCheckingStatus] = useState(false);

  const [importOpen, setImportOpen] = useState(false);
  const [subKeyDialogOpen, setSubKeyDialogOpen] = useState(false);
  const [editingSubKey, setEditingSubKey] = useState<ProxySubKey | null>(null);
  const [detail, setDetail] = useState<{ title: string; category: "upstream" | "sub"; keyId: string } | null>(null);
  const [activeTab, setActiveTab] = useState("upstream");

  const logBoxRef = useRef<HTMLDivElement>(null);

  const loadStatus = useCallback(async () => {
    const s = await api.getProxyStatus();
    setStatus(s);
    setPort(s.settings?.port ?? s.port ?? 8002);
    setMode(s.settings?.mode ?? s.mode ?? "local");
    setAutoStart(Boolean(s.settings?.auto_start));
    setUpstreamProxy(s.settings?.upstream_proxy ?? "");
  }, []);

  const loadUpstreamKeys = useCallback(async () => {
    const { keys } = await api.listProxyUpstreamKeys();
    setUpstreamKeys(keys);
  }, []);

  const loadSubKeys = useCallback(async () => {
    const { keys } = await api.listProxySubKeys();
    setSubKeys(keys);
  }, []);

  const loadLogs = useCallback(async () => {
    const { logs } = await api.getProxyLogs(0, 300);
    setLogs(logs);
  }, []);

  const loadOverview = useCallback(async () => {
    setOverview(await api.getProxyOverview());
  }, []);

  const loadAll = useCallback(async () => {
    try {
      setError(null);
      await Promise.all([loadStatus(), loadUpstreamKeys(), loadSubKeys(), loadLogs(), loadOverview()]);
    } catch (cause) {
      setError(asError(cause));
    }
  }, [loadStatus, loadUpstreamKeys, loadSubKeys, loadLogs, loadOverview]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  // 日志 Tab 激活时每 3 秒增量刷新。
  useEffect(() => {
    if (activeTab !== "logs") return;
    const timer = window.setInterval(() => {
      void loadLogs().catch(() => undefined);
    }, 3000);
    return () => window.clearInterval(timer);
  }, [activeTab, loadLogs]);

  // 消耗总览每 10 秒刷新（转发统计随请求实时变化）。
  useEffect(() => {
    const timer = window.setInterval(() => {
      void loadOverview().catch(() => undefined);
    }, 10_000);
    return () => window.clearInterval(timer);
  }, [loadOverview]);

  // 日志更新后滚到底部（useLayoutEffect 保证绘制前完成滚动，新日志始终自动下滑可见）。
  useLayoutEffect(() => {
    if (activeTab === "logs" && logBoxRef.current) {
      logBoxRef.current.scrollTop = logBoxRef.current.scrollHeight;
    }
  }, [logs, activeTab]);

  const toggleService = async () => {
    setToggling(true);
    try {
      if (status?.running) {
        await api.stopProxyServer();
        toast.success("代理服务已停止");
      } else {
        await api.startProxyServer(port, mode);
        toast.success(`代理服务已启动 :${port}`);
      }
      await loadStatus();
    } catch (cause) {
      toast.error(asError(cause));
    } finally {
      setToggling(false);
    }
  };

  const persistSettings = async (patch: Record<string, unknown>) => {
    try {
      const s = await api.saveProxySettings(patch);
      setStatus(s);
    } catch (cause) {
      toast.error(`保存设置失败: ${asError(cause)}`);
    }
  };

  const copyText = (text: string, label: string) => {
    void navigator.clipboard
      .writeText(text)
      .then(() => toast.success(`${label}已复制`))
      .catch(() => toast.error("复制失败"));
  };

  /** 后台逐个处理期间每 1.5 秒拉一次 Key 列表，表格随每个 Key 的处理结果渐进更新。 */
  const pollUpstreamKeysWhile = useCallback(
    async (task: () => Promise<void>) => {
      const timer = window.setInterval(() => {
        void loadUpstreamKeys().catch(() => undefined);
      }, 1500);
      try {
        await task();
      } finally {
        window.clearInterval(timer);
      }
    },
    [loadUpstreamKeys],
  );

  const refreshPoints = async () => {
    setRefreshingPoints(true);
    try {
      let result: { success: number; failed: number } | null = null;
      await pollUpstreamKeysWhile(async () => {
        result = await api.refreshProxyKeyPoints();
      });
      const { success, failed } = result ?? { success: 0, failed: 0 };
      toast.success(`积分刷新完成：${success} 个成功${failed > 0 ? `，${failed} 个失败` : ""}`);
      await Promise.all([loadUpstreamKeys(), loadSubKeys()]);
    } catch (cause) {
      toast.error(`积分刷新失败: ${asError(cause)}`);
    } finally {
      setRefreshingPoints(false);
    }
  };

  const checkStatus = async () => {
    setCheckingStatus(true);
    try {
      let result: { normal: number; abnormal: number; failed: number } | null = null;
      await pollUpstreamKeysWhile(async () => {
        result = await api.checkProxyKeyStatus();
      });
      const { normal, abnormal, failed } = result ?? { normal: 0, abnormal: 0, failed: 0 };
      const message = `检测完成：正常 ${normal}，异常 ${abnormal}，失败 ${failed}`;
      if (abnormal > 0) toast.warning(`${message}（异常 Key 已自动标记）`);
      else toast.success(message);
      await loadUpstreamKeys();
    } catch (cause) {
      toast.error(`状态检测失败: ${asError(cause)}`);
    } finally {
      setCheckingStatus(false);
    }
  };

  const setUpstreamKeyStatus = async (keyId: string, status: string) => {
    try {
      await api.updateProxyUpstreamKey(keyId, { status });
      await loadUpstreamKeys();
    } catch (cause) {
      toast.error(asError(cause));
    }
  };

  const removeUpstreamKey = async (keyId: string) => {
    try {
      await api.deleteProxyUpstreamKey(keyId);
      toast.success("已删除");
      await loadUpstreamKeys();
    } catch (cause) {
      toast.error(asError(cause));
    }
  };

  const submitSubKey = async (data: SubKeyFormData) => {
    if (editingSubKey) {
      await api.updateProxySubKey(editingSubKey.key_id, { ...data });
      toast.success("子 Key 已更新");
    } else {
      await api.createProxySubKey({ ...data });
      toast.success("子 API Key 创建成功");
    }
    await loadSubKeys();
  };

  const toggleSubKey = async (key: ProxySubKey) => {
    try {
      await api.updateProxySubKey(key.key_id, { is_active: !key.is_active });
      await loadSubKeys();
    } catch (cause) {
      toast.error(asError(cause));
    }
  };

  const removeSubKey = async (keyId: string) => {
    try {
      await api.deleteProxySubKey(keyId);
      toast.success("已删除");
      await loadSubKeys();
    } catch (cause) {
      toast.error(asError(cause));
    }
  };

  const running = Boolean(status?.running);
  const serviceUrl = running
    ? `http://127.0.0.1:${status?.port}/v1`
    : `http://127.0.0.1:${port}/v1`;

  const upstreamStats = {
    total: upstreamKeys.length,
    active: upstreamKeys.filter((k) => k.status === "active").length,
    exhausted: upstreamKeys.filter((k) => k.status === "exhausted").length,
    abnormal: upstreamKeys.filter((k) => k.status === "abnormal").length,
    used: upstreamKeys.reduce((sum, k) => sum + (k.used_count ?? 0), 0),
  };
  const subStats = {
    total: subKeys.length,
    active: subKeys.filter((k) => k.is_active).length,
    used: subKeys.reduce((sum, k) => sum + (k.used_count ?? 0), 0),
  };

  return (
    <div className="mx-auto w-full max-w-[1180px] min-w-0 px-4 py-6 sm:px-8 sm:py-9">
      <header className="mb-8 flex min-w-0 flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-[28px] font-semibold tracking-tight">API 代理</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
            本地 API 中转服务 · OpenAI 兼容接口 · 多账号积分池化转发
          </p>
        </div>
      </header>

      {error && (
        <Alert variant="destructive" className="mb-5">
          <CircleAlert />
          <AlertTitle>加载失败</AlertTitle>
          <AlertDescription className="flex flex-wrap items-center gap-3">
            <span>{error}</span>
            <Button size="sm" variant="outline" onClick={() => void loadAll()}>
              重试
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {/* 服务控制 */}
      <Card className="mb-6">
        <CardContent className="flex flex-col gap-4 p-5">
          <div className="flex flex-wrap items-center gap-3">
            <Label className="shrink-0">端口</Label>
            <Input
              type="number"
              min={1024}
              max={65535}
              value={port}
              disabled={running}
              onChange={(e) => setPort(Math.min(65535, Math.max(1024, Number(e.target.value) || 8002)))}
              className="w-24"
            />
            <Select value={mode} onValueChange={setMode} disabled={running}>
              <SelectTrigger className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="local">本地模式</SelectItem>
                <SelectItem value="open">开放模式</SelectItem>
              </SelectContent>
            </Select>
            <div className="flex items-center gap-2">
              <Switch
                checked={autoStart}
                onCheckedChange={(v) => {
                  setAutoStart(v);
                  void persistSettings({ auto_start: v });
                }}
              />
              <Label className="text-sm text-muted-foreground">启动应用时自动运行</Label>
            </div>
            <div className="ml-auto flex items-center gap-3">
              <Badge variant={running ? "default" : "secondary"}>
                {running ? `运行中 :${status?.port}` : "已停止"}
              </Badge>
              <Button onClick={() => void toggleService()} disabled={toggling} variant={running ? "destructive" : "default"}>
                {toggling ? <Loader2 className="animate-spin" /> : running ? <Square /> : <Play />}
                {running ? "停止服务" : "启动服务"}
              </Button>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted-foreground">接口地址:</span>
            <code className="rounded bg-foreground/[0.05] px-1.5 py-0.5 text-[13px] font-medium">{serviceUrl}</code>
            <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => copyText(serviceUrl, "接口地址")}>
              <Copy className="size-3.5" />
              复制
            </Button>
          </div>
          {mode === "open" && (
            <p className="rounded-md bg-amber-500/10 px-3 py-2 text-xs leading-5 text-amber-700 dark:text-amber-400">
              开放模式监听 0.0.0.0，局域网内所有用户均可访问：必须创建子 Key 并分发给使用者，未携带有效子 Key 的请求将被拒绝。
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Label className="shrink-0 text-sm text-muted-foreground">自定义上游（留空用默认）</Label>
            <Input
              value={upstreamProxy}
              onChange={(e) => setUpstreamProxy(e.target.value)}
              onBlur={() => void persistSettings({ upstream_proxy: upstreamProxy.trim() })}
              placeholder="https://copilot.tencent.com/v2"
              className="max-w-sm"
            />
          </div>
        </CardContent>
      </Card>

      {/* 消耗总览 */}
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <OverviewMetric label="累计调用" value={overview ? String(Math.round(overview.total.requests)) : "—"} />
        <OverviewMetric
          label="累计 Token"
          value={overview ? fmtTokens(overview.total.tokens) : "—"}
          tip={overview ? `输入 ${overview.total.prompt_tokens.toLocaleString()} / 输出 ${overview.total.completion_tokens.toLocaleString()} / 缓存 ${overview.total.cached_tokens.toLocaleString()}` : undefined}
        />
        <OverviewMetric
          label="累计积分消耗"
          value={overview ? fmtCredits(overview.total.credits) : "—"}
          tip={overview ? `精确值 ${overview.total.credits.toFixed(4)}` : undefined}
        />
        <OverviewMetric label="今日调用" value={overview ? String(Math.round(overview.today.requests)) : "—"} />
        <OverviewMetric label="今日 Token" value={overview ? fmtTokens(overview.today.tokens) : "—"} />
        <OverviewMetric label="今日积分消耗" value={overview ? fmtCredits(overview.today.credits) : "—"} />
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="upstream">上游 Key 池</TabsTrigger>
          <TabsTrigger value="subkeys">子 API Keys</TabsTrigger>
          <TabsTrigger value="logs">使用日志</TabsTrigger>
        </TabsList>

        {/* 上游 Key 池 */}
        <TabsContent value="upstream" className="mt-4">
          <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium">总 Key: {upstreamStats.total}</span>
            <span className="font-medium text-emerald-600">活跃: {upstreamStats.active}</span>
            <span className="font-medium text-red-600">耗尽: {upstreamStats.exhausted}</span>
            <span className="font-medium text-amber-600">异常: {upstreamStats.abnormal}</span>
            <span className="font-medium text-violet-600">总调用: {upstreamStats.used}</span>
            <div className="ml-auto flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={() => setImportOpen(true)}>
                <Download />
                从账号导入
              </Button>
              <Button size="sm" variant="outline" onClick={() => void refreshPoints()} disabled={refreshingPoints}>
                {refreshingPoints ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                刷新积分
              </Button>
              <Button size="sm" variant="outline" onClick={() => void checkStatus()} disabled={checkingStatus}>
                {checkingStatus ? <Loader2 className="animate-spin" /> : <SearchCheck />}
                一键检测状态
              </Button>
            </div>
          </div>
          <div className="overflow-x-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Key ID</TableHead>
                  <TableHead>标签</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>调用次数</TableHead>
                  <TableHead>积分</TableHead>
                  <TableHead>Token</TableHead>
                  <TableHead>积分消耗</TableHead>
                  <TableHead>缓存命中</TableHead>
                  <TableHead className="w-52">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {upstreamKeys.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={9} className="py-8 text-center text-sm text-muted-foreground">
                      Key 池为空，点「从账号导入」把账号库中的账号加入 Key 池
                    </TableCell>
                  </TableRow>
                ) : (
                  upstreamKeys.map((k) => {
                    const cacheRate =
                      (k.total_tokens ?? 0) > 0 && (k.total_cached_tokens ?? 0) > 0
                        ? `${(((k.total_cached_tokens ?? 0) / (k.total_tokens ?? 1)) * 100).toFixed(1)}%`
                        : "-";
                    return (
                      <TableRow key={k.key_id}>
                        <TableCell className="font-mono text-xs" title={k.key_id}>
                          {k.key_id}
                        </TableCell>
                        <TableCell className="max-w-36 truncate" title={k.label}>
                          {k.label || "-"}
                        </TableCell>
                        <TableCell>{upstreamStatusBadge(k.status)}</TableCell>
                        <TableCell>{k.used_count ?? 0}</TableCell>
                        <TableCell>{k.points || "-"}</TableCell>
                        <TableCell
                          title={`输入: ${k.total_prompt_tokens ?? 0} 输出: ${k.total_completion_tokens ?? 0} 总计: ${k.total_tokens ?? 0}`}
                        >
                          {(k.total_tokens ?? 0) > 0
                            ? `${fmtTokens(k.total_prompt_tokens)}+${fmtTokens(k.total_completion_tokens)}`
                            : "-"}
                        </TableCell>
                        <TableCell title={`累计积分消耗: ${(k.total_credits ?? 0).toFixed(4)}`}>
                          {fmtCredits(k.total_credits)}
                        </TableCell>
                        <TableCell>{cacheRate}</TableCell>
                        <TableCell>
                          <div className="flex items-center gap-1">
                            {k.status === "active" ? (
                              <Button size="sm" variant="ghost" className="h-7 px-2 text-xs text-amber-600" onClick={() => void setUpstreamKeyStatus(k.key_id, "disabled")}>
                                禁用
                              </Button>
                            ) : (
                              <Button size="sm" variant="ghost" className="h-7 px-2 text-xs text-emerald-600" onClick={() => void setUpstreamKeyStatus(k.key_id, "active")}>
                                恢复
                              </Button>
                            )}
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-7 px-2 text-xs"
                              onClick={() => setDetail({ title: `上游 Key ${k.label || k.key_id}`, category: "upstream", keyId: k.key_id })}
                            >
                              明细
                            </Button>
                            <Button size="sm" variant="ghost" className="h-7 px-2 text-xs text-red-600" onClick={() => void removeUpstreamKey(k.key_id)}>
                              删除
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </div>
        </TabsContent>

        {/* 子 API Keys */}
        <TabsContent value="subkeys" className="mt-4">
          <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium">总 Key: {subStats.total}</span>
            <span className="font-medium text-emerald-600">启用: {subStats.active}</span>
            <span className="font-medium text-amber-600">禁用: {subStats.total - subStats.active}</span>
            <span className="font-medium text-violet-600">总调用: {subStats.used}</span>
            <div className="ml-auto flex items-center gap-2">
              <Button
                size="sm"
                onClick={() => {
                  setEditingSubKey(null);
                  setSubKeyDialogOpen(true);
                }}
              >
                <Plus />
                创建子 Key
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void loadSubKeys()}>
                <RefreshCw />
                刷新
              </Button>
            </div>
          </div>
          <div className="overflow-x-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>API Key</TableHead>
                  <TableHead>标签</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>模型限制</TableHead>
                  <TableHead>已用/上限</TableHead>
                  <TableHead>总积分</TableHead>
                  <TableHead>调用模式</TableHead>
                  <TableHead>Token</TableHead>
                  <TableHead>积分消耗</TableHead>
                  <TableHead className="w-56">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {subKeys.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={10} className="py-8 text-center text-sm text-muted-foreground">
                      暂无子 Key；本地模式可不创建子 Key 直接透传使用，开放模式必须创建子 Key 分发
                    </TableCell>
                  </TableRow>
                ) : (
                  subKeys.map((k) => (
                    <TableRow key={k.key_id}>
                      <TableCell
                        className="cursor-pointer font-mono text-xs"
                        title={`${k.api_key}\n点击复制`}
                        onClick={() => copyText(k.api_key, "API Key")}
                      >
                        {k.api_key.slice(0, 12)}…
                      </TableCell>
                      <TableCell className="max-w-28 truncate" title={k.label}>
                        {k.label || "-"}
                      </TableCell>
                      <TableCell>
                        <span className={cn("text-xs font-medium", k.is_active ? "text-emerald-600" : "text-amber-600")}>
                          {k.is_active ? "启用" : "禁用"}
                        </span>
                      </TableCell>
                      <TableCell className="max-w-32 truncate" title={k.allowed_models.join(", ") || "全部模型"}>
                        {k.allowed_models.length === 0 ? "全部" : `${k.allowed_models.length} 个模型`}
                      </TableCell>
                      <TableCell>
                        {k.used_count ?? 0}/{k.max_usage > 0 ? k.max_usage : "∞"}
                      </TableCell>
                      <TableCell>
                        {k.total_points && k.total_points > 0 ? (
                          <span className="text-emerald-600">{k.total_points.toFixed(0)}</span>
                        ) : (
                          "-"
                        )}
                      </TableCell>
                      <TableCell className="text-xs">{keyModeLabel(k.key_mode)}</TableCell>
                      <TableCell
                        title={`输入: ${k.total_prompt_tokens ?? 0} 输出: ${k.total_completion_tokens ?? 0} 总计: ${k.total_tokens ?? 0}${k.max_tokens ? ` / 上限 ${k.max_tokens}` : ""}`}
                      >
                        <span className={usageTone(k.total_tokens ?? 0, k.max_tokens)}>
                          {k.max_tokens
                            ? `${fmtTokens(k.total_tokens ?? 0)} / ${fmtTokens(k.max_tokens)}`
                            : `${fmtTokens(k.total_prompt_tokens ?? 0)}+${fmtTokens(k.total_completion_tokens ?? 0)}`}
                        </span>
                      </TableCell>
                      <TableCell
                        title={k.max_credits ? `累计 ${(k.total_credits ?? 0).toFixed(4)} / 上限 ${k.max_credits}` : undefined}
                      >
                        <span className={usageTone(k.total_credits ?? 0, k.max_credits)}>
                          {(k.total_credits ?? 0).toFixed(2)}
                          {k.max_credits ? ` / ${k.max_credits}` : ""}
                        </span>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1">
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 px-2 text-xs"
                            onClick={() => {
                              setEditingSubKey(k);
                              setSubKeyDialogOpen(true);
                            }}
                          >
                            <Pencil className="size-3.5" />
                            编辑
                          </Button>
                          <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => copyText(k.api_key, "API Key")}>
                            <Copy className="size-3.5" />
                            复制
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className={cn("h-7 px-2 text-xs", k.is_active ? "text-amber-600" : "text-emerald-600")}
                            onClick={() => void toggleSubKey(k)}
                          >
                            {k.is_active ? "禁用" : "启用"}
                          </Button>
                          <Button size="sm" variant="ghost" className="h-7 px-2 text-xs text-red-600" onClick={() => void removeSubKey(k.key_id)}>
                            <Trash2 className="size-3.5" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </TabsContent>

        {/* 使用日志 */}
        <TabsContent value="logs" className="mt-4">
          <div
            ref={logBoxRef}
            className="h-[420px] overflow-y-auto rounded-md border bg-zinc-950 p-3 font-mono text-xs leading-5 text-zinc-400"
          >
            {logs.length === 0 ? (
              <div className="text-zinc-500">暂无日志；启动服务并发起请求后在此显示</div>
            ) : (
              logs.map((log, index) => <LogLine key={index} log={log} />)
            )}
          </div>
          <div className="mt-3 flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={() => void loadLogs()}>
              <ScrollText />
              刷新日志
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                void api
                  .clearProxyLogs()
                  .then(() => loadLogs())
                  .catch((cause) => toast.error(asError(cause)));
              }}
            >
              <Trash2 />
              清空
            </Button>
          </div>
        </TabsContent>
      </Tabs>

      <ImportAccountsDialog open={importOpen} onOpenChange={setImportOpen} onImported={() => void loadUpstreamKeys()} />
      <SubKeyDialog
        open={subKeyDialogOpen}
        onOpenChange={setSubKeyDialogOpen}
        upstreamKeys={upstreamKeys}
        editKey={editingSubKey}
        onSubmit={submitSubKey}
      />
      {detail && (
        <DailyDetailDialog
          open={Boolean(detail)}
          onOpenChange={(open) => {
            if (!open) setDetail(null);
          }}
          title={detail.title}
          category={detail.category}
          keyId={detail.keyId}
        />
      )}
    </div>
  );
}

function OverviewMetric({ label, value, tip }: { label: string; value: string; tip?: string }) {
  return (
    <div className="rounded-lg border bg-card px-3 py-2.5" title={tip}>
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="mt-0.5 truncate text-lg font-semibold leading-6">{value}</div>
    </div>
  );
}

function LogLine({ log }: { log: ProxyRequestLog }) {
  const time = fmtLogTime(log.timestamp ?? 0);
  const event = log.event ?? "";
  const parts: string[] = [];
  if (log.sub_key_label) parts.push(`子Key:${log.sub_key_label}`);
  if (log.main_key_label) parts.push(`上游:${log.main_key_label}`);
  if (log.model) parts.push(`模型:${log.model}`);
  if (log.event === "end") {
    parts.push(
      `完成 ${log.duration_ms ?? 0}ms 首字 ${log.first_token_ms ?? 0}ms token ${log.prompt_tokens ?? 0}+${log.completion_tokens ?? 0}`,
    );
  }
  if (log.error) parts.push(log.error);
  const isError = ["error", "auth_fail", "upstream_error", "upstream_429"].includes(event);
  return (
    <div className={cn(isError && "text-red-400")}>
      [{time}] [{event}] {parts.join(" ")}
    </div>
  );
}
