import Link from "next/link";
import { BotFareMark } from "@/components/brand/bot-fare-mark";
import styles from "./landing.module.css";
import { pillars } from "./pillar-data";

const link = `${styles.focusRing} rounded-md px-3 py-2 whitespace-nowrap text-muted-foreground hover:text-foreground`;

export function SiteHeader() {
  return (
    <header className="border-b">
      <div className="mx-auto flex h-14 w-full max-w-6xl items-center gap-4 px-4 sm:px-6">
        <Link
          href="/"
          className={`${styles.focusRing} inline-flex items-center gap-2 rounded-md text-lg font-bold tracking-tight`}
        >
          <BotFareMark className="size-7" />
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
            Two-minute tour
          </Link>
          <Link
            href="/signin"
            className={`${styles.focusRing} rounded-md px-3 py-2 font-medium whitespace-nowrap hover:bg-muted`}
          >
            Sign in
          </Link>
        </nav>
      </div>
    </header>
  );
}
