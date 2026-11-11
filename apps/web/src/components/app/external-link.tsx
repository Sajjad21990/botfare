import { ArrowUpRight } from "lucide-react";
import type { ComponentProps } from "react";

/**
 * Attributes for a link that opens in a new tab: links to other sites, and in-app side trips a
 * visitor wants next to the page they are on (such as /verify from a receipt).
 */
export const newTab = { target: "_blank", rel: "noopener noreferrer" } as const;

/** Tells screen readers that a link opens a new tab. Put it last inside the link. */
export function NewTabHint() {
  return <span className="sr-only"> (opens in a new tab)</span>;
}

/**
 * A plain anchor that opens in a new tab and says so to screen readers. `icon` adds a small
 * arrow after the text (extra classes in `iconClassName`); leave it off when the link already
 * shows its own icon.
 */
export function NewTabLink({
  children,
  icon = false,
  iconClassName,
  ...props
}: Omit<ComponentProps<"a">, "target" | "rel"> & { icon?: boolean; iconClassName?: string }) {
  return (
    <a {...props} {...newTab}>
      {children}
      {icon ? (
        <ArrowUpRight
          aria-hidden
          className={["inline size-3.5 shrink-0", iconClassName].filter(Boolean).join(" ")}
        />
      ) : null}
      <NewTabHint />
    </a>
  );
}
