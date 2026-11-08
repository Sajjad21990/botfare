import {
  appBaseUrl,
  newLoginState,
  paypalAuthorizeUrl,
  paypalLoginEnabled,
  paypalRedirectUri,
  redirectResponse,
  stateCookieHeader,
} from "../../../../../lib/server/paypal-login";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Log in with PayPal, step 1: remember a random state and send the browser to PayPal (sandbox). */
export async function GET(request: Request): Promise<Response> {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  if (!paypalLoginEnabled() || !clientId) {
    return redirectResponse(`${appBaseUrl(request)}/signin?error=paypal_disabled`);
  }
  const state = newLoginState();
  const url = paypalAuthorizeUrl({ clientId, redirectUri: paypalRedirectUri(request), state });
  return redirectResponse(url, [stateCookieHeader(state, request)]);
}
