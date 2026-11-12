"use client";

import { Check, Copy, ExternalLink, KeyRound, Loader2, Lock } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { NewTabLink } from "@/components/app/external-link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatCap, formatMoney, formatMoneyExact } from "./format";
import { LocalTime } from "./local-time";
import { NewKeyDialog, SnippetBlock } from "./new-key-dialog";
import { agentUsageSnippet, SDK_SOURCE_URL } from "./snippets";
import type { WalletAgentKey, WalletSite } from "./types";

/**
 * The signed-in owner's agent keys with their budgets, today's spend, and revoke. Revoked keys
 * stay in the database (receipts point at them) but are hidden until "Show revoked" is on.
 */
export function AgentKeysCard({ keys, sites }: { keys: WalletAgentKey[]; sites: WalletSite[] }) {
  const siteNames = new Map(sites.map((site) => [site.id, site.name]));
  const [showRevoked, setShowRevoked] = useState(false);
  const revokedCount = keys.filter((key) => key.status === "revoked").length;
  const activeCount = keys.length - revokedCount;
  const visible = showRevoked ? keys : keys.filter((key) => key.status !== "revoked");
  return (
    <Card>
      <CardHeader>
        <CardTitle>Agent keys</CardTitle>
        <CardDescription>
          One key per AI agent. BotFare checks its budget and allowed sites before every payment.
        </CardDescription>
        {visible.length ? (
          <CardAction>
            <NewKeyDialog sites={sites} />
          </CardAction>
        ) : null}
      </CardHeader>
      <CardContent>
        {revokedCount > 0 ? (
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
            <span>
              {activeCount} active
              {showRevoked ? "" : ` · ${revokedCount} revoked hidden`}
            </span>
            <label
              htmlFor="show-revoked-keys"
              className="inline-flex cursor-pointer items-center gap-2"
            >
              <Switch
                id="show-revoked-keys"
                size="sm"
                checked={showRevoked}
                onCheckedChange={(checked) => setShowRevoked(checked)}
              />
              Show revoked
            </label>
          </div>
        ) : null}
        {visible.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed px-6 py-10 text-center">
            <div className="flex size-10 items-center justify-center rounded-full bg-muted">
              <KeyRound className="size-5 text-muted-foreground" />
            </div>
            <div className="space-y-1">
              <p className="font-medium">
                {keys.length === 0 ? "No agent keys yet" : "No active agent keys"}
              </p>
              <p className="max-w-sm text-sm text-muted-foreground">
                Create a key for each agent and set its budget. You get a{" "}
                <code className="font-mono text-xs">BOTFARE_AGENT_KEY</code> to put in its
                environment.
              </p>
            </div>
            <NewKeyDialog sites={sites} trigger="empty" />
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Agent</TableHead>
                <TableHead>Limits</TableHead>
                <TableHead className="min-w-36">Spent today</TableHead>
                <TableHead>Sites</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="w-0">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((key) => (
                <KeyRow key={key.id} agentKey={key} siteNames={siteNames} />
              ))}
            </TableBody>
          </Table>
        )}
        <KeyUsage exampleOrigin={sites[0]?.origin} />
      </CardContent>
    </Card>
  );
}

