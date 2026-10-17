import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Calculator,
  Database,
  FlaskConical,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { displayName } from "@/lib/account-display";
import * as api from "@/lib/api";
import type { CatalogModel, ModelCatalog } from "@/lib/api";
import type { AccountMeta } from "@/lib/types";

const LEGACY_GROUPS: Record<string, string[]> = {
  Pro: ["Gpt52", "Gemini3ProPreview"],
  Max: ["ClaudeOpus46MaxMode", "ClaudeSonnet46MaxMode", "Gpt52MaxMode", "Gemini3ProMaxMode"],
  Ultra: ["Gpt52Codex", "ClaudeOpus46", "Gemini31ProPreview", "Gemini31FlashLitePreview", "ClaudeSonnet46", "Gpt52Xhigh"],
  Lite: ["Gpt52Medium", "ClaudeHaiku45", "Gemini3FlashPreview", "HunyuanT1", "HunyuanTurbosLatest", "DeepseekV31Terminus", "DeepseekV32", "KimiK25"],
  Free: ["Default", "Auto", "ClaudeSonnet45", "Gpt5Mini", "Gpt5Nano", "Gpt41"],
};

const CONTEXT_LABELS: Record<number, string> = { 64000: "64K", 200000: "200K", 272000: "272K", 400000: "400K", 500000: "500K", 1000000: "1M" };

/** 积分 ↔ 人民币换算基准（与后端 /v1/models/pricing 口径一致）。 */
const CREDITS_PER_YUAN = 400;

const TEST_ACCOUNT_KEY = "wb_models_test_account";

function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** 模型的 Max 模式档位：max_mode 为数字时即档位；为 true 时取上下文档位的最大值。 */
function maxModeTier(m: CatalogModel): number | null {
  const direct = num(m.max_mode);
  if (direct) return direct;
  const raw = (m.raw ?? {}) as Record<string, unknown>;
  const tiers = [raw.ContextLengths, raw.contextLengths, m.raw?.context_lengths]
    .flatMap((v) => (Array.isArray(v) ? v : []))
    .map(num)
    .filter((v): v is number => v != null);
  const truthy =
    m.max_mode === true || raw.MaxMode === true || (typeof raw.MaxMode === "number" && raw.MaxMode > 0);
  if (!truthy) return null;
  return tiers.length ? Math.max(...tiers) : null;
}

function classifyContextLengths(raw: CatalogModel["raw"]): { standard: number[]; max: number[] } {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const out: { standard: number[]; max: number[] } = { standard: [], max: [] };
  const add = (key: string, bucket: number[]) => {
    const v = obj[key];
    if (Array.isArray(v)) bucket.push(...v.map(num).filter((n): n is number => n != null));
    else {
      const n = num(v);
      if (n) bucket.push(n);
    }
  };
  add("ContextLengths", out.standard);
  add("contextLengths", out.standard);
  add("context_lengths", out.standard);
  add("MaxModeContextLengths", out.max);
  return { standard: [...new Set(out.standard)].sort((a, b) => a - b), max: [...new Set(out.max)].sort((a, b) => a - b) };
}

function fmtCtx(n: number): string {
  return CONTEXT_LABELS[n] ?? `${Math.round(n / 1000)}K`;
}

/** 单价来源：实测优先，其次手动填写；返回每 1M tokens 的积分与人民币价。 */
function priceOf(m: CatalogModel): { credits1m: number | null; rmb1m: number | null; measured: boolean } {
  const credits1m = m.measured?.credits_per_1m ?? m.price_credits ?? null;
  const rmb1m = m.measured?.rmb_per_1m ?? m.price_rmb ?? (credits1m != null ? credits1m / CREDITS_PER_YUAN : null);
  return { credits1m, rmb1m, measured: m.measured?.credits_per_1m != null };
}

type ProbeState =
  | { state: "running" }
  | { state: "ok"; latency: number; creditsPer1m?: number; rmbPer1m?: number; note?: string }
  | { state: "fail"; error: string; latency?: number; status?: number };

interface EditForm {
  id: string;
  name: string;
  context_length: string;
  thinking_levels: string;
  default_effort: string;
  max_mode: "" | "on" | "off";
  credits_multiplier: string;
  price_credits: string;
  price_rmb: string;
}

