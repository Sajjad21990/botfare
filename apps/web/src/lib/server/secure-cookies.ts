/**
 * Whether cookies set in answer to this request should carry `Secure`.
 *
 * Decided by the request's own scheme, not by NODE_ENV: the judge Docker stack runs the production
 * build on http://localhost:3300, and Safari drops `Secure` cookies on plain-http localhost (Chrome
 * and Firefox accept them), so a production-only rule would sign Safari users straight back out.
 * On Render, TLS ends at the proxy, which sends `X-Forwarded-Proto: https`, so the cookies stay
 * `Secure` there.
 *
 * Order: the first `X-Forwarded-Proto` value, then the request URL's scheme. A client that sends a
 * false `X-Forwarded-Proto: http` only weakens its own cookie.
 */
export function isSecureRequest(request: Request): boolean {
  const forwarded = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  if (forwarded === "https") return true;
  if (forwarded === "http") return false;
  try {
    return new URL(request.url).protocol === "https:";
  } catch {
    return false;
  }
}
