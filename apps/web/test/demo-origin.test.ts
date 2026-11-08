import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { encodeAgentKey } from "@botfare/contracts";
import { generateAgentKeyPair } from "@botfare/x402-paypal";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  createRewritingFetch,
  demoOriginRewrite,
  demoPublicOrigin,
  rewriteUrl,
} from "../src/lib/server/demo-origin";
import { createResearchDeps, selectSites } from "../src/lib/server/research-runtime";

// The demo as the web container reaches it on the compose network (http://demo:4000 in Docker).
const seen: { url: string; headers: IncomingHttpHeaders }[] = [];
let internal: Server;
let internalOrigin = "";

beforeAll(async () => {
  internal = createServer((req, res) => {
    seen.push({ url: req.url ?? "", headers: req.headers });
    if (req.url === "/catalog.json") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ articles: [{ url: "http://localhost:4399/a", title: "A" }] }));
      return;
    }
    res.setHeader("content-type", "text/html");
    res.end("<article>free</article>");
  });
  await new Promise<void>((resolve) => internal.listen(0, "127.0.0.1", resolve));
  internalOrigin = `http://127.0.0.1:${(internal.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => internal.close(() => resolve())));
afterEach(() => {
  seen.length = 0;
  vi.unstubAllEnvs();
});

// Nothing listens here: a request that is not rewritten fails.
const PUBLIC = "http://localhost:4399";

describe("demo origin mapping", () => {
  it("is off unless DEMO_INTERNAL_URL and a public origin are set", () => {
    expect(demoOriginRewrite({})).toBeNull();
    expect(demoOriginRewrite({ DEMO_INTERNAL_URL: "http://demo:4000" })).toBeNull();
    expect(demoOriginRewrite({ DEMO_PUBLIC_URL: PUBLIC })).toBeNull();
    expect(
      demoOriginRewrite({ DEMO_PUBLIC_URL: PUBLIC, DEMO_INTERNAL_URL: "not a url" }),
    ).toBeNull();
    expect(
      demoOriginRewrite({ DEMO_PUBLIC_URL: `${PUBLIC}/`, DEMO_INTERNAL_URL: "http://demo:4000/x" }),
    ).toEqual({ from: PUBLIC, to: "http://demo:4000" });
    // DEMO_ORIGIN (what pnpm seed registers) is the fallback public origin.
    expect(demoPublicOrigin({ DEMO_ORIGIN: "http://localhost:4300" })).toBe(
      "http://localhost:4300",
    );
    expect(demoPublicOrigin({ DEMO_PUBLIC_URL: PUBLIC, DEMO_ORIGIN: "http://x.test" })).toBe(
      PUBLIC,
    );
  });

  it("rewrites only the exact public origin, keeping path and query", () => {
    const rewrite = { from: PUBLIC, to: "http://demo:4000" };
    expect(rewriteUrl(`${PUBLIC}/api/brew-ratio?dose=18`, rewrite)).toBe(
      "http://demo:4000/api/brew-ratio?dose=18",
    );
    expect(rewriteUrl("http://localhost:4000/articles/a", rewrite)).toBe(
      "http://localhost:4000/articles/a",
    );
    expect(rewriteUrl("https://localhost:4399/a", rewrite)).toBe("https://localhost:4399/a");
    expect(rewriteUrl("http://localhost:4399.evil.test/a", rewrite)).toBe(
      "http://localhost:4399.evil.test/a",
    );
    expect(rewriteUrl(`${PUBLIC}/a`, null)).toBe(`${PUBLIC}/a`);
  });

  it("sends demo requests to the internal origin with the public host forwarded", async () => {
    const base = vi.fn(globalThis.fetch);
    const fetchImpl = createRewritingFetch({ from: PUBLIC, to: internalOrigin }, base);
    const res = await fetchImpl(`${PUBLIC}/articles/burr-basics?x=1`, {
      headers: { "x-botfare-agent": "1" },
    });
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe("/articles/burr-basics?x=1");
    expect(seen[0]?.headers["x-forwarded-host"]).toBe("localhost:4399");
    expect(seen[0]?.headers["x-forwarded-proto"]).toBe("http");
    expect(seen[0]?.headers["x-botfare-agent"]).toBe("1");
    // Other origins pass straight through to the base fetch.
    const other = createRewritingFetch(
      { from: "http://elsewhere.test", to: "http://demo:4000" },
      base,
    );
    await other(`${internalOrigin}/plain`);
    expect(seen[1]?.headers["x-forwarded-host"]).toBeUndefined();
  });

  it("is used by the research agent's catalog reads and agent fetches", async () => {
    vi.stubEnv("DEMO_PUBLIC_URL", PUBLIC);
    vi.stubEnv("DEMO_INTERNAL_URL", internalOrigin);
    const { privateJwk } = await generateAgentKeyPair();
    const deps = createResearchDeps({
      ok: true,
      apiKey: "test-key-not-used",
      agentKey: encodeAgentKey({
        v: 1,
        keyId: "ak_test",
        privateJwk: privateJwk as Parameters<typeof encodeAgentKey>[0]["privateJwk"],
      }),
      model: "test-model",
    });
    const site = { id: "site_demo", name: "Crema Notes", origin: PUBLIC };
    const catalog = await deps.fetchCatalog(site, new AbortController().signal);
    expect(catalog).toMatchObject({ articles: [{ title: "A" }] });

    const agent = deps.createAgent({ maxPerRequestCents: 10, onWire: () => {} });
    // A 200 is not an offer: nothing to pay, and the request went to the internal origin.
    expect(await agent.getOffer(`${PUBLIC}/articles/burr-basics`)).toBeNull();
    const article = seen.find((r) => r.url === "/articles/burr-basics");
    expect(article?.headers["x-forwarded-host"]).toBe("localhost:4399");
    // Signed for the public host the publisher will check it against.
    expect(article?.headers["signature-input"]).toContain('"@authority"');
  });

  it("trusts the public origin in production's private-host filter", () => {
    const rows = [
      { id: "site_demo", name: "Crema", origin: "http://localhost:4300", createdAt: new Date(1) },
      { id: "site_lan", name: "LAN", origin: "http://10.0.0.8:4000", createdAt: new Date(2) },
    ];
    expect(
      selectSites(rows, { production: true, trustedOrigins: ["http://localhost:4300"] }).map(
        (s) => s.id,
      ),
    ).toEqual(["site_demo"]);
  });
});
