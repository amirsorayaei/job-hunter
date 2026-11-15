/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as auth from "../auth.js";
import type * as companies from "../companies.js";
import type * as crons from "../crons.js";
import type * as gmail_mutations from "../gmail/mutations.js";
import type * as gmail_node from "../gmail/node.js";
import type * as gmail_queries from "../gmail/queries.js";
import type * as http from "../http.js";
import type * as lib_authz from "../lib/authz.js";
import type * as owner from "../owner.js";
import type * as ownerPassword from "../ownerPassword.js";
import type * as postings from "../postings.js";
import type * as roles from "../roles.js";
import type * as runs from "../runs.js";
import type * as settings from "../settings.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  auth: typeof auth;
  companies: typeof companies;
  crons: typeof crons;
  "gmail/mutations": typeof gmail_mutations;
  "gmail/node": typeof gmail_node;
  "gmail/queries": typeof gmail_queries;
  http: typeof http;
  "lib/authz": typeof lib_authz;
  owner: typeof owner;
  ownerPassword: typeof ownerPassword;
  postings: typeof postings;
  roles: typeof roles;
  runs: typeof runs;
  settings: typeof settings;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
