import { BrowserRouter, Navigate, NavLink, Outlet, Route, Routes } from "react-router-dom";
import { ChartColumn, Network, Settings, User } from "lucide-react";

import { cn } from "@/lib/utils";
import * as api from "@/lib/api";
import AccountsPage from "@/pages/AccountsPage";
import UsageStatsPage from "@/pages/UsageStatsPage";
import ApiProxyPage from "@/pages/ApiProxyPage";
import SettingsPage from "@/pages/SettingsPage";
import { AppIconMark } from "@/components/product-marks";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useCreditAutoRefresh } from "@/lib/use-credit-auto-refresh";
import { useWorkbuddyStatusRefresh } from "@/lib/use-workbuddy-status-refresh";

function Layout() {
  const hasUnifiedTitleBar =
    api.isDesktop() && typeof navigator !== "undefined" && navigator.userAgent.includes("Macintosh");
  useCreditAutoRefresh();
  useWorkbuddyStatusRefresh();

  return (
    <div className="flex h-screen min-h-0 overflow-hidden bg-background">
      {hasUnifiedTitleBar ? (
        <div
          data-tauri-drag-region
          className="fixed inset-x-0 top-0 z-50 h-8"
          aria-hidden="true"
        />
      ) : null}
      <aside
        className={cn(
          "flex min-h-0 w-[220px] shrink-0 flex-col border-r border-sidebar-border bg-sidebar px-3 pb-4",
          hasUnifiedTitleBar ? "pt-20" : "pt-4",
        )}
      >
        <div className="flex items-center gap-2.5 px-1 pb-5">
          <AppIconMark size={36} className="drop-shadow-sm" />
          <div className="min-w-0">
            <div
              className="truncate text-[15px] leading-5 tracking-[-0.02em] text-sidebar-foreground/90"
              style={{
                fontFamily: '"Bricolage Grotesque Variable", "SF Pro Display", ui-sans-serif, sans-serif',
                fontWeight: 640,
              }}
            >
              CodeBuddy
            </div>
          </div>
        </div>
        <nav className="flex min-h-0 flex-1 flex-col gap-0.5" aria-label="主导航">
          <NavLink
            to="/"
            end
            className={({ isActive }) =>
              cn(
                "flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-sidebar-ring/50",
                isActive
                  ? "bg-foreground/[0.06] font-medium text-foreground"
                  : "text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground",
              )
            }
          >
            <User className="size-4" />
            账号管理
          </NavLink>
          <NavLink
            to="/usage-stats"
            className={({ isActive }) =>
              cn(
                "flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-sidebar-ring/50",
                isActive
                  ? "bg-foreground/[0.06] font-medium text-foreground"
                  : "text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground",
              )
            }
          >
            <ChartColumn className="size-4" />
            用量统计
          </NavLink>
          <NavLink
            to="/api-proxy"
            className={({ isActive }) =>
              cn(
                "flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-sidebar-ring/50",
                isActive
                  ? "bg-foreground/[0.06] font-medium text-foreground"
                  : "text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground",
              )
            }
          >
            <Network className="size-4" />
            API 代理
          </NavLink>
          <NavLink
            to="/settings"
            className={({ isActive }) =>
              cn(
                "flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-sidebar-ring/50",
                isActive
                  ? "bg-foreground/[0.06] font-medium text-foreground"
                  : "text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground",
              )
            }
          >
            <Settings className="size-4" />
            设置
          </NavLink>
        </nav>
      </aside>
      <main
        className={cn(
          "min-w-0 flex-1 overflow-y-auto bg-background overscroll-contain",
          hasUnifiedTitleBar && "pt-16 [&>div]:pt-4",
        )}
      >
        <Outlet />
      </main>
    </div>
  );
}

export default function App() {
  return (
    <TooltipProvider delayDuration={250}>
      <BrowserRouter>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/" element={<AccountsPage />} />
            <Route path="/usage-stats" element={<UsageStatsPage />} />
            <Route path="/credit-stats" element={<Navigate to="/usage-stats" replace />} />
            <Route path="/token-stats" element={<Navigate to="/usage-stats" replace />} />
            <Route path="/api-proxy" element={<ApiProxyPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
        <Toaster />
      </BrowserRouter>
    </TooltipProvider>
  );
}
