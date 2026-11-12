"use client";

import { BarChart3, Globe } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { buttonVariants } from "@/components/ui/button";
import { AddSiteDialog } from "./add-site-dialog";
import { FareAdvisorCard } from "./advisor/fare-advisor-card";
import { api } from "./api";
import { DisputesLink } from "./disputes-link";
import { EarningsCard, PayoutEmailCard, PayoutHistory } from "./earnings";
import { SiteCard } from "./site-card";
import type { PayoutView, PublisherDashboard, SiteView } from "./types";

const REFRESH_MS = 15_000;

/** The /publisher page body. Starts from server-rendered data and keeps itself fresh. */
export function PublisherView({
  initial,
  botfareUrl,
}: {
  initial: PublisherDashboard;
  botfareUrl: string;
}) {
  const [data, setData] = useState(initial);
  // Bumped when Fare Advisor changes a site's prices, so that site's pricing editor reloads them.
  const [advisorApplied, setAdvisorApplied] = useState<Record<string, number>>({});

  const reload = useCallback(async () => {
    try {
      setData(await api<PublisherDashboard>("GET", "/api/publisher/summary"));
    } catch {
      // Background refresh only; the page keeps what it has.
    }
  }, []);

  // Earnings move whenever an agent pays, so refresh while the tab is visible.
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "visible") void reload();
    };
    const id = setInterval(tick, REFRESH_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [reload]);

  function replaceSite(site: SiteView) {
    setData((current) => ({
      ...current,
      sites: current.sites.map((s) =>
        s.id === site.id
          ? { ...site, paidRequests: s.paidRequests, earningsMicros: s.earningsMicros }
          : s,
      ),
    }));
  }

  function addSite(site: SiteView) {
    setData((current) => ({ ...current, sites: [site, ...current.sites] }));
    void reload();
  }

  function applyFromAdvisor(site: SiteView) {
    replaceSite(site);
    setAdvisorApplied((current) => ({ ...current, [site.id]: (current[site.id] ?? 0) + 1 }));
  }

  function addPayout(payout: PayoutView) {
    setData((current) => ({ ...current, payouts: [payout, ...current.payouts] }));
    void reload();
  }

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
          <p className="text-sm text-muted-foreground">
            Price your pages for AI agents and get paid through PayPal.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link href="/publisher/analytics" className={buttonVariants({ variant: "outline" })}>
            <BarChart3 />
            Analytics
          </Link>
          <DisputesLink />
          {data.sites.length > 0 && (
            <AddSiteDialog
              defaultPayoutEmail={data.payoutEmail}
              botfareUrl={botfareUrl}
              onCreated={addSite}
            />
          )}
        </div>
      </div>

      <EarningsCard data={data} onPayout={addPayout} />

      {data.sites.length > 0 && <FareAdvisorCard sites={data.sites} onApplied={applyFromAdvisor} />}

      <section className="space-y-4" aria-labelledby="publisher-sites">
        <div className="space-y-1">
          <h2 id="publisher-sites" className="text-lg font-semibold tracking-tight">
            {data.sites.length > 1 ? "Your sites" : "Your site"}
          </h2>
          <p className="text-sm text-muted-foreground">
            Set your prices here. Changes reach your site within 30 seconds.
          </p>
        </div>
        {data.sites.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed px-6 py-14 text-center">
            <span className="flex size-10 items-center justify-center rounded-full bg-muted">
              <Globe className="size-5 text-muted-foreground" />
            </span>
            <div className="space-y-1">
              <p className="font-medium">Add your first site</p>
              <p className="max-w-sm text-sm text-muted-foreground">
                Register a site, add one line to your server, and AI agents start paying their fare.
                People keep reading free.
              </p>
            </div>
            <AddSiteDialog
              defaultPayoutEmail={data.payoutEmail}
              botfareUrl={botfareUrl}
              onCreated={addSite}
              trigger="large"
            />
          </div>
        ) : (
          <div className="space-y-4">
            {data.sites.map((site) => (
              <SiteCard
                key={`${site.id}:${advisorApplied[site.id] ?? 0}`}
                site={site}
                botfareUrl={botfareUrl}
                onChange={replaceSite}
              />
            ))}
          </div>
        )}
      </section>

      <section className="space-y-4" aria-labelledby="publisher-payouts">
        <div className="space-y-1">
          <h2 id="publisher-payouts" className="text-lg font-semibold tracking-tight">
            Payouts
          </h2>
          <p className="text-sm text-muted-foreground">
            Where your earnings go, and every PayPal payout so far.
          </p>
        </div>
        <div className="grid gap-4 lg:grid-cols-3">
          <PayoutEmailCard
            key={`${data.payoutEmail ?? ""}:${data.payoutEmailOnProfile}`}
            data={data}
            onSaved={(payoutEmail, payoutEmailOnProfile) =>
              setData((current) => ({ ...current, payoutEmail, payoutEmailOnProfile }))
            }
          />
          <PayoutHistory
            className="lg:col-span-2"
            payouts={data.payouts}
            onSynced={(payouts) => {
              setData((current) => ({ ...current, payouts }));
              void reload();
            }}
          />
        </div>
      </section>
    </div>
  );
}
