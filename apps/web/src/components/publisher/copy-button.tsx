"use client";

import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** Copies `value` to the clipboard and shows a check for a moment. */
export function CopyButton({
  value,
  label = "Copy",
  showLabel = false,
  className,
  variant = "ghost",
}: {
  value: string;
  label?: string;
  showLabel?: boolean;
  className?: string;
  variant?: "ghost" | "outline" | "secondary";
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(id);
  }, [copied]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      toast.error("Could not copy. Select the text and copy it by hand.");
    }
  }

  const Icon = copied ? Check : Copy;
  return (
    <Button
      type="button"
      variant={variant}
      size={showLabel ? "sm" : "icon-sm"}
      onClick={copy}
      aria-label={copied ? "Copied" : label}
      className={cn(copied && "text-emerald-600 dark:text-emerald-400", className)}
    >
      <Icon />
      {showLabel && (copied ? "Copied" : label)}
    </Button>
  );
}

/** A monospace value with a copy button, for IDs and secrets. */
export function CopyField({
  label,
  value,
  secret = false,
}: {
  label: string;
  value: string;
  secret?: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div
        className={cn(
          "flex items-center gap-2 rounded-lg border bg-muted/40 py-1 pr-1 pl-3",
          secret && "border-amber-500/40 bg-amber-500/5",
        )}
      >
        <code className="min-w-0 flex-1 truncate font-mono text-[13px]" title={value}>
          {value}
        </code>
        <CopyButton value={value} label={`Copy ${label.toLowerCase()}`} />
      </div>
    </div>
  );
}

/** A copyable code block. */
export function CodeBlock({ code, label }: { code: string; label?: string }) {
  return (
    <div className="group relative rounded-lg border bg-muted/40">
      {label && (
        <div className="border-b px-3 py-1.5 text-xs font-medium text-muted-foreground">
          {label}
        </div>
      )}
      <pre className="overflow-x-auto px-3 py-2.5 pr-11 font-mono text-[12.5px] leading-relaxed">
        <code>{code}</code>
      </pre>
      <CopyButton
        value={code}
        label={label ? `Copy ${label.toLowerCase()}` : "Copy code"}
        className={cn("absolute right-1.5", label ? "top-9" : "top-1.5")}
      />
    </div>
  );
}
