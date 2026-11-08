import "server-only";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { isDemoPersonaEmail } from "@botfare/contracts";
import { createUser, type DbOrTx, getUserByEmail, setPayoutEmail, type User } from "@botfare/core";
import { SANDBOX_BASE_URL } from "@botfare/paypal";
import { z } from "zod";
import { isSecureRequest } from "./secure-cookies";

/**
 * Log in with PayPal (sandbox only), for publishers who want their own account:
 *
 * 1. GET /api/auth/paypal/start sets a random `state` in a short-lived httpOnly cookie and sends
 *    the browser to PayPal's consent page.
 * 2. PayPal redirects to GET /api/auth/paypal/callback?code=…&state=…. The callback checks the
 *    state, exchanges the code at /v1/oauth2/token (grant_type=authorization_code, the app's own
 *    client credentials), reads the OpenID Connect userinfo and requires a verified email.
 * 3. The user is found or created by that email, signed in, and their payout email is set to it:
 *    PayPal has verified it, so Payouts reach the account the publisher just logged in with.
 *
 * Off unless PAYPAL_LOGIN_ENABLED=true: the sandbox app needs "Log in with PayPal" turned on and
 * the callback URL registered as its return URL. Calls PayPal with fetch directly; the access
 * token is used once and never stored.
 */

/** PayPal's sandbox consent page. Never the live one. */
export const PAYPAL_AUTHORIZE_URL = "https://www.sandbox.paypal.com/connect";
export const PAYPAL_LOGIN_SCOPES = "openid email https://uri.paypal.com/services/paypalattributes";
/** OpenID Connect userinfo (standard claims: `email`, `email_verified`, `user_id`, `name`). */
export const PAYPAL_USERINFO_PATH = "/v1/identity/openidconnect/userinfo?schema=openid";

export const STATE_COOKIE = "botfare_paypal_state";
export const CALLBACK_PATH = "/api/auth/paypal/callback";
const STATE_COOKIE_PATH = "/api/auth/paypal";
const STATE_MAX_AGE_SECONDS = 10 * 60;

export type PayPalLoginErrorCode =
  | "paypal_disabled"
  | "paypal_denied"
  | "paypal_state"
  | "paypal_unverified"
  | "paypal_demo_account"
  | "paypal_failed";

/** Shown on /signin?error=… after a failed callback. */
export const PAYPAL_LOGIN_ERRORS: Record<PayPalLoginErrorCode, string> = {
  paypal_disabled: "Log in with PayPal is not turned on for this BotFare.",
  paypal_denied: "PayPal sign-in was cancelled.",
  paypal_state: "That PayPal sign-in link expired or was already used. Please try again.",
  paypal_unverified:
    "Your PayPal account has no verified email address. Confirm your email with PayPal, then try again.",
  paypal_demo_account: "That email belongs to a shared demo account. Use the demo buttons instead.",
  paypal_failed: "PayPal sign-in did not complete. Please try again.",
};

export class PayPalLoginError extends Error {
  constructor(
    readonly code: PayPalLoginErrorCode,
    message: string = PAYPAL_LOGIN_ERRORS[code],
  ) {
    super(message);
    this.name = "PayPalLoginError";
  }
}

export function paypalLoginEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    env.PAYPAL_LOGIN_ENABLED?.trim().toLowerCase() === "true" &&
    Boolean(env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET)
  );
}

/** The app's public origin: BOTFARE_URL, or the request's own origin when it is unset. */
export function appBaseUrl(request: Request, env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.BOTFARE_URL?.trim();
  if (configured) {
    const withScheme = /^https?:\/\//i.test(configured) ? configured : `https://${configured}`;
    return withScheme.replace(/\/+$/, "");
  }
  return new URL(request.url).origin;
}

/** The return URL PayPal redirects to; it must match the sandbox app's return URL exactly. */
export function paypalRedirectUri(request: Request, env: NodeJS.ProcessEnv = process.env): string {
  return `${appBaseUrl(request, env)}${CALLBACK_PATH}`;
}

export function newLoginState(): string {
  return randomBytes(32).toString("base64url");
}

