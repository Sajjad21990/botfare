/**
 * `pnpm e2e`: end to end on real processes and the local Postgres.
 *
 * Starts the BotFare web app (reused if already up on WEB_PORT) and the Saffron & Salt demo
 * (DEMO_PORT) with the values `pnpm seed` wrote to .env, then pays for recipes with the agent SDK
 * and checks every ledger movement, and checks agent detection (who pays, and why) against the
 * seeded demo site settings (standard level, Turnstile test key). Prints PASS / FAIL lines and
 * exits non-zero on any FAIL.
 *
 * Environment:
 * - WEB_PORT (default 3000), DEMO_PORT (default 4000): run beside a dev setup with
 *   `WEB_PORT=3100 DEMO_PORT=4100 E2E_WEB=start pnpm e2e`.
 * - E2E_WEB: how to start the web app when nothing answers on WEB_PORT: `dev` (next dev, the
 *   default) or `start` (next start on the last `pnpm --filter @botfare/web build`; use it when a
 *   next dev already runs on another port, since Next allows one dev server per app directory).
 * - E2E_VERBOSE=1 streams the child processes' logs.
 * - E2E_AI=1 (with any AI provider key, or OLLAMA_BASE_URL, in .env) keeps the provider settings
 *   for the web app this run starts and adds an optional check that the AI judge refunds a stub. By
 *   default the web app starts with every provider setting blanked, so Fare Court's no-AI path
 *   (the publisher decides) is what the required checks cover.
 *
 * The human-check step posts Cloudflare's dummy Turnstile token, so the demo calls Cloudflare's
 * real siteverify with the always-pass test secret: it needs network access.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  AGENT_HEADER,
  DEMO_SITE_NAME,
  decodeAgentKey,
  FACILITATOR_PATH,
  siteAuthHeader,
  siteConfigPath,
} from "@botfare/contracts";
import { contentDigestSha256, REQUIREMENT_EXTRA_KEYS } from "@botfare/contracts/fare";
import {
  checkAnswerSource,
  decodeStatement,
  RECEIPT_JWT_TYPE,
  RECEIPT_KEYS_PATH,
  type ReceiptStatements,
  receiptStatementsPath,
  SETTLE_EXTRA_RECEIPT_KEY,
  verifyStatement,
} from "@botfare/contracts/receipts";
import {
  Accounts,
  accountBalanceMicros,
  checkLedgerInvariants,
  createDb,
  type Db,
  getAgentKeyById,
  getReceipt,
  getSite,
  listReceipts,
  type Site,
} from "@botfare/core";
import { BOTFARE_SIGNAL_EXTRA, HUMAN_CHECK_PATH, HUMAN_PASS_COOKIE } from "@botfare/express";
import {
  type BotFareAgent,
  BotFareSpendLimitError,
  createBotFareAgent,
  type WireEvent,
} from "@botfare/sdk";
import { PAYPAL_SANDBOX, PrepaidPayPalClient } from "@botfare/x402-paypal";
import { decodePaymentRequiredHeader, decodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentPayload, SettleResponse } from "@x402/core/types";
import { decodePaymentResponseHeader, wrapFetchWithPayment, x402Client } from "@x402/fetch";
import type { JSONWebKeySet, JWK } from "jose";
import { FARE_COURT_STUB_PATH, FARE_COURT_STUB_SLUG } from "../apps/demo/src/app";
import { loadArticles } from "../apps/demo/src/content";
import { NUTRITION } from "../apps/demo/src/nutrition";
import { loadRootEnv, ROOT, requireEnv } from "./lib/env-file";
import { DEMO_PAGES, NUTRITION_PATH } from "./lib/traffic";

function port(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`${name} must be a TCP port, got ${process.env[name]}`);
  }
  return value;
}

const WEB_PORT = port("WEB_PORT", 3000);
const DEMO_PORT = port("DEMO_PORT", 4000);
const WEB_MODE = process.env.E2E_WEB === "start" ? "start" : "dev";
const WEB_URL = `http://localhost:${WEB_PORT}`;
const DEMO_URL = `http://localhost:${DEMO_PORT}`;
/** The 50¢ chapter the 10¢-capped agent may not buy, and the pricing rule the Advisor changes. */
const COOKBOOK_PATH = DEMO_PAGES.cookbook;
const COOKBOOK_PATTERN = "/cookbook/*";
const VERBOSE = process.env.E2E_VERBOSE === "1";
/** Every AI provider setting, blanked for the web app this run starts unless E2E_AI is on. */
const AI_PROVIDER_ENV = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "XAI_API_KEY",
  "GROQ_API_KEY",
  "OPENROUTER_API_KEY",
  "OLLAMA_BASE_URL",
];
const NO_AI_PROVIDERS = Object.fromEntries(AI_PROVIDER_ENV.map((name) => [name, ""]));

/**
 * Start the web app with its AI provider settings and run the optional AI judge check (never
 * required). Set in main() after .env is loaded, since the keys usually live there.
 */
let E2E_AI = false;
/** True when this run started the web app (so it knows whether an AI judge is configured). */
let WEB_STARTED_BY_E2E = false;

/** What Chrome 130 on macOS sends for a top-level navigation (a person clicking a link). */
const CHROME_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  "Sec-Ch-Ua": '"Chromium";v="130", "Google Chrome";v="130", "Not?A_Brand";v="99"',
  "Sec-Ch-Ua-Mobile": "?0",
  "Sec-Ch-Ua-Platform": '"macOS"',
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-User": "?1",
  "Sec-Fetch-Dest": "document",
  "Upgrade-Insecure-Requests": "1",
};
const HEADLESS_CHROME_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/130.0.0.0 Safari/537.36";
const GPTBOT_UA =
  "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot";
/** Cloudflare's dummy token: what the test site key's widget yields; the test secret accepts it. */
const TURNSTILE_DUMMY_TOKEN = "XXXX.DUMMY.TOKEN.XXXX";

// ---------------------------------------------------------------------------------------------
// Output

let failures = 0;

function pass(name: string, detail = ""): void {
  console.log(`PASS ${name}${detail ? ` (${detail})` : ""}`);
}

function fail(name: string, detail: string): void {
  failures++;
  console.log(`FAIL ${name}: ${detail}`);
}

/** Runs one check; a thrown error is a FAIL with its message. */
async function check(name: string, run: () => Promise<string | undefined>): Promise<void> {
  try {
    const detail = await run();
    pass(name, detail ?? "");
  } catch (err) {
    fail(name, err instanceof Error ? err.message : String(err));
  }
}

function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

// ---------------------------------------------------------------------------------------------
// Child processes

interface Child {
  name: string;
  process: ChildProcess;
  log: string[];
}

const children: Child[] = [];

/** Spawns `pnpm <args>` in its own process group so the whole tree can be stopped. */
function start(name: string, args: string[], env: NodeJS.ProcessEnv): Child {
  const child = spawn("pnpm", args, {
    cwd: ROOT,
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const entry: Child = { name, process: child, log: [] };
  const collect = (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n")) {
      if (!line.trim()) continue;
      entry.log.push(line);
      if (entry.log.length > 200) entry.log.shift();
      if (VERBOSE) console.log(`  [${name}] ${line}`);
    }
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  children.push(entry);
  return entry;
}

async function stopAll(): Promise<void> {
  await Promise.all(
    children.map(async ({ process: child }) => {
      if (child.exitCode !== null || child.pid === undefined) return;
      const exited = new Promise<void>((done) => child.once("exit", () => done()));
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        return;
      }
      const timer = setTimeout(() => {
        try {
          if (child.pid) process.kill(-child.pid, "SIGKILL");
        } catch {}
      }, 5_000);
      await exited;
      clearTimeout(timer);
    }),
  );
}

function printLogs(): void {
  for (const child of children) {
    console.log(`\n--- last lines from ${child.name} ---`);
    console.log(child.log.slice(-40).join("\n") || "(no output)");
  }
}

async function isUp(url: string, accept: (body: unknown) => boolean): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    return response.ok && accept(await response.json());
  } catch {
    return false;
  }
}

