import { ArrowUpRightIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { NEW_TAB, NEW_TAB_HINT } from "./links";

type NewTabLinkProps = Omit<ComponentProps<"a">, "target" | "rel"> & {
  /** The mark after the text; a small up-right arrow by default, `false` for none. */
  icon?: ReactNode | false;
};

/**
 * A link that opens in a new tab and says so: hidden text for screen readers, and (unless `icon`
 * is false) a small arrow for everyone else. Used for other sites and for side trips like /verify.
 */
export function NewTabLink({
  children,
  icon = <ArrowUpRightIcon aria-hidden className="size-4" />,
  ...props
}: NewTabLinkProps) {
  return (
    <a {...props} {...NEW_TAB}>
      {children}
      <span className="sr-only">{NEW_TAB_HINT}</span>
      {icon === false ? null : icon}
    </a>
  );
}
