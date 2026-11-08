import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "Not found · BotFare" };

export default function NotFound() {
  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-4 px-4 py-16">
      <p className="font-mono text-sm text-muted-foreground">404</p>
      <h1 className="text-2xl font-semibold tracking-tight">No page here</h1>
      <p className="text-sm leading-relaxed text-muted-foreground">
        The link may be old. Judges can start from the guided tour.
      </p>
      <div className="flex flex-wrap gap-3 text-sm font-medium">
        <Link href="/judge" className="underline underline-offset-4">
          Judge mode
        </Link>
        <Link href="/" className="underline underline-offset-4">
          Home
        </Link>
        <Link href="/signin" className="underline underline-offset-4">
          Sign in
        </Link>
      </div>
    </main>
  );
}
