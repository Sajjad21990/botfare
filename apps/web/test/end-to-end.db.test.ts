/**
 * The whole x402 round trip over real HTTP: an @x402/fetch agent pays a publisher running
 * botfare() (@x402/express), whose facilitator is this app's route handlers on Postgres.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { AGENT_HEADER } from "@botfare/contracts";
import { earningsBalanceMicros, listReceipts, walletBalanceMicros } from "@botfare/core";
import { botfare } from "@botfare/express";
import { PAYPAL_SANDBOX } from "@botfare/x402-paypal";
import { decodePaymentResponseHeader } from "@x402/core/http";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as siteConfig } from "../src/app/api/sites/[siteId]/config/route";
import { POST as settle } from "../src/app/api/x402/settle/route";
import { GET as supported } from "../src/app/api/x402/supported/route";
import { POST as verify } from "../src/app/api/x402/verify/route";
import { closeDb, getDb } from "../src/lib/server/db";
import { resetFacilitator } from "../src/lib/server/facilitator";
import { makeAgent, makePublisher, useTestDatabase } from "./helpers";

type Handler = (request: Request) => Response | Promise<Response>;

/** Serves the app's route handlers over node:http, like `next start` would. */
function routeHandlers(request: Request): Promise<Response> | Response {
  const { pathname } = new URL(request.url);
  const routes: Record<string, Handler> = {
    "GET /api/x402/supported": () => supported(),
    "POST /api/x402/verify": verify,
    "POST /api/x402/settle": settle,
  };
  const config = /^\/api\/sites\/([^/]+)\/config$/.exec(pathname);
  if (request.method === "GET" && config?.[1]) {
    const siteId = decodeURIComponent(config[1]);
    return siteConfig(request, { params: Promise.resolve({ siteId }) });
  }
  const route = routes[`${request.method} ${pathname}`];
  return route ? route(request) : new Response("not found", { status: 404 });
}

function listen(server: Server): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
            server.closeAllConnections();
          }),
      });
    });
  });
}

function startBotFare() {
  return listen(
    createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) {
        if (typeof value === "string") headers.set(name, value);
      }
      const hasBody = req.method !== "GET" && req.method !== "HEAD";
      const response = await routeHandlers(
        new Request(`http://${req.headers.host}${req.url}`, {
          method: req.method,
          headers,
          body: hasBody ? Buffer.concat(chunks) : undefined,
        }),
      );
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    }),
  );
}

let botfareServer: Awaited<ReturnType<typeof startBotFare>>;
beforeAll(async () => {
  useTestDatabase();
  botfareServer = await startBotFare();
});
afterAll(async () => {
  await botfareServer?.close();
  resetFacilitator();
  await closeDb();
});

describe("agent → publisher → BotFare facilitator", () => {
  it("pays 3¢ for an article and settles into the Postgres ledger", async () => {
    const db = getDb();
    const publisher = await makePublisher(db);
    const agent = await makeAgent(db, 100);

    const app = express();
    app.use(
      botfare({
        siteId: publisher.site.id,
        siteSecret: publisher.siteSecret,
        botfareUrl: botfareServer.url,
        logger: () => {},
      }),
    );
    app.get("/articles/:slug", (req, res) => {
      res.type("html").send(`<h1>${req.params.slug}</h1>`);
    });
    const site = await listen(createServer(app));

    try {
      const agentFetch: typeof fetch = (input, init) => {
        const headers = new Headers(
          init?.headers ?? (input instanceof Request ? input.headers : undefined),
        );
        headers.set(AGENT_HEADER, "e2e-agent");
        return fetch(input, { ...init, headers });
      };
      const payingFetch = wrapFetchWithPayment(
        agentFetch,
        new x402Client().register(PAYPAL_SANDBOX, agent.client),
      );

      // The middleware loads its config and /supported lazily; the first agent call may 503.
      let res = await payingFetch(`${site.url}/articles/grinders`);
      for (let i = 0; i < 20 && res.status === 503; i++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        res = await payingFetch(`${site.url}/articles/grinders`);
      }
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("grinders");

      const receipt = decodePaymentResponseHeader(res.headers.get("payment-response") ?? "");
      expect(receipt).toMatchObject({ success: true, network: "paypal:sandbox" });
      expect(receipt.transaction).toMatch(/^rcpt_/);

      expect(await walletBalanceMicros(db, agent.owner.id)).toBe(970_000);
      expect(await earningsBalanceMicros(db, publisher.owner.id)).toBe(28_500);
      const [stored] = await listReceipts(db, { siteId: publisher.site.id });
      expect(stored?.id).toBe(receipt.transaction);
    } finally {
      await site.close();
    }
  });
});
