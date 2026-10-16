import { useCallback, useEffect, useState } from "react";
import { Database, Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import * as api from "@/lib/api";
import type { CatalogModel, ModelCatalog } from "@/lib/api";

function formatCtx(ctx?: number): string {
  if (!ctx) return "—";
  if (ctx >= 1_000_000) return `${(ctx / 1_000_000).toFixed(1)}M`;
  if (ctx >= 1000) return `${Math.round(ctx / 1000)}K`;
  return String(ctx);
}

function formatThinking(model: CatalogModel): string {
  const levels = model.thinking_levels;
  if (Array.isArray(levels) && levels.length > 0) {
    const s = levels.map((l) => String(l)).join(" / ");
    return model.default_effort ? `${s}（默认 ${model.default_effort}）` : s;
  }
  if (model.only_reasoning) return "仅思考模式";
  return "—";
}

function formatMaxMode(v?: unknown): string {
  if (v === undefined || v === null) return "—";
  if (typeof v === "boolean") return v ? "支持" : "不支持";
  if (typeof v === "number") return formatCtx(v);
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (o.enabled === false) return "不支持";
    const bits: string[] = ["支持"];
    if (typeof o.maxTokens === "number") bits.push(formatCtx(o.maxTokens));
    if (typeof o.max_tokens === "number") bits.push(formatCtx(o.max_tokens));
    return bits.join(" ");
  }
  return String(v);
}

function ModelRow({ model }: { model: CatalogModel }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <tr className="border-b border-border/50 last:border-0">
        <td className="px-4 py-2.5 font-mono text-xs">{model.id}</td>
        <td className="px-4 py-2.5 text-xs">{model.name || "—"}</td>
        <td className="px-4 py-2.5 text-xs tabular-nums">{formatCtx(model.context_length)}</td>
        <td className="px-4 py-2.5 text-xs">{formatThinking(model)}</td>
        <td className="px-4 py-2.5 text-xs tabular-nums">{formatMaxMode(model.max_mode)}</td>
        <td className="px-4 py-2.5 text-xs tabular-nums">
          {model.credits_multiplier != null ? `x${model.credits_multiplier}` : "—"}
        </td>
        <td className="px-4 py-2.5">
          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setOpen(!open)}>
            {open ? "收起" : "原文"}
          </Button>
        </td>
      </tr>
      {open ? (
        <tr className="border-b border-border/50 last:border-0">
          <td colSpan={7} className="bg-muted/30 px-4 py-2.5">
            <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-all text-[11px] leading-5 text-muted-foreground">
              {JSON.stringify(model.raw ?? model, null, 2)}
            </pre>
          </td>
        </tr>
      ) : null}
    </>
  );
}

export default function ModelsPage() {
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [savingCfg, setSavingCfg] = useState(false);
  const [filter, setFilter] = useState("");

  const load = useCallback(async () => {
    try {
      setCatalog(await api.getModelCatalog());
    } catch (e) {
      toast.error("加载模型目录失败", { description: api.asError(e) });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function refresh(source: "api" | "cache") {
    setRefreshing(true);
    try {
      const res =
        source === "cache"
          ? await api.refreshModelCatalogClientCache()
          : await api.refreshModelCatalog();
      if (res.ok) {
        toast.success(`模型列表已更新（${res.count} 个模型）`, { description: res.source });
        if (res.catalog) setCatalog(res.catalog);
        else void load();
      } else {
        toast.error("更新失败", { description: res.error });
      }
    } catch (e) {
      toast.error("更新失败", { description: api.asError(e) });
    } finally {
      setRefreshing(false);
    }
  }

  async function saveAuto(autoUpdate: boolean, hours: number) {
    setSavingCfg(true);
    try {
      const next = await api.saveModelCatalogConfig({
        auto_update: autoUpdate,
        update_interval_hours: hours,
      });
      setCatalog(next);
      toast.success("自动更新设置已保存");
    } catch (e) {
      toast.error("保存失败", { description: api.asError(e) });
    } finally {
      setSavingCfg(false);
    }
  }

  const models = (catalog?.models ?? []).filter((m) => {
    const q = filter.trim().toLowerCase();
    if (!q) return true;
    return m.id.toLowerCase().includes(q) || (m.name ?? "").toLowerCase().includes(q);
  });

  return (
    <div className="mx-auto min-w-0 w-full max-w-4xl px-4 py-6 sm:px-6 sm:py-8">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">模型管理</h1>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            从 CodeBuddy CN API 拉取全部模型列表与参数（思考强度 / max 模式），API 代理的
            <code className="mx-1">/v1/models</code>
            即刻使用最新目录；目录为空时回退内置列表。
          </p>
        </div>
        <div className="flex gap-2">
          <Button onClick={() => void refresh("api")} disabled={refreshing}>
            {refreshing ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            从 API 更新
          </Button>
          <Button variant="outline" onClick={() => void refresh("cache")} disabled={refreshing}>
            {refreshing ? <Loader2 className="animate-spin" /> : <Database />}
            读客户端配置缓存
          </Button>
        </div>
      </header>

      <Card className="mb-6">
        <CardContent className="flex flex-wrap items-center gap-x-6 gap-y-3 p-4 sm:px-5">
          <label className="flex items-center gap-2 text-sm">
            <Switch
              checked={catalog?.auto_update ?? false}
              disabled={!catalog || savingCfg}
              onCheckedChange={(v) => void saveAuto(v, catalog?.update_interval_hours ?? 24)}
            />
            后台自动更新
          </label>
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            间隔
            <Input
              type="number"
              min={1}
              max={720}
              className="h-8 w-20 text-xs"
              disabled={!catalog || savingCfg}
              value={catalog?.update_interval_hours ?? 24}
              onChange={(e) => {
                const hours = Math.max(1, Number(e.target.value) || 1);
                setCatalog((c) => (c ? { ...c, update_interval_hours: hours } : c));
              }}
              onBlur={() => {
                if (catalog) void saveAuto(catalog.auto_update, catalog.update_interval_hours);
              }}
            />
            小时
          </label>
          <span className="text-xs text-muted-foreground">
            {catalog?.updated_at
              ? `上次更新：${new Date(catalog.updated_at).toLocaleString()}${catalog.source ? ` · 来源 ${catalog.source}` : ""}`
              : "尚未从远端拉取过（当前使用内置列表）"}
          </span>
        </CardContent>
      </Card>

      <div className="mb-3 flex items-center gap-3">
        <Input
          placeholder="搜索模型 id / 名称…"
          className="h-9 max-w-xs text-sm"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <Badge variant="secondary" className="tabular-nums">{models.length}</Badge>
      </div>

      <Card>
        <CardContent className="p-0">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="px-4 py-2.5 font-medium">模型 ID</th>
                <th className="px-4 py-2.5 font-medium">名称</th>
                <th className="px-4 py-2.5 font-medium">上下文</th>
                <th className="px-4 py-2.5 font-medium">思考强度</th>
                <th className="px-4 py-2.5 font-medium">Max 模式</th>
                <th className="px-4 py-2.5 font-medium">积分倍率</th>
                <th className="px-4 py-2.5 font-medium">原始参数</th>
              </tr>
            </thead>
            <tbody>
              {models.map((m) => (
                <ModelRow key={m.id} model={m} />
              ))}
              {models.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-10 text-center text-sm text-muted-foreground">
                    {catalog?.models.length ? "没有匹配的模型" : "目录为空，点击「立即更新」从 CodeBuddy CN 拉取"}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
