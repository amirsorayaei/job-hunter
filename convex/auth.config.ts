/**
 * JWT provider configuration.
 *
 * The convex-auth skill flags this file as the single biggest real-world auth
 * footgun: if it is missing or wrong, `ctx.auth.getUserIdentity()` silently
 * returns null forever and the app is permanently signed out with no error.
 *
 * For @convex-dev/auth the issuer is this deployment's own site URL, which
 * Convex sets automatically as CONVEX_SITE_URL.
 */
const authConfig = {
  providers: [
    {
      domain: process.env.CONVEX_SITE_URL,
      applicationID: "convex",
    },
  ],
};

export default authConfig;
