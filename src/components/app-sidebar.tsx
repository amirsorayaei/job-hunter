"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useQuery } from "convex/react";
import { Briefcase, CalendarClock, LayoutDashboard, ListTodo, Settings } from "lucide-react";
import { cn } from "@/lib/utils";
import { api } from "../../convex/_generated/api";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar";

/** Four places, nothing else: the dashboard, the roles list, the agents' schedule, settings. */
const NAV = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/roles", label: "Roles", icon: ListTodo, badge: true },
  { href: "/schedule", label: "Schedule", icon: CalendarClock },
  { href: "/settings", label: "Settings", icon: Settings },
] as const;

export function AppSidebar() {
  const pathname = usePathname();
  const roles = useQuery(api.roles.list, {});
  const newCount = roles?.filter((role) => role.stage === "new").length;
  const settings = useQuery(api.settings.get, {});
  const gmail = useQuery(api.gmail.queries.connection, {});
  const gmailOk = gmail?.account !== null && gmail?.account !== undefined && gmail.account.status === "active" && gmail.account.canDraft;

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="px-3 py-4">
        <Link href="/" className="flex items-center gap-2 overflow-hidden">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <Briefcase className="size-4" />
          </span>
          <span className="min-w-0 group-data-[collapsible=icon]:hidden">
            <span className="block truncate font-heading text-sm font-semibold">Job Hunter</span>
            <span className="block truncate text-[0.625rem] text-muted-foreground">Runs on your Mac</span>
          </span>
        </Link>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {NAV.map((item) => {
                const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
                return (
                  <SidebarMenuItem key={item.href}>
                    <SidebarMenuButton asChild isActive={active} tooltip={item.label}>
                      <Link href={item.href} aria-current={active ? "page" : undefined}>
                        <item.icon className="size-4" />
                        <span>{item.label}</span>
                      </Link>
                    </SidebarMenuButton>
                    {"badge" in item && newCount !== undefined && newCount > 0 && (
                      <SidebarMenuBadge>{newCount}</SidebarMenuBadge>
                    )}
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="px-3 pb-4 group-data-[collapsible=icon]:hidden">
        <Link href="/settings" className="flex flex-col gap-1.5 rounded-lg border bg-muted/30 p-2.5 text-[0.6875rem] text-muted-foreground hover:bg-muted/50">
          <span className="flex items-center gap-2">
            <span className={cn("size-1.5 rounded-full", settings === undefined ? "bg-muted-foreground" : settings.paused ? "bg-amber-400" : "bg-emerald-400")} />
            Agents {settings === undefined ? "…" : settings.paused ? "paused" : "running"}
          </span>
          <span className="flex items-center gap-2">
            <span className={cn("size-1.5 rounded-full", gmail === undefined ? "bg-muted-foreground" : gmailOk ? "bg-emerald-400" : "bg-amber-400")} />
            Gmail {gmail === undefined ? "…" : gmailOk ? "connected" : "not connected"}
          </span>
        </Link>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
