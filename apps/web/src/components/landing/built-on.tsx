const parts = [
  {
    name: "x402 V2",
    role: "The open HTTP 402 standard. BotFare adds the prepaid scheme on paypal:sandbox as a plug-in for the official SDK.",
  },
  {
    name: "PayPal Orders v2 and JS SDK v6",
    role: "Wallet top-ups. The wallet is credited only from a confirmed capture, and PayPal's fee is booked from it.",
  },
  {
    name: "PayPal Payouts",
    role: "Publisher earnings, paid in batches with an idempotent sender batch ID.",
  },
  {
    name: "PayPal Webhooks",
    role: "Signature-verified events keep captures and payouts in sync with the ledger.",
  },
];

export function BuiltOn() {
  return (
    <section aria-labelledby="built-title" className="border-b bg-muted/40">
      <div className="mx-auto grid w-full max-w-6xl gap-10 px-4 py-20 sm:px-6 sm:py-24 lg:grid-cols-[20rem_1fr] lg:gap-20">
        <h2
          id="built-title"
          className="text-3xl leading-tight font-bold tracking-tight text-balance sm:text-4xl"
        >
          Built on x402 V2 + PayPal Orders, JS SDK v6, Payouts, Webhooks
        </h2>
        <dl className="grid gap-x-10 gap-y-8 sm:grid-cols-2">
          {parts.map((p) => (
            <div key={p.name}>
              <dt className="font-bold">{p.name}</dt>
              <dd className="mt-1.5 leading-relaxed text-muted-foreground">{p.role}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}
