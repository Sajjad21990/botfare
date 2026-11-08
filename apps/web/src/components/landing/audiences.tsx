import { BotIcon, NewspaperIcon, WalletIcon } from "lucide-react";

const audiences = [
  {
    icon: NewspaperIcon,
    title: "Publishers",
    body: "Add one line of middleware, set a price per page or API call, and get paid through PayPal Payouts.",
  },
  {
    icon: WalletIcon,
    title: "Agent owners",
    body: "Top up with PayPal and give each agent a key with a daily cap, a per-request maximum and a list of allowed sites.",
  },
  {
    icon: BotIcon,
    title: "Agents",
    body: "Read the price and a free preview, then pay a few cents per request with a signed x402 payment.",
  },
];

export function Audiences() {
  return (
    <section aria-labelledby="audiences-title" className="border-b">
      <div className="mx-auto w-full max-w-6xl px-4 py-20 sm:px-6 sm:py-24">
        <h2
          id="audiences-title"
          className="max-w-2xl text-3xl leading-tight font-bold tracking-tight text-balance sm:text-4xl"
        >
          Three riders, one fare system
        </h2>
        <ul className="mt-12 grid gap-10 md:grid-cols-3 md:gap-8">
          {audiences.map(({ icon: Icon, title, body }) => (
            <li key={title} className="border-t-2 border-foreground pt-5">
              <Icon aria-hidden className="size-6" strokeWidth={1.75} />
              <h3 className="mt-4 text-xl font-bold tracking-tight">{title}</h3>
              <p className="mt-2 leading-relaxed text-muted-foreground">{body}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
