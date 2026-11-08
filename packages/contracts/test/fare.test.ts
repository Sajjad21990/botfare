import { describe, expect, it } from "vitest";
import {
  advisorRecommendationSchema,
  citationReportSchema,
  contentDigestSha256,
  declineNoteSchema,
  disputeRequestSchema,
  disputeVerdictSchema,
  isContentDigest,
  receiptAttestationPath,
  receiptAttestationSchema,
} from "../src/fare";

describe("fare contracts", () => {
  it("computes RFC 9530 sha-256 content digests over the exact bytes", async () => {
    // sha256("hello") = 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
    const digest = await contentDigestSha256("hello");
    expect(digest).toBe("sha-256=:LPJNul+wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ=:");
    expect(isContentDigest(digest)).toBe(true);
    expect(await contentDigestSha256(new TextEncoder().encode("hello"))).toBe(digest);
    expect(isContentDigest("sha-256=:nope:")).toBe(false);
  });

  it("builds the attestation path and validates attestations", async () => {
    expect(receiptAttestationPath("rcpt_1")).toBe("/api/x402/receipts/rcpt_1/attest");
    const ok = receiptAttestationSchema.safeParse({
      contentDigest: await contentDigestSha256("x"),
      contentLength: 1,
      contentType: "text/html",
      status: 200,
    });
    expect(ok.success).toBe(true);
  });

  it("validates dispute requests and verdicts", () => {
    expect(
      disputeRequestSchema.safeParse({
        receiptId: "rcpt_1",
        reason: "stub_or_paywall",
        contentBase64: "aGVsbG8=",
      }).success,
    ).toBe(true);
    expect(
      disputeRequestSchema.safeParse({
        receiptId: "x_1",
        reason: "stub_or_paywall",
        contentBase64: "",
      }).success,
    ).toBe(false);
    const verdict = disputeVerdictSchema.parse({
      decision: "refund",
      confidence: 0.92,
      category: "stub_or_paywall",
      rationale: "The page is a subscription prompt, not the declared guide.",
    });
    expect(verdict.evidence).toEqual([]);
    expect(disputeVerdictSchema.safeParse({ ...verdict, confidence: 2 }).success).toBe(false);
  });

  it("validates advisor signals and recommendations", () => {
    expect(
      declineNoteSchema.parse({
        url: "https://demo.example/a",
        priceCents: 50,
        reason: "thin listicle",
      }).category,
    ).toBe("other");
    expect(citationReportSchema.safeParse({ answerId: "answer-1234", citations: [] }).success).toBe(
      false,
    );
    expect(
      advisorRecommendationSchema.safeParse({
        pattern: "/articles/premium-*",
        kind: "price",
        currentPriceCents: 50,
        suggestedPriceCents: 8,
        headline: "Agents skip this page at 50¢",
        rationale: "14 of 23 agents called it a thin listicle.",
        evidence: {
          offers: 23,
          paid: 0,
          declined: 23,
          cited: 0,
          disputed: 0,
          topReasons: [{ reason: "thin listicle", count: 14 }],
        },
        projectedWeeklyRevenueDeltaCents: 120,
        confidence: 0.7,
      }).success,
    ).toBe(true);
  });
});
