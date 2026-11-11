import { cn } from "cn";
import Link from "next/link";
import { BotFareMark } from "@/components/brand/bot-fare-mark";
import { buttonVariants } from "@/components/ui/button";
import styles from "./landing.module.css";
import { readmeUrl } from "./links";

/** Page anchors, hidden on a phone, where Sign in and the main button are all that fit. */
const anchor = `${styles.focusRing} hidden rounded-md px-3 py-2 whitespace-nowrap text-muted-foreground hover:text-foreground md:inline-block`;

export function SiteHeader() {
  return (
    <header className="border-b">
      <div className="mx-auto flex h-16 w-full max-w-6xl items-center gap-3 px-4 sm:px-6">
        <Link
          href="/"
          className={`${styles.focusRing} inline-flex shrink-0 items-center gap-2 rounded-md font-heading text-lg font-extrabold tracking-tight`}
        >
          <BotFareMark className="size-7" />
          {/* On the narrowest phones only the mark shows, so Sign in and the button still fit. */}
          <span className="max-[359px]:sr-only">BotFare</span>
        </Link>
        <nav aria-label="Main" className="ml-auto flex items-center text-sm sm:gap-1">
          <a href="/#how" className={anchor}>
            How it works
          </a>
          <a href="/#setup" className={anchor}>
            Set up
          </a>
          <a href={readmeUrl()} className={anchor}>
            README
          </a>
          <Link
            href="/signin"
            className={`${styles.focusRing} rounded-md px-2 py-2 font-medium whitespace-nowrap hover:bg-muted sm:px-3`}
          >
            Sign in
          </Link>
          <Link
            href="/judge"
            className={cn(
              buttonVariants({
                className: "ml-1 h-9 px-3 text-[0.8125rem] sm:ml-2 sm:px-4 sm:text-sm",
              }),
            )}
          >
            Try it in 2 minutes
          </Link>
        </nav>
      </div>
    </header>
  );
}
