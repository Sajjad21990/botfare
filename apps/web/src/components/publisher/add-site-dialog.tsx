"use client";

import { Loader2, Plus } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, errorText } from "./api";
import { CodeBlock } from "./copy-button";
import { SecretReveal } from "./secret-reveal";
import { MIDDLEWARE_SNIPPET } from "./site-card";
import type { SiteSecretResponse, SiteView } from "./types";

/** Adds a site, then shows its one-time secret with copy buttons. */
export function AddSiteDialog({
  defaultPayoutEmail,
  botfareUrl,
  onCreated,
  trigger = "default",
}: {
  defaultPayoutEmail: string | null;
  botfareUrl: string;
  onCreated: (site: SiteView) => void;
  trigger?: "default" | "large";
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [origin, setOrigin] = useState("");
  const [payoutEmail, setPayoutEmail] = useState(defaultPayoutEmail ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<SiteSecretResponse | null>(null);

  function reset() {
    setName("");
    setOrigin("");
    setPayoutEmail(defaultPayoutEmail ?? "");
    setError(null);
    setCreated(null);
  }

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (next) reset();
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const result = await api<SiteSecretResponse>("POST", "/api/publisher/sites", {
        name,
        origin: withScheme(origin),
        payoutEmail: payoutEmail.trim() || null,
      });
      setCreated(result);
      onCreated(result.site);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger render={<Button size={trigger === "large" ? "lg" : "default"} />}>
        <Plus />
        Add a site
      </DialogTrigger>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
        {created ? (
          <>
            <DialogHeader>
              <DialogTitle>{created.site.name} is on BotFare</DialogTitle>
              <DialogDescription>
                Add these to your server&apos;s environment and the line below to your app, then set
                prices on the site card.
              </DialogDescription>
            </DialogHeader>
            <SecretReveal
              siteId={created.site.id}
              siteSecret={created.siteSecret}
              botfareUrl={botfareUrl}
            />
            {/* min-w-0: the long line scrolls inside the block instead of widening the dialog. */}
            <div className="min-w-0">
              <CodeBlock label="server.ts" code={MIDDLEWARE_SNIPPET} />
            </div>
            <DialogFooter>
              <Button onClick={() => setOpen(false)}>I saved the secret</Button>
            </DialogFooter>
          </>
        ) : (
          <form onSubmit={submit} className="grid gap-4">
            <DialogHeader>
              <DialogTitle>Add a site</DialogTitle>
              <DialogDescription>
                AI agents pay to read it; people keep reading free. You set prices next.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-1.5">
              <Label htmlFor="site-name">Site name</Label>
              <Input
                id="site-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Kettle Quarterly"
                required
                maxLength={200}
                autoFocus
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="site-origin">Address</Label>
              <Input
                id="site-origin"
                value={origin}
                onChange={(e) => setOrigin(e.target.value)}
                placeholder="https://kettle-quarterly.example"
                required
                inputMode="url"
                spellCheck={false}
              />
              <p className="text-xs text-muted-foreground">
                Only the origin is kept, e.g. https://kettle-quarterly.example.
              </p>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="site-payout-email">
                PayPal payout email <span className="text-muted-foreground">(optional)</span>
              </Label>
              <Input
                id="site-payout-email"
                type="email"
                value={payoutEmail}
                onChange={(e) => setPayoutEmail(e.target.value)}
                placeholder="payouts@kettle-quarterly.example"
              />
            </div>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setOpen(false)}
                disabled={submitting}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={submitting}>
                {submitting && <Loader2 className="animate-spin" />}
                Add site
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** "kettle.example" → "https://kettle.example"; anything with a scheme is left alone. */
function withScheme(origin: string): string {
  const value = origin.trim();
  if (!value || /^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return value;
  return `https://${value}`;
}
