import { TicketIcon } from "lucide-react";
import Link from "next/link";

export function SiteHeader() {
  return (
    <header className="border-b">
      <div className="mx-auto flex h-14 w-full max-w-6xl items-center gap-6 px-4 sm:px-6">
        <Link
          href="/"
          className="inline-flex items-center gap-2 rounded-md text-lg font-bold tracking-tight outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <TicketIcon aria-hidden className="size-5" />
          BotFare
        </Link>
        <nav aria-label="Main" className="ml-auto flex items-center gap-1 text-sm sm:gap-2">
          <a
            href="#how-it-works"
            className="hidden rounded-md px-3 py-2 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 sm:inline-block"
          >
            How it works
          </a>
          <Link
            href="/judge"
            className="rounded-md px-3 py-2 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
          >
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