/** True when anything at all answers HTTP at `url`. */
async function answers(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    await response.body?.cancel();
    return true;
  } catch {
    return false;
  }
}

async function waitFor(
  label: string,
  url: string,
  accept: (body: unknown) => boolean,
  timeoutMs: number,
  child?: Child,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isUp(url, accept)) return;
    if (child && child.process.exitCode !== null) {
      throw new Error(`${label} exited with code ${child.process.exitCode}`);
    }
    await new Promise((done) => setTimeout(done, 500));
  }
  throw new Error(`${label} did not answer ${url} within ${timeoutMs / 1000}s`);
}

// ---------------------------------------------------------------------------------------------
// Ledger helpers

interface Balances {
  wallet: number;
  earnings: number;
  fees: number;
  receipts: number;
}

async function balances(db: Db, ownerUserId: string, publisherUserId: string, keyId: string) {
  const [wallet, earnings, fees, receipts] = await Promise.all([
    accountBalanceMicros(db, Accounts.wallet(ownerUserId)),
    accountBalanceMicros(db, Accounts.earnings(publisherUserId)),
    accountBalanceMicros(db, Accounts.platformFees),
    listReceipts(db, { agentKeyId: keyId, limit: 500 }),
  ]);
  return { wallet, earnings, fees, receipts: receipts.length } satisfies Balances;
}

function delta(before: Balances, after: Balances) {
  return {
    wallet: after.wallet - before.wallet,
    earnings: after.earnings - before.earnings,
    fees: after.fees - before.fees,
    receipts: after.receipts - before.receipts,
  };
}

function expectDelta(
  actual: ReturnType<typeof delta>,
  expected: ReturnType<typeof delta>,
  label: string,
): void {
  const keys = ["wallet", "earnings", "fees", "receipts"] as const;
  for (const key of keys) {
    expect(
      actual[key] === expected[key],
      `${label}: ${key} moved ${actual[key]}, expected ${expected[key]}`,
    );
  }
}

/** The detection signal botfare() put in a 402's requirements (`accepts[0].extra.botfareSignal`). */
function signalOf(response: Response): unknown {
  const header = response.headers.get("PAYMENT-REQUIRED");
  if (!header) return undefined;
  return decodePaymentRequiredHeader(header).accepts[0]?.extra?.[BOTFARE_SIGNAL_EXTRA];
}

/** A raw @x402/fetch client (no BotFare SDK, no agent header) sending the given User-Agent. */
function rawPayingFetch(userAgent: string, keyId: string, privateJwk: unknown) {
  const sentAgentHeader: boolean[] = [];
  const base: typeof fetch = (input, init) => {
    const request = new Request(input, init);
    sentAgentHeader.push(request.headers.has(AGENT_HEADER));
    const headers = new Headers(request.headers);
    headers.set("User-Agent", userAgent);
    return fetch(new Request(request, { headers }));
  };
  const client = new x402Client().register(
    PAYPAL_SANDBOX,
    new PrepaidPayPalClient({ keyId, privateJwk: privateJwk as JWK }),
  );
  return { fetch: wrapFetchWithPayment(base, client), sentAgentHeader };
}

const micros = (value: number) => `${value > 0 ? "+" : ""}${value.toLocaleString("en-US")}`;

// ---------------------------------------------------------------------------------------------
// Signed receipts

/** BotFare's public receipt keys, fetched from the web app under test (never from the database). */
async function fetchReceiptKeys(): Promise<{ jwks: JSONWebKeySet; response: Response }> {
  const response = await fetch(`${WEB_URL}${RECEIPT_KEYS_PATH}`);
  if (!response.ok) throw new Error(`${RECEIPT_KEYS_PATH} answered ${response.status}`);
  return { jwks: (await response.json()) as JSONWebKeySet, response };
}

/** The public statements for a receipt (GET /api/receipts/:id/statements); null on 404. */
async function fetchStatements(receiptId: string): Promise<ReceiptStatements | null> {
  const response = await fetch(`${WEB_URL}${receiptStatementsPath(receiptId)}`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`statements for ${receiptId} answered ${response.status}`);
  return (await response.json()) as ReceiptStatements;
}

/** Waits until BotFare holds a statement of `kind` for the receipt. */
async function waitForStatement(
  receiptId: string,
  kind: "payment" | "delivery" | "refund",
  timeoutMs = 10_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const statements = await fetchStatements(receiptId);
    const token = statements?.[kind];
    if (token) return token;
    if (Date.now() > deadline) {
      throw new Error(`no ${kind} statement for ${receiptId} within ${timeoutMs / 1000}s`);
    }
    await new Promise((done) => setTimeout(done, 500));
  }
}

/** The statement with one claim changed and the original signature kept. */
function tamper(token: string, edit: (claims: Record<string, unknown>) => void): string {
  const [header, payload, signature] = token.split(".");
  const claims = JSON.parse(Buffer.from(payload as string, "base64url").toString("utf8"));
  edit(claims);
  return `${header}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${signature}`;
}

/** JWK members that only a private (or symmetric) key has. */
const PRIVATE_JWK_MEMBERS = ["d", "p", "q", "dp", "dq", "qi", "k", "oth"];

// ---------------------------------------------------------------------------------------------
// Main

