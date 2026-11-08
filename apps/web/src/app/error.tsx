"use client";

import { RotateCw } from "lucide-react";
import Link from "next/link";
import { useEffect } from "react";
import { Button, buttonVariants } from "@/components/ui/button";

/** Any page that throws: a short apology, a retry, and a way home. Details stay in the logs. */
export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-4 px-4 py-16">
      <h1 className="text-2xl font-semibold tracking-tight">Something went wrong</h1>
      <p className="text-sm leading-relaxed text-muted-foreground">
        This page could not load. It is usually a brief database or network hiccup; trying again
        normally fixes it.
        {error.digest ? (
          <span className="mt-2 block font-mono text-xs">Reference: {error.digest}</span>
        ) : null}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button onClick={reset}>
          <RotateCw aria-hidden /> Try again
        </Button>
        <Link href="/" className={buttonVariants({ variant: "outline" })}>
          Home
        </Link>
      </div>
    </main>
  );
}
