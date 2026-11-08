import { TicketIcon } from "lucide-react";
import Link from "next/link";
import { pillars } from "./pillar-data";

const link =
  "rounded-md px-3 py-2 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50";

export function SiteHeader() {
  return (
    <header className="border-b">
      <div className="mx-auto flex h-14 w-full max-w-6xl items-center gap-4 px-4 sm:px-6">
        <Link
          href="/"
          className="inline-flex items-center gap-2 rounded-md text-lg font-bold tracking-tight outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <TicketIcon aria-hidden className="size-5" />
          BotFare
        </Link>
        <nav aria-label="Main" className="ml-auto flex items-center text-sm sm:gap-1">
          {pillars.map((p) => (
            <a key={p.id} href={`#${p.id}`} className={`${link} hidden md:inline-block`}>
              {p.name}
            </a>
          ))}
          <span aria-hidden className="mx-1 hidden h-4 w-px bg-border md:inline-block" />
          <Link href="/judge" className={link}>
            Judges
          </Link>
          <Link
            href="/signin"
            className="rounded-md px-3 py-2 font-medium outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            Sign in
          </Link>
        </nav>
      </div>
    </header>
  );
}
