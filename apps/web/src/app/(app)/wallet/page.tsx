import { requireUser } from "@/lib/server/session";

export default async function Page() {
  await requireUser();
  return <p className="text-muted-foreground">Coming in Phase 2.</p>;
}
