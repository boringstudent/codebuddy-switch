import { useState } from "react";

import { cn } from "@/lib/utils";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import CreditStatsPage from "@/pages/CreditStatsPage";
import TokenStatsPage from "@/pages/TokenStatsPage";

type StatsTab = "credits" | "tokens";

/**
 * 用量统计：积分统计与 Token 统计合并为一个页面，Tab 切换。
 * 首次切到的 Tab 才挂载，之后保持常驻（避免来回切换时重复取数）。
 */
export default function UsageStatsPage() {
  const [tab, setTab] = useState<StatsTab>("credits");
  const [visited, setVisited] = useState<Set<StatsTab>>(() => new Set(["credits"]));

  const switchTab = (value: string) => {
    const next = value as StatsTab;
    setTab(next);
    setVisited((prev) => (prev.has(next) ? prev : new Set(prev).add(next)));
  };

  return (
    <div className="mx-auto w-full max-w-[1180px] min-w-0 px-4 py-6 sm:px-8 sm:py-9">
      <header className="mb-8 flex min-w-0 flex-wrap items-center justify-between gap-4">
        <h1 className="text-[28px] font-semibold tracking-tight">用量统计</h1>
        <Tabs value={tab} onValueChange={switchTab}>
          <TabsList aria-label="统计类型">
            <TabsTrigger value="credits">积分统计</TabsTrigger>
            <TabsTrigger value="tokens">Token 统计</TabsTrigger>
          </TabsList>
        </Tabs>
      </header>

      {visited.has("credits") && (
        <div className={cn(tab !== "credits" && "hidden")}>
          <CreditStatsPage embedded />
        </div>
      )}
      {visited.has("tokens") && (
        <div className={cn(tab !== "tokens" && "hidden")}>
          <TokenStatsPage embedded />
        </div>
      )}
    </div>
  );
}
