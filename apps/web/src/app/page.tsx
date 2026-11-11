import type { Metadata } from "next";
import { AiCards } from "@/components/landing/ai-cards";
import { Hero } from "@/components/landing/hero";
import { HowSteps } from "@/components/landing/how-steps";
import styles from "@/components/landing/landing.module.css";
import { PaypalMath } from "@/components/landing/paypal-math";
import { SetupBand } from "@/components/landing/setup-band";
import { SiteFooter } from "@/components/landing/site-footer";
import { SiteHeader } from "@/components/landing/site-header";

export const metadata: Metadata = {
  title: "BotFare: every bot pays its fare",
  description: "AI agents pay websites a few cents a page through PayPal. People still read free.",
};

export default function Home() {
  return (
    <div className={`${styles.root} flex flex-1 flex-col`}>
      <SiteHeader />
      <main className="flex-1">
        <Hero />
        <HowSteps />
        <SetupBand />
        <AiCards />
        <PaypalMath />
      </main>
      <SiteFooter />
    </div>
  );
}
