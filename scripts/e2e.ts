/**
 * `pnpm e2e`: end to end on real processes and the local Postgres.
 *
 * Starts the BotFare web app (reused if already up on WEB_PORT) and the Crema Notes demo
 * (DEMO_PORT) with the values `pnpm seed` wrote to .env, then pays for content with the agent SDK
 * and checks every ledger movement, and checks agent detection (who pays, and why) against the
 * seeded Crema Notes settings (standard level, Turnstile test key). Prints PASS / FAIL lines and
 * exits non-zero on any FAIL.
 *
 * Environment:
 * - WEB_PORT (default 3000), DEMO_PORT (default 4000): run beside a dev setup with
 *   `WEB_PORT=3100 DEMO_PORT=4100 E2E_WEB=start pnpm e2e`.
 * - E2E_WEB: how to start the web app when nothing answers on WEB_PORT: `dev` (next dev, the
 *   default) or `start` (next start on the last `pnpm --filter @botfare/web build`; use it when a
 *   next dev already runs on another port, since Next allows one dev server per app directory).
 * - E2E_VERBOSE=1 streams the child processes' logs.
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
  decodeAgentKey,
  FACILITATOR_PATH,
  siteAuthHeader,
  siteConfigPath,
} from "@botfare/contracts";
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
} from "@botfare/core";
import { BOTFARE_SIGNAL_EXTRA, HUMAN_CHECK_PATH, HUMAN_PASS_COOKIE } from "@botfare/express";
import { BotFareSpendLimitError, createBotFareAgent, type WireEvent } from "@botfare/sdk";
import { PAYPAL_SANDBOX, PrepaidPayPalClient } from "@botfare/x402-paypal";
import { decodePaymentRequiredHeader, decodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentPayload, SettleResponse } from "@x402/core/types";
import { decodePaymentResponseHeader, wrapFetchWithPayment, x402Client } from "@x402/fetch";
import type { JWK } from "jose";
import { loadRootEnv, ROOT, requireEnv } from "./lib/env-file";

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
const VERBOSE = process.env.E2E_VERBOSE === "1";

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
// Main

async function main(): Promise<void> {
  loadRootEnv();
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
          BOTFARE_URL: WEB_URL,
          // next start refuses to run without one; a throwaway secret is fine for this run.
          SESSION_SECRET: process.env.SESSION_SECRET || randomBytes(32).toString("hex"),
        },
      );
      await waitFor("BotFare app", `${WEB_URL}/api/health`, healthy, 180_000, web);
    }
    if (await answers(DEMO_URL)) {
      throw new Error(
        `Something is already listening on ${DEMO_URL}. Stop it: the e2e run starts its own demo with the current site secret.`,
      );
    }
    console.log(`Starting the Crema Notes demo on ${DEMO_URL}`);
    const demo = start("demo", ["--filter", "@botfare/demo", "start"], {
      ...process.env,
      PORT: String(DEMO_PORT),
      HOST: "127.0.0.1",
      BOTFARE_URL: WEB_URL,
      BOTFARE_SITE_ID: siteId,
      BOTFARE_SITE_SECRET: siteSecret,
    });
    await waitFor(
      "Crema Notes demo",
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

    const articleUrl = `${DEMO_URL}/articles/burr-basics`;
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
    await check("Human in a real browser (full Chrome headers) reads an article free", async () => {
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
      expect(offer.priceCents === 3, `price ${offer.priceCents}¢, expected 3¢`);
      expect(offer.payTo === siteId, `payTo ${offer.payTo}`);
      expect(offer.preview?.title, "no preview title");
      expect((offer.preview?.excerpt.length ?? 0) > 50, "preview excerpt is too short");
      expectDelta(delta(before, after), { wallet: 0, earnings: 0, fees: 0, receipts: 0 }, "offer");
      return `${offer.priceUsd}, "${offer.preview.title}"`;
    });

    let receiptId = "";
    let brewReceiptId = "";
    let signatureHeader = "";
    const beforePay = await snapshot();
    await check("Agent pays 3¢ and gets the article with a receipt", async () => {
      wire.length = 0;
      const result = await agent.fetch(articleUrl);
      const body = await result.response.text();
      expect(result.response.status === 200, `status ${result.response.status}`);
      expect(result.paid && result.receipt?.success, "no successful PAYMENT-RESPONSE");
      expect(result.receipt.transaction.startsWith("rcpt_"), "transaction is not a receipt ID");
      expect(result.receipt.payer === keyId, `payer ${result.receipt.payer}`);
      expect(body.includes("<article"), "no article in the paid response");
      const stages = wire.map((event) => event.stage).join(" -> ");
      expect(
        stages === "payment-required -> payment-signature -> payment-response",
        `wire stages ${stages}`,
      );
      const signed = wire.find((event) => event.stage === "payment-signature");
      signatureHeader = signed?.header ?? "";
      receiptId = result.receipt.transaction;
      return `200, ${receiptId}, wire: ${stages}`;
    });

    await check("Ledger moved exactly: wallet -30,000, earnings +28,500, fees +1,500", async () => {
      const moved = delta(beforePay, await snapshot());
      expectDelta(moved, { wallet: -30_000, earnings: 28_500, fees: 1_500, receipts: 1 }, "pay");
      return `micros: wallet ${micros(moved.wallet)}, earnings ${micros(moved.earnings)}, fees ${micros(moved.fees)}`;
    });

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

    await check("50¢ premium article is refused by the 10¢ cap, no charge", async () => {
      const before = await snapshot();
      wire.length = 0;
      let error: unknown;
      try {
        await agent.fetch(`${DEMO_URL}/articles/premium-grinder-roundup`);
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
      "Brew API: 402 to a plain fetch, 1¢ for a paying client without the agent header",
      async () => {
        const brewUrl = `${DEMO_URL}/api/brew-ratio?method=pour-over&coffeeGrams=20`;
        const plain = await fetch(brewUrl);
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
        const response = await wrapFetchWithPayment(recordingFetch, client)(brewUrl);
        const body = (await response.json()) as { waterGrams?: number };
        expect(response.status === 200, `paid fetch got ${response.status}`);
        expect(!sentAgentHeader.includes(true), "the agent header was sent");
        const receipt = decodePaymentResponseHeader(response.headers.get("PAYMENT-RESPONSE") ?? "");
        expect(receipt.success, "no successful PAYMENT-RESPONSE");
        expect(body.waterGrams === 320, `waterGrams ${body.waterGrams}`);
        expectDelta(
          delta(before, await snapshot()),
          { wallet: -10_000, earnings: 9_500, fees: 500, receipts: 1 },
          "brew",
        );
        brewReceiptId = receipt.transaction;
        return `402, then 200 with ${receipt.transaction}; wallet -10,000 micros`;
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
        { wallet: 30_000, earnings: -28_500, fees: -1_500, receipts: 0 },
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
      return `wallet +30,000 micros, repeat call alreadyRefunded`;
    });

    // 4. Agent detection: who pays, and why (Crema Notes: standard level, Turnstile test key).
    const detectUrl = `${DEMO_URL}/articles/grinders-under-200`;

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
          { wallet: -30_000, earnings: 28_500, fees: 1_500, receipts: 1 },
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
        const response = await paying.fetch(`${DEMO_URL}/articles/latte-art-hearts`);
        await response.body?.cancel();
        expect(response.status === 200, `status ${response.status}`);
        expect(!paying.sentAgentHeader.includes(true), "the agent header was sent");
        const receipt = decodePaymentResponseHeader(response.headers.get("PAYMENT-RESPONSE") ?? "");
        expect(receipt.success, "no successful PAYMENT-RESPONSE");
        automationReceiptId = receipt.transaction;
        expectDelta(
          delta(before, await snapshot()),
          { wallet: -30_000, earnings: 28_500, fees: 1_500, receipts: 1 },
          "automation",
        );
        return `402 then 200, ${automationReceiptId}`;
      },
    );

    await check(
      "Headless browser: Turnstile page, test token sets the pass, next read is free",
      async () => {
        const path = "/articles/dialing-in-espresso";
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
        expect(html.includes("<article"), "no article with the pass");

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
        ["Node fetch on the everyone-priced brew API", brewReceiptId, "automation"],
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
