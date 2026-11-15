"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { useConvexAuth, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";

/**
 * Client-side route guard.
 *
 * This is a convenience, NOT the security boundary. Every Convex function
 * enforces ownership server-side via `requireOwner`, so bypassing this
 * component reveals nothing — the queries behind it simply throw.
 *
 * The auth state is read from `useConvexAuth` FIRST, and nothing is decided
 * while it is still loading. `bootstrapStatus` is a public query that answers
 * `isOwner: false` for an unauthenticated caller, and on a hard navigation the
 * Convex client is briefly unauthenticated before it has restored the session.
 * Acting on that first answer redirected a signed-in owner to /signin, which
 * then bounced them to Today — so opening /settings or /funnel in a new tab
 * landed on the wrong page, seemingly at random. The end-to-end suite caught it
 * as two "the page did not render" failures.
 */
export function OwnerGate({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { isLoading, isAuthenticated } = useConvexAuth();

  // Skipped entirely until the session is known, so the transient
  // unauthenticated answer is never observed.
  const status = useQuery(api.owner.bootstrapStatus, isAuthenticated ? {} : "skip");

  const settled = !isLoading && (!isAuthenticated || status !== undefined);
  const allowed = isAuthenticated && status?.isOwner === true;

  useEffect(() => {
    if (settled && !allowed) router.replace("/signin");
  }, [settled, allowed, router]);

  if (!settled) {
    return (
      <main className="flex flex-1 items-center justify-center gap-2 p-6">
        <Loader2 className="size-4 animate-spin text-muted-foreground" />
        <p className="text-sm text-muted-foreground">Loading…</p>
      </main>
    );
  }

  if (!allowed) {
    return (
      <main className="flex flex-1 items-center justify-center p-6">
        <p className="text-sm text-muted-foreground">Redirecting to sign in…</p>
      </main>
    );
  }

  return <>{children}</>;
}
