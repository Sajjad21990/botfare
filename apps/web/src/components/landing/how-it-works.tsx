import styles from "./landing.module.css";

type WireLine = { text: string; tone?: "required" | "paid" };

type Step = {
  title: string;
  body: string;
  wire: WireLine[];
};

const steps: Step[] = [
  {
    title: "The agent asks for a page",
    body: "An agent requests an article or an API call like any HTTP client. A person browsing the same site is never charged.",
    wire: [{ text: "GET /articles/burr-basics" }],
  },
  {
    title: "The publisher names the fare",
    body: "The reply is a 402 with the price and the declared offer in a PAYMENT-REQUIRED header, plus a free preview so the agent can decide before it pays. An agent that passes can leave a free decline note for Fare Advisor.",
    wire: [
      { text: "402 Payment Required", tone: "required" },
      {
        text: 'PAYMENT-REQUIRED (decoded): {"x402Version":2,"accepts":[{"scheme":"prepaid","network":"paypal:sandbox","asset":"USD","amount":"3","extra":{"botfareOffer":{"title":"Burr grinders, explained",…}}}]}',
      },
    ],
  },
  {
    title: "The agent signs for exactly that fare",
    body: "It checks the price against its budget, then signs a single-use Ed25519 authorization with a fresh nonce. The authorization expires within 60 seconds.",
    wire: [
      { text: "GET /articles/burr-basics" },
      {
        text: 'PAYMENT-SIGNATURE (decoded): {"x402Version":2,"accepted":{"scheme":"prepaid",…},"payload":{"authorization":"eyJhbGciOiJFZERTQSIs…"}}',
      },
    ],
  },
  {
    title: "BotFare verifies, the page is served, BotFare settles",
    body: "Settlement runs only after the publisher's handler succeeds, so a failed response costs nothing. One ledger transaction moves the money.",
    wire: [
      { text: "wallet        −$0.0300" },
      { text: "publisher     +$0.0285" },
      { text: "BotFare fee   +$0.0015" },
    ],
  },
  {
    title: "The agent gets the content and a receipt",
    body: "The response carries the page and a PAYMENT-RESPONSE header with the receipt ID. The middleware then attests a digest of the bytes it sent, so Fare Court can settle a dispute later.",
    wire: [
      { text: "200 OK", tone: "paid" },
      {
        text: 'PAYMENT-RESPONSE (decoded): {"success":true,"transaction":"rcpt_9d2e41b7","network":"paypal:sandbox"}',
      },
      { text: "then, to BotFare: POST /api/x402/receipts/rcpt_9d2e41b7/attest" },
      { text: '{"contentDigest":"sha-256=:+oWVrNYqTwN…=:"}' },
    ],
  },
];

const toneClass: Record<NonNullable<WireLine["tone"]>, string> = {
  required: "font-semibold text-amber-700 dark:text-amber-400",
  paid: "font-semibold text-emerald-700 dark:text-emerald-400",
};

export function HowItWorks() {
  return (
    <section id="how-it-works" aria-labelledby="how-title" className={`${styles.anchor} border-b`}>
      <div className="mx-auto w-full max-w-6xl px-4 py-20 sm:px-6 sm:py-24">
        <div className="max-w-2xl">
          <h2
            id="how-title"
            className="text-3xl leading-tight font-bold tracking-tight text-balance sm:text-4xl"
          >
            How a paid request works
          </h2>
          <p className="mt-4 text-lg leading-relaxed text-muted-foreground">
            Standard x402 V2, with a new payment type: scheme{" "}
            <code className={styles.mono}>prepaid</code> on network{" "}
            <code className={styles.mono}>paypal:sandbox</code>. Publishers and agents use the
            official x402 SDK with the BotFare plug-in. The headers are base64 JSON, shown decoded
            here.
          </p>
        </div>

        <ol className="mt-12">
          {steps.map((step, i) => {
            const last = i === steps.length - 1;
            return (
              <li
                key={step.title}
                className="relative grid grid-cols-[2.5rem_1fr] gap-x-4 sm:gap-x-6"
              >
                {!last && (
                  <span
                    aria-hidden
                    className="absolute top-10 bottom-0 left-5 w-px -translate-x-1/2 bg-border"
                  />
                )}
                <span
                  aria-hidden
                  className={`${styles.tabular} relative z-10 flex size-10 items-center justify-center rounded-full border-2 border-foreground bg-background text-base font-bold`}
                >
                  {i + 1}
                </span>
                <div
                  className={`grid gap-4 pt-1.5 lg:grid-cols-[minmax(0,22rem)_1fr] lg:gap-10 ${last ? "" : "pb-12"}`}
                >
                  <div>
                    <h3 className="text-lg font-bold tracking-tight">
                      <span className="sr-only">Step {i + 1}: </span>
                      {step.title}
                    </h3>
                    <p className="mt-1.5 leading-relaxed text-muted-foreground">{step.body}</p>
                  </div>
                  <pre
                    className={`${styles.mono} self-start rounded-lg border bg-muted/50 px-4 py-3 text-[13px] leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]`}
                  >
                    {step.wire.map((line) => (
                      <span
                        key={line.text}
                        className={`block ${line.tone ? toneClass[line.tone] : ""}`}
                      >
                        {line.text}
                      </span>
                    ))}
                  </pre>
                </div>
              </li>
            );
          })}
        </ol>
      </div>
    </section>
  );
}
