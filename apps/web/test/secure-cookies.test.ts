import { afterEach, describe, expect, it, vi } from "vitest";

// Session code runs outside Next here: no "server-only" guard, and cookies() is recorded.
vi.mock("server-only", () => ({}));
const jar = vi.hoisted(() => ({
  set: [] as { name: string; value: string; options: Record<string, unknown> }[],
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    set: (name: string, value: string, options: Record<string, unknown>) => {
      jar.set.push({ name, value, options });
    },
  }),
}));

import { clearStateCookieHeader, stateCookieHeader } from "../src/lib/server/paypal-login";
import { isSecureRequest } from "../src/lib/server/secure-cookies";
import { createSessionCookie } from "../src/lib/server/session";

afterEach(() => {
  jar.set = [];
  vi.unstubAllEnvs();
});

const request = (url: string, headers: Record<string, string> = {}) =>
  new Request(url, { headers });

describe("isSecureRequest", () => {
  it("follows the request URL's scheme", () => {
    expect(isSecureRequest(request("https://botfare.example/api/session/persona"))).toBe(true);
    expect(isSecureRequest(request("http://localhost:3300/api/session/persona"))).toBe(false);
    expect(isSecureRequest(request("http://127.0.0.1:3000/"))).toBe(false);
  });

  it("trusts the proxy's X-Forwarded-Proto first (Render ends TLS at its proxy)", () => {
    expect(
      isSecureRequest(request("http://10.0.0.5:10000/", { "x-forwarded-proto": "https" })),
    ).toBe(true);
    expect(
      isSecureRequest(request("http://10.0.0.5:10000/", { "x-forwarded-proto": "https, http" })),
    ).toBe(true);
    expect(
      isSecureRequest(request("https://botfare.example/", { "x-forwarded-proto": "http" })),
    ).toBe(false);
    expect(isSecureRequest(request("http://localhost:3300/", { "x-forwarded-proto": "" }))).toBe(
      false,
    );
  });
});

describe("createSessionCookie", () => {
  it("leaves Secure off on http://localhost even in production (Safari in the Docker stack)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SESSION_SECRET", "x".repeat(48));
    await createSessionCookie("usr_1", request("http://localhost:3300/api/session/persona"));
    expect(jar.set).toHaveLength(1);
    const [cookie] = jar.set;
    expect(cookie?.name).toBe("botfare_session");
    expect(cookie?.options).toMatchObject({ httpOnly: true, sameSite: "lax", secure: false });
  });

  it("sets Secure behind an https proxy (Render)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SESSION_SECRET", "x".repeat(48));
    await createSessionCookie(
      "usr_1",
      request("http://10.0.0.5:10000/api/session/persona", { "x-forwarded-proto": "https" }),
    );
    expect(jar.set[0]?.options).toMatchObject({ secure: true });
    await createSessionCookie("usr_1", request("https://botfare.example/api/session/persona"));
    expect(jar.set[1]?.options).toMatchObject({ secure: true });
  });
});

describe("Log in with PayPal state cookie", () => {
  it("is Secure only over https", () => {
    const https = request("https://botfare.example/api/auth/paypal/start");
    const http = request("http://localhost:3300/api/auth/paypal/start");
    expect(stateCookieHeader("abc", https)).toContain("; Secure");
    expect(clearStateCookieHeader(https)).toContain("; Secure");
    expect(stateCookieHeader("abc", http)).not.toContain("Secure");
    expect(clearStateCookieHeader(http)).not.toContain("Secure");
  });
});