/** PayPal's consent URL. Built by hand so the scopes are joined with %20, as PayPal documents. */
export function paypalAuthorizeUrl(input: {
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const params: [string, string][] = [
    ["flowEntry", "static"],
    ["client_id", input.clientId],
    ["response_type", "code"],
    ["scope", PAYPAL_LOGIN_SCOPES],
    ["redirect_uri", input.redirectUri],
    ["state", input.state],
  ];
  const query = params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
  return `${PAYPAL_AUTHORIZE_URL}?${query}`;
}

function cookieAttributes(maxAge: number, request: Request): string {
  const secure = isSecureRequest(request) ? "; Secure" : "";
  // Lax: the cookie must ride along on PayPal's top-level GET redirect back to the callback.
  return `Path=${STATE_COOKIE_PATH}; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

/** `Secure` only when the request came over https (see isSecureRequest). */
export function stateCookieHeader(state: string, request: Request): string {
  return `${STATE_COOKIE}=${state}; ${cookieAttributes(STATE_MAX_AGE_SECONDS, request)}`;
}

export function clearStateCookieHeader(request: Request): string {
  return `${STATE_COOKIE}=; ${cookieAttributes(0, request)}`;
}

/** One cookie's value from the request's Cookie header. */
export function readCookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim() || null;
  }
  return null;
}

/** Constant-time comparison of the state PayPal echoed and the one in the cookie. */
export function statesMatch(fromQuery: string | null, fromCookie: string | null): boolean {
  if (!fromQuery || !fromCookie) return false;
  const a = Buffer.from(fromQuery);
  const b = Buffer.from(fromCookie);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** A redirect that can also set cookies (Response.redirect's headers are immutable). */
export function redirectResponse(location: string, cookies: string[] = []): Response {
  const headers = new Headers({ location, "cache-control": "no-store" });
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(null, { status: 302, headers });
}

// ---------------------------------------------------------------------------------------------
// PayPal calls

function logCall(method: string, path: string, response: Response, started: number): void {
  console.info(
    `[paypal] ${method} ${path} -> ${response.status} (${Date.now() - started} ms, debug ${
      response.headers.get("paypal-debug-id") ?? "-"
    })`,
  );
}

const tokenSchema = z.object({ access_token: z.string().min(1) });

/** Exchanges the authorization code for the user's access token (used once, never stored). */
export async function exchangeAuthorizationCode(
  code: string,
  credentials: { clientId: string; clientSecret: string },
): Promise<string> {
  const basic = Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`).toString(
    "base64",
  );
  const started = Date.now();
  const response = await fetch(`${SANDBOX_BASE_URL}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      authorization: `Basic ${basic}`,
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
      "paypal-request-id": randomUUID(),
    },
    body: new URLSearchParams({ grant_type: "authorization_code", code }).toString(),
  });
  logCall("POST", "/v1/oauth2/token (authorization_code)", response, started);
  if (!response.ok) throw new PayPalLoginError("paypal_failed", "PayPal token exchange failed");
  const parsed = tokenSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new PayPalLoginError("paypal_failed", "PayPal sent no access token");
  return parsed.data.access_token;
}

const booleanish = z.union([z.boolean(), z.enum(["true", "false"]).transform((v) => v === "true")]);

export const userInfoSchema = z.looseObject({
  user_id: z.string().optional(),
  sub: z.string().optional(),
  name: z.string().optional(),
  email: z.string().optional(),
  email_verified: booleanish.optional(),
  /** The paypalv1.1 schema lists every address instead; accepted too. */
  emails: z
    .array(
      z.looseObject({
        value: z.string(),
        primary: booleanish.optional(),
        confirmed: booleanish.optional(),
      }),
    )
    .optional(),
});

export type PayPalUserInfo = z.output<typeof userInfoSchema>;

export async function fetchPayPalUserInfo(accessToken: string): Promise<PayPalUserInfo> {
  const started = Date.now();
  const response = await fetch(`${SANDBOX_BASE_URL}${PAYPAL_USERINFO_PATH}`, {
    headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
  });
  logCall("GET", PAYPAL_USERINFO_PATH, response, started);
  if (!response.ok) throw new PayPalLoginError("paypal_failed", "PayPal userinfo failed");
  const parsed = userInfoSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new PayPalLoginError("paypal_failed", "Unexpected PayPal userinfo");
  return parsed.data;
}

const emailSchema = z.email();

/** The verified email PayPal vouches for, or null. Unverified addresses are never used. */
export function verifiedPayPalEmail(info: PayPalUserInfo): string | null {
  const candidates: string[] = [];
  if (info.email && info.email_verified === true) candidates.push(info.email);
  const confirmed = (info.emails ?? []).filter((e) => e.confirmed === true);
  confirmed.sort((a, b) => Number(b.primary === true) - Number(a.primary === true));
  candidates.push(...confirmed.map((e) => e.value));
  for (const candidate of candidates) {
    const email = candidate.trim().toLowerCase();
    if (emailSchema.safeParse(email).success) return email;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Account

/**
 * Finds or creates the user for a verified PayPal email and points their payouts at it. The
 * shared demo personas cannot be reached this way (their payout account is fixed).
 */
export async function signInWithPayPalEmail(
  db: DbOrTx,
  input: { email: string; name?: string | null },
): Promise<User> {
  const email = input.email.trim().toLowerCase();
  if (isDemoPersonaEmail(email)) throw new PayPalLoginError("paypal_demo_account");
  const name = input.name?.trim() || email.split("@")[0] || "PayPal publisher";
  let user = await getUserByEmail(db, email);
  if (!user) {
    try {
      user = await createUser(db, { email, name: name.slice(0, 200) });
    } catch (err) {
      // Two callbacks racing on a new email: the unique index lets one win; use that row.
      user = await getUserByEmail(db, email);
      if (!user) throw err;
    }
  }
  return setPayoutEmail(db, { userId: user.id, email });
}
