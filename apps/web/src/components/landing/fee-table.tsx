import styles from "./landing.module.css";

/**
 * Fees on $5.00 of 3¢ reads (166 reads), at PayPal's published US rates.
 * Standard: 166 × (3.49% × $0.03 + $0.49) = $81.51.
 * Micropayments: 166 × (4.99% × $0.03 + $0.09) = $15.19.
 * BotFare: one $5.00 top-up, 3.49% × $5.00 + $0.49 = $0.66 (also the fee measured in sandbox).
 */
const rows = [
  {
    method: "PayPal checkout, per read",
    rate: "3.49% + 49¢ on every read",
    transactions: "166",
    fees: 81.51,
  },
  {
    method: "PayPal micropayments, per read",
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

/** The Fares example: PayPal fees on $5.00 of 3¢ reads, three ways. */
export function FeeTable() {
  return (
    <figure>
      <div className="overflow-hidden rounded-xl border bg-background">
        <table className={`${styles.tabular} w-full text-left text-sm`}>
          <caption className="border-b px-4 py-3 text-left text-base font-bold sm:px-5">
            One top-up instead of 166 payments
          </caption>
          <thead className="border-b text-xs text-muted-foreground">
            <tr>
              <th scope="col" className="px-4 py-2.5 font-medium sm:px-5">
                How $5.00 of 3¢ reads is paid
              </th>
              <th scope="col" className="px-2 py-2.5 text-right font-medium">
                Payments
              </th>
              <th scope="col" className="px-4 py-2.5 text-right font-medium sm:px-5">
                PayPal fees
              </th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.map((row) => (
              <tr
                key={row.method}
                className={row.highlight ? "bg-emerald-50/60 dark:bg-emerald-950/30" : undefined}
              >
                <th scope="row" className="px-4 py-4 align-top font-normal sm:px-5">
                  <span className="block font-semibold">{row.method}</span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">{row.rate}</span>
                  <span aria-hidden className="mt-2.5 block h-1.5 w-full rounded-full bg-muted">
                    <span
                      className={`${styles.bar} block h-1.5 rounded-full ${
                        row.highlight ? "bg-emerald-600 dark:bg-emerald-400" : "bg-foreground/70"
                      }`}
                      style={{ width: `${(row.fees / maxFee) * 100}%` }}
                    />
                  </span>
                </th>
                <td className="px-2 py-4 text-right align-top">{row.transactions}</td>
                <td
                  className={`px-4 py-4 text-right align-top font-bold sm:px-5 ${
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
      <figcaption className="mt-4 text-sm leading-relaxed text-muted-foreground">
        $5.00 buys about 166 reads at 3¢. PayPal&apos;s published US rates; the $0.66 top-up fee is
        what the sandbox capture reported.
      </figcaption>
    </figure>
  );
}
