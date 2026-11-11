import type { Metadata } from "next";
import { BuiltOn } from "@/components/landing/built-on";
import { Hero } from "@/components/landing/hero";
import { HowItWorks } from "@/components/landing/how-it-works";
import styles from "@/components/landing/landing.module.css";
import { PillarAdvisor } from "@/components/landing/pillar-advisor";
import { PillarCourt } from "@/components/landing/pillar-court";
import { PillarFares } from "@/components/landing/pillar-fares";
import { PillarIndex } from "@/components/landing/pillar-index";
import { Problem } from "@/components/landing/problem";
import { SiteFooter } from "@/components/landing/site-footer";
import { SiteHeader } from "@/components/landing/site-header";
import { Thesis } from "@/components/landing/thesis";
import { Trust } from "@/components/landing/trust";

export const metadata: Metadata = {
  title: "BotFare: every bot pays its fare",
  description:
    "Pay-per-request for AI agents, settled on PayPal: x402 for PayPal's 440 million accounts, with Fare Court buyer protection and Fare Advisor pricing.",
};

export default function Home() {
  return (
    <div className={`${styles.root} flex flex-1 flex-col`}>
      <SiteHeader />
      <main className="flex-1">
        <Hero />
        <PillarIndex />
        <Problem />
        <Thesis />
        <PillarFares />
        <PillarCourt />
        <PillarAdvisor />
        <HowItWorks />
        <Trust />
        <BuiltOn />
      </main>
      <SiteFooter />
    </div>
  );
}
