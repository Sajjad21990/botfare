import { DEMO_PERSONAS, type DemoPersona } from "@botfare/contracts";
import Link from "next/link";
import { NavLinks } from "@/components/app/nav-links";
import { SignOutButton } from "@/components/app/sign-out-button";
import { BotFareLogo } from "@/components/brand/bot-fare-mark";
import { requireUser } from "@/lib/server/session";

export const dynamic = "force-dynamic";

/**
 * Shell for every signed-in page: the logo with a Sandbox chip and the signed-in user on top, then
 * the navigation on its own row (the two role groups and Verify a receipt), which wraps on a phone,
 * so nothing scrolls sideways. From sm up the header sticks to the top of the window, so the nav
 * stays in view on long pages and beside the full-height analytics dashboard. A demo persona sees
 * its role ("Agent owner", "Publisher"), and opening the other role's pages (a link, Back, or a
 * typed URL) switches persona, so they never look empty.
 */
export default async function AppLayout({ children }: LayoutProps<"/">) {
  const user = await requireUser();
  const email = user.email.trim().toLowerCase();
  const persona = (Object.keys(DEMO_PERSONAS) as DemoPersona[]).find(
    (p) => DEMO_PERSONAS[p].email === email,
  );
  return (
    <div className="flex min-h-full flex-1 flex-col">
      <header className="z-40 border-b-[1.5px] border-foreground bg-background sm:sticky sm:top-0">
        <div className="mx-auto flex w-full max-w-6xl items-center gap-x-3 px-4 sm:px-6">
          <div className="flex h-14 shrink-0 items-center gap-2.5">
            <Link
              href="/"
              className="rounded-md outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <BotFareLogo />
            </Link>
            {/* On a phone the demo role sits under the Sandbox chip; from sm up it is beside Sign out. */}
            <div className="flex flex-col items-start gap-0.5">
              <span
                className="rounded-full border border-foreground/25 bg-card px-2 py-0.5 text-[11px] leading-4 font-semibold tracking-wider text-muted-foreground uppercase"
                title="PayPal sandbox: test money only. Nothing real is charged."
              >
                Sandbox<span className="sr-only">: PayPal test money only</span>
              </span>
              {persona ? (
                <span className="pl-0.5 text-[11px] leading-4 text-muted-foreground sm:hidden">
                  {DEMO_PERSONAS[persona].label}
                </span>
              ) : null}
            </div>
          </div>
          <div className="ml-auto flex h-14 shrink-0 items-center gap-3 text-sm text-muted-foreground">
            {/* From sm up. On a phone the logo, Sandbox chip, role and Sign out do not fit on one row. */}
            <span className="hidden max-w-48 truncate sm:inline">
              {persona ? DEMO_PERSONAS[persona].label : (user.name ?? user.email)}
            </span>
            <SignOutButton />
          </div>
        </div>
        {/* The nav row, under a dashed tear line like a ticket stub. */}
        <div className="border-t border-dashed border-foreground/25">
          <NavLinks demoPersona={persona} className="mx-auto w-full max-w-6xl px-4 py-2 sm:px-6" />
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6 sm:py-8">{children}</main>
    </div>
  );
}