async function main(): Promise<void> {
  loadRootEnv();
  E2E_AI = process.env.E2E_AI === "1" && AI_PROVIDER_ENV.some((name) => process.env[name]?.trim());
  const databaseUrl = requireEnv("DATABASE_URL");
  const siteId = requireEnv("BOTFARE_SITE_ID");
  const siteSecret = requireEnv("BOTFARE_SITE_SECRET");
  const agentKey = requireEnv("BOTFARE_AGENT_KEY");
  const auth = siteAuthHeader(siteId, siteSecret);
  // The SDK sends this origin as Signature-Agent; point it at the app under test.
  process.env.BOTFARE_URL = WEB_URL;

  const { db, close } = createDb(databaseUrl, { max: 4 });
  try {
    // Who pays and who earns, from the seeded rows.
    const { keyId, privateJwk } = decodeAgentKey(agentKey);
    const key = await getAgentKeyById(db, keyId);
    const site = await getSite(db, siteId);
    if (!key || !site) {
      throw new Error("The agent key or site in .env is not in the database: run pnpm seed");
    }
    const snapshot = () => balances(db, key.ownerUserId, site.ownerUserId, keyId);

    // 1. Processes.
    const healthy = (body: unknown) => (body as { ok?: boolean; db?: boolean })?.db === true;
    if (await isUp(`${WEB_URL}/api/health`, healthy)) {
      console.log(`Reusing the BotFare app already running on ${WEB_URL}`);
    } else {
      if (await answers(WEB_URL)) {
        throw new Error(`Something that is not the BotFare app is listening on ${WEB_URL}`);
      }
      if (WEB_MODE === "start" && !existsSync(join(ROOT, "apps/web/.next/BUILD_ID"))) {
        throw new Error("E2E_WEB=start needs a build: run pnpm --filter @botfare/web build");
      }
      console.log(`Starting the BotFare app (next ${WEB_MODE}) on ${WEB_URL}`);
      const web = start(
        "web",
        ["--filter", "@botfare/web", "exec", "next", WEB_MODE, "--port", String(WEB_PORT)],
        {
          ...process.env,
          // Without E2E_AI the judge is off (no AI provider at all), so disputes go to the
          // publisher (checked below).
          ...(E2E_AI ? {} : NO_AI_PROVIDERS),
          BOTFARE_URL: WEB_URL,
          // next start refuses to run without one; a throwaway secret is fine for this run.
          SESSION_SECRET: process.env.SESSION_SECRET || randomBytes(32).toString("hex"),
        },
      );
      await waitFor("BotFare app", `${WEB_URL}/api/health`, healthy, 180_000, web);
      WEB_STARTED_BY_E2E = true;
    }
    if (await answers(DEMO_URL)) {
      throw new Error(
        `Something is already listening on ${DEMO_URL}. Stop it: the e2e run starts its own demo with the current site secret.`,
      );
    }
    console.log(`Starting the ${DEMO_SITE_NAME} demo on ${DEMO_URL}`);
    const demo = start("demo", ["--filter", "@botfare/demo", "start"], {
      ...process.env,
      PORT: String(DEMO_PORT),
      HOST: "127.0.0.1",
      BOTFARE_URL: WEB_URL,
      BOTFARE_SITE_ID: siteId,
      BOTFARE_SITE_SECRET: siteSecret,
    });
    await waitFor(
      `${DEMO_SITE_NAME} demo`,
      `${DEMO_URL}/health`,
      (body) => (body as { payments?: string }).payments === "on",
      60_000,
      demo,
    );

    // 2. Warm up: next dev compiles each route on first use, and botfare() needs the site config.
    await fetch(`${WEB_URL}${FACILITATOR_PATH}/supported`);
    for (const op of ["verify", "settle", "refund"]) {
      await fetch(`${WEB_URL}${FACILITATOR_PATH}/${op}`, { method: "POST" });
    }
    const config = await fetch(`${WEB_URL}${siteConfigPath(siteId)}`, {
      headers: { Authorization: auth },
    });
    if (!config.ok) throw new Error(`Site config answered ${config.status}: check the site secret`);

    // A 2¢ recipe: read free by a person, offered, bought, replayed and refunded below.
    const articleUrl = `${DEMO_URL}${DEMO_PAGES.dal}`;
    const wire: WireEvent[] = [];
    const agent = createBotFareAgent({
      agentKey,
      botfareUrl: WEB_URL,
      onWire: (event) => wire.push(event),
    });

    const warmDeadline = Date.now() + 30_000;
    while ((await agent.getOffer(articleUrl).catch(() => null)) === null) {
      if (Date.now() > warmDeadline) throw new Error("The demo never asked an agent to pay");
      await new Promise((done) => setTimeout(done, 1_000));
    }
    wire.length = 0;
    console.log("Both services are up\n");

    // 3. Checks.
    await check("Human in a real browser (full Chrome headers) reads a recipe free", async () => {
      const response = await fetch(articleUrl, { headers: CHROME_HEADERS });
      const html = await response.text();
      expect(response.status === 200, `status ${response.status}`);
      expect(!response.headers.has("PAYMENT-REQUIRED"), "a human got PAYMENT-REQUIRED");
      expect(html.includes("<article"), "no article body in the page");
      return `200, ${html.length} bytes, no payment headers at level standard`;
    });

    await check("getOffer reads price and preview, moves no money", async () => {
      const before = await snapshot();
      const offer = await agent.getOffer(articleUrl);
      const after = await snapshot();
      expect(offer, "no 402 offer");
      expect(offer.priceCents === 2, `price ${offer.priceCents}¢, expected 2¢`);
      expect(offer.payTo === siteId, `payTo ${offer.payTo}`);
      expect(offer.preview?.title, "no preview title");
      expect((offer.preview?.excerpt.length ?? 0) > 50, "preview excerpt is too short");
      expectDelta(delta(before, after), { wallet: 0, earnings: 0, fees: 0, receipts: 0 }, "offer");
      return `${offer.priceUsd}, "${offer.preview.title}"`;
    });

    let receiptId = "";
    let nutritionReceiptId = "";
    let signatureHeader = "";
    /** The paid recipe as the agent received it, and the PAYMENT-RESPONSE statement. */
    let articleBytes: Uint8Array | null = null;
    let articleReadDigest: string | null = null;
    let paymentStatement = "";
    const beforePay = await snapshot();
    await check("Agent pays 2¢ and gets the recipe with a receipt", async () => {
      wire.length = 0;
      const result = await agent.fetch(articleUrl);
      const body = await result.response.text();
      expect(result.response.status === 200, `status ${result.response.status}`);
      expect(result.paid && result.receipt?.success, "no successful PAYMENT-RESPONSE");
      expect(result.receipt.transaction.startsWith("rcpt_"), "transaction is not a receipt ID");
      expect(result.receipt.payer === keyId, `payer ${result.receipt.payer}`);
      expect(body.includes("<article"), "no recipe in the paid response");
      const stages = wire.map((event) => event.stage).join(" -> ");
      expect(
        stages === "payment-required -> payment-signature -> payment-response",
        `wire stages ${stages}`,
      );
      const signed = wire.find((event) => event.stage === "payment-signature");
      signatureHeader = signed?.header ?? "";
      receiptId = result.receipt.transaction;
      articleBytes = result.body;
      articleReadDigest = result.readDigest;
      // The raw PAYMENT-RESPONSE header as the publisher sent it, decoded here (not by the SDK).
      const settled = wire.find((event) => event.stage === "payment-response");
      const raw = settled ? decodePaymentResponseHeader(settled.header) : null;
      const statement = raw?.extra?.[SETTLE_EXTRA_RECEIPT_KEY];
      paymentStatement = typeof statement === "string" ? statement : "";
      return `200, ${receiptId}, wire: ${stages}`;
    });

    await check(
      "Ledger moved exactly: wallet -20,000, publisher +19,000, BotFare +1,000",
      async () => {
        const moved = delta(beforePay, await snapshot());
        expectDelta(moved, { wallet: -20_000, earnings: 19_000, fees: 1_000, receipts: 1 }, "pay");
        return `micros: wallet ${micros(moved.wallet)}, earnings ${micros(moved.earnings)}, fees ${micros(moved.fees)}`;
      },
    );

    // Signed receipts: everything below verifies with the public JWKS only.
    let jwks: JSONWebKeySet = { keys: [] };
    await check("Receipt JWKS: public Ed25519 keys only, no private members", async () => {
      const { jwks: published, response } = await fetchReceiptKeys();
      jwks = published;
      expect(
        response.headers.get("content-type")?.startsWith("application/jwk-set+json"),
        `content-type ${response.headers.get("content-type")}`,
      );
      expect(published.keys.length > 0, "no keys published: is BOTFARE_RECEIPT_KEY_SEED set?");
      for (const key of published.keys) {
        const leaked = PRIVATE_JWK_MEMBERS.filter((member) => member in key);
        expect(leaked.length === 0, `key ${key.kid} publishes ${leaked.join(", ")}`);
        expect(
          key.kty === "OKP" && key.crv === "Ed25519",
          `key ${key.kid} is ${key.kty}/${key.crv}`,
        );
        expect(key.kid && key.x, "a key without kid or x");
      }
      return `${published.keys.length} key(s), kid ${published.keys[0]?.kid?.slice(0, 12)}…, ${response.headers.get("cache-control")}`;
    });

    await check(
      "PAYMENT-RESPONSE carries a payment statement that verifies against the JWKS",
      async () => {
        expect(paymentStatement, `no extra.${SETTLE_EXTRA_RECEIPT_KEY} in PAYMENT-RESPONSE`);
        const verified = await verifyStatement(paymentStatement, jwks, {
          issuer: WEB_URL,
          kind: "payment",
        });
        expect(verified.ok, verified.ok ? "" : `${verified.error}: ${verified.message}`);
        const { statement } = verified;
        expect(statement.kind === "payment", `kind ${statement.kind}`);
        const p = statement.payment;
        expect(statement.sub === receiptId, `sub ${statement.sub}, expected ${receiptId}`);
        expect(p.amount === "2" && p.amountMicros === 20_000, `amount ${p.amount}`);
        expect(p.publisherMicros === 19_000 && p.feeMicros === 1_000, "split is not 95/5");
        expect(p.payTo === siteId, `payTo ${p.payTo}`);
        expect(p.payer === keyId, `payer ${p.payer}`);
        expect(p.resource === articleUrl, `resource ${p.resource}`);
        expect(p.signal === "signed-agent", `signal ${p.signal}`);
        expect(p.offerDigest, "no offerDigest for a declared offer");
        // The SDK hands the agent the same statement, and its own verifier agrees.
        const viaSdk = await agent.verifyReceipt(paymentStatement, { receiptId, kind: "payment" });
        expect(viaSdk.ok, viaSdk.ok ? "" : `SDK: ${viaSdk.message}`);
        // BotFare keeps it: the public statements endpoint returns the identical JWS.
        const stored = await fetchStatements(receiptId);
        expect(stored?.payment === paymentStatement, "the statements endpoint differs");
        return `kid ${verified.kid.slice(0, 12)}…, ${p.amount}¢ to ${p.payTo.slice(0, 12)}…, 19,000 + 1,000 micros, signal ${p.signal}`;
      },
    );

    await check("A tampered payment statement does not verify", async () => {
      expect(paymentStatement, "no payment statement");
      const cheaper = tamper(paymentStatement, (claims) => {
        (claims.payment as { amountMicros: number }).amountMicros = 1;
      });
      const otherReceipt = tamper(paymentStatement, (claims) => {
        claims.sub = "rcpt_tampered";
      });
      const [signature] = paymentStatement.split(".").slice(2);
      const flipped = `${paymentStatement.slice(0, -(signature as string).length)}${
        (signature as string)[0] === "A" ? "B" : "A"
      }${(signature as string).slice(1)}`;
      const results = await Promise.all(
        [cheaper, otherReceipt, flipped].map((token) => verifyStatement(token, jwks)),
      );
      const errors = results.map((result) => (result.ok ? "ok" : result.error));
      expect(
        errors.every((error) => error === "bad_signature"),
        `results ${errors.join(", ")}`,
      );
      const forged = decodeStatement(cheaper);
      expect(forged?.kind === "payment", "the tampered claims no longer decode");
      const wrongIssuer = await verifyStatement(paymentStatement, jwks, {
        issuer: "https://not-botfare.example",
      });
      expect(!wrongIssuer.ok && wrongIssuer.error === "wrong_issuer", "issuer not enforced");
      return `amount, receipt and signature edits: ${errors.join(", ")}; other issuer: wrong_issuer`;
    });

    await check(
      "After attestation a delivery statement's digest equals the bytes the agent received",
      async () => {
        expect(articleBytes && paymentStatement, "no paid recipe");
        const digest = await contentDigestSha256(articleBytes);
        expect(articleReadDigest === digest, `SDK readDigest ${articleReadDigest}`);
        const delivery = await waitForStatement(receiptId, "delivery");
        const verified = await verifyStatement(delivery, jwks, {
          issuer: WEB_URL,
          kind: "delivery",
        });
        expect(verified.ok, verified.ok ? "" : `${verified.error}: ${verified.message}`);
        expect(verified.statement.kind === "delivery", "not a delivery statement");
        const d = verified.statement.delivery;
        expect(verified.statement.sub === receiptId, `sub ${verified.statement.sub}`);
        expect(d.contentDigest === digest, `attested ${d.contentDigest}, received ${digest}`);
        expect(d.contentLength === articleBytes.length, `length ${d.contentLength}`);
        // What the research agent's "Verify sources" panel shows: three checks for the source.
        const source = await checkAnswerSource(
          {
            url: articleUrl,
            receiptId,
            claim: "e2e",
            payment: paymentStatement,
            delivery,
            readDigest: articleReadDigest,
          },
          jwks,
          { issuer: WEB_URL },
        );
        const checks = [source.paid, source.delivered, source.bytesMatch];
        expect(
          checks.every((c) => c.ok),
          checks.map((c) => c.message).join("; "),
        );
        return `${d.contentLength} bytes, ${d.contentDigest.slice(0, 22)}…; Paid ✓ Delivered ✓ Bytes match ✓`;
      },
    );

    await check("Replayed PAYMENT-SIGNATURE is refused (nonce_used)", async () => {
      expect(signatureHeader, "no PAYMENT-SIGNATURE was captured");
      const before = await snapshot();
      // At the publisher: the same signed payment again gets a 402, not the content.
      const replay = await fetch(articleUrl, {
        headers: { [AGENT_HEADER]: "1", "PAYMENT-SIGNATURE": signatureHeader },
      });
      await replay.body?.cancel();
      expect(replay.status === 402, `publisher answered ${replay.status}`);
      const required = decodePaymentRequiredHeader(replay.headers.get("PAYMENT-REQUIRED") ?? "");
      expect(required.error === "invalid_prepaid_nonce_used", `publisher reason ${required.error}`);
      // At the facilitator: settle names the receipt the nonce was first charged under.
      const payload: PaymentPayload = decodePaymentSignatureHeader(signatureHeader);
      const settle = await fetch(`${WEB_URL}${FACILITATOR_PATH}/settle`, {
        method: "POST",
        headers: { Authorization: auth, "Content-Type": "application/json" },
        body: JSON.stringify({
          x402Version: payload.x402Version,
          paymentPayload: payload,
          paymentRequirements: payload.accepted,
        }),
      });
      const result = (await settle.json()) as SettleResponse & {
        extra?: { originalTransaction?: string };
      };
      expect(!result.success, "replayed settle succeeded");
      expect(result.errorReason === "invalid_prepaid_nonce_used", `reason ${result.errorReason}`);
      expect(
        result.extra?.originalTransaction === receiptId,
        `originalTransaction ${result.extra?.originalTransaction}, expected ${receiptId}`,
      );
      expectDelta(
        delta(before, await snapshot()),
        { wallet: 0, earnings: 0, fees: 0, receipts: 0 },
        "replay",
      );
      return `publisher 402 ${required.error}; settle originalTransaction ${receiptId}`;
    });

    await check("50¢ cookbook chapter is refused by the 10¢ cap, no charge", async () => {
      const before = await snapshot();
      wire.length = 0;
      let error: unknown;
      try {
        await agent.fetch(`${DEMO_URL}${COOKBOOK_PATH}`);
      } catch (err) {
        error = err;
      }
      expect(
        error instanceof BotFareSpendLimitError,
        `expected BotFareSpendLimitError, got ${String(error)}`,
      );
      expect(error.offer.priceCents === 50, `price ${error.offer.priceCents}`);
      expect(!wire.some((event) => event.stage === "payment-signature"), "a payment was signed");
      expectDelta(
        delta(before, await snapshot()),
        { wallet: 0, earnings: 0, fees: 0, receipts: 0 },
        "cap",
      );
      return `$0.50 > $${(error.maxPerRequestCents / 100).toFixed(2)}, nothing signed`;
    });

    await check(
      "Nutrition API: 402 to a plain fetch, 1¢ for a paying client without the agent header",
      async () => {
        const recipe = "weeknight-red-lentil-dal";
        const nutritionUrl = `${DEMO_URL}${NUTRITION_PATH}?recipe=${recipe}`;
        const plain = await fetch(nutritionUrl);
        await plain.body?.cancel();
        expect(plain.status === 402, `plain fetch got ${plain.status}`);

        // Raw @x402/fetch with the plug-in: no x-botfare-agent header on either request.
        const sentAgentHeader: boolean[] = [];
        const recordingFetch: typeof fetch = (input, init) => {
          const request = new Request(input, init);
          sentAgentHeader.push(request.headers.has(AGENT_HEADER));
          return fetch(request);
        };
        const client = new x402Client().register(
          PAYPAL_SANDBOX,
          new PrepaidPayPalClient({ keyId, privateJwk: privateJwk as JWK }),
        );
        const before = await snapshot();
        const response = await wrapFetchWithPayment(recordingFetch, client)(nutritionUrl);
        const body = (await response.json()) as {
          recipe?: string;
          servings?: number;
          perServing?: Record<string, number>;
        };
        expect(response.status === 200, `paid fetch got ${response.status}`);
        expect(!sentAgentHeader.includes(true), "the agent header was sent");
        const receipt = decodePaymentResponseHeader(response.headers.get("PAYMENT-RESPONSE") ?? "");
        expect(receipt.success, "no successful PAYMENT-RESPONSE");
        // Exactly the figures apps/demo publishes for that recipe.
        const expected = NUTRITION[recipe];
        expect(body.recipe === recipe, `recipe ${body.recipe}`);
        expect(body.servings === expected?.servings, `servings ${body.servings}`);
        expect(
          JSON.stringify(body.perServing) === JSON.stringify(expected?.perServing),
          `per serving ${JSON.stringify(body.perServing)}`,
        );
        const kcal = body.perServing?.kcal;
        expectDelta(
          delta(before, await snapshot()),
          { wallet: -10_000, earnings: 9_500, fees: 500, receipts: 1 },
          "nutrition",
        );
        nutritionReceiptId = receipt.transaction;
        return `402, then 200 with ${receipt.transaction} (${kcal} kcal per serving); wallet -10,000 micros`;
      },
    );

    await check("Refund through POST /api/x402/refund restores the wallet once", async () => {
      expect(receiptId, "no receipt to refund");
      const refund = () =>
        fetch(`${WEB_URL}${FACILITATOR_PATH}/refund`, {
          method: "POST",
          headers: { Authorization: auth, "Content-Type": "application/json" },
          body: JSON.stringify({ transaction: receiptId }),
        });
      const before = await snapshot();
      const first = await refund();
      const firstBody = (await first.json()) as { ok?: boolean; alreadyRefunded?: boolean };
      expect(first.status === 200 && firstBody.ok, `first refund ${first.status}`);
      expect(firstBody.alreadyRefunded === false, "first refund was marked already refunded");
      const afterFirst = await snapshot();
      expectDelta(
        delta(before, afterFirst),
        { wallet: 20_000, earnings: -19_000, fees: -1_000, receipts: 0 },
        "refund",
      );
      const second = await refund();
      const secondBody = (await second.json()) as { ok?: boolean; alreadyRefunded?: boolean };
      expect(
        second.status === 200 && secondBody.alreadyRefunded === true,
        "repeat refund not idempotent",
      );
      expectDelta(
        delta(afterFirst, await snapshot()),
        { wallet: 0, earnings: 0, fees: 0, receipts: 0 },
        "repeat refund",
      );
      const refundStatement = await waitForStatement(receiptId, "refund");
      const verified = await verifyStatement(refundStatement, jwks, {
        issuer: WEB_URL,
        kind: "refund",
      });
      expect(verified.ok, verified.ok ? "" : `refund statement: ${verified.message}`);
      expect(verified.statement.kind === "refund", "not a refund statement");
      const r = verified.statement.refund;
      expect(
        r.refundedMicros === 20_000 && r.via === "publisher",
        `refund ${r.via} ${r.refundedMicros}`,
      );
      return `wallet +20,000 micros, repeat call alreadyRefunded; signed refund statement (via ${r.via})`;
    });

    // 4. Agent detection on recipe pages: who pays, and why (standard level, Turnstile test key).
    const detectUrl = `${DEMO_URL}${DEMO_PAGES.potatoes}`;

    await check(
      "curl and python-requests without the agent header get 402 (automation)",
      async () => {
        const before = await snapshot();
        const seen: string[] = [];
        for (const userAgent of ["curl/8.7.1", "python-requests/2.32.3"]) {
          const response = await fetch(detectUrl, {
            headers: { "User-Agent": userAgent, Accept: "*/*" },
          });
          await response.body?.cancel();
          expect(response.status === 402, `${userAgent} got ${response.status}`);
          const signal = signalOf(response);
          expect(signal === "automation", `${userAgent} signal ${String(signal)}`);
          seen.push(`${userAgent.split("/")[0]} 402 ${signal}`);
        }
        expectDelta(
          delta(before, await snapshot()),
          { wallet: 0, earnings: 0, fees: 0, receipts: 0 },
          "402",
        );
        return seen.join(", ");
      },
    );

    await check(
      "A script wearing a Chrome user agent without browser headers gets 402",
      async () => {
        const response = await fetch(detectUrl, {
          headers: { "User-Agent": CHROME_HEADERS["User-Agent"], Accept: "text/html" },
        });
        await response.body?.cancel();
        expect(response.status === 402, `status ${response.status}`);
        expect(signalOf(response) === "automation", `signal ${String(signalOf(response))}`);
        return "402 automation (no Accept-Language, no Sec-Fetch-*)";
      },
    );

    await check(
      "A non-browser user agent (research-bot/1.0) gets 402; a chat link preview reads free",
      async () => {
        const before = await snapshot();
        const bot = await fetch(detectUrl, {
          headers: { "User-Agent": "research-bot/1.0", Accept: "text/html" },
        });
        const body = await bot.text();
        expect(bot.status === 402, `research-bot got ${bot.status}`);
        expect(signalOf(bot) === "automation", `signal ${String(signalOf(bot))}`);
        // Not a browser, so no human check: the plain x402 offer.
        expect(!body.includes("Continue free"), "research-bot was shown the human check");
        const preview = await fetch(detectUrl, {
          headers: {
            "User-Agent": "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)",
            Accept: "*/*",
          },
        });
        await preview.body?.cancel();
        expect(preview.status === 200, `Slackbot link preview got ${preview.status}`);
        expectDelta(
          delta(before, await snapshot()),
          { wallet: 0, earnings: 0, fees: 0, receipts: 0 },
          "non-browser 402",
        );
        return "research-bot 402 automation (no human check), Slackbot preview 200";
      },
    );

    await check("GPTBot user agent from 127.0.0.1 is flagged bot-impostor", async () => {
      const response = await fetch(detectUrl, {
        headers: { "User-Agent": GPTBOT_UA, Accept: "*/*" },
      });
      await response.body?.cancel();
      expect(response.status === 402, `status ${response.status}`);
      const signal = signalOf(response);
      expect(signal === "bot-impostor", `signal ${String(signal)}`);
      return "402 bot-impostor (outside OpenAI's published ranges)";
    });

    let signedReceiptId = "";
    await check(
      "SDK request is signed (Web Bot Auth), recognised as signed-agent, and pays",
      async () => {
        const signed: string[] = [];
        const signedWire: WireEvent[] = [];
        const signedAgent = createBotFareAgent({
          agentKey,
          botfareUrl: WEB_URL,
          onWire: (event) => signedWire.push(event),
          fetch: (input, init) => {
            const request = new Request(input, init);
            signed.push(request.headers.get("signature-input") ?? "");
            return fetch(request);
          },
        });
        const before = await snapshot();
        const result = await signedAgent.fetch(detectUrl);
        await result.response.body?.cancel();
        expect(result.response.status === 200 && result.paid, `status ${result.response.status}`);
        expect(signed.length === 2, `${signed.length} requests sent`);
        expect(
          signed.every((input) => input.includes('tag="web-bot-auth"')),
          "a request was not signed",
        );
        const required = signedWire.find((event) => event.stage === "payment-required");
        const signal =
          required?.stage === "payment-required"
            ? required.decoded.accepts[0]?.extra?.[BOTFARE_SIGNAL_EXTRA]
            : undefined;
        expect(signal === "signed-agent", `402 signal ${String(signal)}`);
        signedReceiptId = result.receipt?.transaction ?? "";
        expectDelta(
          delta(before, await snapshot()),
          { wallet: -20_000, earnings: 19_000, fees: 1_000, receipts: 1 },
          "signed",
        );
        return `both legs signed, 402 signal signed-agent, ${signedReceiptId}`;
      },
    );

    let automationReceiptId = "";
    await check(
      "python-requests that pays through raw @x402/fetch is charged as automation",
      async () => {
        const paying = rawPayingFetch("python-requests/2.32.3", keyId, privateJwk);
        const before = await snapshot();
        const response = await paying.fetch(`${DEMO_URL}${DEMO_PAGES.lemonChicken}`);
        await response.body?.cancel();
        expect(response.status === 200, `status ${response.status}`);
        expect(!paying.sentAgentHeader.includes(true), "the agent header was sent");
        const receipt = decodePaymentResponseHeader(response.headers.get("PAYMENT-RESPONSE") ?? "");
        expect(receipt.success, "no successful PAYMENT-RESPONSE");
        automationReceiptId = receipt.transaction;
        expectDelta(
          delta(before, await snapshot()),
          { wallet: -20_000, earnings: 19_000, fees: 1_000, receipts: 1 },
          "automation",
        );
        return `402 then 200, ${automationReceiptId}`;
      },
    );

    await check(
      "Headless browser: Turnstile page, test token sets the pass, next read is free",
      async () => {
        const path = DEMO_PAGES.lemonChicken;
        const headless = { "User-Agent": HEADLESS_CHROME_UA, Accept: "text/html" };
        const before = await snapshot();

        const paywall = await fetch(`${DEMO_URL}${path}`, { headers: headless });
        const page = await paywall.text();
        expect(paywall.status === 402, `first request got ${paywall.status}`);
        expect(signalOf(paywall) === "automation", `signal ${String(signalOf(paywall))}`);
        expect(page.includes("Reading as a human? Continue free."), "no human-check page");
        expect(page.includes('class="cf-turnstile"'), "no Turnstile widget");

        const form = new URLSearchParams({
          "cf-turnstile-response": TURNSTILE_DUMMY_TOKEN,
          return: path,
        });
        const passed = await fetch(`${DEMO_URL}${HUMAN_CHECK_PATH}`, {
          method: "POST",
          headers: { ...headless, "Content-Type": "application/x-www-form-urlencoded" },
          body: form,
          redirect: "manual",
        });
        await passed.body?.cancel();
        expect(passed.status === 303, `${HUMAN_CHECK_PATH} answered ${passed.status}`);
        expect(
          passed.headers.get("location") === path,
          `location ${passed.headers.get("location")}`,
        );
        const setCookie = passed.headers.get("set-cookie") ?? "";
        const cookie = setCookie.split(";")[0] ?? "";
        expect(cookie.startsWith(`${HUMAN_PASS_COOKIE}=v1.`), "no human pass cookie");
        expect(/HttpOnly/i.test(setCookie) && /SameSite=Lax/i.test(setCookie), "cookie flags");

        const free = await fetch(`${DEMO_URL}${path}`, {
          headers: { ...headless, Cookie: cookie },
        });
        const html = await free.text();
        expect(free.status === 200, `with the pass got ${free.status}`);
        expect(!free.headers.has("PAYMENT-REQUIRED"), "PAYMENT-REQUIRED with the pass");
        expect(html.includes("<article"), "no recipe with the pass");

        // The pass covers scores only: a self-identified agent still pays.
        const agentWithPass = await fetch(`${DEMO_URL}${path}`, {
          headers: { ...headless, Cookie: cookie, [AGENT_HEADER]: "1" },
        });
        await agentWithPass.body?.cancel();
        expect(agentWithPass.status === 402, `agent with the pass got ${agentWithPass.status}`);
        expect(signalOf(agentWithPass) === "agent-header", "agent with the pass: wrong signal");
        expectDelta(
          delta(before, await snapshot()),
          { wallet: 0, earnings: 0, fees: 0, receipts: 0 },
          "human",
        );
        return "402 page -> 303 + botfare_human cookie -> 200 free; agent header still 402";
      },
    );

    await check("Receipts record why each request paid (detection_signal)", async () => {
      const expected: Array<[string, string, string]> = [
        ["SDK paid fetch", receiptId, "signed-agent"],
        ["signed SDK fetch", signedReceiptId, "signed-agent"],
        ["python-requests via x402", automationReceiptId, "automation"],
        ["Node fetch on the everyone-priced nutrition API", nutritionReceiptId, "automation"],
      ];
      const seen: string[] = [];
      for (const [label, id, signal] of expected) {
        expect(id, `no receipt for ${label}`);
        const receipt = await getReceipt(db, id);
        expect(receipt, `receipt ${id} not found`);
        expect(
          receipt.detectionSignal === signal,
          `${label}: ${receipt.detectionSignal}, expected ${signal}`,
        );
        seen.push(`${id.slice(0, 13)}… ${signal}`);
      }
      return seen.join(", ");
    });

    // 5. Fare Court and Fare Advisor.
    await fareChecks({
      db,
      agent,
      wire,
      keyId,
      site,
      auth,
      snapshot,
      citable: [signedReceiptId, automationReceiptId],
      jwks,
    });

    await check("/verify renders for a receipt; unknown receipts are 404 on the API", async () => {
      const page = await fetch(`${WEB_URL}/verify?receipt=${encodeURIComponent(receiptId)}`);
      const html = await page.text();
      expect(page.status === 200, `/verify answered ${page.status}`);
      expect(/verif/i.test(html), "the page does not mention verification");
      const unknown = await fetch(`${WEB_URL}${receiptStatementsPath("rcpt_doesnotexist000")}`);
      await unknown.body?.cancel();
      expect(unknown.status === 404, `unknown receipt answered ${unknown.status}`);
      expect(
        decodeStatement(paymentStatement)?.sub === receiptId &&
          paymentStatement.split(".").length === 3,
        "payment statement is not a compact JWS",
      );
      return `200, ${html.length} bytes; unknown receipt 404; typ ${RECEIPT_JWT_TYPE}`;
    });

    await check("Ledger sums to zero and cached balances match entries", async () => {
      const report = await checkLedgerInvariants(db);
      expect(report.totalMicros === 0, `entries sum to ${report.totalMicros}`);
      expect(
        report.balanceMismatches.length === 0,
        `${report.balanceMismatches.length} cache mismatches`,
      );
      expect(report.unbalancedTransactions.length === 0, "unbalanced transactions");
      return "total 0, 0 mismatches, 0 unbalanced transactions";
    });
  } finally {
    await close();
  }
}

