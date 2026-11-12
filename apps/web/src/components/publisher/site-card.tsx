"use client";

import {
  Code2,
  ExternalLink,
  KeyRound,
  Loader2,
  Lock,
  RefreshCw,
  ShieldCheck,
  Tags,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { NewTabLink } from "@/components/app/external-link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api, errorText } from "./api";
import { CodeBlock, CopyButton } from "./copy-button";
import { DetectionPanel } from "./detection-panel";
import { formatCount, formatMoney, formatMoneyExact } from "./format";
import { PricingEditor } from "./pricing-editor";
import { SecretReveal } from "./secret-reveal";
import type { SiteSecretResponse, SiteView } from "./types";

const REPO_URL = "https://github.com/Sajjad21990/botfare";

/** The line the site card's callout shows and copies. */
const ONE_LINE = "app.use(botfare({ siteId, siteSecret }));";

/**
 * The working version of that line for an Express app (strict TypeScript). `botfare()` reads
 * BOTFARE_URL from the environment; see packages/express/src/index.ts.
 */
export const MIDDLEWARE_SNIPPET = `import { botfare } from "@botfare/express";

// Before your routes. BOTFARE_URL, BOTFARE_SITE_ID and BOTFARE_SITE_SECRET live in .env
app.use(botfare({ siteId: process.env.BOTFARE_SITE_ID!, siteSecret: process.env.BOTFARE_SITE_SECRET! }));`;

type SiteTab = "pricing" | "detection" | "integration" | "secret";

/** One site: who it is, its prices, how to install the middleware, and its secret. */
export function SiteCard({
  site,
  botfareUrl,
  onChange,
}: {
  site: SiteView;
  botfareUrl: string;
  onChange: (site: SiteView) => void;
}) {
  const host = safeHost(site.origin);
  // A site nobody has paid yet most likely still needs the middleware: open on the setup steps.
  const [tab, setTab] = useState<SiteTab>(site.paidRequests === 0 ? "integration" : "pricing");
  return (
    <Card>
      <CardHeader className="gap-3 border-b">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="truncate text-base font-medium">{site.name}</h3>
              <Badge variant="secondary" className="font-normal">
                {site.pricing.length === 0
                  ? "No prices"
                  : `${site.pricing.length} ${site.pricing.length === 1 ? "rule" : "rules"}`}
              </Badge>
            </div>
            <NewTabLink
              href={site.origin}
              className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
            >
              {host}
              <ExternalLink aria-hidden className="size-3" />
            </NewTabLink>
          </div>
          <dl className="flex gap-6 text-right">
            <div>
              <dt className="text-xs text-muted-foreground">Paid requests</dt>
              <dd className="font-medium tabular-nums">{formatCount(site.paidRequests)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Earned</dt>
              <dd
                className="font-medium tabular-nums"
                title={formatMoneyExact(site.earningsMicros)}
              >
                {formatMoney(site.earningsMicros)}
              </dd>
            </div>
          </dl>
        </div>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span>Site ID</span>
          <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-foreground">
            {site.id}
          </code>
          <CopyButton value={site.id} label="Copy site ID" className="size-6" />
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <OneLineCallout />
        <Tabs value={tab} onValueChange={(value) => setTab(value as SiteTab)}>
          <TabsList
            variant="line"
            className="mb-3 -ml-1.5 max-w-[calc(100%+0.375rem)] justify-start overflow-x-auto"
          >
            <TabsTrigger value="pricing">
              <Tags />
              Pricing
            </TabsTrigger>
            <TabsTrigger value="detection">
              <ShieldCheck />
              Bot detection
            </TabsTrigger>
            <TabsTrigger value="integration">
              <Code2 />
              Integration
            </TabsTrigger>
            <TabsTrigger value="secret">
              <KeyRound />
              Secret
            </TabsTrigger>
          </TabsList>
          <TabsContent value="pricing">
            <PricingEditor site={site} onSaved={onChange} />
          </TabsContent>
          <TabsContent value="detection">
            <DetectionPanel site={site} onSaved={onChange} />
          </TabsContent>
          <TabsContent value="integration">
            <Integration site={site} botfareUrl={botfareUrl} />
          </TabsContent>
          <TabsContent value="secret">
            <SecretPanel site={site} botfareUrl={botfareUrl} onChange={onChange} />
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}

/** "Turned on with one line", above the tabs. */
function OneLineCallout() {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border bg-ticket px-3 py-2 text-ticket-foreground">
      <span className="text-sm">Turned on with one line:</span>
      <span className="flex min-w-0 items-center gap-1">
        {/* Wraps at its spaces on a phone rather than hiding the line behind an ellipsis. */}
        <code className="min-w-0 rounded bg-card px-1.5 py-0.5 font-mono text-[13px] break-words">
          {ONE_LINE}
        </code>
        <CopyButton value={ONE_LINE} label="Copy the line" />
      </span>
    </div>
  );
}

function Integration({ site, botfareUrl }: { site: SiteView; botfareUrl: string }) {
  return (
    <ol className="space-y-5">
      <Step n={1} title="Get the package">
        <p className="text-sm">
          Not on npm yet.{" "}
          <NewTabLink href={REPO_URL} className="font-medium underline underline-offset-2">
            Clone the repo
          </NewTabLink>
          , run <code className="font-mono">pnpm install</code>, and add{" "}
          <code className="font-mono">{'"@botfare/express": "workspace:*"'}</code> to your
          app&apos;s dependencies (<code className="font-mono">apps/demo</code> does exactly this).
        </p>
      </Step>
      <Step n={2} title="Add one line to your Express app">
        <CodeBlock label="server.ts" code={MIDDLEWARE_SNIPPET} />
        <p className="text-xs text-muted-foreground">
          Behind a proxy or CDN? Add{" "}
          <code className="font-mono">{'app.set("trust proxy", true)'}</code>. Own Turnstile widget?
          Set <code className="font-mono">TURNSTILE_SECRET_KEY</code>.
        </p>
        <p className="text-xs text-muted-foreground">
          People read free. AI agents see your price, pay from their BotFare wallet, and are charged
          only after your page is delivered.
        </p>
      </Step>
      <Step n={3} title="Set the environment">
        <CodeBlock
          label=".env"
          code={`BOTFARE_URL=${botfareUrl}\nBOTFARE_SITE_ID=${site.id}\nBOTFARE_SITE_SECRET=<your site secret>`}
        />
        <p className="text-xs text-muted-foreground">
          Your secret was shown once when you added the site.{" "}
          {site.demoLocked
            ? "Trying the demo? Click Add a site to get your own."
            : "Lost it? Rotate it on the Secret tab."}
        </p>
      </Step>
    </ol>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <li className="grid grid-cols-[24px_minmax(0,1fr)] gap-3">
      <span className="flex size-6 items-center justify-center rounded-full bg-muted text-xs font-medium tabular-nums">
        {n}
      </span>
      <div className="min-w-0 space-y-2">
        <div className="pt-0.5 text-sm font-medium">{title}</div>
        {children}
      </div>
    </li>
  );
}

function SecretPanel({
  site,
  botfareUrl,
  onChange,
}: {
  site: SiteView;
  botfareUrl: string;
  onChange: (site: SiteView) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);

  async function rotate() {
    setRotating(true);
    try {
      const result = await api<SiteSecretResponse>(
        "POST",
        `/api/publisher/sites/${encodeURIComponent(site.id)}/rotate-secret`,
      );
      setSecret(result.siteSecret);
      onChange(result.site);
      toast.success("New secret issued. The old one no longer works.");
    } catch (err) {
      toast.error(errorText(err));
      setConfirming(false);
    } finally {
      setRotating(false);
    }
  }

  function close() {
    setConfirming(false);
    setSecret(null);
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-4 rounded-lg border p-4">
      <div className="max-w-md space-y-1">
        <div className="text-sm font-medium">Site secret</div>
        <p className="text-xs text-muted-foreground">
          Your middleware signs every call to BotFare with it. Rotate it if it leaked; the old
          secret stops working at once, so update your server&apos;s environment straight away.
        </p>
        {site.demoLocked && (
          <p className="flex items-start gap-1.5 pt-1 text-xs text-muted-foreground">
            <Lock className="mt-px size-3.5 shrink-0" />
            Judge mode: the live {site.name} demo runs with this secret, so it stays as it is. Add a
            site of your own to try rotation.
          </p>
        )}
      </div>
      <Button
        variant="outline"
        size="sm"
        onClick={() => setConfirming(true)}
        disabled={site.demoLocked}
      >
        <RefreshCw />
        Rotate secret
      </Button>

      <Dialog open={confirming} onOpenChange={(open) => (open ? setConfirming(true) : close())}>
        <DialogContent className="sm:max-w-lg">
          {secret ? (
            <>
              <DialogHeader>
                <DialogTitle>New secret for {site.name}</DialogTitle>
                <DialogDescription>
                  Put it in your server&apos;s environment and restart it.
                </DialogDescription>
              </DialogHeader>
              <SecretReveal siteId={site.id} siteSecret={secret} botfareUrl={botfareUrl} />
              <DialogFooter>
                <Button onClick={close}>I saved it</Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>Rotate the secret?</DialogTitle>
                <DialogDescription>
                  {site.name} stops accepting paid requests until its server runs with the new
                  secret.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="outline" onClick={close} disabled={rotating}>
                  Cancel
                </Button>
                <Button onClick={rotate} disabled={rotating}>
                  {rotating && <Loader2 className="animate-spin" />}
                  Rotate secret
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function safeHost(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}
