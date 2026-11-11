import Link from "next/link";
import { NavLinks } from "@/components/app/nav-links";
import { SignOutButton } from "@/components/app/sign-out-button";
import { BotFareMark } from "@/components/brand/bot-fare-mark";
import { requireUser } from "@/lib/server/session";

export const dynamic = "force-dynamic";

/** Shell for every signed-in page: header, navigation, and the signed-in user. */
export default async function AppLayout({ children }: LayoutProps<"/">) {
  const user = await requireUser();
  return (
    <div className="flex min-h-full flex-1 flex-col">
      <header className="border-b">
        <div className="mx-auto flex h-14 w-full max-w-6xl items-center gap-3 px-4 sm:gap-6 sm:px-6">
          <Link
            href="/"
            className="inline-flex shrink-0 items-center gap-2 font-semibold tracking-tight"
          >
            <BotFareMark className="size-7" />
            BotFare
          </Link>
          <NavLinks />
          <div className="ml-auto flex shrink-0 items-center gap-3 text-sm text-muted-foreground">
            <span className="hidden md:inline">{user.name ?? user.email}</span>
            <SignOutButton />
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6 sm:py-8">{children}</main>
    </div>
  );
}
