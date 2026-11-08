import { FlaskConical } from "lucide-react";
import { CopyField } from "@/components/publisher/copy-button";

/**
 * The PayPal sandbox buyer a judge uses to approve a wallet top-up. Shown only when both
 * JUDGE_SANDBOX_BUYER_EMAIL and JUDGE_SANDBOX_BUYER_PASSWORD are set; these are sandbox test
 * credentials (fake money), never a real PayPal account.
 */
export function SandboxAccount({ email, password }: { email: string; password: string }) {
  return (
    <div className="space-y-3 rounded-lg border border-dashed bg-muted/30 p-3">
      <div className="flex items-start gap-2 text-sm">
        <FlaskConical aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div>
          <div className="font-medium">PayPal sandbox test account — fake money</div>
          <p className="text-muted-foreground">
            Use it in the PayPal window when you top up. Nothing real is charged.
          </p>
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <CopyField label="Email" value={email} />
        <CopyField label="Password" value={password} />
      </div>
    </div>
  );
}

/** Both values, or null when either is missing. */
export function judgeSandboxBuyer(env: NodeJS.ProcessEnv = process.env) {
  const email = env.JUDGE_SANDBOX_BUYER_EMAIL?.trim();
  const password = env.JUDGE_SANDBOX_BUYER_PASSWORD?.trim();
  return email && password ? { email, password } : null;
}
