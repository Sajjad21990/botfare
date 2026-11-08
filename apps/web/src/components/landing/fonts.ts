import { Overpass, Overpass_Mono } from "next/font/google";

/** Overpass descends from highway signage lettering: fitting for a page about fares. */
export const landingSans = Overpass({
  subsets: ["latin"],
  variable: "--font-landing-sans",
  display: "swap",
});

/** Used only for what is literally on the wire: HTTP lines, headers, IDs. */
export const landingMono = Overpass_Mono({
  subsets: ["latin"],
  variable: "--font-landing-mono",
  display: "swap",
});
