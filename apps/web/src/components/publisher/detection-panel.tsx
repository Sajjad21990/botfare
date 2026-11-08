"use client";

import {
  CREMA_NOTES_DETECTION,
  type DetectionConfig,
  type DetectionLevel,
  TURNSTILE_TEST_SITE_KEY,
} from "@botfare/contracts";
import { Check, Info, Loader2, RotateCcw, ShieldAlert } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { api, errorText } from "./api";
import { DETECTION_LEVELS, SIGNAL_DESCRIPTIONS, signalLabel } from "./detection-copy";
import { formatCount, formatMicros } from "./format";
import type { DetectionResponse, SiteView } from "./types";

const HEADER_RE = /^[A-Za-z0-9-]+$/;
const SITE_KEY_RE = /^[A-Za-z0-9_-]*$/;

interface Form {
  level: DetectionLevel;
  /** Empty = the level's default. */
  threshold: string;
  cfEnabled: boolean;
  cfScoreHeader: string;
  cfVerifiedHeader: string;
  cfMaxScore: string;
  akEnabled: boolean;
  akHeader: string;
  turnstileSiteKey: string;
}

function toForm(detection: DetectionConfig): Form {
  return {
    level: detection.level,
    threshold: detection.threshold === undefined ? "" : String(detection.threshold),
    cfEnabled: detection.edge.cloudflare.enabled,
    cfScoreHeader: detection.edge.cloudflare.scoreHeader,
    cfVerifiedHeader: detection.edge.cloudflare.verifiedBotHeader,
    cfMaxScore: String(detection.edge.cloudflare.maxBotScore),
    akEnabled: detection.edge.akamai.enabled,
    akHeader: detection.edge.akamai.header,
    turnstileSiteKey: detection.turnstileSiteKey ?? "",
  };
}

function intIn(value: string, min: number, max: number): boolean {
  const n = Number(value);
  return value.trim() !== "" && Number.isInteger(n) && n >= min && n <= max;
}

type Errors = Partial<Record<keyof Form, string>>;

function validate(form: Form): Errors {
  const errors: Errors = {};
  if (form.threshold.trim() && !intIn(form.threshold, 1, 100)) {
    errors.threshold = "A whole number from 1 to 100, or empty for the default.";
  }
  if (!intIn(form.cfMaxScore, 1, 99)) errors.cfMaxScore = "A whole number from 1 to 99.";
  if (!HEADER_RE.test(form.cfScoreHeader.trim())) errors.cfScoreHeader = "Letters, digits, dashes.";
  if (!HEADER_RE.test(form.cfVerifiedHeader.trim())) {
    errors.cfVerifiedHeader = "Letters, digits, dashes.";
  }
  if (!HEADER_RE.test(form.akHeader.trim())) errors.akHeader = "Letters, digits, dashes.";
  if (!SITE_KEY_RE.test(form.turnstileSiteKey.trim())) {
    errors.turnstileSiteKey = "Site keys use letters, digits, - and _ only.";
  }
  return errors;
}

function toBody(form: Form) {
  return {
    level: form.level,
    ...(form.threshold.trim() ? { threshold: Number(form.threshold) } : {}),
    edge: {
      cloudflare: {
        enabled: form.cfEnabled,
        scoreHeader: form.cfScoreHeader.trim(),
        verifiedBotHeader: form.cfVerifiedHeader.trim(),
        maxBotScore: Number(form.cfMaxScore),
      },
      akamai: { enabled: form.akEnabled, header: form.akHeader.trim() },
    },
    turnstileSiteKey: form.turnstileSiteKey.trim() || null,
  };
}

/**
 * "Bot detection" for one site: how strict BotFare is about who pays, the CDN bot scores it
 * reads, the Turnstile human check, and what each detection signal has earned.
 */
