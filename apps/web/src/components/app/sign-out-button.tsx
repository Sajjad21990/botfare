"use client";

import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

export function SignOutButton() {
  const router = useRouter();
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={async () => {
        await fetch("/api/session/logout", { method: "POST" });
        router.push("/signin");
        router.refresh();
      }}
    >
      Sign out
    </Button>
  );
}
