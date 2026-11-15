"use client";

import { ConvexAuthProvider } from "@convex-dev/auth/react";
import { ConvexReactClient } from "convex/react";
import type { ReactNode } from "react";

/**
 * Convex client + auth provider.
 *
 * `ConvexAuthProvider` (not plain `ConvexProvider`) is required: the plain one
 * does not attach tokens to requests, which produces an app that is silently
 * always signed out.
 */
const convex = new ConvexReactClient(process.env.NEXT_PUBLIC_CONVEX_URL!);

export function ConvexClientProvider({ children }: { children: ReactNode }) {
  return <ConvexAuthProvider client={convex}>{children}</ConvexAuthProvider>;
}