function formFromModel(m: CatalogModel | null): EditForm {
  return {
    id: m?.id ?? "",
    name: m?.name ?? "",
    context_length: m?.context_length != null ? String(m.context_length) : "",
    thinking_levels: (m?.thinking_levels ?? []).map(String).join(", "),
    default_effort: m?.default_effort ?? "",
    max_mode: m?.max_mode == null ? "" : m.max_mode === false ? "off" : "on",
    credits_multiplier: m?.credits_multiplier != null ? String(m.credits_multiplier) : "",
    price_credits: m?.price_credits != null ? String(m.price_credits) : "",
    price_rmb: m?.price_rmb != null ? String(m.price_rmb) : "",
  };
}

export default function ModelsPage() {
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState<"server" | "cache" | null>(null);
  const [filter, setFilter] = useState("");
  const [autoUpdate, setAutoUpdate] = useState(false);
  const [intervalHours, setIntervalHours] = useState("24");
  const [savingCfg, setSavingCfg] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  const [accounts, setAccounts] = useState<AccountMeta[]>([]);
  const [testAccountId, setTestAccountId] = useState(() => localStorage.getItem(TEST_ACCOUNT_KEY) ?? "");
  const [probes, setProbes] = useState<Record<string, ProbeState>>({});
  const [probingAll, setProbingAll] = useState(false);

  const [editTarget, setEditTarget] = useState<CatalogModel | null | "new">(null);
  const [editForm, setEditForm] = useState<EditForm>(formFromModel(null));
  const [savingEdit, setSavingEdit] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<CatalogModel | null>(null);

  const [convModelId, setConvModelId] = useState("");
  const [convKind, setConvKind] = useState<"rmb" | "credits" | "tokens">("rmb");
  const [convValue, setConvValue] = useState("10");

  const reload = useCallback(async () => {
    try {
      const data = await api.getModelCatalog();
      setCatalog(data);
      setAutoUpdate(data.auto_update);
      setIntervalHours(String(data.update_interval_hours));
    } catch (e) {
      toast.error("加载模型目录失败", { description: api.asError(e) });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
    api.getAccounts().then((res) => setAccounts(res.accounts)).catch(() => undefined);
  }, [reload]);

  const doRefresh = async (source: "server" | "cache") => {
    setRefreshing(source);
    try {
      const res = source === "server" ? await api.refreshModelCatalog() : await api.refreshModelCatalogClientCache();
      if (res.ok && res.catalog) {
        setCatalog(res.catalog);
        toast.success(`模型列表已更新（${res.count} 个模型）`, { description: res.source });
      } else {
        toast.error("更新失败", { description: res.error });
      }
    } catch (e) {
      toast.error("更新失败", { description: api.asError(e) });
    } finally {
      setRefreshing(null);
    }
  };

  const saveConfig = async () => {
    setSavingCfg(true);
    try {
      await api.saveModelCatalogConfig({ auto_update: autoUpdate, update_interval_hours: Number(intervalHours) || 24 });
      toast.success("自动更新设置已保存");
    } catch (e) {
      toast.error("保存失败", { description: api.asError(e) });
    } finally {
      setSavingCfg(false);
    }
  };

  // --- 检测与实测 -------------------------------------------------------------

  const pickTestAccount = (id: string) => {
    setTestAccountId(id);
    localStorage.setItem(TEST_ACCOUNT_KEY, id);
  };

  const models = catalog?.models ?? [];
  const filtered = models.filter(
    (m) => !filter || m.id.toLowerCase().includes(filter.toLowerCase()) || (m.name ?? "").toLowerCase().includes(filter.toLowerCase()),
  );

  const probeOne = useCallback(
    async (modelId: string): Promise<boolean> => {
      if (!testAccountId) {
        toast.error("请先选择测试账号", { description: "检测会真实调用模型，消耗所选账号的少量积分" });
        return false;
      }
      setProbes((s) => ({ ...s, [modelId]: { state: "running" } }));
      try {
        const r = await api.probeModelCatalogEntry(testAccountId, modelId);
        if (r.ok) {
          setProbes((s) => ({
            ...s,
            [modelId]: { state: "ok", latency: r.latency_ms ?? 0, creditsPer1m: r.credits_per_1m, rmbPer1m: r.rmb_per_1m, note: r.note },
          }));
          return true;
        }
        setProbes((s) => ({ ...s, [modelId]: { state: "fail", error: r.error ?? "未知错误", latency: r.latency_ms, status: r.status } }));
        return false;
      } catch (e) {
        setProbes((s) => ({ ...s, [modelId]: { state: "fail", error: api.asError(e) } }));
        return false;
      }
    },
    [testAccountId],
  );

  const probeAll = async () => {
    if (!testAccountId) {
      toast.error("请先选择测试账号", { description: "批量检测会逐个真实调用模型，消耗所选账号积分" });
      return;
    }
    setProbingAll(true);
    let okCount = 0;
    try {
      for (const m of filtered) {
        if (await probeOne(m.id)) okCount += 1;
      }
      toast.success(`检测完成：${okCount}/${filtered.length} 可用`, { description: "计费的模型已把实测单价写回价格表" });
    } finally {
      setProbingAll(false);
      await reload();
    }
  };

  // --- 编辑 / 删除 ---------------------------------------------------------------

  const openEdit = (m: CatalogModel | null) => {
    setEditTarget(m ?? "new");
    setEditForm(formFromModel(m));
  };

  const parseNumField = (s: string): number | null | undefined => {
    const t = s.trim();
    if (t === "") return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : undefined;
  };

  const saveEdit = async () => {
    const f = editForm;
    if (!f.id.trim()) {
      toast.error("请填写模型 ID");
      return;
    }
    for (const [label, v] of [
      ["上下文", parseNumField(f.context_length)],
      ["积分倍率", parseNumField(f.credits_multiplier)],
      ["积分单价", parseNumField(f.price_credits)],
      ["人民币单价", parseNumField(f.price_rmb)],
    ] as const) {
      if (v === undefined) {
        toast.error(`${label}不是有效数字`);
        return;
      }
    }
    setSavingEdit(true);
    try {
      const levels = f.thinking_levels.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
      const res = await api.upsertModelCatalogEntry({
        id: f.id.trim(),
        name: f.name.trim() || null,
        context_length: parseNumField(f.context_length) ?? null,
        thinking_levels: levels.length ? levels : null,
        default_effort: f.default_effort.trim() || null,
        max_mode: f.max_mode === "" ? null : f.max_mode === "on",
        credits_multiplier: parseNumField(f.credits_multiplier) ?? null,
        price_credits: parseNumField(f.price_credits) ?? null,
        price_rmb: parseNumField(f.price_rmb) ?? null,
      });
      if (res.ok && res.catalog) {
        setCatalog(res.catalog);
        setEditTarget(null);
        toast.success(editTarget === "new" ? "模型已添加" : "模型已保存");
      } else {
        toast.error("保存失败", { description: res.error });
      }
    } catch (e) {
      toast.error("保存失败", { description: api.asError(e) });
    } finally {
      setSavingEdit(false);
    }
  };

  const doDelete = async () => {
    if (!deleteTarget) return;
    try {
      const res = await api.removeModelCatalogEntry(deleteTarget.id);
      if (res.ok && res.catalog) {
        setCatalog(res.catalog);
        toast.success(`已删除 ${deleteTarget.id}`);
      } else {
        toast.error("删除失败", { description: res.error });
      }
    } catch (e) {
      toast.error("删除失败", { description: api.asError(e) });
    } finally {
      setDeleteTarget(null);
    }
  };

  // --- 换算器 ---------------------------------------------------------------

  const convModel = useMemo(() => models.find((m) => m.id === convModelId) ?? null, [models, convModelId]);
  const convPrice = convModel ? priceOf(convModel) : null;

  const conversion = useMemo(() => {
    if (!convPrice || convPrice.credits1m == null || convPrice.rmb1m == null) return null;
    const v = Number(convValue);
    if (!Number.isFinite(v) || v < 0) return null;
    const { credits1m } = convPrice;
    if (convKind === "rmb") {
      const credits = v * CREDITS_PER_YUAN;
      return { rmb: v, credits, tokens: credits1m > 0 ? (credits / credits1m) * 1_000_000 : null };
    }
    if (convKind === "credits") {
      return { rmb: v / CREDITS_PER_YUAN, credits: v, tokens: credits1m > 0 ? (v / credits1m) * 1_000_000 : null };
    }
    const credits = (v / 1_000_000) * credits1m;
    return { rmb: credits / CREDITS_PER_YUAN, credits, tokens: v };
  }, [convPrice, convKind, convValue]);

  const fmtTokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(Math.round(n)));

  if (loading) {
    return (
      <div className="flex h-40 items-center justify-center text-muted-foreground">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" /> 加载中…
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold">模型管理</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {catalog ? `共 ${models.length} 个模型 · 更新于 ${catalog.updated_at ? new Date(catalog.updated_at).toLocaleString("zh-CN") : "—"}` : "暂无模型数据"}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" onClick={() => openEdit(null)}>
            <Plus className="mr-2 h-4 w-4" /> 新增模型
          </Button>
          <Button variant="outline" onClick={() => doRefresh("server")} disabled={refreshing !== null}>
            {refreshing === "server" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
            从服务器拉取
          </Button>
          <Button variant="outline" onClick={() => doRefresh("cache")} disabled={refreshing !== null}>
            {refreshing === "cache" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Database className="mr-2 h-4 w-4" />}
            读客户端配置缓存
          </Button>
        </div>
      </div>

      <Card>
        <CardContent className="flex flex-wrap items-center gap-4 py-4">
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={autoUpdate} onCheckedChange={setAutoUpdate} /> 自动更新
          </label>
          <label className="flex items-center gap-2 text-sm">
            更新间隔
            <Input className="w-20" value={intervalHours} onChange={(e) => setIntervalHours(e.target.value)} />
            小时
          </label>
          <Button size="sm" onClick={saveConfig} disabled={savingCfg}>
            {savingCfg ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}保存设置
          </Button>
          <span className="text-xs text-muted-foreground">自动更新按来源记录各自周期（缓存扫描默认 6 小时）</span>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex flex-wrap items-center gap-3 py-4">
          <FlaskConical className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium">可用性检测与价格实测</span>
          <Select value={testAccountId} onValueChange={pickTestAccount}>
            <SelectTrigger className="w-64">
              <SelectValue placeholder="选择测试账号（消耗其积分）" />
            </SelectTrigger>
            <SelectContent>
              {accounts.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {displayName(a)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button size="sm" variant="outline" onClick={probeAll} disabled={probingAll || !testAccountId}>
            {probingAll ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            检测全部（逐个真实调用）
          </Button>
          <span className="text-xs text-muted-foreground">每个模型发一条 1-token 请求；计费模型的实测单价（每 1M tokens）自动写回价格表</span>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex flex-wrap items-center gap-3 py-4">
          <Calculator className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium">费用换算器</span>
          <Select value={convModelId} onValueChange={setConvModelId}>
            <SelectTrigger className="w-56">
              <SelectValue placeholder="选择模型" />
            </SelectTrigger>
            <SelectContent>
              {models.map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  {m.name ?? m.id}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={convKind} onValueChange={(v) => setConvKind(v as typeof convKind)}>
            <SelectTrigger className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="rmb">人民币 ¥</SelectItem>
              <SelectItem value="credits">积分</SelectItem>
              <SelectItem value="tokens">Tokens</SelectItem>
            </SelectContent>
          </Select>
          <Input className="w-32" value={convValue} onChange={(e) => setConvValue(e.target.value)} />
          {convModel && !conversion && (
            <span className="text-xs text-muted-foreground">该模型暂无单价，请先实测或在编辑中填写</span>
          )}
          {conversion && (
            <span className="text-sm">
              = <b>¥{conversion.rmb.toFixed(2)}</b> · <b>{conversion.credits.toLocaleString(undefined, { maximumFractionDigits: 1 })}</b> 积分
              {conversion.tokens != null && (
                <>
                  {" "}· 约 <b>{fmtTokens(conversion.tokens)}</b> tokens
                </>
              )}
            </span>
          )}
        </CardContent>
      </Card>

      <div className="flex items-center gap-3">
        <Input placeholder="搜索模型…" className="max-w-xs" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <span className="text-sm text-muted-foreground">{filtered.length} 个模型</span>
      </div>

      <Card>
        <div className="max-h-[60vh] overflow-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-card">
              <tr className="border-b text-left text-muted-foreground">
                <th className="px-4 py-2 font-medium">模型</th>
                <th className="px-4 py-2 font-medium">上下文</th>
                <th className="px-4 py-2 font-medium">思考强度</th>
                <th className="px-4 py-2 font-medium">Max</th>
                <th className="px-4 py-2 font-medium">倍率</th>
                <th className="px-4 py-2 font-medium">单价（每 1M tokens）</th>
                <th className="px-4 py-2 font-medium">检测</th>
                <th className="px-4 py-2 font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((m) => {
                const tiers = (m.thinking_levels ?? []).map(String).filter(Boolean);
                const ctxStd = m.context_length ?? null;
                const maxTier = maxModeTier(m);
                const price = priceOf(m);
                const probe = probes[m.id];
                const isOpen = expanded === m.id;
                return [
                  <tr key={m.id} className="border-b last:border-0">
                    <td className="px-4 py-2">
                      <div className="flex items-center gap-2">
                        <div>
                          <div className="font-medium">{m.name ?? m.id}</div>
                          {m.name && <div className="text-xs text-muted-foreground">{m.id}</div>}
                        </div>
                        {LEGACY_GROUPS[m.id] && <Badge variant="outline">套餐组</Badge>}
                      </div>
                    </td>
                    <td className="px-4 py-2 tabular-nums">{ctxStd ? fmtCtx(ctxStd) : "—"}</td>
                    <td className="px-4 py-2">
                      {tiers.length ? (
                        <button
                          type="button"
                          className="cursor-pointer text-left"
                          onClick={() => setExpanded(isOpen ? null : m.id)}
                          title="点击展开档位数"
                        >
                          {tiers.join(" / ")}
                          {m.default_effort && (
                            <span className="text-muted-foreground">（默认 {m.default_effort}）</span>
                          )}
                        </button>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-4 py-2">{maxTier ? <Badge variant="secondary">支持 · {fmtCtx(maxTier)}</Badge> : <span className="text-muted-foreground">—</span>}</td>
                    <td className="px-4 py-2 tabular-nums">{m.credits_multiplier != null ? `x${m.credits_multiplier}` : "—"}</td>
                    <td className="px-4 py-2 tabular-nums">
                      {price.rmb1m != null ? (
                        <span title={price.measured && m.measured ? `实测于 ${m.measured.at ? new Date(m.measured.at).toLocaleString("zh-CN") : "—"}${m.measured.by ? ` · 账号 ${m.measured.by}` : ""}` : "手动填写"}>
                          ¥{price.rmb1m.toFixed(2)}
                          {price.credits1m != null && <span className="text-xs text-muted-foreground">（{price.credits1m.toLocaleString()} 积分）</span>}
                          {price.measured && <Badge variant="outline" className="ml-1">实测</Badge>}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-4 py-2">
                      {probe?.state === "running" && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
                      {probe?.state === "ok" && (
                        <span className="text-xs text-emerald-600 dark:text-emerald-400" title={probe.note ?? ""}>
                          可用 · {probe.latency}ms
                          {probe.creditsPer1m != null && ` · 实测 ¥${(probe.rmbPer1m ?? 0).toFixed(2)}`}
                        </span>
                      )}
                      {probe?.state === "fail" && (
                        <span className="text-xs text-red-500" title={probe.error}>
                          不可用{probe.status != null && probe.status > 0 ? ` (${probe.status})` : ""}
                        </span>
                      )}
                      {!probe && (
                        <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => probeOne(m.id)} disabled={!testAccountId || probingAll}>
                          检测
                        </Button>
                      )}
                      {probe && probe.state !== "running" && (
                        <Button size="sm" variant="ghost" className="ml-1 h-7 px-2 text-xs" onClick={() => probeOne(m.id)} disabled={!testAccountId || probingAll}>
                          重测
                        </Button>
                      )}
                    </td>
                    <td className="px-4 py-2">
                      <div className="flex gap-1">
                        <Button size="sm" variant="ghost" className="h-7 w-7 p-0" title="编辑" onClick={() => openEdit(m)}>
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-destructive" title="删除" onClick={() => setDeleteTarget(m)}>
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </td>
                  </tr>,
                  isOpen && (
                    <tr key={`${m.id}-detail`} className="border-b bg-muted/30">
                      <td colSpan={8} className="px-4 py-3 text-xs">
                        <ContextDetail model={m} />
                      </td>
                    </tr>
                  ),
                ];
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <Dialog open={editTarget !== null} onOpenChange={(open) => !open && setEditTarget(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{editTarget === "new" ? "新增模型" : `编辑模型 ${editTarget?.id ?? ""}`}</DialogTitle>
            <DialogDescription>留空的字段会被清除；单价为每 1M tokens 的费用（实测优先于手动填写）</DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-3 text-sm">
            <label className="space-y-1">
              <span className="text-xs text-muted-foreground">模型 ID *</span>
              <Input value={editForm.id} disabled={editTarget !== "new"} onChange={(e) => setEditForm({ ...editForm, id: e.target.value })} />
            </label>
            <label className="space-y-1">
              <span className="text-xs text-muted-foreground">显示名称</span>
              <Input value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} />
            </label>
            <label className="space-y-1">
              <span className="text-xs text-muted-foreground">上下文（tokens）</span>
              <Input value={editForm.context_length} onChange={(e) => setEditForm({ ...editForm, context_length: e.target.value })} placeholder="200000" />
            </label>
            <label className="space-y-1">
              <span className="text-xs text-muted-foreground">积分倍率</span>
              <Input value={editForm.credits_multiplier} onChange={(e) => setEditForm({ ...editForm, credits_multiplier: e.target.value })} placeholder="1.2" />
            </label>
            <label className="col-span-2 space-y-1">
              <span className="text-xs text-muted-foreground">思考强度档位（逗号分隔）</span>
              <Input value={editForm.thinking_levels} onChange={(e) => setEditForm({ ...editForm, thinking_levels: e.target.value })} placeholder="low, medium, high, xhigh, max" />
            </label>
            <label className="space-y-1">
              <span className="text-xs text-muted-foreground">默认思考强度</span>
              <Input value={editForm.default_effort} onChange={(e) => setEditForm({ ...editForm, default_effort: e.target.value })} placeholder="medium" />
            </label>
            <label className="space-y-1">
              <span className="text-xs text-muted-foreground">Max 模式</span>
              <Select value={editForm.max_mode} onValueChange={(v) => setEditForm({ ...editForm, max_mode: v as EditForm["max_mode"] })}>
                <SelectTrigger>
                  <SelectValue placeholder="未设置" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">未设置</SelectItem>
                  <SelectItem value="on">支持</SelectItem>
                  <SelectItem value="off">不支持</SelectItem>
                </SelectContent>
              </Select>
            </label>
            <label className="space-y-1">
              <span className="text-xs text-muted-foreground">积分单价（/1M tokens）</span>
              <Input value={editForm.price_credits} onChange={(e) => setEditForm({ ...editForm, price_credits: e.target.value })} placeholder="4800" />
            </label>
            <label className="space-y-1">
              <span className="text-xs text-muted-foreground">人民币单价（/1M tokens）</span>
              <Input value={editForm.price_rmb} onChange={(e) => setEditForm({ ...editForm, price_rmb: e.target.value })} placeholder="12" />
            </label>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditTarget(null)}>
              取消
            </Button>
            <Button onClick={saveEdit} disabled={savingEdit}>
              {savingEdit ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteTarget !== null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除模型</DialogTitle>
            <DialogDescription>
              确定从目录中删除「{deleteTarget?.name ?? deleteTarget?.id}」？删除后代理不再下发该模型。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>
              取消
            </Button>
            <Button variant="destructive" onClick={doDelete}>
              删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ContextDetail({ model }: { model: CatalogModel }) {
  const { standard, max } = classifyContextLengths(model.raw);
  const tiers = (model.thinking_levels ?? []).map(String).filter(Boolean);
  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <span className="w-24 shrink-0 text-muted-foreground">思考强度档位</span>
        <span>{tiers.length ? `${tiers.length} 档：${tiers.join(" / ")}` : "不支持"}</span>
      </div>
      <div className="flex gap-2">
        <span className="w-24 shrink-0 text-muted-foreground">上下文档位</span>
        <span>{standard.length ? standard.map(fmtCtx).join(" / ") : "未知"}</span>
      </div>
      <div className="flex gap-2">
        <span className="w-24 shrink-0 text-muted-foreground">Max 模式档位</span>
        <span>{max.length ? max.map(fmtCtx).join(" / ") : "不支持"}</span>
      </div>
      {model.measured && (
        <div className="flex gap-2">
          <span className="w-24 shrink-0 text-muted-foreground">实测记录</span>
          <span>
            {model.measured.credits_per_1m != null && `${model.measured.credits_per_1m.toLocaleString()} 积分/1M（¥${(model.measured.rmb_per_1m ?? 0).toFixed(2)}）`}
            {model.measured.by && ` · 账号 ${model.measured.by}`}
            {model.measured.at && ` · ${new Date(model.measured.at).toLocaleString("zh-CN")}`}
          </span>
        </div>
      )}
      {model.raw && Object.keys(model.raw).length > 0 && (
        <details className="text-muted-foreground">
          <summary className="cursor-pointer">查看原始字段（{Object.keys(model.raw).length} 个）</summary>
          <pre className="mt-1 max-h-48 overflow-auto rounded bg-muted p-2 text-[11px]">{JSON.stringify(model.raw, null, 2)}</pre>
        </details>
      )}
    </div>
  );
}
