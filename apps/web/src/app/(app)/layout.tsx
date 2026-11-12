import { DEMO_PERSONAS, type DemoPersona } from "@botfare/contracts";
import Link from "next/link";
import { NavLinks } from "@/components/app/nav-links";
import { SignOutButton } from "@/components/app/sign-out-button";
import { BotFareLogo } from "@/components/brand/bot-fare-mark";
import { requireUser } from "@/lib/server/session";

export const dynamic = "force-dynamic";

/**
 * Shell for every signed-in page: the logo with a Sandbox chip, the navigation, and the signed-in
 * user. Below `lg` the navigation gets its own scrollable row, so a phone never scrolls sideways.
 * A demo persona sees its role ("Agent owner", "Publisher"), and a link in the other role's group
 * switches persona, so the other role's pages never look empty.
 */
export default async function AppLayout({ children }: LayoutProps<"/">) {
  const user = await requireUser();
  const email = user.email.trim().toLowerCase();
  const persona = (Object.keys(DEMO_PERSONAS) as DemoPersona[]).find(
    (p) => DEMO_PERSONAS[p].email === email,
  );
  return (
    <div className="flex min-h-full flex-1 flex-col">
      <header className="border-b">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-x-3 px-4 sm:px-6 lg:flex-nowrap lg:gap-x-6">
          <div className="flex h-14 shrink-0 items-center gap-2.5">
            <Link
              href="/"
              className="rounded-md outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <BotFareLogo />
            </Link>
            <span
              className="rounded-full border border-foreground/25 bg-card px-2 py-0.5 text-[11px] leading-4 font-semibold tracking-wider text-muted-foreground uppercase"
              title="PayPal sandbox: test money only. Nothing real is charged."
            >
              Sandbox<span className="sr-only">: PayPal test money only</span>
            </span>
          </div>
          <NavLinks
            demoPersona={persona}
            className="order-last -mx-2.5 h-11 w-[calc(100%+1.25rem)] lg:order-none lg:mx-0 lg:h-14 lg:w-auto"
          />
          <div className="ml-auto flex h-14 shrink-0 items-center gap-3 text-sm text-muted-foreground">
            {/* From sm up. On a phone the logo, Sandbox chip, role and Sign out do not fit on one row. */}
            <span className="hidden max-w-48 truncate sm:inline">
              {persona ? DEMO_PERSONAS[persona].label : (user.name ?? user.email)}
            </span>
            <SignOutButton />
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6 sm:py-8">{children}</main>
    </div>
  );
}
