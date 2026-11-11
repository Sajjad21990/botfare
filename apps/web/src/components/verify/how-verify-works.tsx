import { RECEIPT_JWT_TYPE, RECEIPT_KEYS_PATH } from "@botfare/contracts/receipts";
import { ChevronRight } from "lucide-react";
import { NewTabLink } from "@/components/app/external-link";
import { readmeUrl } from "@/components/landing/links";

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
    <details className="group rounded-xl border px-4 py-3">
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-sm font-semibold outline-none focus-visible:ring-3 focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden">
        <ChevronRight
          aria-hidden
          className="size-4 transition-transform group-open:rotate-90 motion-reduce:transition-none"
        />
        How this works
      </summary>
      <dl className="mt-4 flex flex-col gap-4 text-sm">
        {points.map((point) => (
          <div key={point.title}>
            <dt className="font-medium">{point.title}</dt>
            <dd className="mt-1 leading-relaxed text-muted-foreground">{point.body}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
        To check offline, call <span className="font-mono">verifyStatement()</span> from{" "}
        <span className="font-mono">@botfare/contracts/receipts</span> with a saved copy of the
        keys. It runs in Node and in the browser.{" "}
        <NewTabLink
          href={readmeUrl("signed-receipts")}
          icon
          className="inline-flex items-center gap-0.5 rounded-sm font-medium text-foreground underline underline-offset-4 outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          Signed receipts in the README
        </NewTabLink>
      </p>
    </details>
  );
}
