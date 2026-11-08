/**
 * Fare Court, proof of delivery: after a paid response has been sent, botfare() tells BotFare the
 * SHA-256 digest (RFC 9530 `Content-Digest` form) of the exact body bytes it delivered for that
 * receipt. The agent cannot fake content in a dispute, and the publisher cannot deny it.
 *
 * Which bytes: the ones that pass through botfare() on their way out. `@x402/express` buffers the
 * handler's output until settle succeeds and then replays it into `res.write`/`res.end`; botfare()
 * wraps those two methods *before* the x402 middleware installs its buffer, so it sees exactly the
 * replayed bytes, in order, and nothing it did not send.
 *
 * Compression: mount `compression()` (or any content-encoding middleware) *before* botfare()
 * (`app.use(compression()); app.use(botfare(...))`). Then botfare() sits closer to the handler and
 * hashes the decoded body, which is what an agent's `fetch` hands back from `res.arrayBuffer()`
 * after it undoes gzip/br. Mounted after botfare(), the encoder would run inside it and the digest
 * would be over the compressed bytes, which no agent ever sees, so its disputes would fail the
 * digest check.
 */
import { createHash } from "node:crypto";
import {
  type ReceiptAttestation,
  receiptAttestationPath,
  receiptAttestationSchema,
} from "@botfare/contracts/fare";
import { decodePaymentResponseHeader } from "@x402/core/http";
import type { Response } from "express";

/** What botfare() saw leave for one response. */
export interface DeliveredBody {
  /** `sha-256=:<base64>:` over every body byte, same as `contentDigestSha256()` from contracts. */
  contentDigest: string;
  contentLength: number;
}

type WriteArgs = [chunk?: unknown, encoding?: unknown, cb?: unknown];

function chunkBytes(chunk: unknown, encoding: unknown): Buffer | undefined {
  if (chunk === undefined || chunk === null || typeof chunk === "function") return undefined;
  if (typeof chunk === "string") {
    return Buffer.from(chunk, typeof encoding === "string" ? (encoding as BufferEncoding) : "utf8");
  }
  if (chunk instanceof Uint8Array) return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.length);
  return undefined;
}

/**
 * Hashes every body byte written to `res` from now on, without holding them in memory. Call
 * before the x402 middleware runs; `onFinish` runs once, after the response has been flushed.
 */
export function captureDeliveredBody(res: Response, onFinish: (body: DeliveredBody) => void): void {
  const hash = createHash("sha256");
  let length = 0;
  let ended = false;
  const feed = (chunk: unknown, encoding: unknown) => {
    if (ended) return;
    const bytes = chunkBytes(chunk, encoding);
    if (!bytes || bytes.length === 0) return;
    hash.update(bytes);
    length += bytes.length;
  };

  const originalWrite = res.write.bind(res) as (...args: WriteArgs) => boolean;
  const originalEnd = res.end.bind(res) as (...args: WriteArgs) => Response;
  res.write = ((...args: WriteArgs) => {
    feed(args[0], args[1]);
    return originalWrite(...args);
  }) as Response["write"];
  res.end = ((...args: WriteArgs) => {
    feed(args[0], args[1]);
    ended = true;
    return originalEnd(...args);
  }) as Response["end"];

  res.once("finish", () => {
    onFinish({ contentDigest: `sha-256=:${hash.digest("base64")}:`, contentLength: length });
  });
}

/** The receipt ID from a successful `PAYMENT-RESPONSE` header, if this response was paid. */
export function paidReceiptId(res: Response): string | undefined {
  const header = res.getHeader("payment-response");
  if (typeof header !== "string" || !header) return undefined;
  try {
    const settlement = decodePaymentResponseHeader(header);
    if (!settlement.success) return undefined;
    return settlement.transaction?.startsWith("rcpt_") ? settlement.transaction : undefined;
  } catch {
    return undefined;
  }
}

/** Retry delays after the first attempt; an attestation gives up after these. */
const RETRY_DELAYS_MS = [500, 2_000, 5_000];
const ATTEST_TIMEOUT_MS = 5_000;

export interface AttestorOptions {
  botfareUrl: string;
  authHeader: string;
  log: (msg: string) => void;
  /** Override the retry delays (tests). */
  retryDelaysMs?: number[];
}

/** Posts receipt attestations to BotFare in the background, with a short retry. */
export class Attestor {
  private readonly retryDelays: number[];

  constructor(private readonly options: AttestorOptions) {
    this.retryDelays = options.retryDelaysMs ?? RETRY_DELAYS_MS;
  }

  /** Fire and forget: never throws, never delays the response it describes. */
  attest(receiptId: string, attestation: ReceiptAttestation): void {
    const parsed = receiptAttestationSchema.safeParse(attestation);
    if (!parsed.success) {
      this.options.log(`attestation for ${receiptId} is invalid: ${parsed.error.message}`);
      return;
    }
    void this.send(receiptId, parsed.data, 0);
  }

  private async send(receiptId: string, body: ReceiptAttestation, attempt: number): Promise<void> {
    const url = new URL(receiptAttestationPath(receiptId), this.options.botfareUrl).toString();
    let retryable = true;
    let problem = "";
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { authorization: this.options.authHeader, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(ATTEST_TIMEOUT_MS),
      });
      // 409: already attested (a retry whose first attempt landed). Either way, done.
      if (res.ok || res.status === 409) return;
      problem = `HTTP ${res.status}`;
      retryable = res.status >= 500 || res.status === 408 || res.status === 429;
    } catch (err) {
      problem = (err as Error).message;
    }
    const delay = this.retryDelays[attempt];
    if (!retryable || delay === undefined) {
      this.options.log(`attestation for ${receiptId} failed (${problem}); giving up`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, delay).unref?.());
    await this.send(receiptId, body, attempt + 1);
  }
}

/** The attestation for a finished paid response, or undefined if it must not be attested. */
export function attestationFor(
  res: Response,
  body: DeliveredBody,
): { receiptId: string; attestation: ReceiptAttestation } | undefined {
  if (res.statusCode >= 400) return undefined;
  const receiptId = paidReceiptId(res);
  if (!receiptId) return undefined;
  const contentType = String(res.getHeader("content-type") ?? "").slice(0, 200);
  return {
    receiptId,
    attestation: {
      contentDigest: body.contentDigest,
      contentLength: body.contentLength,
      contentType,
      status: res.statusCode,
    },
  };
}
