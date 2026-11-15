"use client";

import { LogOut } from "lucide-react";
import { useAuthActions } from "@convex-dev/auth/react";
import { AppSidebar } from "@/components/app-sidebar";
import { Badge } from "@/components/ui/badge";
import { Button as UiButton } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";

/**
 * Shared page frame: sidebar, sticky header, page title, sign out.
 *
 * Every owner-facing page renders inside this, so the shell is also where
 * global affordances live — navigation, sign out, and help. Sign-in
 * deliberately does not use it: an unclaimed deployment has nothing to
 * navigate to.
 *
 * There is no theme switch. The app is dark only, by the owner's choice; see
 * `forcedTheme` in the root layout.
 */
export function PageShell({
  title,
  subtitle,
  children,
  actions,
  wide,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  actions?: React.ReactNode;
  wide?: boolean;
}) {
  const { signOut } = useAuthActions();

  return (
    <SidebarProvider>
      {/*
        First focusable element in the document, BEFORE the sidebar. It used to
        sit inside SidebarInset, which put it after every nav link — so the one
        thing it exists to skip was already behind you by the time you reached
        it. The accessibility suite caught that: pressing Tab once did not focus
        it.
      */}
      <a
        href="#content"
        className="sr-only focus:not-sr-only focus:absolute focus:start-2 focus:top-2 focus:z-50 focus:rounded-md focus:bg-primary focus:px-3 focus:py-2 focus:text-sm focus:text-primary-foreground"
      >
        Skip to content
      </a>
      <AppSidebar />
      <SidebarInset>
        <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-2 border-b bg-background/80 px-4 backdrop-blur">
          <SidebarTrigger />
          <Separator orientation="vertical" className="mr-1 h-4" />
          <h1 className="truncate font-heading text-sm font-semibold">{title}</h1>
          <div className="ms-auto flex items-center gap-1">
            {actions}
            <UiButton
              variant="ghost"
              size="icon"
              aria-label="Sign out"
              title="Sign out"
              onClick={() => void signOut()}
            >
              <LogOut className="size-4" />
            </UiButton>
          </div>
        </header>

        <main
          id="main"
          className={cn(
            "mx-auto w-full flex-1 px-4 py-6 sm:px-6",
            wide ? "max-w-[100rem]" : "max-w-4xl",
          )}
        >
          {subtitle !== undefined && (
            <p className="mb-6 max-w-2xl text-sm text-muted-foreground">{subtitle}</p>
          )}
          <div id="content" className="flex flex-col gap-6">
            {children}
          </div>
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}

/**
 * A titled block of page content.
 *
 * Cards rather than bare headings: several pages stack five or six unrelated
 * blocks, and without a container the eye cannot tell where one ends.
 */
export function Section({
  title,
  description,
  count,
  children,
  action,
  className,
}: {
  title: string;
  description?: string;
  count?: number;
  children: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
  /**
   * Optional, unlike the page-level one. Section help belongs on sections that
   * ask you to DO something consequential — approve, promote, generate, apply.
   * An icon beside every heading in the app would be noise, and noise is what
   * makes people stop seeing the icons that matter.
   */
}) {
  return (
    <Card className={className}>
      <CardHeader className="border-b">
        {/* A real <h2>, not a styled div: these are the page's section headings,
            and both screen readers and the end-to-end suite navigate by them. */}
        <h2
          data-slot="card-title"
          className="flex items-center gap-2 font-heading text-sm font-medium"
        >
          <span>{title}</span>
          {count !== undefined && (
            <Badge variant="secondary" className="tabular-nums">
              {count}
            </Badge>
          )}
        </h2>
        {description !== undefined && (
          <p className="text-xs text-muted-foreground">{description}</p>
        )}
        {action !== undefined && <CardAction>{action}</CardAction>}
      </CardHeader>
      <CardContent className="text-sm">{children}</CardContent>
    </Card>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="py-1 text-sm text-muted-foreground">{children}</p>;
}

/**
 * Back-compatible button.
 *
 * The old shell exposed `primary | secondary | danger`; pages across the app
 * still ask for those names, so they map onto the shadcn variants here rather
 * than being renamed in twelve files.
 */
export function Button({
  children,
  onClick,
  variant = "secondary",
  disabled,
  type = "button",
  title,
  size = "sm",
  className,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  variant?: "primary" | "secondary" | "danger" | "ghost";
  disabled?: boolean;
  type?: "button" | "submit";
  title?: string;
  size?: "sm" | "default" | "lg";
  className?: string;
}) {
  const mapped =
    variant === "primary"
      ? "default"
      : variant === "danger"
        ? "destructive"
        : variant === "ghost"
          ? "ghost"
          : "outline";

  return (
    <UiButton
      type={type}
      title={title}
      onClick={onClick}
      disabled={disabled}
      variant={mapped}
      size={size}
      className={className}
    >
      {children}
    </UiButton>
  );
}

/**
 * A labelled form control.
 *
 * With no `htmlFor`, the whole thing is a `<label>` so the control inside is
 * associated implicitly — that is what makes `getByLabel("Body")` work, and it
 * is how every panel in the app is written. Pass `htmlFor` when the control
 * cannot be nested (a Radix trigger, say) and the association must be explicit.
 */
export function Field({
  label,
  htmlFor,
  hint,
  children,
  className,
}: {
  label: string;
  htmlFor?: string;
  hint?: string;
  children: React.ReactNode;
  className?: string;
}) {
  const body = (
    <>
      <span className="text-xs leading-none font-medium text-muted-foreground">
        {label}
      </span>
      {children}
      {hint !== undefined && (
        <span className="text-[0.6875rem] text-muted-foreground">{hint}</span>
      )}
    </>
  );

  if (htmlFor === undefined) {
    return <label className={cn("flex flex-col gap-1.5", className)}>{body}</label>;
  }

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <Label htmlFor={htmlFor} className="text-xs text-muted-foreground">
        {label}
      </Label>
      {children}
      {hint !== undefined && (
        <p className="text-[0.6875rem] text-muted-foreground">{hint}</p>
      )}
    </div>
  );
}

/**
 * The `Input` component's own classes, for the native `<input>`, `<select>` and
 * `<textarea>` elements the panels still use.
 *
 * They are deliberately still native. A native `<select>` is one tag, works on
 * a phone, and `selectOption()` drives it in a test; the Radix equivalent is
 * none of those things. Sharing the class string is what keeps them looking
 * identical to the shadcn controls next to them — so if `ui/input.tsx` is ever
 * restyled, mirror the change here.
 */
export const inputClass =
  "rounded-md border border-input bg-input/20 px-2 py-1 text-sm transition-colors " +
  "outline-none placeholder:text-muted-foreground " +
  "focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 " +
  "disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30";

/** A label/value pair for the small metric grids several pages open with. */
export function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: React.ReactNode;
  tone?: "default" | "good" | "warn" | "bad";
}) {
  const toneClass =
    tone === "good"
      ? "text-emerald-600 dark:text-emerald-400"
      : tone === "warn"
        ? "text-amber-600 dark:text-amber-400"
        : tone === "bad"
          ? "text-destructive"
          : "text-foreground";

  return (
    <div className="rounded-lg bg-muted/40 px-3 py-2 ring-1 ring-foreground/5">
      <p className="truncate text-[0.6875rem] tracking-wide text-muted-foreground uppercase">
        {label}
      </p>
      <p className={cn("mt-0.5 font-heading text-xl font-semibold tabular-nums", toneClass)}>
        {value}
      </p>
    </div>
  );
}