function KeyRow({
  agentKey: key,
  siteNames,
}: {
  agentKey: WalletAgentKey;
  siteNames: Map<string, string>;
}) {
  const revoked = key.status === "revoked";
  const capMicros = key.dailyCapCents === null ? null : key.dailyCapCents * 10_000;
  const used = capMicros ? Math.min(100, (key.spentTodayMicros / capMicros) * 100) : 0;
  return (
    <TableRow className={revoked ? "text-muted-foreground" : undefined}>
      <TableCell>
        <div className="font-medium text-foreground">{key.name}</div>
        <KeyId id={key.id} />
      </TableCell>
      <TableCell className="text-sm tabular-nums">
        <div>
          {key.perRequestMaxCents === null
            ? "No per-page limit"
            : `${formatCap(key.perRequestMaxCents)} a page`}
        </div>
        <div className="text-muted-foreground">
          {key.dailyCapCents === null ? "No daily cap" : `${formatCap(key.dailyCapCents)} a day`}
        </div>
      </TableCell>
      <TableCell>
        <div className="text-sm tabular-nums" title={formatMoneyExact(key.spentTodayMicros)}>
          {formatMoney(key.spentTodayMicros)}
          {capMicros ? (
            <span className="text-muted-foreground"> of {formatMoney(capMicros)}</span>
          ) : null}
        </div>
        {capMicros && !revoked ? (
          <div
            className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-muted"
            role="progressbar"
            aria-label="Daily cap used"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(used)}
          >
            <div
              className={used >= 90 ? "h-full bg-amber-500" : "h-full bg-foreground/70"}
              style={{ width: `${used}%` }}
            />
          </div>
        ) : null}
      </TableCell>
      <TableCell>
        {key.allowedSiteIds === null ? (
          <span className="text-sm text-muted-foreground">Any site</span>
        ) : (
          <div className="flex max-w-48 flex-wrap gap-1">
            {key.allowedSiteIds.map((id) => (
              <Badge key={id} variant="outline">
                {siteNames.get(id) ?? id}
              </Badge>
            ))}
          </div>
        )}
      </TableCell>
      <TableCell>
        {revoked ? (
          <Badge variant="secondary">Revoked</Badge>
        ) : (
          <Badge variant="outline" className="border-success/40 text-success">
            Active
          </Badge>
        )}
      </TableCell>
      <TableCell className="text-sm text-muted-foreground">
        <LocalTime iso={key.createdAt} dateOnly />
      </TableCell>
      <TableCell className="text-right">
        {revoked ? null : key.demoLocked ? (
          <span
            className="inline-flex items-center gap-1 text-xs text-muted-foreground"
            title="The demo agent pays with this key, so judge mode keeps it active."
          >
            <Lock className="size-3" />
            Demo key
          </span>
        ) : (
          <RevokeButton agentKey={key} />
        )}
      </TableCell>
    </TableRow>
  );
}

/** The SDK snippet for using a key in your own agent, in a disclosure that starts closed. */
function KeyUsage({ exampleOrigin }: { exampleOrigin: string | undefined }) {
  return (
    <details className="mt-6 border-t pt-5">
      <summary className="cursor-pointer text-sm font-medium">
        For developers: use a key in your own agent
      </summary>
      <div className="mt-4 grid gap-4 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">
            Put the key in your AI agent&apos;s <code className="font-mono text-xs">.env</code> and
            fetch pages through the BotFare SDK. When a page has a price within the key&apos;s
            limits, the SDK pays it from this wallet, and you are charged only after the page
            arrives.
          </p>
          <NewTabLink
            href={SDK_SOURCE_URL}
            className="inline-flex items-center gap-1 rounded text-sm font-medium underline underline-offset-4 outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            Install the SDK from GitHub
            <ExternalLink aria-hidden className="size-3.5" />
          </NewTabLink>
        </div>
        <SnippetBlock title="agent.ts" code={agentUsageSnippet({ exampleOrigin })} />
      </div>
    </details>
  );
}

function KeyId({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="group/id mt-0.5 inline-flex items-center gap-1 font-mono text-xs text-muted-foreground hover:text-foreground"
      onClick={() =>
        navigator.clipboard.writeText(id).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        })
      }
      aria-label={`Copy key ID ${id}`}
    >
      {id}
      {copied ? (
        <Check className="size-3" />
      ) : (
        <Copy className="size-3 opacity-0 transition-opacity group-hover/id:opacity-100" />
      )}
    </button>
  );
}

function RevokeButton({ agentKey }: { agentKey: WalletAgentKey }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);

  async function revoke() {
    setPending(true);
    try {
      const res = await fetch(`/api/wallet/keys/${encodeURIComponent(agentKey.id)}/revoke`, {
        method: "POST",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(body.message ?? `Request failed (${res.status})`);
      }
      toast.success(`${agentKey.name} revoked`, {
        description: "Payments signed with this key are refused from now on.",
      });
      setOpen(false);
      router.refresh();
    } catch (err) {
      toast.error("Could not revoke the key", {
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !pending && setOpen(next)}>
      <DialogTrigger render={<Button variant="ghost" size="sm" />}>Revoke</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Revoke {agentKey.name}?</DialogTitle>
          <DialogDescription>
            The agent can no longer pay with this key; BotFare refuses its next payment. This cannot
            be undone, but you can always create a new key.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" disabled={pending} />}>Cancel</DialogClose>
          <Button variant="destructive" onClick={revoke} disabled={pending}>
            {pending ? <Loader2 className="animate-spin" /> : null} Revoke key
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
