"use client";

import type { PricingRule } from "@botfare/contracts";
import { ArrowDown, ArrowUp, Loader2, Plus, RotateCcw, Tag, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { api, errorText } from "./api";
import { formatCents } from "./format";
import type { SiteView } from "./types";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
const AUDIENCES = [
  { value: "agents", label: "Agents only" },
  { value: "everyone", label: "Everyone" },
] as const;
const MAX_PRICE_CENTS = 10_000;

interface Row {
  key: string;
  method: string;
  pattern: string;
  price: string;
  audience: "agents" | "everyone";
  description: string;
}

let rowCounter = 0;
function newKey(): string {
  rowCounter += 1;
  return `row-${rowCounter}`;
}

function toRows(pricing: PricingRule[]): Row[] {
  return pricing.map((rule) => ({
    key: newKey(),
    method: rule.method,
    pattern: rule.pattern,
    price: String(rule.priceCents),
    audience: rule.audience,
    description: rule.description ?? "",
  }));
}

function patternError(pattern: string): string | null {
  const value = pattern.trim();
  if (!value) return "Enter a path";
  if (!value.startsWith("/")) return "Start with /";
  if (/\s/.test(value)) return "No spaces";
  if (value.slice(0, -1).includes("*")) return "Use * only at the end";
  return null;
}

function priceError(price: string): string | null {
  if (!/^\d+$/.test(price.trim())) return "Whole cents";
  const cents = Number(price);
  if (cents < 1) return "At least 1¢";
  if (cents > MAX_PRICE_CENTS) return "At most $100";
  return null;
}

function parseFreePaths(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function snapshot(rows: Row[], freePaths: string, chargeKnownBots: boolean): string {
  return JSON.stringify({
    rules: rows.map(({ key: _key, ...rest }) => ({ ...rest, pattern: rest.pattern.trim() })),
    freePaths: parseFreePaths(freePaths),
    chargeKnownBots,
  });
}

/** Edits a site's pricing rules, free paths and known-bot charging, and saves them together. */
export function PricingEditor({
  site,
  onSaved,
}: {
  site: SiteView;
  onSaved: (site: SiteView) => void;
}) {
  const [rows, setRows] = useState<Row[]>(() => toRows(site.pricing));
  const [freePaths, setFreePaths] = useState(site.freePaths.join("\n"));
  const [chargeKnownBots, setChargeKnownBots] = useState(site.chargeKnownBots);
  const [baseline, setBaseline] = useState(() =>
    snapshot(toRows(site.pricing), site.freePaths.join("\n"), site.chargeKnownBots),
  );
  const [saving, setSaving] = useState(false);
  const [showErrors, setShowErrors] = useState(false);
  const [freeOpen, setFreeOpen] = useState(false);

  const dirty = snapshot(rows, freePaths, chargeKnownBots) !== baseline;
  const freePathList = parseFreePaths(freePaths);
  const freePathErrors = freePathList.filter((path) => patternError(path) !== null);
  const freePathsInvalid = showErrors && freePathErrors.length > 0;
  const rowErrors = useMemo(
    () => rows.map((row) => ({ pattern: patternError(row.pattern), price: priceError(row.price) })),
    [rows],
  );
  const invalid = rowErrors.some((e) => e.pattern || e.price) || freePathErrors.length > 0;

  function update(key: string, patch: Partial<Row>) {
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  }

  function move(index: number, by: -1 | 1) {
    setRows((current) => {
      const next = [...current];
      const [row] = next.splice(index, 1);
      if (row) next.splice(index + by, 0, row);
      return next;
    });
  }

  function addRow() {
    setRows((current) => [
      ...current,
      {
        key: newKey(),
        method: "GET",
        pattern: current.length === 0 ? "/articles/*" : "",
        price: "2",
        audience: "agents",
        description: "",
      },
    ]);
  }

  function reset() {
    setRows(toRows(site.pricing));
    setFreePaths(site.freePaths.join("\n"));
    setChargeKnownBots(site.chargeKnownBots);
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
        `/api/publisher/sites/${encodeURIComponent(site.id)}/pricing`,
        {
          pricing: rows.map((row) => ({
            method: row.method,
            pattern: row.pattern.trim(),
            priceCents: Number(row.price),
            audience: row.audience,
            ...(row.description.trim() ? { description: row.description.trim() } : {}),
          })),
          freePaths: freePathList,
          chargeKnownBots,
        },
      );
      const savedRows = toRows(saved.pricing);
      setRows(savedRows);
      setFreePaths(saved.freePaths.join("\n"));
      setChargeKnownBots(saved.chargeKnownBots);
      setBaseline(snapshot(savedRows, saved.freePaths.join("\n"), saved.chargeKnownBots));
      setShowErrors(false);
      onSaved(saved);
      toast.success("Prices saved. Your middleware picks them up on its next config refresh.");
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h4 className="text-sm font-medium">Pricing rules</h4>
            <p className="text-xs text-muted-foreground">
              The first rule that matches the method and path sets the price. End a path with * to
              match everything under it.
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={addRow}>
            <Plus />
            Add rule
          </Button>
        </div>

        {rows.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed px-4 py-8 text-center">
            <Tag className="size-5 text-muted-foreground" />
            <p className="text-sm font-medium">No prices yet</p>
            <p className="max-w-sm text-xs text-muted-foreground">
              Every request is free until you add a rule. Start with your articles, for example 2¢
              for <code className="font-mono">/articles/*</code>.
            </p>
            <Button size="sm" className="mt-1" onClick={addRow}>
              <Plus />
              Add your first rule
            </Button>
          </div>
        ) : (
          <div className="overflow-hidden rounded-lg border">
            <div className="hidden grid-cols-[92px_minmax(0,1.4fr)_104px_128px_minmax(0,1fr)_92px] gap-2 border-b bg-muted/40 px-3 py-2 text-xs font-medium text-muted-foreground md:grid">
              <span>Method</span>
              <span>Path</span>
              <span>Price</span>
              <span>Who pays</span>
              <span>Description</span>
              <span className="sr-only">Actions</span>
            </div>
            <ol className="divide-y">
              {rows.map((row, index) => {
                const errors = rowErrors[index];
                // Show a field's error as soon as it has content, and every error after a save attempt.
                const patternInvalid =
                  Boolean(errors?.pattern) && (showErrors || row.pattern.trim() !== "");
                const priceInvalid =
                  Boolean(errors?.price) && (showErrors || row.price.trim() !== "");
                const priceCents = Number(row.price);
                return (
                  <li
                    key={row.key}
                    className="grid grid-cols-2 gap-2 px-3 py-3 md:grid-cols-[92px_minmax(0,1.4fr)_104px_128px_minmax(0,1fr)_92px] md:items-start md:py-2"
                  >
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground md:sr-only">Method</Label>
                      <Select
                        value={row.method}
                        onValueChange={(value) => update(row.key, { method: String(value) })}
                      >
                        <SelectTrigger size="sm" className="w-full font-mono text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {METHODS.map((method) => (
                            <SelectItem key={method} value={method} className="font-mono text-xs">
                              {method}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="col-span-2 row-start-2 space-y-1 md:col-span-1 md:row-start-auto">
                      <Label className="text-xs text-muted-foreground md:sr-only">Path</Label>
                      <Input
                        value={row.pattern}
                        onChange={(e) => update(row.key, { pattern: e.target.value })}
                        placeholder="/articles/*"
                        aria-invalid={patternInvalid || undefined}
                        aria-label="Path pattern"
                        className="h-7 font-mono text-xs md:text-xs"
                        spellCheck={false}
                      />
                      {patternInvalid && (
                        <p className="text-xs text-destructive">{errors?.pattern}</p>
                      )}
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground md:sr-only">Price</Label>
                      <div className="relative">
                        <Input
                          value={row.price}
                          onChange={(e) => update(row.key, { price: e.target.value })}
                          inputMode="numeric"
                          aria-invalid={priceInvalid || undefined}
                          aria-label="Price in cents"
                          className="h-7 pr-8 text-right font-mono text-xs tabular-nums md:text-xs"
                        />
                        <span
                          className="pointer-events-none absolute inset-y-px right-px flex w-6 items-center justify-center rounded-r-[calc(var(--radius-lg)-1px)] border-l border-input bg-muted text-xs font-semibold text-foreground"
                          aria-hidden
                        >
                          ¢
                        </span>
                      </div>
                      <p
                        className={cn(
                          "text-xs",
                          priceInvalid ? "text-destructive" : "text-muted-foreground",
                        )}
                      >
                        {priceInvalid
                          ? errors?.price
                          : errors?.price
                            ? "Enter cents"
                            : `${formatCents(priceCents)} each`}
                      </p>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground md:sr-only">Who pays</Label>
                      <Select
                        value={row.audience}
                        items={AUDIENCES}
                        onValueChange={(value) =>
                          update(row.key, {
                            audience: value === "everyone" ? "everyone" : "agents",
                          })
                        }
                      >
                        <SelectTrigger size="sm" className="w-full text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {AUDIENCES.map((audience) => (
                            <SelectItem
                              key={audience.value}
                              value={audience.value}
                              className="text-xs"
                            >
                              {audience.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="col-span-2 space-y-1 md:col-span-1">
                      <Label className="text-xs text-muted-foreground md:sr-only">
                        Description
                      </Label>
                      <Input
                        value={row.description}
                        onChange={(e) => update(row.key, { description: e.target.value })}
                        placeholder="Shown to agents in the offer"
                        maxLength={200}
                        aria-label="Description"
                        className="h-7 text-xs md:text-xs"
                      />
                    </div>
                    <div className="col-span-2 flex items-center justify-end gap-0.5 md:col-span-1">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => move(index, -1)}
                        disabled={index === 0}
                        aria-label="Move rule up"
                      >
                        <ArrowUp />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => move(index, 1)}
                        disabled={index === rows.length - 1}
                        aria-label="Move rule down"
                      >
                        <ArrowDown />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() =>
                          setRows((current) => current.filter((r) => r.key !== row.key))
                        }
                        aria-label="Remove rule"
                        className="text-muted-foreground hover:text-destructive"
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ol>
          </div>
        )}
      </section>

      <details
        open={freeOpen || freePathsInvalid}
        onToggle={(e) => setFreeOpen(e.currentTarget.open)}
      >
        <summary className="cursor-pointer text-sm font-medium">Free paths (advanced)</summary>
        <div className="mt-2 space-y-2">
          <Textarea
            id={`${site.id}-free`}
            aria-label="Free paths"
            value={freePaths}
            onChange={(e) => setFreePaths(e.target.value)}
            placeholder={"/about\n/articles/free-*"}
            rows={3}
            spellCheck={false}
            aria-invalid={freePathsInvalid || undefined}
            className="font-mono text-xs md:text-xs"
          />
          <p
            className={cn(
              "text-xs",
              freePathsInvalid ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {freePathsInvalid
              ? `Check ${freePathErrors.join(", ")}: paths start with / and use * only at the end.`
              : "One per line. Always free, even for agents, whatever the rules say."}
          </p>
        </div>
      </details>

      <div className="flex flex-wrap items-center justify-end gap-2 border-t pt-4">
        {dirty && <span className="mr-auto text-xs text-muted-foreground">Unsaved changes</span>}
        <Button variant="ghost" size="sm" onClick={reset} disabled={!dirty || saving}>
          <RotateCcw />
          Discard
        </Button>
        <Button size="sm" onClick={save} disabled={!dirty || saving}>
          {saving && <Loader2 className="animate-spin" />}
          Save prices
        </Button>
      </div>
    </div>
  );
}