// ---------------------------------------------------------------------------------------------
// Fare Court and Fare Advisor

interface FareContext {
  db: Db;
  agent: BotFareAgent;
  wire: WireEvent[];
  keyId: string;
  site: Site;
  auth: string;
  snapshot: () => Promise<Balances>;
  /** Settled receipts of this run that an answer may cite. */
  citable: string[];
  /** BotFare's public receipt keys, as fetched from the web app. */
  jwks: JSONWebKeySet;
}

/** Signs in as a demo persona (POST /api/session/persona) and returns the session cookie. */
async function personaCookie(persona: "publisher" | "agentOwner"): Promise<string> {
  const response = await fetch(`${WEB_URL}/api/session/persona`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ persona }),
  });
  await response.body?.cancel();
  if (!response.ok) throw new Error(`persona sign-in answered ${response.status}`);
  const cookie = response.headers
    .getSetCookie()
    .map((line) => line.split(";")[0])
    .join("; ");
  if (!cookie) throw new Error("persona sign-in set no cookie");
  return cookie;
}

async function waitUntil<T>(
  what: string,
  read: () => Promise<T | null | undefined>,
  timeoutMs: number,
  everyMs = 500,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`${what} within ${timeoutMs / 1000}s`);
    await new Promise((done) => setTimeout(done, everyMs));
  }
}

