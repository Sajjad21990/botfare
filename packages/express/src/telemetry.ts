/**
 * Fare Advisor, "offer shown" telemetry: each 402 that carries a price is counted and sent to
 * BotFare in batches, so the publisher can see how often an offer was shown against how often it
 * was bought. Fire and forget, bounded memory, and no personal data: only the normalized path
 * (no query string), method, price, detection signal and time.
 */
import type { DetectionSignal } from "@botfare/contracts";
import {
  OFFER_TELEMETRY_PATH,
  type OfferTelemetryBatch,
  offerTelemetryBatchSchema,
} from "@botfare/contracts/fare";

type OfferEvent = OfferTelemetryBatch["events"][number];

export interface OfferTelemetryOptions {
  botfareUrl: string;
  authHeader: string;
  log: (msg: string) => void;
  /** Send at least this often while events are waiting. Default 15 s. */
  flushMs?: number;
  /** Send as soon as this many events are waiting. Default 200 (the contract allows 500). */
  batchSize?: number;
  /** Keep at most this many unsent events; the oldest are dropped first. Default 2,000. */
  maxPending?: number;
}

const SEND_TIMEOUT_MS = 5_000;

export class OfferTelemetry {
  private pending: OfferEvent[] = [];
  private dropped = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly url: string;
  private readonly batchSize: number;
  private readonly maxPending: number;
  private lastProblem: string | undefined;

  constructor(private readonly options: OfferTelemetryOptions) {
    this.url = new URL(OFFER_TELEMETRY_PATH, options.botfareUrl).toString();
    this.batchSize = Math.min(options.batchSize ?? 200, 500);
    this.maxPending = Math.max(options.maxPending ?? 2_000, this.batchSize);
  }

  record(event: {
    path: string;
    method: string;
    priceCents: number;
    signal: DetectionSignal | null;
  }) {
    this.pending.push({
      path: (event.path.startsWith("/") ? event.path : `/${event.path}`).slice(0, 500),
      method: event.method.slice(0, 10),
      priceCents: event.priceCents,
      signal: event.signal,
      at: new Date().toISOString(),
    });
    if (this.pending.length > this.maxPending) {
      const excess = this.pending.length - this.maxPending;
      this.pending.splice(0, excess);
      this.dropped += excess;
    }
    if (this.pending.length >= this.batchSize) {
      void this.flush();
    } else if (!this.timer) {
      this.timer = setInterval(() => void this.flush(), this.options.flushMs ?? 15_000);
      this.timer.unref?.(); // never keeps the publisher's process alive
    }
  }

  /** Sends everything waiting, in batches. Never throws. */
  async flush(): Promise<void> {
    if (this.pending.length === 0) {
      if (this.timer) clearInterval(this.timer);
      this.timer = undefined;
      return;
    }
    while (this.pending.length > 0) {
      const events = this.pending.splice(0, this.batchSize);
      await this.send({ events });
    }
  }

  /** Events waiting to be sent (tests and diagnostics). */
  get size(): number {
    return this.pending.length;
  }

  private async send(batch: OfferTelemetryBatch): Promise<void> {
    const parsed = offerTelemetryBatchSchema.safeParse(batch);
    if (!parsed.success) {
      this.report(`offer telemetry batch is invalid: ${parsed.error.message}`);
      return;
    }
    try {
      const res = await fetch(this.url, {
        method: "POST",
        headers: { authorization: this.options.authHeader, "content-type": "application/json" },
        body: JSON.stringify(parsed.data),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.lastProblem = undefined;
    } catch (err) {
      // Telemetry is best effort: the batch is dropped, and each new kind of failure is logged once.
      this.report(`offer telemetry not sent (${(err as Error).message})`);
    }
    if (this.dropped > 0) {
      this.options.log(`offer telemetry: ${this.dropped} events dropped while the queue was full`);
      this.dropped = 0;
    }
  }

  private report(problem: string) {
    if (problem !== this.lastProblem) this.options.log(problem);
    this.lastProblem = problem;
  }
}
