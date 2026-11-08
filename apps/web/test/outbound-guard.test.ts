import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assertPublicHost,
  createGuardedFetch,
  isPrivateAddress,
  isPrivateHostname,
} from "../src/lib/server/outbound-guard";

let server: Server;
let origin = "";
const hits: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    hits.push(req.url ?? "");
    if (req.url === "/paid-bounce") {
      res.writeHead(302, { location: `${origin}/internal-secret`, "payment-response": "receipt" });
      res.end("Found. Redirecting");
      return;
    }
    if (req.url === "/bounce") {
      res.writeHead(302, { location: `${origin}/internal-secret` });
      res.end();
      return;
    }
    res.end("ok");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe("private addresses", () => {
  it("covers IPv4 private, loopback, link-local, CGNAT and reserved ranges", () => {
    for (const address of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "224.0.0.1",
      "255.255.255.255",
    ]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
    for (const address of ["8.8.8.8", "172.32.0.1", "100.128.0.1", "93.184.216.34"]) {
      expect(isPrivateAddress(address), address).toBe(false);
    }
  });

  it("covers IPv6 loopback, unspecified, mapped, NAT64, 6to4, ULA and link-local forms", () => {
    for (const address of [
      "::1",
      "::",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "0:0:0:0:0:ffff:a00:1",
      "::127.0.0.1",
      "64:ff9b::a9fe:a9fe",
      "2002:7f00:1::",
      "fd00::1",
      "fe80::1%en0",
      "ff02::1",
      "not an address",
    ]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
    for (const address of ["2606:4700::1111", "::ffff:8.8.8.8", "2002:808:808::"]) {
      expect(isPrivateAddress(address), address).toBe(false);
    }
  });

  it("checks hostnames as the URL parser normalizes them", () => {
    const host = (url: string) => new URL(url).hostname;
    expect(host("http://[::ffff:127.0.0.1]:10000")).toBe("[::ffff:7f00:1]");
    expect(isPrivateHostname(host("http://[::ffff:127.0.0.1]:10000"))).toBe(true);
    expect(isPrivateHostname(host("http://[::]:80"))).toBe(true);
    expect(isPrivateHostname(host("http://2130706433/"))).toBe(true);
    expect(isPrivateHostname("app.localhost")).toBe(true);
    expect(isPrivateHostname("crema.example")).toBe(false);
  });

  it("refuses names that resolve to a private address", async () => {
    const resolve = async (name: string) =>
      name === "127.0.0.1.nip.io"
        ? ["127.0.0.1"]
        : name === "mixed.test"
          ? ["8.8.8.8", "::1"]
          : ["8.8.8.8"];
    await expect(assertPublicHost("127.0.0.1.nip.io", resolve)).rejects.toThrow(/private/);
    await expect(assertPublicHost("mixed.test", resolve)).rejects.toThrow(/private/);
    await expect(assertPublicHost("public.test", resolve)).resolves.toBeUndefined();
    const failing = async () => {
      throw new Error("ENOTFOUND");
    };
    await expect(assertPublicHost("missing.test", failing)).rejects.toThrow(/resolved/);
  });
});

describe("guarded fetch", () => {
  it("never follows redirects", async () => {
    hits.length = 0;
    const guarded = createGuardedFetch(globalThis.fetch, { checkAddresses: false });
    await expect(guarded(`${origin}/bounce`)).rejects.toThrow(/redirect/);
    expect(hits).toEqual(["/bounce"]);
    expect(await (await guarded(`${origin}/page`)).text()).toBe("ok");
  });

  it("returns a redirect the publisher settled a payment for, without following it", async () => {
    hits.length = 0;
    const guarded = createGuardedFetch(globalThis.fetch, { checkAddresses: false });
    const response = await guarded(`${origin}/paid-bounce`);
    expect(response.status).toBe(302);
    expect(response.headers.get("payment-response")).toBe("receipt");
    expect(await response.text()).toBe("Found. Redirecting");
    expect(hits).toEqual(["/paid-bounce"]);
  });

  it("in production, refuses private hosts unless the origin is trusted", async () => {
    hits.length = 0;
    const mapped = origin.replace("127.0.0.1", "[::ffff:127.0.0.1]");
    const guarded = createGuardedFetch(globalThis.fetch, {
      checkAddresses: true,
      trustedOrigins: [origin],
      resolve: async () => ["127.0.0.1"],
    });
    await expect(guarded(`${mapped}/x`)).rejects.toThrow(/private/);
    await expect(guarded("http://rebound.test/x")).rejects.toThrow(/private/);
    await expect(guarded("http://localhost:1/x")).rejects.toThrow(/private/);
    expect(hits).toEqual([]);
    // The configured demo origin is reached even on a private address.
    expect((await guarded(`${origin}/page`)).status).toBe(200);
  });
});
