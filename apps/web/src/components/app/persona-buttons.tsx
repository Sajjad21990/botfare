"use client";

import { DEMO_PERSONAS, type DemoPersona } from "@botfare/contracts";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/** Judge mode: one click signs in as a demo persona. */
export function PersonaButtons() {
  const router = useRouter();
  const [pending, setPending] = useState<DemoPersona | null>(null);

  async function signIn(persona: DemoPersona) {
    setPending(persona);
    const response = await fetch("/api/session/persona", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ persona }),
    });
    setPending(null);
    if (!response.ok) {
      toast.error("Could not sign in. Is the database running?");
      return;
    }
    const { home } = (await response.json()) as { home: string };
    router.push(home);
    router.refresh();
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {(Object.keys(DEMO_PERSONAS) as DemoPersona[]).map((persona) => {
        const p = DEMO_PERSONAS[persona];
        return (
          <Card key={persona}>
            <CardHeader>
              <CardTitle>{p.label}</CardTitle>
              <CardDescription>{p.description}</CardDescription>
            </CardHeader>
            <CardContent>
              <Button
                className="w-full"
                disabled={pending !== null}
                onClick={() => signIn(persona)}
              >
                {pending === persona ? "Signing in…" : `Continue as ${p.label.toLowerCase()}`}
              </Button>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
