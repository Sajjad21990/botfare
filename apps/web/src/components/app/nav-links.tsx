"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

/** Top-level sections of the signed-in app. Each phase adds its pages under src/app/(app). */
const LINKS = [
  { href: "/wallet", label: "Wallet" },
  { href: "/publisher", label: "Publisher" },
  { href: "/publisher/analytics", label: "Analytics" },
];

export function NavLinks() {
  const pathname = usePathname();
  return (
    <nav className="flex items-center gap-1">
      {LINKS.map((link) => {
        const active =
          link.href === "/publisher" ? pathname === link.href : pathname.startsWith(link.href);
        return (
          <Link
            key={link.href}
            href={link.href}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm transition-colors hover:bg-muted",
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
