import { RECEIPT_JWT_TYPE, RECEIPT_KEYS_PATH } from "@botfare/contracts/receipts";
import { ChevronRight } from "lucide-react";
import { NewTabLink } from "@/components/app/external-link";
import landing from "@/components/landing/landing.module.css";
import { readmeUrl } from "@/components/landing/links";
import { disclosureSummary } from "./disclosure";

const points = [
  {
    title: "Signed once, when it happens",
    body: "BotFare signs a payment statement when it settles, a delivery statement when the site reports what it sent, and a refund statement when it refunds. It never signs the same event twice.",
  },
  {
    title: "Ed25519 JWS",
    body: `Each statement is a compact JWS (RFC 7515) signed with EdDSA over Ed25519 (RFC 8037), typ ${RECEIPT_JWT_TYPE}. Its kid header names the signing key.`,
  },
  {
    title: "Public keys",
    body: `The public keys are a JWKS (RFC 7517) at ${RECEIPT_KEYS_PATH}. Private keys never leave the server. This page fetches the keys and checks every signature in your browser.`,
  },
  {
    title: "Content digests",
    body: "A delivery statement carries the RFC 9530 SHA-256 digest of the exact body the site sent. Hash your copy and compare. One changed byte gives a different digest.",
  },
  {
    title: "Limits",
    body: "A valid signature proves BotFare issued the statement. It does not prove that BotFare never deleted a receipt or that the content was accurate. A tamper-evident log of every receipt is not built yet.",
  },
];

/** Plain explanation of the cryptography behind /verify. */
export function HowVerifyWorks() {
  return (
    <details className="group rounded-xl border border-foreground/15 bg-card">
      <summary className={disclosureSummary}>
        <ChevronRight
          aria-hidden
          className="size-4 shrink-0 transition-transform group-open:rotate-90 motion-reduce:transition-none"
        />
        <span className="font-heading text-lg font-bold">How this works</span>
      </summary>
      <div className="border-t border-foreground/10 px-4 pt-4 pb-5 sm:px-5">
        <dl className="grid gap-x-8 gap-y-5 text-sm sm:grid-cols-2">
          {points.map((point) => (
            <div key={point.title}>
              <dt className="font-semibold">{point.title}</dt>
              <dd className="mt-1 leading-relaxed text-muted-foreground">{point.body}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-5 border-t border-dashed border-foreground/25 pt-4 text-sm leading-relaxed text-muted-foreground">
          To check offline, call <span className="font-mono">verifyStatement()</span> from{" "}
          <span className="font-mono">@botfare/contracts/receipts</span> with a saved copy of the
          keys. It runs in Node and in the browser.{" "}
          <NewTabLink
            href={readmeUrl("signed-receipts")}
            icon
            className={`${landing.focusRing} inline-flex items-center gap-0.5 rounded-sm font-medium text-foreground underline decoration-foreground/40 underline-offset-4 hover:decoration-foreground`}
          >
            Signed receipts in the README
          </NewTabLink>
        </p>
      </div>
    </details>
  );
}
