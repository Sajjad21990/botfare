import Link from "next/link";
import styles from "./landing.module.css";

type Row = { what: string; standard: string; body: string };

const rows: Row[] = [
  {
    what: "Agent payments",
    standard: "Ed25519 JWS",
    body: "The agent's key signs each fare: the exact amount and payee, a single-use nonce and a 60-second expiry. BotFare checks it before the page is served.",
  },
  {
    what: "Agent requests",
    standard: "RFC 9421 HTTP Message Signatures (Web Bot Auth)",
    body: "Agents sign each request. The publisher's middleware checks the signature against BotFare's key directory, so a signed agent cannot be spoofed by a user agent string.",
  },
  {
    what: "Delivery",
    standard: "RFC 9530 Content-Digest",
    body: "After serving a paid response, the publisher's middleware attests a SHA-256 digest of the exact bytes it sent. Fare Court and anyone holding the receipt can compare.",
  },
  {
    what: "Receipts",
    standard: "Signed by BotFare (Ed25519 JWS, public JWKS)",
    body: "BotFare signs a statement when a fare is paid, delivered or refunded, and publishes its public keys. Check any receipt in your own browser.",
  },
  {
    what: "PayPal webhooks",
    standard: "Verified with PayPal",
    body: "Each capture and payout event is verified with PayPal before it touches the ledger, and applied once.",
  },
];

export function Trust() {
  return (
    <section id="trust" aria-labelledby="trust-title" className={`${styles.anchor} border-b`}>
      <div className="mx-auto grid w-full max-w-6xl gap-10 px-4 py-20 sm:px-6 sm:py-24 lg:grid-cols-[20rem_1fr] lg:gap-20">
        <div>
          <h2
            id="trust-title"
            className="text-3xl leading-tight font-bold tracking-tight text-balance sm:text-4xl"
          >
            Trust and cryptography
          </h2>
          <p className="mt-4 leading-relaxed text-muted-foreground">
            Every party signs what it is responsible for, with open standards, so nobody has to take
            anyone&apos;s word for it, BotFare&apos;s included.
          </p>
          <Link
            href="/verify"
            className={`${styles.focusRing} mt-6 inline-flex items-center gap-1 rounded-md font-semibold underline underline-offset-4`}
          >
            Verify a receipt <span aria-hidden>→</span>
          </Link>
        </div>
        <div>
          <dl className="divide-y border-y">
            {rows.map((row) => (
              <div key={row.what} className="grid gap-1.5 py-4 sm:grid-cols-[11rem_1fr] sm:gap-6">
                <dt className="font-bold">{row.what}</dt>
                <dd>
                  <span className={`${styles.mono} text-[13px] font-medium`}>{row.standard}</span>
                  <p className="mt-1 leading-relaxed text-muted-foreground">{row.body}</p>
                </dd>
              </div>
            ))}
          </dl>
          <p className="mt-5 text-sm leading-relaxed text-muted-foreground">
            The honest limit: a signed receipt proves BotFare issued it and cannot deny it later. It
            does not prove BotFare never deleted one; a tamper-evident log of receipts is future
            work.
          </p>
        </div>
      </div>
    </section>
  );
}
