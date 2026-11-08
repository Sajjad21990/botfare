"use client";

import { encodeAgentKey } from "@botfare/contracts";
import { AlertTriangle, Check, Copy, Download, KeyRound, Loader2, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { Switch } from "@/components/ui/switch";
import { parseDollarsToCents } from "./format";
import type { WalletAgentKey, WalletSite } from "./types";

type Step =
  | { kind: "form" }
  | { kind: "creating" }
  | { kind: "reveal"; key: WalletAgentKey; agentKey: string };

interface Draft {
  name: string;
  perRequest: string;
  dailyCap: string;
  siteIds: string[];
}

const EMPTY_DRAFT: Draft = { name: "", perRequest: "0.10", dailyCap: "1.00", siteIds: [] };
const MAX_CAP_CENTS = 100_000;

function validate(draft: Draft): { error: string } | { perRequest: number; dailyCap: number } {
  if (!draft.name.trim()) return { error: "Give the key a name, e.g. the agent it belongs to." };
  const perRequest = parseDollarsToCents(draft.perRequest);
  const dailyCap = parseDollarsToCents(draft.dailyCap);
  if (perRequest === null) return { error: "Per-request max must be at least $0.01." };
  if (dailyCap === null) return { error: "Daily cap must be at least $0.01." };
  if (perRequest > MAX_CAP_CENTS || dailyCap > MAX_CAP_CENTS) {
    return { error: "Limits go up to $1,000." };
  }
  if (perRequest > dailyCap) return { error: "Per-request max cannot exceed the daily cap." };
  return { perRequest, dailyCap };
}

/**
 * Creates an agent key. The Ed25519 key pair is generated here, in the browser; only the public
 * JWK goes to BotFare. The private half is shown once, inside the agent key string, and is never
 * stored or sent anywhere.
 */
export function NewKeyDialog({
  sites,
  trigger = "default",
}: {
  sites: WalletSite[];
  trigger?: "default" | "empty";
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [step, setStep] = useState<Step>({ kind: "form" });
  const [error, setError] = useState<string | null>(null);
  const ids = useId();

  function reset() {
    setDraft(EMPTY_DRAFT);
    setStep({ kind: "form" });
    setError(null);
  }

  async function create(event: React.FormEvent) {
    event.preventDefault();
    const checked = validate(draft);
    if ("error" in checked) {
      setError(checked.error);
      return;
    }
    setError(null);
    setStep({ kind: "creating" });
    try {
      const { exportJWK, generateKeyPair } = await import("jose");
      const { publicKey, privateKey } = await generateKeyPair("EdDSA", {
        crv: "Ed25519",
        extractable: true,
      });
      const pub = await exportJWK(publicKey);
      const priv = await exportJWK(privateKey);
      if (pub.kty !== "OKP" || !pub.x || !priv.d) throw new Error("Unexpected key format");

      const res = await fetch("/api/wallet/keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: draft.name.trim(),
          // The public half only: no `d`.
          publicJwk: { kty: "OKP", crv: "Ed25519", x: pub.x },
          perRequestMaxCents: checked.perRequest,
          dailyCapCents: checked.dailyCap,
          allowedSiteIds: draft.siteIds.length ? draft.siteIds : undefined,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        key?: WalletAgentKey;
        message?: string;
      };
      if (!res.ok || !body.key) throw new Error(body.message ?? `Request failed (${res.status})`);

      const agentKey = encodeAgentKey({
        v: 1,
        keyId: body.key.id,
        privateJwk: { kty: "OKP", crv: "Ed25519", x: pub.x, d: priv.d },
      });
      setStep({ kind: "reveal", key: body.key, agentKey });
      router.refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Something went wrong";
      setError(
        /Ed25519|EdDSA|not supported/i.test(message)
          ? "This browser cannot generate Ed25519 keys. Use a current Chrome, Edge, Firefox or Safari."
          : message,
      );
      setStep({ kind: "form" });
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (step.kind === "creating") return;
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger
        render={trigger === "empty" ? <Button variant="outline" /> : <Button variant="default" />}
      >
        <Plus /> New agent key
      </DialogTrigger>
      <DialogContent
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg"
        showCloseButton={step.kind !== "creating"}
      >
        {step.kind === "reveal" ? (
          <RevealKey
            agentKey={step.agentKey}
            agentName={step.key.name}
            perRequestMaxCents={step.key.perRequestMaxCents}
            exampleOrigin={sites[0]?.origin}
            onDone={() => {
              setOpen(false);
              reset();
            }}
          />
        ) : (
          <form onSubmit={create} className="grid gap-5">
            <DialogHeader>
              <DialogTitle>New agent key</DialogTitle>
              <DialogDescription>
                The key pair is generated in your browser. BotFare keeps only the public half, and
                enforces these limits on every payment.
              </DialogDescription>
            </DialogHeader>

            <div className="grid gap-2">
              <Label htmlFor={`${ids}-name`}>Name</Label>
              <Input
                id={`${ids}-name`}
                placeholder="Research agent"
                maxLength={60}
                autoComplete="off"
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <MoneyField
                id={`${ids}-per`}
                label="Max per request"
                value={draft.perRequest}
                onChange={(perRequest) => setDraft({ ...draft, perRequest })}
              />
              <MoneyField
                id={`${ids}-day`}
                label="Daily cap"
                value={draft.dailyCap}
                onChange={(dailyCap) => setDraft({ ...draft, dailyCap })}
              />
            </div>

            <fieldset className="grid gap-2">
              <legend className="mb-2 text-sm font-medium">Allowed sites</legend>
              {sites.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No publisher sites yet. The key may pay any site that joins BotFare.
                </p>
              ) : (
                <div className="divide-y rounded-lg border">
                  {sites.map((site) => {
                    const checked = draft.siteIds.includes(site.id);
                    return (
                      <label
                        key={site.id}
                        htmlFor={`${ids}-${site.id}`}
                        className="flex cursor-pointer items-center justify-between gap-3 px-3 py-2.5"
                      >
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium">{site.name}</span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {site.origin.replace(/^https?:\/\//, "")}
                          </span>
                        </span>
                        <Switch
                          id={`${ids}-${site.id}`}
                          checked={checked}
                          onCheckedChange={(on) =>
                            setDraft({
                              ...draft,
                              siteIds: on
                                ? [...draft.siteIds, site.id]
                                : draft.siteIds.filter((id) => id !== site.id),
                            })
                          }
                        />
                      </label>
                    );
                  })}
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                {draft.siteIds.length
                  ? `This key can pay only the ${draft.siteIds.length === 1 ? "site" : `${draft.siteIds.length} sites`} you picked.`
                  : "Leave all off to let the key pay any BotFare site."}
              </p>
            </fieldset>

            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}

            <DialogFooter>
              <Button type="submit" disabled={step.kind === "creating"}>
                {step.kind === "creating" ? (
                  <>
                    <Loader2 className="animate-spin" /> Generating key…
                  </>
                ) : (
                  <>
                    <KeyRound /> Create key
                  </>
                )}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function MoneyField({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{label}</Label>
      <div className="relative">
        <span className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-sm text-muted-foreground">
          $
        </span>
        <Input
          id={id}
          inputMode="decimal"
          autoComplete="off"
          className="pl-6 tabular-nums"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      </div>
    </div>
  );
}

function useCopy(): [string | null, (label: string, text: string) => void] {
  const [copied, setCopied] = useState<string | null>(null);
  return [
    copied,
    (label, text) => {
      navigator.clipboard.writeText(text).then(
        () => {
          setCopied(label);
          setTimeout(() => setCopied((current) => (current === label ? null : current)), 2000);
        },
        () => toast.error("Could not copy. Select the text and copy it by hand."),
      );
    },
  ];
}

function RevealKey({
  agentKey,
  agentName,
  perRequestMaxCents,
  exampleOrigin,
  onDone,
}: {
  agentKey: string;
  agentName: string;
  perRequestMaxCents: number | null;
  exampleOrigin: string | undefined;
  onDone: () => void;
}) {
  const [copied, copy] = useCopy();
  const envLine = `BOTFARE_AGENT_KEY=${agentKey}`;
  const usage = `import { createBotFareAgent } from "@botfare/sdk";

const agent = createBotFareAgent({
  agentKey: process.env.BOTFARE_AGENT_KEY!,
  maxPerRequestUsd: ${((perRequestMaxCents ?? 10) / 100).toFixed(2)},
});

const offer = await agent.getOffer("${exampleOrigin ?? "https://crema-notes.example"}/articles/dialing-in-espresso");
const { response, receipt } = await agent.fetch(offer!.url);`;

  function download() {
    const blob = new Blob([`${envLine}\n`], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const slug = agentName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    link.href = url;
    link.download = `botfare-${slug || "agent"}.env`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="grid min-w-0 gap-4">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <Check className="size-4 text-emerald-600" /> {agentName} is ready
        </DialogTitle>
        <DialogDescription>
          Give this key to the agent. It signs every payment with it.
        </DialogDescription>
      </DialogHeader>

      <Alert className="border-amber-300 bg-amber-50 text-amber-950 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100">
        <AlertTriangle />
        <AlertTitle>Copy it now. We never see this again.</AlertTitle>
        <AlertDescription className="text-amber-900/80 dark:text-amber-100/80">
          The private key was made in your browser and BotFare only stored the public half. If you
          lose it, revoke the key and create a new one.
        </AlertDescription>
      </Alert>

      <div className="grid min-w-0 gap-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium">Agent key</span>
          <div className="flex gap-1.5">
            <Button variant="outline" size="sm" onClick={() => copy("key", agentKey)}>
              {copied === "key" ? <Check /> : <Copy />} {copied === "key" ? "Copied" : "Copy"}
            </Button>
            <Button variant="outline" size="sm" onClick={download}>
              <Download /> .env
            </Button>
          </div>
        </div>
        <code className="block max-h-24 overflow-y-auto rounded-lg border bg-muted/50 p-3 font-mono text-xs break-all select-all">
          {agentKey}
        </code>
      </div>

      <CodeBlock
        title=".env"
        code={`BOTFARE_AGENT_KEY=bfk_…`}
        copied={copied === "env"}
        onCopy={() => copy("env", envLine)}
      />
      <CodeBlock
        title="agent.ts"
        code={usage}
        copied={copied === "usage"}
        onCopy={() => copy("usage", usage)}
      />

      <DialogFooter>
        <Button onClick={onDone}>I saved the key</Button>
      </DialogFooter>
    </div>
  );
}

function CodeBlock({
  title,
  code,
  copied,
  onCopy,
}: {
  title: string;
  code: string;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <div className="min-w-0 overflow-hidden rounded-lg border">
      <div className="flex items-center justify-between border-b bg-muted/50 px-3 py-1.5">
        <span className="font-mono text-xs text-muted-foreground">{title}</span>
        <Button variant="ghost" size="icon-xs" onClick={onCopy} aria-label={`Copy ${title}`}>
          {copied ? <Check /> : <Copy />}
        </Button>
      </div>
      <pre className="overflow-x-auto p-3 font-mono text-xs leading-relaxed">{code}</pre>
    </div>
  );
}
