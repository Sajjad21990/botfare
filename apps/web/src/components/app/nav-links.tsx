"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Fragment, useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

/**
 * Top-level sections of the signed-in app, grouped by who uses them: agent owners, then
 * publishers. Grouped, never hidden: one PayPal login can be both.
 */
const GROUPS = [
  {
    label: "For AI agent owners",
    links: [
      { href: "/wallet", label: "Wallet" },
      { href: "/agent", label: "Research agent" },
    ],
  },
  {
    label: "For websites",
    links: [
      { href: "/publisher", label: "Dashboard" },
      { href: "/publisher/analytics", label: "Analytics" },
      { href: "/publisher/disputes", label: "Disputes" },
    ],
  },
] as const;

/** `/publisher` is active only on itself; the other sections also on their sub-pages. */
function isActive(href: string, pathname: string): boolean {
  if (href === "/publisher") return pathname === href;
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function NavLinks({ className }: { className?: string }) {
  const pathname = usePathname();
  const navRef = useRef<HTMLElement>(null);

  // On a phone the row scrolls sideways: bring the current page's link into view (e.g. Disputes).
  useEffect(() => {
    const nav = navRef.current;
    if (!nav || nav.scrollWidth <= nav.clientWidth) return;
    const href = GROUPS.flatMap((group): readonly { href: string }[] => group.links).find((link) =>
      isActive(link.href, pathname),
    )?.href;
    const active = href ? nav.querySelector<HTMLElement>(`a[href="${href}"]`) : null;
    if (!active) return;
    const navBox = nav.getBoundingClientRect();
    const linkBox = active.getBoundingClientRect();
    if (linkBox.right > navBox.right) nav.scrollLeft += linkBox.right - navBox.right + 8;
    else if (linkBox.left < navBox.left) nav.scrollLeft -= navBox.left - linkBox.left + 8;
  }, [pathname]);

  return (
    <nav
      ref={navRef}
      aria-label="Main"
      className={cn(
        "flex min-w-0 items-stretch overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        className,
      )}
    >
      {GROUPS.map((group, index) => (
        <Fragment key={group.label}>
          {index > 0 ? (
            <span aria-hidden className="mx-1.5 h-4 w-px shrink-0 self-center bg-border sm:mx-2" />
          ) : null}
          {/* biome-ignore lint/a11y/useSemanticElements: a labelled group of links, not a form fieldset */}
          <div role="group" aria-label={group.label} className="flex shrink-0 items-stretch">
            {group.links.map((link) => {
              const active = isActive(link.href, pathname);
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "relative inline-flex shrink-0 items-center rounded-md px-2.5 text-sm whitespace-nowrap transition-colors outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset sm:px-3",
                    active ? "font-medium text-foreground" : "text-muted-foreground",
                  )}
                >
                  {link.label}
                  {active ? (
                    <span
                      aria-hidden
                      className="absolute inset-x-2 bottom-0 h-[3px] rounded-t-sm bg-brand sm:inset-x-2.5"
                    />
                  ) : null}
                </Link>
              );
            })}
          </div>
        </Fragment>
      ))}
    </nav>
  );
}
