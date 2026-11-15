"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuthActions } from "@convex-dev/auth/react";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { Briefcase, Loader2 } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Sign in / owner bootstrap.
 *
 * Two states, driven by `bootstrapStatus` (the one query deliberately callable
 * while signed out, and which returns only booleans):
 *
 *  - nobody has claimed this deployment  → sign up, then claim with the secret
 *  - someone has                         → sign in only
 */
export default function SignInPage() {
  const router = useRouter();
  const { signIn } = useAuthActions();
  const { isAuthenticated } = useConvexAuth();
  const status = useQuery(api.owner.bootstrapStatus, {});
  const claimOwnership = useMutation(api.owner.claimOwnership);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [bootstrapSecret, setBootstrapSecret] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Set once sign-in succeeds, so the claim runs only after auth settles. */
  const [claimPending, setClaimPending] = useState(false);

  const needsClaim = status !== undefined && !status.ownerClaimed;

  // Redirect in an effect, never during render. Calling router.replace() in the
  // render body is a side effect during render and makes React re-enter the
  // component before navigation commits.
  useEffect(() => {
    if (status?.isOwner) router.replace("/");
  }, [status?.isOwner, router]);

  /**
   * Claim only after the Convex client is actually authenticated.
   *
   * `signIn()` resolving does not guarantee the client has installed the new
   * token yet. Calling claimOwnership straight after it races that handoff and
   * intermittently fails with "Not authenticated". Waiting for
   * `isAuthenticated` removes the race entirely.
   */
  useEffect(() => {
    if (!claimPending || !isAuthenticated) return;

    let cancelled = false;
    void (async () => {
      try {
        await claimOwnership({ bootstrapSecret });
        if (!cancelled) router.replace("/");
      } catch (caught) {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : "Could not claim ownership");
        }
      } finally {
        if (!cancelled) {
          setClaimPending(false);
          setBusy(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [claimPending, isAuthenticated, bootstrapSecret, claimOwnership, router]);

  if (status === undefined) {
    return (
      <Shell>
        <p className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading…
        </p>
      </Shell>
    );
  }

  if (status.isOwner) {
    return (
      <Shell>
        <p className="text-center text-sm text-muted-foreground">Redirecting…</p>
      </Shell>
    );
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (!isAuthenticated) {
        await signIn("password", {
          email,
          password,
          flow: needsClaim ? "signUp" : "signIn",
        });
      }

      if (needsClaim) {
        // Handed to the effect above, which waits for isAuthenticated.
        setClaimPending(true);
        return;
      }

      router.replace("/");
      setBusy(false);
    } catch (caught) {
      // Surface the server's message verbatim. It is deliberately vague about
      // whether a secret was correct once ownership is claimed.
      setError(caught instanceof Error ? caught.message : "Sign in failed");
      setBusy(false);
    }
  }

  return (
    <Shell>
      <Card>
        <CardHeader className="border-b">
          {/* The page's only heading, so it is an <h1> rather than a styled div. */}
          <h1
            data-slot="card-title"
            className="font-heading text-base font-medium"
          >
            {needsClaim ? "Claim this deployment" : "Sign in"}
          </h1>
          <CardDescription>
            {needsClaim
              ? "No owner has been set. The first account plus the bootstrap secret becomes the owner — once."
              : "This deployment already has an owner."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <Field
              id="email"
              label="Email"
              type="email"
              value={email}
              onChange={setEmail}
              autoComplete="username"
            />
            <Field
              id="password"
              label="Password"
              type="password"
              value={password}
              onChange={setPassword}
              autoComplete={needsClaim ? "new-password" : "current-password"}
            />
            {needsClaim && (
              <Field
                id="bootstrap-secret"
                label="Bootstrap secret"
                type="password"
                value={bootstrapSecret}
                onChange={setBootstrapSecret}
                autoComplete="off"
              />
            )}

            {error !== null && (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            )}

            <Button type="submit" size="lg" disabled={busy} className="mt-1 w-full">
              {busy && <Loader2 className="animate-spin" />}
              {busy ? "Working…" : needsClaim ? "Claim ownership" : "Sign in"}
            </Button>
          </form>

          <SignInHelp needsClaim={needsClaim} />
        </CardContent>
      </Card>
    </Shell>
  );
}

/**
 * Help, for the one page the guide cannot reach.
 *
 * `/help` is behind the owner gate, so a person stuck on this page cannot read
 * it. This is therefore self-contained, and deliberately small: it explains the
 * two states of this page and nothing else. It reveals no secret — knowing that
 * a bootstrap secret exists is not knowing one — and it does not expose the
 * signed-in navigation to someone who is not signed in.
 */
function SignInHelp({ needsClaim }: { needsClaim: boolean }) {
  return (
    <details className="mt-5 border-t border-border pt-4 text-xs text-muted-foreground">
      <summary className="cursor-pointer font-medium text-foreground">
        {needsClaim ? "What is a bootstrap secret?" : "Trouble signing in?"}
      </summary>
      <ul className="mt-2 list-disc space-y-1.5 ps-5">
        <li>
          <span className="text-foreground">Claim this deployment</span> appears only
          before anyone owns it. Once an owner exists, this page is an ordinary sign-in
          and the secret field is gone.
        </li>
        <li>
          The bootstrap secret is set by whoever deployed the app, as a deployment
          setting. It is never shown anywhere in this interface — ask the person who
          set it up.
        </li>
        <li>
          A deployment has exactly one owner, claimed once. Another account cannot
          claim one that is already owned, so creating a second account will not help.
        </li>
        <li>
          The full guide lives inside the app, at{" "}
          <span className="font-mono">/help</span>, once you are signed in.
        </li>
      </ul>
    </details>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-6 p-6">
      <div className="flex items-center gap-2">
        <span className="flex size-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
          <Briefcase className="size-4" />
        </span>
        <span className="font-heading text-sm font-semibold">Job Hunter</span>
      </div>
      {children}
    </main>
  );
}

function Field({
  id,
  label,
  type,
  value,
  onChange,
  autoComplete,
}: {
  id: string;
  label: string;
  type: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type={type}
        value={value}
        required
        autoComplete={autoComplete}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}
