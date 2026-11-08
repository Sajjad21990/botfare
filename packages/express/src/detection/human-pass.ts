/**
 * The human pass: an HMAC-signed cookie set after a visitor passes the Turnstile human check.
 * While it is valid (24 h), automation and edge scores no longer charge that browser. It never
 * overrides self-identified agents, signed agents, known crawlers or payments.
 *
 *   botfare_human=v1.<expires unix seconds>.<base64url HMAC-SHA256(key, "v1.<siteId>.<expires>")>
 *
 * The key is derived from the site secret, so only this publisher's middleware can mint a pass.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const HUMAN_PASS_COOKIE = "botfare_human";
export const HUMAN_PASS_TTL_SECONDS = 24 * 60 * 60;

export class HumanPass {
  private readonly key: Buffer;

  constructor(
    private readonly siteId: string,
    siteSecret: string,
  ) {
    this.key = createHmac("sha256", siteSecret).update("botfare human pass v1").digest();
  }

  /** A fresh cookie value valid for 24 h from `nowSeconds`. */
  issue(nowSeconds: number): string {
    const expires = nowSeconds + HUMAN_PASS_TTL_SECONDS;
    return `v1.${expires}.${this.mac(expires)}`;
  }

  /** The `Set-Cookie` header value for a new pass. */
  setCookieHeader(nowSeconds: number, secure: boolean): string {
    const attrs = [
      `${HUMAN_PASS_COOKIE}=${this.issue(nowSeconds)}`,
      "Path=/",
      `Max-Age=${HUMAN_PASS_TTL_SECONDS}`,
      "HttpOnly",
      "SameSite=Lax",
    ];
    if (secure) attrs.push("Secure");
    return attrs.join("; ");
  }

  isValid(value: string | undefined, nowSeconds: number): boolean {
    const match = /^v1\.(\d{1,12})\.([A-Za-z0-9_-]{43})$/.exec(value ?? "");
    if (!match?.[1] || !match[2]) return false;
    const expires = Number(match[1]);
    if (expires < nowSeconds || expires > nowSeconds + HUMAN_PASS_TTL_SECONDS + 60) return false;
    const expected = Buffer.from(this.mac(expires));
    const given = Buffer.from(match[2]);
    return expected.length === given.length && timingSafeEqual(expected, given);
  }

  /** Reads the pass from a `Cookie` header. */
  fromCookieHeader(cookieHeader: string | undefined, nowSeconds: number): boolean {
    return this.isValid(readCookie(cookieHeader, HUMAN_PASS_COOKIE), nowSeconds);
  }

  private mac(expires: number): string {
    return createHmac("sha256", this.key)
      .update(`v1.${this.siteId}.${expires}`)
      .digest("base64url");
  }
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}
