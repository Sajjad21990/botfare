import type { DetectionSignal } from "@botfare/contracts";

/** The parts of an Express request the detection engine reads. */
export interface DetectionRequest {
  method: string;
  /** Path and query as received, e.g. `/articles/burr-basics?ref=1`. */
  originalUrl: string;
  /** `http` or `https` (Express `req.protocol`, which honours `trust proxy`). */
  protocol: string;
  /** Client IP (Express `req.ip`; set `app.set("trust proxy", …)` behind a proxy). */
  ip?: string | undefined;
  get(name: string): string | undefined;
}

export interface Detection {
  /** True when this request must pay (402 or a verified payment). */
  charge: boolean;
  /** Why it pays; null when it does not. Recorded on the receipt as `extra.botfareSignal`. */
  signal: DetectionSignal | null;
  /** Automation score in [0, 100] from every signal seen, whether or not it decided the charge. */
  score: number;
  /** Human-readable notes on what was seen, for logs and the dashboard. */
  reasons: string[];
  /** Charged only on a score (edge or heuristics), so a human check may let it through free. */
  humanCheckable: boolean;
  /** A valid human-pass cookie was presented. */
  humanPass: boolean;
}
