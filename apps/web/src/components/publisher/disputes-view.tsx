"use client";

import {
  ArrowLeft,
  Bot,
  CheckCircle2,
  FileCheck2,
  Gavel,
  Loader2,
  Scale,
  ShieldCheck,
  UserCheck,
} from "lucide-react";
import Link from "next/link";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { verifyHref } from "@/components/verify/verify-href";
import { api, errorText } from "./api";
import {
  decidedByLabel,
  decisionLabel,
  formatFare,
  percent,
  reasonLabel,
  statusMeta,
} from "./disputes-format";
import type { DisputeView, PublisherDecisionResult, PublisherDisputes } from "./disputes-types";
import { formatDateTime } from "./format";

const REFRESH_MS = 15_000;

type Filter = "review" | "all";

/** The /publisher/disputes page body: Fare Court's review queue and history. */
export function DisputesView({ initial }: { initial: PublisherDisputes }) {
  const [data, setData] = useState(initial);
  const [filter, setFilter] = useState<Filter>(initial.pendingCount > 0 ? "review" : "all");
  const [openId, setOpenId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setData(await api<PublisherDisputes>("GET", "/api/publisher/disputes"));
      setLoadError(null);
    } catch (err) {
      setLoadError(errorText(err));
    }
  }, []);

  // New disputes arrive whenever an agent files one, so refresh while the tab is visible.
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

  const pending = useMemo(
    () => data.disputes.filter((d) => d.status === "pending_publisher"),
    [data.disputes],
  );
  const shown = filter === "review" ? pending : data.disputes;
  const selected = data.disputes.find((d) => d.id === openId) ?? null;
  const refundedCents = data.disputes.reduce((sum, d) => sum + d.refundedCents, 0);
  const aiDecided = data.disputes.filter((d) => d.decidedBy === "ai").length;

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <Link
          href="/publisher"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          Publisher
        </Link>
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Disputes</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Fare Court: buyer protection for purchases too small for a person to dispute. AI decides
            confident cases instantly; you decide the rest.
          </p>
        </div>
      </div>

      <PolicyStrip />

      {loadError && (
        <Alert variant="destructive">
          <AlertDescription>Could not refresh disputes: {loadError}</AlertDescription>
        </Alert>
      )}

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div
            className="inline-flex rounded-lg border bg-muted/40 p-0.5"
            role="tablist"
            aria-label="Filter disputes"
          >
            <FilterButton active={filter === "review"} onClick={() => setFilter("review")}>
              Needs review
              {data.pendingCount > 0 && (
                <span className="ml-1.5 rounded-full bg-primary px-1.5 text-xs text-primary-foreground tabular-nums">
                  {data.pendingCount}
                </span>
              )}
            </FilterButton>
            <FilterButton active={filter === "all"} onClick={() => setFilter("all")}>
              All
              <span className="ml-1.5 text-xs text-muted-foreground tabular-nums">
                {data.disputes.length}
              </span>
            </FilterButton>
          </div>
          {data.disputes.length > 0 && (
            <p className="text-sm text-muted-foreground">
              {aiDecided} decided by AI · {formatFare(refundedCents)} refunded
            </p>
          )}
        </div>

        {shown.length === 0 ? (
          <EmptyState filter={filter} hasAny={data.disputes.length > 0} />
        ) : (
          <ul className="divide-y rounded-xl border">
            {shown.map((dispute) => (
              <DisputeRow key={dispute.id} dispute={dispute} onOpen={() => setOpenId(dispute.id)} />
            ))}
          </ul>
        )}
      </section>

      <DisputeDialog
        dispute={selected}
        onClose={() => setOpenId(null)}
        onDecided={(result) => {
          setData((current) => ({
            pendingCount: result.pendingCount,
            disputes: current.disputes.map((d) =>
              d.id === result.outcome.disputeId
                ? {
                    ...d,
                    status: result.outcome.status,
                    message: result.outcome.message,
                    refundedCents: result.outcome.refundedCents,
                    decidedBy: result.outcome.status === "pending_publisher" ? null : "publisher",
                    decidedAt: new Date().toISOString(),
                  }
                : d,
            ),
          }));
          void reload();
        }}
      />
    </div>
  );
}

function FilterButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={
        active
          ? "inline-flex items-center rounded-md bg-background px-3 py-1 text-sm font-medium shadow-sm"
          : "inline-flex items-center rounded-md px-3 py-1 text-sm text-muted-foreground hover:text-foreground"
      }
    >
      {children}
    </button>
  );
}

