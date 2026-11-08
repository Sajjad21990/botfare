"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

/** Top-level sections of the signed-in app. Each phase adds its pages under src/app/(app). */
const LINKS = [
  { href: "/wallet", label: "Wallet" },
  { href: "/agent", label: "Agent" },
  { href: "/publisher", label: "Publisher" },
  { href: "/publisher/analytics", label: "Analytics" },
];

export function NavLinks() {
  const pathname = usePathname();
  return (
    <nav className="-mx-1 flex min-w-0 items-center gap-0.5 overflow-x-auto px-1 [scrollbar-width:none] sm:gap-1">
      {LINKS.map((link) => {
        const active =
          link.href === "/publisher" ? pathname === link.href : pathname.startsWith(link.href);
        return (
          <Link
            key={link.href}
            href={link.href}
            className={cn(
              "shrink-0 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-muted sm:px-3",
              active ? "bg-muted font-medium text-foreground" : "text-muted-foreground",
            )}
          >
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}
