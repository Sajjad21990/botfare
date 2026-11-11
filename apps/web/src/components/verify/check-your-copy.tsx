"use client";

import { contentDigestSha256 } from "@botfare/contracts/fare";
import type { DeliveryStatement } from "@botfare/contracts/receipts";
import { cn } from "cn";
import { Check, ChevronRight, FileSearch, X } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { CopyChip } from "./copy-chip";
import { disclosureSummary } from "./disclosure";

/** Lets the viewer hash their own copy of the content and compare it with the signed digest. */
export function CheckYourCopy({ statement }: { statement: DeliveryStatement }) {
  const [text, setText] = useState("");
  const [outcome, setOutcome] = useState<{ digest: string; source: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function hash(body: Uint8Array | string, source: string) {
    setBusy(true);
    try {
      setOutcome({ digest: await contentDigestSha256(body), source });
    } finally {
      setBusy(false);
    }
  }

  const matches = outcome ? outcome.digest === statement.delivery.contentDigest : null;

  return (
    <details className="group rounded-xl border border-foreground/15 bg-card">
      <summary className={disclosureSummary}>
        <ChevronRight
          aria-hidden
          className="size-4 shrink-0 transition-transform group-open:rotate-90 motion-reduce:transition-none"
        />
        <FileSearch aria-hidden className="size-4 shrink-0" />
        <span className="font-semibold">Check your copy</span>
        <span className="hidden text-sm font-normal text-muted-foreground sm:inline">
          Compare a file with the signed digest
        </span>
      </summary>
      <div className="flex flex-col gap-3 border-t border-foreground/10 px-4 pt-3 pb-4 text-sm">
        <p className="text-muted-foreground">
          Pick the file you received or paste its exact text. Your browser hashes it and uploads
          nothing. The signed digest is{" "}
          <CopyChip value={statement.delivery.contentDigest} label="signed digest" />.
        </p>
        <input
          type="file"
          aria-label="File to hash"
          className="max-w-full text-sm file:mr-3 file:rounded-md file:border file:border-foreground/20 file:bg-background file:px-2.5 file:py-1 file:text-sm file:font-medium"
          onChange={async (event) => {
            const file = event.target.files?.[0];
            if (file) await hash(new Uint8Array(await file.arrayBuffer()), file.name);
          }}
        />
        <Textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="Or paste the exact body here"
          aria-label="Content to hash"
          className="max-h-40 bg-background font-mono text-xs"
        />
        <div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!text || busy}
            onClick={() => hash(text, "The pasted text")}
          >
            Hash the pasted text
          </Button>
        </div>
        {outcome ? (
          <p
            role="status"
            className={cn(
              "flex items-start gap-2 font-medium",
              matches ? "text-success" : "text-stamp",
            )}
          >
            {matches ? (
              <Check aria-hidden className="mt-0.5 size-4 shrink-0" />
            ) : (
              <X aria-hidden className="mt-0.5 size-4 shrink-0" />
            )}
            <span className="min-w-0 [overflow-wrap:anywhere]">
              {matches
                ? `${outcome.source} matches the signed digest byte for byte.`
                : `${outcome.source} hashes to ${outcome.digest}, not the signed digest.`}
            </span>
          </p>
        ) : null}
      </div>
    </details>
  );
}
