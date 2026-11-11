"use client";

import { cn } from "cn";
import { CopyButton } from "@/components/publisher/copy-button";

/**
 * A long value (ID, digest, key, URL) as a one-line mono chip with a copy button. When it does not
 * fit, the middle gives way: the start ends in an ellipsis and the last characters stay visible.
 * The full value is in the DOM (screen readers read it whole), in the title, and in what is copied.
 */
export function CopyChip({
  value,
  label,
  tail = 8,
  className,
}: {
  value: string;
  /** What the value is, for the copy button: "receipt ID" gives "Copy receipt ID". */
  label: string;
  /** Characters always shown at the end. */
  tail?: number;
  className?: string;
}) {
  const split = value.length > tail * 2;
  return (
    <span
      className={cn(
        "inline-flex max-w-full min-w-0 items-center gap-1 rounded-md border border-foreground/15 bg-background/70 py-px pr-px pl-2 align-middle",
        className,
      )}
    >
      <code title={value} className="flex min-w-0 font-mono text-xs leading-6 whitespace-pre">
        <span className="truncate">{split ? value.slice(0, -tail) : value}</span>
        {split ? <span className="shrink-0">{value.slice(-tail)}</span> : null}
      </code>
      <CopyButton
        value={value}
        label={`Copy ${label}`}
        className="size-6 shrink-0 rounded-[5px] [&_svg]:size-3.5"
      />
    </span>
  );
}