/** How Fare Court decides, in three short points. */
function PolicyStrip() {
  const items = [
    {
      icon: FileCheck2,
      title: "Proof of delivery",
      text: "Your middleware attests a digest of every paid response. A dispute only counts if the agent's copy matches it, so you see exactly what you served.",
    },
    {
      icon: Bot,
      title: "AI decides confident cases",
      text: "Claude compares what you declared with what you delivered. At 80% confidence or more it refunds or closes the dispute instantly.",
    },
    {
      icon: UserCheck,
      title: "You decide the rest",
      text: "Uncertain verdicts, keys that dispute often, and anything the AI could not judge wait here for your decision.",
    },
  ];
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      {items.map(({ icon: Icon, title, text }) => (
        <div key={title} className="flex gap-3 rounded-xl border bg-card p-4">
          <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div className="space-y-1">
            <p className="text-sm font-medium">{title}</p>
            <p className="text-xs leading-relaxed text-muted-foreground">{text}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

function EmptyState({ filter, hasAny }: { filter: Filter; hasAny: boolean }) {
  const reviewDone = filter === "review" && hasAny;
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed px-6 py-14 text-center">
      <span className="flex size-10 items-center justify-center rounded-full bg-muted">
        {reviewDone ? (
          <CheckCircle2 className="size-5 text-muted-foreground" />
        ) : (
          <Scale className="size-5 text-muted-foreground" />
        )}
      </span>
      <div className="space-y-1">
        <p className="font-medium">{reviewDone ? "Nothing to review" : "No disputes yet"}</p>
        <p className="max-w-sm text-sm text-muted-foreground">
          {reviewDone
            ? "Every dispute on your sites has been decided. New ones the AI is unsure about show up here."
            : "When an agent says a paid page was not what your offer promised, the dispute and the AI's reasoning appear here."}
        </p>
      </div>
    </div>
  );
}

function DisputeRow({ dispute, onOpen }: { dispute: DisputeView; onOpen: () => void }) {
  const status = statusMeta(dispute.status, "publisher");
  const by = decidedByLabel(dispute, "publisher");
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full flex-col gap-2 px-4 py-3 text-left transition-colors hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none sm:flex-row sm:items-center sm:gap-4"
      >
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate font-mono text-sm" title={dispute.url ?? dispute.path}>
              {dispute.path}
            </span>
            <span className="shrink-0 text-xs text-muted-foreground">{dispute.siteName}</span>
          </div>
          <p className="truncate text-sm text-muted-foreground">
            <span className="text-foreground">{reasonLabel(dispute.reason)}</span>
            {dispute.verdict ? ` · ${dispute.verdict.rationale}` : ` · ${dispute.message}`}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3 text-sm">
          <span className="text-muted-foreground">{formatDateTime(dispute.createdAt)}</span>
          <span className="tabular-nums">{formatFare(dispute.amountCents)}</span>
          <Badge variant={status.variant} title={by ? `Decided ${by}` : undefined}>
            {status.label}
          </Badge>
        </div>
      </button>
    </li>
  );
}

function DisputeDialog({
  dispute,
  onClose,
  onDecided,
}: {
  dispute: DisputeView | null;
  onClose: () => void;
  onDecided: (result: PublisherDecisionResult) => void;
}) {
  const [busy, setBusy] = useState<"accept" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function decide(decision: "accept" | "reject") {
    if (!dispute) return;
    setBusy(decision);
    setError(null);
    try {
      const result = await api<PublisherDecisionResult>("POST", "/api/publisher/disputes", {
        disputeId: dispute.id,
        decision,
      });
      onDecided(result);
      toast.success(
        decision === "accept"
          ? `Refunded ${formatFare(result.outcome.refundedCents)} to the agent's wallet`
          : "Dispute declined",
      );
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  }

  const status = dispute ? statusMeta(dispute.status, "publisher") : null;
  const by = dispute ? decidedByLabel(dispute, "publisher") : null;

  return (
    <Dialog
      open={dispute !== null}
      onOpenChange={(open) => {
        if (!open) {
          setError(null);
          onClose();
        }
      }}
    >
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl">
        {dispute && status && (
          <>
            <DialogHeader>
              <div className="flex flex-wrap items-center gap-2 pr-8">
                <Badge variant={status.variant}>{status.label}</Badge>
                {by && <span className="text-xs text-muted-foreground">Decided {by}</span>}
              </div>
              <DialogTitle className="break-all font-mono text-base">{dispute.path}</DialogTitle>
              <DialogDescription>
                {dispute.siteName} · {formatFare(dispute.amountCents)} paid by{" "}
                {dispute.agentKeyName} · filed {formatDateTime(dispute.createdAt)}
              </DialogDescription>
            </DialogHeader>

            {dispute.message && <p className="text-sm">{dispute.message}</p>}

            <Section icon={Gavel} title="The agent's claim">
              <p>
                <span className="font-medium">{reasonLabel(dispute.reason)}</span>
                {dispute.note ? (
                  <span className="text-muted-foreground">: “{dispute.note}”</span>
                ) : null}
              </p>
            </Section>

            <Section icon={Bot} title="AI verdict">
              {dispute.verdict ? (
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <Badge variant="outline">{decisionLabel(dispute.verdict.decision)}</Badge>
                    <span className="text-muted-foreground">
                      {percent(dispute.verdict.confidence)} confident ·{" "}
                      {reasonLabel(dispute.verdict.category)}
                    </span>
                  </div>
                  <p className="leading-relaxed">{dispute.verdict.rationale}</p>
                  {dispute.verdict.evidence.length > 0 && (
                    <ul className="space-y-2">
                      {dispute.verdict.evidence.map((pair) => (
                        <li
                          key={`${pair.declared}|${pair.delivered}`}
                          className="grid gap-2 rounded-lg bg-muted/50 p-3 text-xs sm:grid-cols-2"
                        >
                          <div>
                            <p className="mb-0.5 font-medium text-muted-foreground">Declared</p>
                            <p>{pair.declared}</p>
                          </div>
                          <div>
                            <p className="mb-0.5 font-medium text-muted-foreground">Delivered</p>
                            <p>{pair.delivered}</p>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ) : (
                <p className="text-muted-foreground">
                  No AI verdict for this dispute. Compare the offer with what was delivered below.
                </p>
              )}
            </Section>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2 rounded-lg border p-3">
                <p className="text-xs font-medium text-muted-foreground">Declared offer</p>
                {dispute.declaredOffer ? (
                  <div className="space-y-1 text-sm">
                    <p className="font-medium">{dispute.declaredOffer.title}</p>
                    {dispute.declaredOffer.preview && (
                      <p className="text-muted-foreground">{dispute.declaredOffer.preview}</p>
                    )}
                    {dispute.declaredOffer.wordCount !== undefined && (
                      <p className="text-xs text-muted-foreground">
                        About {dispute.declaredOffer.wordCount} words
                      </p>
                    )}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    This purchase carried no declared offer.
                  </p>
                )}
              </div>
              <div className="space-y-2 rounded-lg border p-3">
                <p className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
                  Delivered
                  {dispute.contentDigestOk && (
                    <span className="inline-flex items-center gap-0.5 text-emerald-700 dark:text-emerald-400">
                      <ShieldCheck className="size-3" /> matches your attested digest
                    </span>
                  )}
                </p>
                <p className="max-h-48 overflow-y-auto whitespace-pre-wrap text-sm text-muted-foreground">
                  {dispute.deliveredExcerpt?.trim() || "(empty)"}
                </p>
              </div>
            </div>

            <p className="text-xs text-muted-foreground">
              Receipt <span className="font-mono">{dispute.receiptId}</span> · purchased{" "}
              {formatDateTime(dispute.purchasedAt)} ·{" "}
              <Link
                href={verifyHref(dispute.receiptId)}
                className="font-medium text-foreground underline underline-offset-4"
              >
                Verify
                <span className="sr-only"> receipt {dispute.receiptId}</span>
              </Link>
            </p>

            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            {dispute.status === "pending_publisher" && (
              <DialogFooter>
                <Button variant="outline" disabled={busy !== null} onClick={() => decide("reject")}>
                  {busy === "reject" && <Loader2 className="animate-spin" />}
                  Decline refund
                </Button>
                <Button disabled={busy !== null} onClick={() => decide("accept")}>
                  {busy === "accept" && <Loader2 className="animate-spin" />}
                  Accept refund ({formatFare(dispute.amountCents)})
                </Button>
              </DialogFooter>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Section({
  icon: Icon,
  title,
  children,
}: {
  icon: typeof Bot;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5 text-sm">
      <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Icon className="size-3.5" />
        {title}
      </p>
      {children}
    </div>
  );
}
