import { Bricolage_Grotesque, Inter, JetBrains_Mono } from "next/font/google";

/** Body text and UI: plain and very readable. */
export const bodySans = Inter({ subsets: ["latin"], variable: "--font-body", display: "swap" });

/** Headlines, prices and the wordmark: friendly letters with character, like the bot. */
export const displaySans = Bricolage_Grotesque({
  subsets: ["latin"],
  variable: "--font-display",
  display: "swap",
});

/** What is literally code or on the wire: snippets, headers, receipt IDs. */
export const codeMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-code",
  display: "swap",
  preload: false,
});
