import styles from "./landing.module.css";

/**
 * Fees on $5.00 of 3¢ reads (166 reads), at PayPal's published US rates.
 * Standard: 166 × (3.49% × $0.03 + $0.49) = $81.51.
 * Micropayments: 166 × (4.99% × $0.03 + $0.09) = $15.19.
 * BotFare: one $5.00 top-up, 3.49% × $5.00 + $0.49 = $0.66 (also the fee measured in sandbox).
 */
const rows = [
  {
    method: "PayPal checkout, paid per read",
    rate: "3.49% + 49¢ on every read",
    transactions: "166",
    fees: 81.51,
  },
  {
    method: "PayPal micropayments rate, paid per read",
    rate: "4.99% + 9¢ on every read",
    transactions: "166",
    fees: 15.19,
  },
  {
    method: "BotFare",
    rate: "One $5.00 top-up; each read settles in the ledger",
    transactions: "1",
    fees: 0.66,
    highlight: true,
  },
];

const maxFee = Math.max(...rows.map((r) => r.fees));
const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

export function FeeMaths() {
  return (
    <section aria-labelledby="fees-title" className="border-b bg-muted/40">
      <div className="mx-auto w-full max-w-6xl px-4 py-20 sm:px-6 sm:py-24">
        <div className="max-w-2xl">
          <h2
            id="fees-title"
            className="text-3xl leading-tight font-bold tracking-tight text-balance sm:text-4xl"
          >
            One top-up instead of 166 payments.
          </h2>
          <p className="mt-4 text-lg leading-relaxed text-muted-foreground">
            $5.00 buys about 166 reads at 3¢. Paid one by one, every read carries its own PayPal
            fee. Through BotFare, the fee is paid once, on the top-up.
          </p>
        </div>

        <div className="mt-10 overflow-hidden rounded-xl border bg-background">
          <table className={`${styles.tabular} w-full text-left text-sm sm:text-base`}>
            <caption className="sr-only">
              PayPal fees on $5.00 of 3¢ reads, by payment method
            </caption>
            <thead className="border-b text-xs text-muted-foreground sm:text-sm">
              <tr>
                <th scope="col" className="px-4 py-3 font-medium sm:px-6">
                  How 166 reads are paid
                </th>
                <th scope="col" className="px-2 py-3 text-right font-medium sm:px-6">
                  PayPal payments
                </th>
                <th scope="col" className="px-4 py-3 text-right font-medium sm:px-6">
                  Fees
                </th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows.map((row) => (
                <tr
                  key={row.method}
                  className={row.highlight ? "bg-emerald-50/60 dark:bg-emerald-950/30" : undefined}
                >
                  <th scope="row" className="px-4 py-5 align-top font-normal sm:px-6">
                    <span className="block font-semibold">{row.method}</span>
                    <span className="mt-0.5 block text-sm text-muted-foreground">{row.rate}</span>
                    <span
                      aria-hidden
                      className="mt-3 block h-2 w-full max-w-md rounded-full bg-muted"
                    >
                      <span
                        className={`${styles.bar} block h-2 rounded-full ${
                          row.highlight ? "bg-emerald-600 dark:bg-emerald-400" : "bg-foreground/70"
                        }`}
                        style={{ width: `${(row.fees / maxFee) * 100}%` }}
                      />
                    </span>
                  </th>
                  <td className="px-2 py-5 text-right align-top sm:px-6">{row.transactions}</td>
                  <td
                    className={`px-4 py-5 text-right align-top font-bold sm:px-6 ${
                      row.highlight ? "text-emerald-700 dark:text-emerald-400" : ""
                    }`}
                  >
                    {usd.format(row.fees)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="mt-5 max-w-3xl text-sm leading-relaxed text-muted-foreground">
          PayPal&apos;s published US rates. The $0.66 top-up fee is what the sandbox capture
          reported. Publishers keep 95% of each fare and receive one Payouts batch for a day&apos;s
          earnings, not one payment per read.
        </p>
      </div>
    </section>
  );
}
