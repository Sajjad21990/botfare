import { getDb } from "../../../../../lib/server/db";
import {
  appBaseUrl,
  clearStateCookieHeader,
  exchangeAuthorizationCode,
  fetchPayPalUserInfo,
  PayPalLoginError,
  type PayPalLoginErrorCode,
  paypalLoginEnabled,
  readCookie,
  redirectResponse,
  STATE_COOKIE,
  signInWithPayPalEmail,
  statesMatch,
  verifiedPayPalEmail,
} from "../../../../../lib/server/paypal-login";
import { createSessionCookie } from "../../../../../lib/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Log in with PayPal, step 2: PayPal redirects here with `code` and `state`. Checks the state,
 * exchanges the code, requires a verified email, signs the user in and sets their payout email.
 * Every outcome clears the state cookie, so a callback URL works at most once.
 */
export async function GET(request: Request): Promise<Response> {
  const base = appBaseUrl(request);
  const clear = clearStateCookieHeader();
  const fail = (code: PayPalLoginErrorCode) =>
    redirectResponse(`${base}/signin?error=${code}`, [clear]);

  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
  if (!paypalLoginEnabled() || !clientId || !clientSecret) return fail("paypal_disabled");

  const params = new URL(request.url).searchParams;
  if (!statesMatch(params.get("state"), readCookie(request, STATE_COOKIE))) {
    return fail("paypal_state");
  }
  if (params.get("error")) return fail("paypal_denied");
  const code = params.get("code");
  if (!code) return fail("paypal_failed");

  try {
    const accessToken = await exchangeAuthorizationCode(code, { clientId, clientSecret });
    const info = await fetchPayPalUserInfo(accessToken);
    const email = verifiedPayPalEmail(info);
    if (!email) return fail("paypal_unverified");
    const user = await signInWithPayPalEmail(getDb(), { email, name: info.name });
    await createSessionCookie(user.id);
    return redirectResponse(`${base}/publisher`, [clear]);
  } catch (err) {
    if (err instanceof PayPalLoginError) {
      console.warn(`[auth] Log in with PayPal: ${err.code}: ${err.message}`);
      return fail(err.code);
    }
    console.error("[auth] Log in with PayPal failed", err);
    return fail("paypal_failed");
  }
}
