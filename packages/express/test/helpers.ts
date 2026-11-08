import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  AGENT_HEADER,
  DEFAULT_DETECTION,
  FACILITATOR_PATH,
  parseSiteAuthHeader,
  SIGNATURE_DIRECTORY_PATH,
  type SiteConfig,
} from "@botfare/contracts";
import {
  generateAgentKeyPair,
  InMemoryLedger,
  PAYPAL_SANDBOX,
  PrepaidPayPalClient,
  PrepaidPayPalFacilitator,
} from "@botfare/x402-paypal";
import { x402Facilitator } from "@x402/core/facilitator";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import express from "express";
import { type BotFareOptions, botfare } from "../src";

export const SITE_ID = "site_0123456789abcdef";
export const SITE_SECRET = "test-site-secret";

export function siteConfig(overrides: Partial<SiteConfig> = {}): SiteConfig {
  return {
    siteId: SITE_ID,
    name: "Brewlab (test)",
    origin: "http://brewlab.test",
    network: "paypal:sandbox",
    pricing: [
      {
        pattern: "/articles/*",
        method: "GET",
        priceCents: 3,
        audience: "agents",
        description: "Full article",
        mimeType: "text/html",
      },
      {
        pattern: "/api/brew-ratio",
        method: "GET",
        priceCents: 2,
        audience: "everyone",
        description: "Brew ratio API",
        mimeType: "application/json",
      },
    ],
    freePaths: ["/articles/free-*"],
    chargeKnownBots: false,
    // Detection off unless a test turns it on, so the classic flows stay simple.
    detection: { ...DEFAULT_DETECTION, level: "off" },
    version: "v1",
    ...overrides,
  };
}

/** A site config with the given detection settings merged over the defaults. */
export function detectionConfig(
  detection: Partial<SiteConfig["detection"]>,
  overrides: Partial<SiteConfig> = {},
): SiteConfig {
  return siteConfig({ detection: { ...DEFAULT_DETECTION, ...detection }, ...overrides });
}

export interface Listening {
  url: string;
  close: () => Promise<void>;
}

export function listen(app: express.Express): Promise<Listening> {
  return new Promise((resolve) => {
    const server: Server = app.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
            server.closeAllConnections(); // drop keep-alive sockets so the port really goes away
          }),
      });
    });
  });
}

/** In-process BotFare: site config plus the x402 facilitator over an in-memory ledger. */
export async function startFakeBotFare(initial: SiteConfig = siteConfig()) {
  let config = initial;
  const calls: string[] = [];
  /** Requirements the facilitator was asked to settle (to check extra.botfareSignal). */
  const settled: Array<{ extra?: Record<string, unknown> }> = [];
  /** Public JWKs served at the signature directory. */
  let directoryKeys: object[] = [];
  const ledger = new InMemoryLedger();
  const facilitator = new x402Facilitator().register(
    PAYPAL_SANDBOX,
    new PrepaidPayPalFacilitator({ ledger }),
  );

  const authorized = (req: express.Request) => {
    const auth = parseSiteAuthHeader(req.get("authorization"));
    return auth?.siteId === SITE_ID && auth.siteSecret === SITE_SECRET;
  };

  const app = express().use(express.json());
  app.use((req, _res, next) => {
    calls.push(`${req.method} ${req.path}`);
    next();
  });
  app.get("/api/sites/:id/config", (req, res) => {
    if (!authorized(req) || req.params.id !== SITE_ID) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    res.json(config);
  });
  app.get(SIGNATURE_DIRECTORY_PATH, (_req, res) => {
    res.type("application/http-message-signatures-directory+json").send({ keys: directoryKeys });
  });
  app.get(`${FACILITATOR_PATH}/supported`, (_req, res) => {
    res.json(facilitator.getSupported());
  });
  app.post(`${FACILITATOR_PATH}/:op`, async (req, res) => {
    if (!authorized(req)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const { paymentPayload, paymentRequirements } = req.body;
    if (req.params.op === "verify") {
      res.json(await facilitator.verify(paymentPayload, paymentRequirements));
    } else if (req.params.op === "settle") {
      settled.push(paymentRequirements);
      res.json(await facilitator.settle(paymentPayload, paymentRequirements));
    } else {
      res.status(404).end();
    }
  });

  const server = await listen(app);
  return {
    ...server,
    ledger,
    calls,
    settled,
    setConfig(next: SiteConfig) {
      config = next;
    },
    setDirectoryKeys(keys: object[]) {
      directoryKeys = keys;
    },
  };
}

/** Publisher site behind botfare(): articles, a free page and a paid API. */
export async function startPublisher(
  options: Partial<BotFareOptions> & { botfareUrl: string; trustProxy?: boolean },
) {
  const { trustProxy, ...botfareOptions } = options;
  const logs: string[] = [];
  const app = express();
  // Lets tests choose the client IP with X-Forwarded-For (known-crawler checks).
  if (trustProxy) app.set("trust proxy", true);
  app.use(
    botfare({
      siteId: SITE_ID,
      siteSecret: SITE_SECRET,
      logger: (msg) => logs.push(msg),
      preview: (req) => ({
        title: `Preview of ${req.path}`,
        excerpt: "Burr grinders crush beans between two abrasive surfaces...",
        wordCount: 1200,
      }),
      ...botfareOptions,
    }),
  );
  app.get("/articles/:slug", (req, res) => {
    res.type("html").send(`<h1>${req.params.slug}</h1><p>The full article.</p>`);
  });
  app.get("/api/brew-ratio", (_req, res) => {
    res.json({ ratio: "1:16" });
  });
  app.get("/about", (_req, res) => {
    res.send("About us");
  });
  const server = await listen(app);
  return { ...server, logs };
}

/** An agent with a funded wallet, paying through the official @x402/fetch wrapper. */
export async function createAgent(ledger: InMemoryLedger, balanceCents = 100) {
  const keyId = "ak_test";
  const { publicJwk, privateJwk } = await generateAgentKeyPair();
  ledger.addKey({ keyId, publicJwk, walletId: "owner" });
  ledger.topUp("owner", balanceCents);

  const agentFetch: typeof fetch = (input, init) => {
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : {}));
    headers.set(AGENT_HEADER, "test-agent");
    return fetch(input, { ...init, headers });
  };
  const client = new x402Client().register(
    PAYPAL_SANDBOX,
    new PrepaidPayPalClient({ keyId, privateJwk }),
  );
  return {
    /** Sends the agent header but never pays. */
    fetch: agentFetch,
    /** Pays the 402 and retries. */
    payingFetch: wrapFetchWithPayment(agentFetch, client),
    /** Pays through a custom underlying fetch (e.g. one that rewrites the 402). */
    payingFetchWith: (base: typeof fetch) => wrapFetchWithPayment(base, client),
    wallet: () => ledger.balanceMicros("wallet:owner"),
  };
}

/** A stand-in for Cloudflare siteverify: passes exactly the token "pass-token". */
export async function startFakeTurnstile() {
  const requests: Record<string, string>[] = [];
  const app = express().use(express.urlencoded({ extended: false }));
  app.post("/siteverify", (req, res) => {
    requests.push(req.body);
    const success = req.body.response === "pass-token" && req.body.secret === "test-secret";
    res.json(
      success
        ? { success: true, "error-codes": [], hostname: "example.com" }
        : { success: false, "error-codes": ["invalid-input-response"] },
    );
  });
  const server = await listen(app);
  return { ...server, verifyUrl: `${server.url}/siteverify`, requests };
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
