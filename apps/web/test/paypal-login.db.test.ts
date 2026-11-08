import { DEMO_PERSONAS } from "@botfare/contracts";
import { createUser, getPayoutEmail, getUserByEmail } from "@botfare/core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Route handlers run outside Next: no "server-only" guard, and the session cookie is recorded.
vi.mock("server-only", () => ({}));
const session = vi.hoisted(() => ({ userIds: [] as string[] }));
vi.mock("../src/lib/server/session", () => ({
  createSessionCookie: async (userId: string) => {
    session.userIds.push(userId);
  },
}));

import { GET as callback } from "../src/app/api/auth/paypal/callback/route";
import { GET as start } from "../src/app/api/auth/paypal/start/route";
import { closeDb, getDb } from "../src/lib/server/db";
import { STATE_COOKIE } from "../src/lib/server/paypal-login";
import { useTestDatabase } from "./helpers";

const BASE = "https://botfare.test";
const STATE = "s".repeat(43);
const PAYPAL = "https://api-m.sandbox.paypal.com";

function unique(label: string): string {
  return `${label}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function callbackRequest(query: Record<string, string>, cookieState: string | null = STATE) {
  const url = new URL(`${BASE}/api/auth/paypal/callback`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const headers = new Headers();
  if (cookieState !== null) headers.set("cookie", `other=1; ${STATE_COOKIE}=${cookieState}`);
  return new Request(url, { headers });
}

/** A mock PayPal: the token endpoint and the userinfo endpoint; anything else fails the test. */
function mockPayPal(userinfo: unknown, options: { tokenStatus?: number } = {}) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push({ url, init });
    if (url === `${PAYPAL}/v1/oauth2/token`) {
      return options.tokenStatus && options.tokenStatus !== 200
        ? Response.json({ error: "invalid_grant" }, { status: options.tokenStatus })
        : Response.json({ access_token: "user-access-token", token_type: "Bearer" });
    }
    if (url.startsWith(`${PAYPAL}/v1/identity/openidconnect/userinfo`)) {
      return Response.json(userinfo);
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetchMock };
}

function location(res: Response): URL {
  return new URL(res.headers.get("location") ?? "");
}

function setCookies(res: Response): string[] {
  return res.headers.getSetCookie();
}

beforeAll(useTestDatabase);
beforeEach(() => {
  vi.stubEnv("PAYPAL_LOGIN_ENABLED", "true");
  vi.stubEnv("PAYPAL_CLIENT_ID", "test-client-id");
  vi.stubEnv("PAYPAL_CLIENT_SECRET", "test-client-secret");
  vi.stubEnv("BOTFARE_URL", BASE);
});
afterEach(() => {
  session.userIds = [];
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
afterAll(closeDb);

describe("GET /api/auth/paypal/start", () => {
  it("sets a state cookie and redirects to PayPal's sandbox consent page", async () => {
    const res = await start(new Request(`${BASE}/api/auth/paypal/start`));
    expect(res.status).toBe(302);
    const target = location(res);
    expect(`${target.origin}${target.pathname}`).toBe("https://www.sandbox.paypal.com/connect");
    expect(target.searchParams.get("flowEntry")).toBe("static");
    expect(target.searchParams.get("client_id")).toBe("test-client-id");
    expect(target.searchParams.get("response_type")).toBe("code");
    expect(target.searchParams.get("scope")).toBe(
      "openid email https://uri.paypal.com/services/paypalattributes",
    );
    expect(res.headers.get("location")).toContain("scope=openid%20email%20https");
    expect(target.searchParams.get("redirect_uri")).toBe(`${BASE}/api/auth/paypal/callback`);
    const state = target.searchParams.get("state") ?? "";
    expect(state.length).toBeGreaterThanOrEqual(32);

    const [cookie] = setCookies(res);
    expect(cookie).toContain(`${STATE_COOKIE}=${state};`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/api/auth/paypal");
  });

  it("sends people back to sign-in when Log in with PayPal is off", async () => {
    vi.stubEnv("PAYPAL_LOGIN_ENABLED", "");
    const res = await start(new Request(`${BASE}/api/auth/paypal/start`));
    expect(res.status).toBe(302);
    expect(location(res).href).toBe(`${BASE}/signin?error=paypal_disabled`);
    expect(setCookies(res)).toEqual([]);
  });
});

describe("GET /api/auth/paypal/callback", () => {
  it("rejects a state that does not match the cookie, without calling PayPal", async () => {
    const { fetchMock } = mockPayPal({ email: "x@example.test", email_verified: true });
    for (const req of [
      callbackRequest({ code: "c", state: "t".repeat(43) }),
      callbackRequest({ code: "c", state: STATE }, null),
      callbackRequest({ code: "c" }),
    ]) {
      const res = await callback(req);
      expect(res.status).toBe(302);
      expect(location(res).href).toBe(`${BASE}/signin?error=paypal_state`);
      expect(setCookies(res).join()).toContain(`${STATE_COOKIE}=;`);
      expect(setCookies(res).join()).toContain("Max-Age=0");
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(session.userIds).toEqual([]);
  });

  it("reports a cancelled consent as denied", async () => {
    const { fetchMock } = mockPayPal({});
    const res = await callback(callbackRequest({ error: "access_denied", state: STATE }));
    expect(location(res).href).toBe(`${BASE}/signin?error=paypal_denied`);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an account without a verified email and creates nobody", async () => {
    const email = `${unique("unverified")}@example.test`;
    mockPayPal({ user_id: "https://www.paypal.com/webapps/auth/identity/user/u1", email });
    const res = await callback(callbackRequest({ code: "auth-code", state: STATE }));
    expect(location(res).href).toBe(`${BASE}/signin?error=paypal_unverified`);
    expect(await getUserByEmail(getDb(), email)).toBeNull();
    expect(session.userIds).toEqual([]);

    mockPayPal({ email, email_verified: "false", emails: [{ value: email, confirmed: false }] });
    const again = await callback(callbackRequest({ code: "auth-code", state: STATE }));
    expect(location(again).href).toBe(`${BASE}/signin?error=paypal_unverified`);
    expect(await getUserByEmail(getDb(), email)).toBeNull();
  });

  it("creates the user, signs them in and sets the verified email as their payout email", async () => {
    const email = `${unique("Publisher")}@Example.test`;
    const { calls } = mockPayPal({
      user_id: "https://www.paypal.com/webapps/auth/identity/user/u2",
      name: "Ada Brewer",
      email,
      email_verified: true,
    });

    const res = await callback(callbackRequest({ code: "auth-code-123", state: STATE }));
    expect(res.status).toBe(302);
    expect(location(res).href).toBe(`${BASE}/publisher`);
    expect(setCookies(res).join()).toContain(`${STATE_COOKIE}=;`);

    const user = await getUserByEmail(getDb(), email);
    expect(user).toMatchObject({ email: email.toLowerCase(), name: "Ada Brewer" });
    expect(user?.payoutEmail).toBe(email.toLowerCase());
    expect(session.userIds).toEqual([user?.id]);

    // Token exchange: authorization_code grant with the app's credentials and a request ID.
    const token = calls[0];
    expect(token?.url).toBe(`${PAYPAL}/v1/oauth2/token`);
    expect(token?.init?.method).toBe("POST");
    const headers = new Headers(token?.init?.headers);
    expect(headers.get("authorization")).toBe(
      `Basic ${Buffer.from("test-client-id:test-client-secret").toString("base64")}`,
    );
    expect(headers.get("paypal-request-id")).toBeTruthy();
    const body = new URLSearchParams(String(token?.init?.body));
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("auth-code-123");

    // Userinfo with the user's token.
    expect(calls[1]?.url).toBe(`${PAYPAL}/v1/identity/openidconnect/userinfo?schema=openid`);
    expect(new Headers(calls[1]?.init?.headers).get("authorization")).toBe(
      "Bearer user-access-token",
    );
  });

  it("signs an existing user in and points their payouts at the verified PayPal email", async () => {
    const email = `${unique("existing")}@example.test`;
    const existing = await createUser(getDb(), { email, name: "Existing publisher" });
    mockPayPal({ emails: [{ value: email, primary: true, confirmed: true }] });

    const res = await callback(callbackRequest({ code: "auth-code", state: STATE }));
    expect(location(res).href).toBe(`${BASE}/publisher`);
    expect(session.userIds).toEqual([existing.id]);
    expect(await getPayoutEmail(getDb(), existing.id)).toBe(email);
    expect((await getUserByEmail(getDb(), email))?.name).toBe("Existing publisher");
  });

  it("refuses the shared demo personas", async () => {
    mockPayPal({ email: DEMO_PERSONAS.publisher.email, email_verified: true });
    const res = await callback(callbackRequest({ code: "auth-code", state: STATE }));
    expect(location(res).href).toBe(`${BASE}/signin?error=paypal_demo_account`);
    expect(session.userIds).toEqual([]);
  });

  it("fails cleanly when PayPal rejects the code", async () => {
    const email = `${unique("badcode")}@example.test`;
    mockPayPal({ email, email_verified: true }, { tokenStatus: 400 });
    const res = await callback(callbackRequest({ code: "used-code", state: STATE }));
    expect(location(res).href).toBe(`${BASE}/signin?error=paypal_failed`);
    expect(await getUserByEmail(getDb(), email)).toBeNull();
    expect(session.userIds).toEqual([]);
  });
});
