import type { Metadata } from "next";
import { Audiences } from "@/components/landing/audiences";
import { BuiltOn } from "@/components/landing/built-on";
import { FeeMaths } from "@/components/landing/fee-maths";
import { landingMono, landingSans } from "@/components/landing/fonts";
import { Hero } from "@/components/landing/hero";
import { HowItWorks } from "@/components/landing/how-it-works";
import styles from "@/components/landing/landing.module.css";
import { Problem } from "@/components/landing/problem";
import { SiteFooter } from "@/components/landing/site-footer";
import { SiteHeader } from "@/components/landing/site-header";

export const metadata: Metadata = {
  title: "BotFare: every bot pays its fare",
  description:
    "Pay-per-request for AI agents, settled on PayPal: x402 for PayPal's 440 million accounts.",
};

export default function Home() {
  return (
    <div
      className={`${landingSans.variable} ${landingMono.variable} ${styles.root} flex flex-1 flex-col`}
    >
      <SiteHeader />
      <main className="flex-1">
        <Hero />
        <Problem />
        <FeeMaths />
        <HowItWorks />
        <Audiences />
        <BuiltOn />
      </main>
      <SiteFooter />
    </div>
  );
}
