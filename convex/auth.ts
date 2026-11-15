import { convexAuth } from "@convex-dev/auth/server";
import { Password } from "@convex-dev/auth/providers/Password";

/**
 * Authentication provider.
 *
 * ── DEVIATION FROM SPEC §4.4 ────────────────────────────────────────────────
 * The spec says "Use `@convex-dev/auth` with Passkey unless the user explicitly
 * selects OAuth/password." `@convex-dev/auth@0.0.94` does not ship a Passkey
 * provider — the shipped set is Anonymous, ConvexCredentials, Email, Password,
 * and Phone. WebAuthn appears only incidentally inside vendored Auth.js OAuth
 * internals, with no supported wiring.
 *
 * Password is therefore used so the owner-bootstrap flow is exercisable end to
 * end. For a single-owner deployment the practical gap is small: sign-in is
 * gated by a password AND the one-time `OWNER_BOOTSTRAP_SECRET`, and no
 * self-service registration exists beyond the first claim.
 *
 * Revisit when the library ships Passkey. Tracked in docs/IMPLEMENTATION_STATUS.md.
 * ────────────────────────────────────────────────────────────────────────────
 */
export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [Password],
});