export function StatGrid({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">{children}</div>
  );
}

/** Semantic badge used for verdicts, states and health across the app. */
export function ToneBadge({
  tone,
  children,
  className,
}: {
  tone: "good" | "warn" | "bad" | "neutral" | "info" | "accent";
  children: React.ReactNode;
  className?: string;
}) {
  const tones = {
    accent: "bg-violet-500/15 text-violet-300",
    good: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
    warn: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
    bad: "bg-destructive/10 text-destructive",
    // Not `text-primary`: the preset's dark primary is a deep teal, and on its
    // own 10% tint it failed axe's contrast rule at "serious". Found by the
    // accessibility suite on the Funnel page, not by looking at it.
    info: "bg-link/10 text-link",
    neutral: "bg-muted text-muted-foreground",
  } as const;

  return (
    <Badge variant="ghost" className={cn(tones[tone], className)}>
      {children}
    </Badge>
  );
}

/** A monospaced log panel — used by Import, Sources and Tailor. */
export function LogPanel({ lines }: { lines: string[] }) {
  if (lines.length === 0) return null;
  return (
    <pre className="max-h-64 overflow-auto rounded-md bg-muted/60 p-3 font-mono text-[0.6875rem] leading-relaxed whitespace-pre-wrap">
      {lines.join("\n")}
    </pre>
  );
}

export function formatDate(ms: number | undefined): string {
  if (ms === undefined) return "—";
  return new Date(ms).toISOString().slice(0, 10);
}

/** Human title for an application; imported folders often have no role. */
