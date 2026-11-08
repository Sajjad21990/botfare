import Link from "next/link";
import { NavLinks } from "@/components/app/nav-links";
import { SignOutButton } from "@/components/app/sign-out-button";
import { requireUser } from "@/lib/server/session";

export const dynamic = "force-dynamic";

/** Shell for every signed-in page: header, navigation, and the signed-in user. */
export default async function AppLayout({ children }: LayoutProps<"/">) {
  const user = await requireUser();
  return (
    <div className="flex min-h-full flex-1 flex-col">
      <header className="border-b">
        <div className="mx-auto flex h-14 w-full max-w-6xl items-center gap-6 px-6">
          <Link href="/" className="font-semibold tracking-tight">
            BotFare
          </Link>
          <NavLinks />
          <div className="ml-auto flex items-center gap-3 text-sm text-muted-foreground">
            <span className="hidden sm:inline">{user.name ?? user.email}</span>
            <SignOutButton />
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-8">{children}</main>
    </div>
  );
}
