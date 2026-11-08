import { Skeleton } from "@/components/ui/skeleton";

/** Shown inside the app shell while a signed-in page loads its data from the server. */
export default function Loading() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading…</span>
      <div className="space-y-2">
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-4 w-full max-w-md" />
      </div>
      <div className="grid gap-6 lg:grid-cols-5">
        <Skeleton className="h-44 lg:col-span-3" />
        <Skeleton className="h-44 lg:col-span-2" />
      </div>
      <Skeleton className="h-64" />
    </div>
  );
}