async function fareChecks(ctx: FareContext): Promise<void> {
  const { db, agent, wire, keyId, site, auth, snapshot } = ctx;
  const runStarted = new Date();
  const stubUrl = `${DEMO_URL}${FARE_COURT_STUB_PATH}`;
  // The title the demo declares for the stub page (its free preview), which the stub breaks.
  const stubTitle = loadArticles().find((page) => page.slug === FARE_COURT_STUB_SLUG)?.title;
  // The web app this run started has no AI judge unless E2E_AI=1; a reused one may have either.
  const judge = WEB_STARTED_BY_E2E ? (E2E_AI ? "ai" : "none") : "unknown";
  if (E2E_AI && judge !== "ai") {
    console.log("NOTE E2E_AI=1 has no effect on a web app this run did not start");
  }
  // Signing in as the publisher persona restores the demo prices and earnings: do it before any
  // ledger snapshot, since it may post demo earnings.
  const publisherCookie = await personaCookie("publisher");
  const publisherApi = (path: string, init: RequestInit = {}) =>
    fetch(`${WEB_URL}${path}`, {
      ...init,
      headers: { Cookie: publisherCookie, "Content-Type": "application/json", ...init.headers },
    });

  let stubReceiptId = "";
  let delivered: Uint8Array | null = null;
  await check(
    "Paid stub recipe: the offer is declared and the publisher attests the delivered digest",
    async () => {
      const before = await snapshot();
      wire.length = 0;
      const result = await agent.fetch(stubUrl);
      const text = new TextDecoder().decode(result.body ?? new Uint8Array());
      expect(result.paid && result.receiptId, `status ${result.response.status}, not paid`);
      expect(result.body, "the SDK kept no body");
      expect(text.includes("Subscribe to keep reading"), "the paid agent did not get the stub");
      const required = wire.find((event) => event.stage === "payment-required");
      const offer =
        required?.stage === "payment-required"
          ? (required.decoded.accepts[0]?.extra?.[REQUIREMENT_EXTRA_KEYS.offer] as
              | { title?: string }
              | undefined)
          : undefined;
      expect(stubTitle, `apps/demo has no ${FARE_COURT_STUB_SLUG} page`);
      expect(offer?.title === stubTitle, `declared ${offer?.title}, expected ${stubTitle}`);
      stubReceiptId = result.receiptId;
      delivered = result.body;
      const digest = await contentDigestSha256(result.body);
      const receipt = await waitUntil(
        "no attestation arrived",
        async () => {
          const row = await getReceipt(db, result.receiptId as string);
          return row?.contentDigest ? row : null;
        },
        10_000,
      );
      expect(receipt.contentDigest === digest, `attested ${receipt.contentDigest}, got ${digest}`);
      expect(receipt.contentLength === result.body.length, "attested length differs");
      expect(receipt.declaredOffer?.title === offer?.title, "receipt lacks the declared offer");
      expectDelta(
        delta(before, await snapshot()),
        { wallet: -20_000, earnings: 19_000, fees: 1_000, receipts: 1 },
        "stub",
      );
      return `${stubReceiptId}, ${result.body.length} bytes, ${digest.slice(0, 20)}…`;
    },
  );

  await check("A dispute with tampered bytes is invalid and moves no money", async () => {
    expect(stubReceiptId && delivered, "no stub purchase");
    const before = await snapshot();
    const tampered = new TextDecoder()
      .decode(delivered)
      .replace("Subscribe to keep reading", "Error 500");
    const outcome = await agent.dispute({
      receiptId: stubReceiptId,
      reason: "error_page",
      content: tampered,
    });
    expect(outcome.status === "invalid", `status ${outcome.status}`);
    expect(outcome.refundedCents === 0, `refunded ${outcome.refundedCents}`);
    expectDelta(
      delta(before, await snapshot()),
      { wallet: 0, earnings: 0, fees: 0, receipts: 0 },
      "tampered",
    );
    return `invalid: ${outcome.message}`;
  });

  let disputeId = "";
  let disputeStatus = "";
  const beforeDispute = await snapshot();
  await check("A dispute with the real delivered bytes is accepted by Fare Court", async () => {
    expect(stubReceiptId && delivered, "no stub purchase");
    const outcome = await agent.dispute({
      receiptId: stubReceiptId,
      reason: "stub_or_paywall",
      note: "Paid for the starter guide and got a subscribe wall (e2e)",
      content: delivered,
    });
    disputeId = outcome.disputeId;
    disputeStatus = outcome.status;
    if (judge === "none") {
      expect(outcome.status === "pending_publisher", `status ${outcome.status}`);
      expect(outcome.verdict === null, "a verdict without an AI judge");
      expectDelta(
        delta(beforeDispute, await snapshot()),
        { wallet: 0, earnings: 0, fees: 0, receipts: 0 },
        "pending dispute",
      );
    } else {
      expect(outcome.status !== "invalid", `status ${outcome.status}: ${outcome.message}`);
    }
    return `${outcome.disputeId} ${outcome.status}: ${outcome.message}`;
  });

  await check(
    "The publisher accepts through the API and the refund happens exactly once",
    async () => {
      expect(disputeId, "no dispute");
      const list = await publisherApi(`/api/publisher/disputes?siteId=${site.id}`);
      const listed = (await list.json()) as {
        pendingCount: number;
        disputes: { id: string; status: string; deliveredExcerpt: string | null }[];
      };
      const row = listed.disputes.find((d) => d.id === disputeId);
      expect(list.status === 200 && row, `dispute not listed (${list.status})`);
      expect(row.deliveredExcerpt?.includes("Subscribe to keep reading"), "excerpt not shown");
      const decide = () =>
        publisherApi("/api/publisher/disputes", {
          method: "POST",
          body: JSON.stringify({ disputeId, decision: "accept" }),
        });
      let how = "by the AI judge";
      if (disputeStatus === "pending_publisher") {
        expect(row.status === "pending_publisher", `listed as ${row.status}`);
        const accepted = await decide();
        const body = (await accepted.json()) as {
          outcome?: { status: string; refundedCents: number };
        };
        expect(accepted.status === 200, `accept answered ${accepted.status}`);
        expect(body.outcome?.status === "refunded", `outcome ${body.outcome?.status}`);
        expect(body.outcome?.refundedCents === 2, `refunded ${body.outcome?.refundedCents}`);
        how = "by the publisher";
      }
      if (disputeStatus === "pending_publisher" || disputeStatus === "refunded") {
        const afterRefund = await snapshot();
        expectDelta(
          delta(beforeDispute, afterRefund),
          { wallet: 20_000, earnings: -19_000, fees: -1_000, receipts: 0 },
          "dispute refund",
        );
        const again = await decide();
        await again.body?.cancel();
        expect(again.status === 409, `second accept answered ${again.status}`);
        let refused = "";
        try {
          await agent.dispute({
            receiptId: stubReceiptId,
            reason: "stub_or_paywall",
            content: delivered as Uint8Array,
          });
        } catch (err) {
          refused = (err as Error).message;
        }
        expect(/refunded/i.test(refused), `re-dispute: ${refused || "accepted"}`);
        expectDelta(
          delta(afterRefund, await snapshot()),
          { wallet: 0, earnings: 0, fees: 0, receipts: 0 },
          "repeat",
        );
        // Fare Court's refund is signed too, naming the dispute that decided it.
        const refundStatement = await waitForStatement(stubReceiptId, "refund");
        const verified = await verifyStatement(refundStatement, ctx.jwks, {
          issuer: WEB_URL,
          kind: "refund",
        });
        expect(verified.ok, verified.ok ? "" : `refund statement: ${verified.message}`);
        expect(verified.statement.kind === "refund", "not a refund statement");
        const r = verified.statement.refund;
        expect(
          r.via === "dispute" && r.disputeId === disputeId,
          `refund via ${r.via} ${r.disputeId}`,
        );
        expect(r.refundedMicros === 20_000, `refunded ${r.refundedMicros} micros`);
        return `refunded 2¢ ${how}; second accept 409, re-dispute refused; signed refund statement via dispute ${disputeId}`;
      }
      return `the AI judge decided ${disputeStatus}; nothing for the publisher to accept`;
    },
  );

  if (E2E_AI && judge === "ai") {
    await check(
      "Optional (E2E_AI=1): the AI judge refunds a stub without the publisher",
      async () => {
        const result = await agent.fetch(stubUrl);
        expect(result.receiptId && result.body, "no paid stub");
        await waitUntil(
          "no attestation arrived",
          async () => (await getReceipt(db, result.receiptId as string))?.contentDigest,
          10_000,
        );
        const outcome = await agent.dispute({
          receiptId: result.receiptId,
          reason: "stub_or_paywall",
          content: result.body,
        });
        expect(outcome.status === "refunded", `status ${outcome.status}: ${outcome.message}`);
        expect(outcome.verdict?.decision === "refund", `verdict ${outcome.verdict?.decision}`);
        return `${outcome.verdict?.confidence} sure: ${outcome.verdict?.rationale.slice(0, 80)}`;
      },
    );
  } else {
    console.log("SKIP Optional AI judge check (set any AI provider key and E2E_AI=1 to run it)");
  }

  await check("A decline note and a citation report are recorded", async () => {
    // Decline notes find their site by its registered origin (the demo runs here on DEMO_PORT),
    // and one note per key, path and day is kept (the query string is dropped), so a second run
    // on the same day finds the first run's note.
    const reason = "Thin list, not worth 50¢";
    const declineUrl = `${site.origin}${COOKBOOK_PATH}?ref=e2e-${runStarted.getTime().toString(36)}`;
    const declined = await agent.decline(
      { url: declineUrl, priceCents: 50 },
      { category: "too_expensive", reason },
    );
    expect(declined, "BotFare refused the decline note");
    const day = new Date().toISOString().slice(0, 10);
    const note = await db.query.offerDeclines.findFirst({
      where: (t, { and, eq }) =>
        and(
          eq(t.agentKeyId, keyId),
          eq(t.siteId, site.id),
          eq(t.path, COOKBOOK_PATH),
          eq(t.day, day),
        ),
    });
    expect(
      note?.siteId === site.id && note.reason === reason,
      "this run's decline note is missing",
    );
    expect(note.path === COOKBOOK_PATH, `stored path ${note.path}`);

    const citable = ctx.citable.filter(Boolean);
    expect(citable.length > 0, "no receipts to cite");
    const answerId = `e2e-${runStarted.getTime().toString(36)}`;
    const reported = await agent.reportCitations({
      answerId,
      citations: citable.map((receiptId) => ({ receiptId, claim: "e2e citation" })),
    });
    expect(reported, "BotFare refused the citation report");
    const rows = await db.query.citations.findMany({
      where: (t, { eq }) => eq(t.answerId, answerId),
    });
    expect(rows.length === citable.length, `${rows.length} citations stored`);
    return `decline "${note.reason}" (${note.category}); ${rows.length} citations for ${answerId}`;
  });

  await check("Offer telemetry from the middleware reaches BotFare", async () => {
    // botfare() sends a batch every 15 s; this run showed the cookbook offer to the capped agent.
    const event = await waitUntil(
      "no offer event from this run",
      () =>
        db.query.offerEvents.findFirst({
          where: (t, { and, eq, gte }) => and(eq(t.siteId, site.id), gte(t.receivedAt, runStarted)),
        }),
      25_000,
      1_000,
    );
    return `${event.method} ${event.path} at ${event.priceCents}¢ (${event.signal})`;
  });

  await check("Fare Advisor returns the funnel per pricing rule without an AI key", async () => {
    const response = await publisherApi(`/api/publisher/advisor?siteId=${site.id}&ai=1`);
    const body = (await response.json()) as {
      aiAvailable: boolean;
      aiStatus: string;
      inputsSummary: {
        rules: {
          pattern: string;
          priceCents: number;
          offers: number;
          paid: number;
          declined: number;
          disputed: number;
          topReasons: { reason: string; count: number }[];
        }[];
      };
    };
    expect(response.status === 200, `advisor answered ${response.status}`);
    if (judge === "none") {
      expect(body.aiAvailable === false, "aiAvailable without a key");
      expect(body.aiStatus === "unavailable", `aiStatus ${body.aiStatus}`);
    }
    const cookbook = body.inputsSummary.rules.find((rule) => rule.pattern === COOKBOOK_PATTERN);
    const recipes = body.inputsSummary.rules.find((rule) => rule.pattern === "/recipes/*");
    expect(cookbook && recipes, "pricing rules missing from the funnel");
    expect(
      cookbook.offers > 0 && cookbook.declined > 0,
      "no offers or declines on the cookbook rule",
    );
    expect(recipes.disputed > 0, "no disputes on the recipe rule");
    const top = cookbook.topReasons[0];
    return `cookbook ${cookbook.priceCents}¢: ${cookbook.offers} offers, ${cookbook.paid} paid, ${cookbook.declined} declined (top: ${top?.reason} ×${top?.count}); aiStatus ${body.aiStatus}`;
  });

  await check(
    "Apply 50¢ → 8¢ on the cookbook rule: config, middleware and the next agent buys",
    async () => {
      const apply = async (priceCents: number) => {
        const response = await publisherApi("/api/publisher/advisor/apply", {
          method: "POST",
          body: JSON.stringify({ siteId: site.id, pattern: COOKBOOK_PATTERN, priceCents }),
        });
        const body = (await response.json()) as { changed?: boolean };
        expect(response.status === 200, `apply ${priceCents}¢ answered ${response.status}`);
        return body;
      };
      const config = async () => {
        const response = await fetch(`${WEB_URL}${siteConfigPath(site.id)}`, {
          headers: { Authorization: auth },
        });
        return (await response.json()) as {
          version: string;
          pricing: { pattern: string; priceCents: number }[];
        };
      };
      const cookbookPrice = (c: Awaited<ReturnType<typeof config>>) =>
        c.pricing.find((rule) => rule.pattern === COOKBOOK_PATTERN)?.priceCents;
      const before = await config();
      try {
        expect((await apply(8)).changed, "apply reported no change");
        const after = await config();
        expect(cookbookPrice(after) === 8, `config price ${cookbookPrice(after)}`);
        expect(after.version !== before.version, "config version did not change");
        // botfare() caches the config for up to 30 s; then the 10¢-capped agent can buy.
        const cookbookUrl = `${DEMO_URL}${COOKBOOK_PATH}`;
        await waitUntil(
          "the middleware never offered 8¢",
          async () => (await agent.getOffer(cookbookUrl).catch(() => null))?.priceCents === 8,
          40_000,
          2_000,
        );
        const balances = await snapshot();
        const bought = await agent.fetch(cookbookUrl);
        await bought.response.body?.cancel();
        expect(bought.paid, `status ${bought.response.status}`);
        expectDelta(
          delta(balances, await snapshot()),
          { wallet: -80_000, earnings: 76_000, fees: 4_000, receipts: 1 },
          "cookbook at 8¢",
        );
        return `config version ${before.version.slice(0, 8)}… → ${after.version.slice(0, 8)}…, agent paid 8¢ (${bought.receiptId})`;
      } finally {
        await apply(50).catch(() => undefined);
        const restored = await config().catch(() => null);
        if (restored && cookbookPrice(restored) !== 50)
          fail("restore cookbook price", "still not 50¢");
      }
    },
  );
}

process.on("SIGINT", () => {
  void stopAll().then(() => process.exit(130));
});

main()
  .catch((err) => fail("e2e setup", err instanceof Error ? err.message : String(err)))
  .finally(async () => {
    if (failures > 0) printLogs();
    await stopAll();
    console.log(failures > 0 ? `\n${failures} check(s) failed` : "\nAll e2e checks passed");
    process.exit(failures > 0 ? 1 : 0);
  });