export function DetectionPanel({
  site,
  onSaved,
}: {
  site: SiteView;
  onSaved: (site: SiteView) => void;
}) {
  const [form, setForm] = useState(() => toForm(site.detection));
  const [baseline, setBaseline] = useState(() => JSON.stringify(toForm(site.detection)));
  const [saving, setSaving] = useState(false);
  const [showErrors, setShowErrors] = useState(false);
  const [revenue, setRevenue] = useState<DetectionResponse["revenueBySignal"] | null>(null);

  const errors = useMemo(() => validate(form), [form]);
  const invalid = Object.keys(errors).length > 0;
  const dirty = JSON.stringify(form) !== baseline;
  const levelCopy = DETECTION_LEVELS.find((level) => level.value === form.level);
  const scored = form.level === "standard" || form.level === "strict";
  const err = (key: keyof Form) => (showErrors ? errors[key] : undefined);

  useEffect(() => {
    let active = true;
    api<DetectionResponse>("GET", `/api/publisher/sites/${encodeURIComponent(site.id)}/detection`)
      .then((body) => active && setRevenue(body.revenueBySignal))
      .catch(() => active && setRevenue([]));
    return () => {
      active = false;
    };
  }, [site.id]);

  function set<K extends keyof Form>(key: K, value: Form[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function reset() {
    setForm(JSON.parse(baseline) as Form);
    setShowErrors(false);
  }

  async function save() {
    if (invalid) {
      setShowErrors(true);
      toast.error("Fix the highlighted fields before saving.");
      return;
    }
    setSaving(true);
    try {
      const { site: saved } = await api<{ site: SiteView }>(
        "PUT",
        `/api/publisher/sites/${encodeURIComponent(site.id)}/detection`,
        toBody(form),
      );
      const next = toForm(saved.detection);
      setForm(next);
      setBaseline(JSON.stringify(next));
      setShowErrors(false);
      onSaved(saved);
      toast.success("Bot detection saved. Your middleware picks it up on its next config refresh.");
    } catch (error) {
      toast.error(errorText(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <div>
          <h4 className="text-sm font-medium">Who pays</h4>
          <p className="text-xs text-muted-foreground">
            Pay, or prove you&apos;re human. BotFare never blocks a request: it asks likely bots for
            the fare and lets people through.
          </p>
        </div>
        <div
          role="radiogroup"
          aria-label="Detection strictness"
          className="grid gap-2 sm:grid-cols-2"
        >
          {DETECTION_LEVELS.map((level) => {
            const selected = form.level === level.value;
            return (
              // biome-ignore lint/a11y/useSemanticElements: a card-style radio, keyboard-accessible as a button
              <button
                key={level.value}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => set("level", level.value)}
                className={cn(
                  "flex items-start gap-3 rounded-lg border p-3 text-left transition-colors outline-none hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50",
                  selected && "border-primary bg-muted/40",
                )}
              >
                <span
                  className={cn(
                    "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border",
                    selected && "border-primary bg-primary text-primary-foreground",
                  )}
                >
                  {selected && <Check className="size-3" />}
                </span>
                <span className="min-w-0 space-y-0.5">
                  <span className="flex items-center gap-2 text-sm font-medium">
                    {level.label}
                    {level.value === "standard" && (
                      <Badge variant="secondary" className="font-normal">
                        Recommended
                      </Badge>
                    )}
                  </span>
                  <span className="block text-xs text-muted-foreground">{level.summary}</span>
                </span>
              </button>
            );
          })}
        </div>

        {scored && (
          <div className="grid gap-2 sm:max-w-xs">
            <Label htmlFor={`${site.id}-threshold`} className="text-sm">
              Automation score threshold
            </Label>
            <Input
              id={`${site.id}-threshold`}
              inputMode="numeric"
              value={form.threshold}
              onChange={(e) => set("threshold", e.target.value)}
              placeholder={`Default ${levelCopy?.defaultThreshold ?? 60}`}
              aria-invalid={Boolean(err("threshold")) || undefined}
            />
            <p
              className={cn(
                "text-xs",
                err("threshold") ? "text-destructive" : "text-muted-foreground",
              )}
            >
              {err("threshold") ??
                "Requests scoring at or above this (0 to 100) are asked to pay. Lower is stricter."}
            </p>
          </div>
        )}
      </section>

      <section className="space-y-3">
        <div>
          <h4 className="text-sm font-medium">Human check</h4>
          <p className="text-xs text-muted-foreground">
            A Cloudflare Turnstile check on the 402 page. A person flagged by mistake passes it and
            reads free; agents pay or stay out.
          </p>
        </div>
        <div className="flex flex-wrap items-start gap-2">
          <div className="min-w-0 flex-1 space-y-1.5">
            <Label htmlFor={`${site.id}-turnstile`} className="sr-only">
              Turnstile site key
            </Label>
            <Input
              id={`${site.id}-turnstile`}
              value={form.turnstileSiteKey}
              onChange={(e) => set("turnstileSiteKey", e.target.value)}
              placeholder="Turnstile site key, e.g. 0x4AAAAAAA…"
              spellCheck={false}
              className="font-mono text-xs md:text-xs"
              aria-invalid={Boolean(err("turnstileSiteKey")) || undefined}
            />
            {err("turnstileSiteKey") && (
              <p className="text-xs text-destructive">{err("turnstileSiteKey")}</p>
            )}
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => set("turnstileSiteKey", TURNSTILE_TEST_SITE_KEY)}
            disabled={form.turnstileSiteKey === TURNSTILE_TEST_SITE_KEY}
          >
            Use test key
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          The test key always passes, which suits a demo. Leave the field empty to turn the check
          off.
        </p>
        {scored && !form.turnstileSiteKey.trim() && (
          <Alert>
            <ShieldAlert />
            <AlertTitle>People have no way through</AlertTitle>
            <AlertDescription>
              {levelCopy?.label} charges traffic that only looks automated. Add a Turnstile key so a
              person flagged by mistake can prove they&apos;re human and read free.
            </AlertDescription>
          </Alert>
        )}
      </section>

      <section className="space-y-3">
        <div>
          <h4 className="text-sm font-medium">CDN bot scores</h4>
          <p className="text-xs text-muted-foreground">
            If your CDN already scores bots, forward its result as a request header and BotFare adds
            it to the score. Used by Standard and Strict.
          </p>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <div className="space-y-3 rounded-lg border p-3">
            <label
              htmlFor={`${site.id}-cf`}
              className="flex cursor-pointer items-start justify-between gap-3"
            >
              <span className="space-y-0.5">
                <span className="block text-sm">Cloudflare Bot Management</span>
                <span className="block text-xs text-muted-foreground">
                  Score 1 is a bot, 99 a person.
                </span>
              </span>
              <Switch
                id={`${site.id}-cf`}
                checked={form.cfEnabled}
                onCheckedChange={(checked) => set("cfEnabled", checked)}
              />
            </label>
            {form.cfEnabled && (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field
                  id={`${site.id}-cf-score`}
                  label="Score header"
                  value={form.cfScoreHeader}
                  onChange={(value) => set("cfScoreHeader", value)}
                  error={err("cfScoreHeader")}
                  mono
                />
                <Field
                  id={`${site.id}-cf-verified`}
                  label="Verified bot header"
                  value={form.cfVerifiedHeader}
                  onChange={(value) => set("cfVerifiedHeader", value)}
                  error={err("cfVerifiedHeader")}
                  mono
                />
                <Field
                  id={`${site.id}-cf-max`}
                  label="Bot at or below"
                  value={form.cfMaxScore}
                  onChange={(value) => set("cfMaxScore", value)}
                  error={err("cfMaxScore")}
                  hint="Cloudflare suggests 29."
                  numeric
                />
              </div>
            )}
          </div>
          <div className="space-y-3 rounded-lg border p-3">
            <label
              htmlFor={`${site.id}-ak`}
              className="flex cursor-pointer items-start justify-between gap-3"
            >
              <span className="space-y-0.5">
                <span className="block text-sm">Akamai Bot Manager</span>
                <span className="block text-xs text-muted-foreground">
                  Reads Akamai&apos;s bot result header.
                </span>
              </span>
              <Switch
                id={`${site.id}-ak`}
                checked={form.akEnabled}
                onCheckedChange={(checked) => set("akEnabled", checked)}
              />
            </label>
            {form.akEnabled && (
              <Field
                id={`${site.id}-ak-header`}
                label="Result header"
                value={form.akHeader}
                onChange={(value) => set("akHeader", value)}
                error={err("akHeader")}
                mono
              />
            )}
          </div>
        </div>
      </section>

      <section className="space-y-3">
        <div>
          <h4 className="text-sm font-medium">Revenue by signal</h4>
          <p className="text-xs text-muted-foreground">
            Why each paid request was asked to pay, after BotFare&apos;s 5%.
          </p>
        </div>
        <SignalRevenue rows={revenue} />
      </section>

      <div className="flex gap-3 rounded-lg bg-muted/50 p-3 text-xs text-muted-foreground">
        <Info className="mt-px size-4 shrink-0" />
        <div className="space-y-1">
          <p className="font-medium text-foreground">How scoring works</p>
          <p>
            Agents that identify themselves always pay. Above that, each request gets an automation
            score from your CDN&apos;s bot score, crawler impostor checks and signs of scripts or
            headless browsers. At or above the threshold, it gets a 402: pay, or prove you&apos;re
            human. People in a normal browser are never charged, and nothing is ever blocked.
          </p>
        </div>
      </div>

      {site.demoLocked && (
        <p className="text-xs text-muted-foreground">
          Judge mode: try any setting. The next sign-in puts {site.name} back to{" "}
          {DETECTION_LEVELS.find((level) => level.value === CREMA_NOTES_DETECTION.level)?.label}{" "}
          with the test human check.
        </p>
      )}

      <div className="flex flex-wrap items-center justify-end gap-2 border-t pt-4">
        {dirty && <span className="mr-auto text-xs text-muted-foreground">Unsaved changes</span>}
        <Button variant="ghost" size="sm" onClick={reset} disabled={!dirty || saving}>
          <RotateCcw />
          Discard
        </Button>
        <Button size="sm" onClick={save} disabled={!dirty || saving}>
          {saving && <Loader2 className="animate-spin" />}
          Save detection
        </Button>
      </div>
    </div>
  );
}

function Field({
  id,
  label,
  value,
  onChange,
  error,
  hint,
  mono,
  numeric,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  hint?: string;
  mono?: boolean;
  numeric?: boolean;
}) {
  return (
    <div className="min-w-0 space-y-1.5">
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      <Input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        inputMode={numeric ? "numeric" : undefined}
        spellCheck={false}
        className={cn(mono && "font-mono text-xs md:text-xs")}
        aria-invalid={Boolean(error) || undefined}
      />
      {(error || hint) && (
        <p className={cn("text-xs", error ? "text-destructive" : "text-muted-foreground")}>
          {error ?? hint}
        </p>
      )}
    </div>
  );
}

function SignalRevenue({ rows }: { rows: DetectionResponse["revenueBySignal"] | null }) {
  if (rows === null) {
    return <div className="h-16 animate-pulse rounded-lg bg-muted/50" />;
  }
  if (rows.length === 0) {
    return (
      <p className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
        No paid requests yet. Each one will show the signal that asked it to pay.
      </p>
    );
  }
  const max = Math.max(...rows.map((row) => row.earningsMicros), 1);
  return (
    <ul className="space-y-2">
      {rows.map((row) => (
        <li key={row.signal ?? "none"} className="space-y-1">
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span
              className="min-w-0 truncate"
              title={row.signal ? SIGNAL_DESCRIPTIONS[row.signal] : undefined}
            >
              {signalLabel(row.signal)}
            </span>
            <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
              {formatCount(row.paidRequests)} paid ·{" "}
              <span className="font-medium text-foreground">
                {formatMicros(row.earningsMicros)}
              </span>
            </span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary"
              style={{ width: `${Math.max((row.earningsMicros / max) * 100, 2)}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}
