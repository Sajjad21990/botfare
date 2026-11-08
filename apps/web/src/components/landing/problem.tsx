const problems = [
  {
    title: "AI reads for free.",
    body: "Agents answer questions from publishers' pages and call their APIs without paying. With an AI summary at the top of search results, people click through on 8% of visits instead of 15%.",
  },
  {
    title: "Paying per request needs crypto.",
    body: "x402, the open HTTP 402 standard for agent payments, settles in stablecoins on blockchains. PayPal is a Premier member of the x402 Foundation, yet x402 has no way to settle to a PayPal account.",
  },
  {
    title: "Card-style fees swallow cents.",
    body: "A PayPal payment costs at least 3.49% + 49¢, so a 3¢ read would carry about 49¢ in fees. Even the micropayments rate, 4.99% + 9¢, costs three times the read.",
  },
];

export function Problem() {
  return (
    <section aria-labelledby="problem-title" className="border-b">
      <div className="mx-auto grid w-full max-w-6xl gap-10 px-4 py-20 sm:px-6 sm:py-24 lg:grid-cols-[20rem_1fr] lg:gap-20">
        <h2
          id="problem-title"
          className="text-3xl leading-tight font-bold tracking-tight text-balance sm:text-4xl"
        >
          The web&apos;s newest readers don&apos;t have a way to pay.
        </h2>
        <ul className="divide-y">
          {problems.map((p) => (
            <li key={p.title} className="py-6 first:pt-0 last:pb-0">
              <h3 className="text-xl font-bold tracking-tight">{p.title}</h3>
              <p className="mt-2 max-w-[62ch] leading-relaxed text-muted-foreground">{p.body}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
