import { DISPUTE_POLICY } from "@botfare/contracts/fare";
import type {
  BotFareStatement,
  DeliveryStatement,
  PaymentStatement,
  RefundStatement,
  StatementKind,
} from "@botfare/contracts/receipts";
import { describe, expect, it } from "vitest";
import {
  type ReceiptOutcome,
  summarizeReceipt,
  verdictText,
} from "../src/components/verify/receipt-summary";
import { formatShareMicros, pageLabel } from "../src/components/verify/statement-copy";
import type { CheckedStatement } from "../src/components/verify/verify-lib";

const RECEIPT = "rcpt_0123456789abcdef";
const SETTLED = "2026-11-11T09:37:25.661Z";

const payment: PaymentStatement = {
  iss: "https://botfare.example",
  sub: RECEIPT,
  iat: 1_794_389_845,
  v: 1,
  kind: "payment",
  payment: {
    scheme: "prepaid",
    network: "paypal:sandbox",
    asset: "USD",
    amount: "5",
    amountMicros: 50_000,
    publisherMicros: 47_500,
    feeMicros: 2_500,
    payTo: "site_1",
    siteOrigin: "https://saffron.example",
    resource: "https://saffron.example/techniques/freezing-and-reheating",
    payer: "ak_1",
    payerThumbprint: null,
    signal: "signed-agent",
    offerDigest: null,
    settledAt: SETTLED,
  },
};

const delivery: DeliveryStatement = {
  iss: "https://botfare.example",
  sub: RECEIPT,
  iat: 1_794_389_845,
  v: 1,
  kind: "delivery",
  delivery: {
    contentDigest: "sha-256=:4c4y5MinRucdx4Q8GufK9DRbmD1t7WyZmWQfvaqkYQo=:",
    contentLength: 3295,
    contentType: "text/html",
    status: 200,
    attestedAt: "2026-11-11T09:37:25.676Z",
  },
};

const refund: RefundStatement = {
  iss: "https://botfare.example",
  sub: RECEIPT,
  iat: 1_794_389_900,
  v: 1,
  kind: "refund",
  refund: {
    refundedMicros: 50_000,
    via: "dispute",
    disputeId: "dsp_1",
    refundedAt: "2026-11-11T09:38:20.000Z",
  },
};

/** A statement as the browser checked it: valid, or with a bad signature. */
function checked(statement: BotFareStatement, ok = true): CheckedStatement {
  return {
    token: `${statement.kind}.${ok ? "ok" : "bad"}.${statement.sub}`,
    slot: statement.kind,
    result: ok
      ? { ok: true, kid: "kid_1", statement }
      : { ok: false, error: "bad_signature", message: "Signature does not verify" },
    decoded: statement,
    header: { alg: "EdDSA", kid: "kid_1" },
  };
}

function outcome(
  statements: CheckedStatement[],
  extra: Partial<ReceiptOutcome> = {},
): ReceiptOutcome {
  const kinds = statements.map((s) => s.slot as StatementKind);
  return {
    receiptId: RECEIPT,
    source: "lookup",
    statements,
    missing: (["payment", "delivery"] as const).filter((k) => !kinds.includes(k)),
    keyCount: 1,
    ...extra,
  };
}

const BEFORE_WINDOW_ENDS = new Date("2026-11-11T12:00:00.000Z");
const check = (summary: ReturnType<typeof summarizeReceipt>, id: string) =>
  summary.checks.find((c) => c.id === id);

describe("/verify copy helpers", () => {
  it("names a page by the last part of its path", () => {
    expect(pageLabel("https://saffron.example/techniques/freezing-and-reheating")).toBe(
      "Freezing and reheating",
    );
    expect(pageLabel("https://saffron.example/recipes/red_lentil-dal.html")).toBe("Red lentil dal");
    expect(pageLabel("https://saffron.example/")).toBe("saffron.example");
    expect(pageLabel("not a url")).toBe("not a url");
  });

  it("shows a share of a fare in cents people read", () => {
    expect(formatShareMicros(47_500)).toBe("4.75¢");
    expect(formatShareMicros(2_500)).toBe("0.25¢");
    expect(formatShareMicros(76_000)).toBe("7.6¢");
    expect(formatShareMicros(1_520_000)).toBe("$1.52");
  });
});

