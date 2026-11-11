"use client";

import { KeyRound } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { CodeBlock, CopyField } from "./copy-button";

/** The one-time view of a site secret: IDs, the secret, and ready-to-paste env lines. */
export function SecretReveal({
  siteId,
  siteSecret,
  botfareUrl,
}: {
  siteId: string;
  siteSecret: string;
  botfareUrl: string;
}) {
  return (
    <div className="min-w-0 space-y-4">
      <Alert className="border-amber-500/40 bg-amber-500/5">
        <KeyRound className="text-amber-600 dark:text-amber-400" />
        <AlertTitle>Copy the secret now</AlertTitle>
        <AlertDescription>
          BotFare keeps only a hash, so this is the only time it is shown. Lost it? Rotate it on the
          site card.
        </AlertDescription>
      </Alert>
      <CopyField label="Site ID" value={siteId} />
      <CopyField label="Site secret" value={siteSecret} secret />
      <CodeBlock
        label=".env"
        code={`BOTFARE_URL=${botfareUrl}\nBOTFARE_SITE_ID=${siteId}\nBOTFARE_SITE_SECRET=${siteSecret}`}
      />
    </div>
  );
}
