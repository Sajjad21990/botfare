"use client";

import { Code2, ExternalLink, KeyRound, Loader2, RefreshCw, Tags } from "lucide-react";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
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
import { formatCount, formatMicros } from "./format";
import { PricingEditor } from "./pricing-editor";
import { SecretReveal } from "./secret-reveal";
import type { SiteSecretResponse, SiteView } from "./types";

const MIDDLEWARE_SNIPPET = `import express from "express";
import { botfare } from "@botfare/express";

const app = express();
app.use(
  botfare({
    siteId: process.env.BOTFARE_SITE_ID,
    siteSecret: process.env.BOTFARE_SITE_SECRET,
  }),
);`;

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
            <a
              href={site.origin}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
            >
              {host}
              <ExternalLink className="size-3" />
            </a>
          </div>
          <dl className="flex gap-6 text-right">
            <div>
              <dt className="text-xs text-muted-foreground">Paid requests</dt>
              <dd className="font-medium tabular-nums">{formatCount(site.paidRequests)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Earned</dt>
              <dd className="font-medium tabular-nums">{formatMicros(site.earningsMicros)}</dd>
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
      <CardContent>
        <Tabs defaultValue="pricing">
          <TabsList variant="line" className="mb-3 -ml-1.5">
            <TabsTrigger value="pricing">
              <Tags />
              Pricing
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

function Integration({ site, botfareUrl }: { site: SiteView; botfareUrl: string }) {
  return (
    <ol className="space-y-5">
      <Step n={1} title="Install the middleware">
        <CodeBlock code="npm i @botfare/express" />
        <p className="text-xs text-muted-foreground">
          In this repository it is the workspace package{" "}
          <code className="font-mono">packages/express</code>; add{" "}
          <code className="font-mono">{'"@botfare/express": "workspace:*"'}</code> to your app.
        </p>
      </Step>
      <Step n={2} title="Add one line to your Express app">
        <CodeBlock label="server.ts" code={MIDDLEWARE_SNIPPET} />
        <p className="text-xs text-muted-foreground">
          Humans browse free. Agents get an x402 <code className="font-mono">402</code> with your
          price, pay from their BotFare wallet, and are charged only after your handler succeeds.
        </p>
      </Step>
      <Step n={3} title="Set the environment">
        <CodeBlock
          label=".env"
          code={`BOTFARE_URL=${botfareUrl}\nBOTFARE_SITE_ID=${site.id}\nBOTFARE_SITE_SECRET=<your site secret>`}
        />
        <p className="text-xs text-muted-foreground">
          The secret was shown once when you added the site. Rotate it on the Secret tab if you need
          a new one.
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
      </div>
      <Button variant="outline" size="sm" onClick={() => setConfirming(true)}>
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