describe("summarizeReceipt", () => {
  it("proves a paid, delivered receipt and keeps the dispute window open for 24 hours", () => {
    const summary = summarizeReceipt(
      outcome([checked(payment), checked(delivery)]),
      BEFORE_WINDOW_ENDS,
    );
    expect(summary.trusted).toBe(true);
    expect(verdictText(summary)).toBe("Both signatures are valid.");
    expect(check(summary, "signed")?.detail).toBe("Both signatures are valid");
    expect(summary.checks.map((c) => [c.id, c.state])).toEqual([
      ["signed", "pass"],
      ["payment", "pass"],
      ["delivery", "pass"],
      ["refund", "none"],
    ]);
    expect(check(summary, "payment")?.detail).toBe("5¢ for Freezing and reheating");
    expect(check(summary, "delivery")?.detail).toBe("3,295 bytes of text/html, HTTP 200");
    expect(summary.timeline.map((t) => t.id)).toEqual(["paid", "delivered", "window"]);
    const window = summary.timeline.at(-1);
    expect(window?.upcoming).toBe(true);
    expect(Date.parse(window?.at ?? "") - Date.parse(SETTLED)).toBe(
      DISPUTE_POLICY.windowHours * 3_600_000,
    );
    expect(summary.split).toMatchObject({
      amount: "5¢",
      publisher: "4.75¢",
      publisherPercent: "95",
      fee: "0.25¢",
      feePercent: "5",
      publisherShare: 95,
    });
  });

  it("says the window ended once 24 hours have passed", () => {
    const summary = summarizeReceipt(
      outcome([checked(payment), checked(delivery)]),
      new Date("2026-11-13T00:00:00.000Z"),
    );
    expect(summary.timeline.at(-1)).toMatchObject({
      title: "Dispute window ended",
      upcoming: false,
    });
  });

  it("is calm about a payment with no delivery statement", () => {
    const summary = summarizeReceipt(outcome([checked(payment)]), BEFORE_WINDOW_ENDS);
    expect(summary.trusted).toBe(true);
    expect(verdictText(summary)).toBe("The signature is valid.");
    expect(check(summary, "delivery")).toMatchObject({
      state: "none",
      detail: "No delivery statement for this receipt",
    });
    expect(summary.delivery).toBeNull();
    expect(summary.timeline.map((t) => t.id)).toEqual(["paid", "window"]);
  });

  it("shows a refund and drops the dispute window", () => {
    const summary = summarizeReceipt(
      outcome([checked(payment), checked(delivery), checked(refund)]),
      BEFORE_WINDOW_ENDS,
    );
    expect(summary.trusted).toBe(true);
    expect(check(summary, "refund")).toMatchObject({
      state: "refunded",
      detail: "Refunded 5¢ through Fare Court",
    });
    expect(summary.timeline.map((t) => t.id)).toEqual(["paid", "delivered", "refunded"]);
  });

  it("trusts nothing when one signature fails, and says which", () => {
    const summary = summarizeReceipt(
      outcome([checked(payment, false), checked(delivery)]),
      BEFORE_WINDOW_ENDS,
    );
    expect(summary.trusted).toBe(false);
    expect(verdictText(summary)).toBe("1 of 2 signatures is not valid.");
    expect(check(summary, "signed")).toMatchObject({ state: "fail", detail: "1 of 2 not valid" });
    expect(check(summary, "payment")).toMatchObject({
      state: "fail",
      detail: "Signature not valid",
    });
    expect(summary.payment).toBeNull();
    // The ticket still shows what the statement says, marked as not proven.
    expect(summary.paymentAsWritten?.payment.amountMicros).toBe(50_000);
    expect(summary.split).toBeNull();
    expect(summary.timeline.some((t) => t.id === "window")).toBe(false);
    expect(summary.failures).toEqual([
      expect.objectContaining({
        title: "Payment statement",
        reason:
          "Signature does not verify. Someone changed it after BotFare signed it, or BotFare never signed it.",
      }),
    ]);
  });

  it("does not count a valid statement about another receipt", () => {
    const other = { ...delivery, sub: "rcpt_ffffffffffffffff" };
    const summary = summarizeReceipt(outcome([checked(payment), checked(other)]));
    expect(summary.trusted).toBe(false);
    expect(summary.delivery).toBeNull();
    expect(summary.failures[0]?.reason).toBe(
      `The signature is valid, but it is about rcpt_ffffffffffffffff, not ${RECEIPT}.`,
    );
  });

  it("says what was not pasted instead of what BotFare lacks", () => {
    const summary = summarizeReceipt(
      outcome([checked(payment)], { source: "pasted", missing: [] }),
    );
    expect(check(summary, "delivery")?.detail).toBe("Not in what you pasted");
    expect(check(summary, "refund")?.detail).toBe("Not in what you pasted");
  });

  it("names no page when the payment statement is bound to none", () => {
    const unbound = { ...payment, payment: { ...payment.payment, resource: null } };
    const summary = summarizeReceipt(outcome([checked(unbound)]));
    expect(check(summary, "payment")).toMatchObject({
      state: "none",
      detail: "The statement names no page",
    });
  });
});
