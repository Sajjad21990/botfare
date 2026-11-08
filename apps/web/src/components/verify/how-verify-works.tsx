import { RECEIPT_JWT_TYPE, RECEIPT_KEYS_PATH } from "@botfare/contracts/receipts";
import { ChevronRight } from "lucide-react";

const points = [
  {
    title: "Signed when it happens",
    body: "BotFare signs a payment statement when it settles a request, a delivery statement when the publisher attests the bytes it served, and a refund statement when a fare is refunded. Each is a record of that moment; BotFare never re-signs history with different content.",
  },
  {
    title: "Ed25519 JWS",
    body: `Each statement is a compact JSON Web Signature (RFC 7515) with the EdDSA algorithm over Ed25519 (RFC 8037), typ ${RECEIPT_JWT_TYPE}. The kid in its header names the key that signed it.`,
  },
  {
    title: "A public key directory (JWKS)",
    body: `BotFare publishes its public signing keys as a JSON Web Key Set (RFC 7517) at ${RECEIPT_KEYS_PATH}. The private keys never leave the server. This page fetches the set and checks signatures in your browser with WebCrypto, so you do not have to trust what BotFare's database says today.`,
  },
  {
    title: "RFC 9530 content digests",
    body: "A delivery statement carries the SHA-256 Content-Digest of the exact response body, as the publisher's middleware computed it. Hash your own copy and compare: one changed byte gives a different digest.",
  },
  {
    title: "What it does not prove",
    body: "A valid signature proves BotFare issued the statement and cannot deny it later. It does not prove BotFare never deleted a receipt or that the publisher's content is accurate; a tamper-evident log of all receipts is future work.",
  },
];

/** Plain explanation of the cryptography behind /verify. */
export function HowVerifyWorks() {
  return (
    <details className="group rounded-xl border px-4 py-3">
      <summary className="flex cursor-pointer list-none items-center gap-2 font-semibold [&::-webkit-details-marker]:hidden">
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
      <p className="mt-4 text-sm text-muted-foreground">
        To check offline, use <span className="font-mono">verifyStatement()</span> from{" "}
        <span className="font-mono">@botfare/contracts/receipts</span> with a saved copy of the key
        set; it runs in Node and in the browser.
      </p>
    </details>
  );
}
