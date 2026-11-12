"use client";

import { Eye, EyeOff, FlaskConical } from "lucide-react";
import { useState } from "react";
import { CopyButton } from "@/components/publisher/copy-button";
import { Button } from "@/components/ui/button";

/**
 * The PayPal sandbox buyer a judge uses to approve a wallet top-up (JUDGE_SANDBOX_BUYER_EMAIL and
 * JUDGE_SANDBOX_BUYER_PASSWORD; sandbox test credentials, never a real PayPal account). The
 * password stays hidden until Show, and both copy without being shown. Without an account, the
 * box says any PayPal sandbox personal account works.
 */
export function SandboxAccount({
  account,
}: {
  account: { email: string; password: string } | null;
}) {
  return (
    <section
      aria-labelledby="test-account-title"
      className="rounded-xl border-[1.5px] border-dashed border-foreground/30 bg-card p-4 sm:p-5"
    >
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-ticket"
        >
          <FlaskConical className="size-4" />
        </span>
        <div className="min-w-0 space-y-0.5">
          <h2 id="test-account-title" className="text-base font-semibold">
            PayPal test account
          </h2>
          <p className="text-sm leading-relaxed">
            {account
              ? "Log in to the PayPal window with this sandbox buyer. Nothing real is charged."
              : "Log in to the PayPal window with any PayPal sandbox personal account. Nothing real is charged."}
          </p>
        </div>
      </div>
      {account && (
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <EmailField email={account.email} />
          <PasswordField password={account.password} />
        </div>
      )}
      <p className="mt-3 text-xs text-muted-foreground">
        This PayPal test buyer is shared with other judges and holds only test money.
      </p>
    </section>
  );
}

const fieldBox = "flex min-h-9 items-center gap-1 rounded-lg border bg-muted/40 py-1 pr-1 pl-3";

function EmailField({ email }: { email: string }) {
  return (
    <div className="min-w-0 space-y-1.5">
      <div className="text-xs font-medium text-muted-foreground">Email</div>
      <div className={fieldBox}>
        <code className="min-w-0 flex-1 truncate font-mono text-[13px]" title={email}>
          {email}
        </code>
        <CopyButton value={email} label="Copy email" />
      </div>
    </div>
  );
}

function PasswordField({ password }: { password: string }) {
  const [shown, setShown] = useState(false);
  return (
    <div className="min-w-0 space-y-1.5">
      <div className="text-xs font-medium text-muted-foreground">Password</div>
      <div className={fieldBox}>
        {shown ? (
          <code className="min-w-0 flex-1 truncate font-mono text-[13px]">{password}</code>
        ) : (
          <span className="min-w-0 flex-1 truncate font-mono text-[13px] tracking-widest">
            <span aria-hidden>••••••••••</span>
            <span className="sr-only">Hidden</span>
          </span>
        )}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={shown ? "Hide password" : "Show password"}
          onClick={() => setShown((s) => !s)}
        >
          {shown ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
          {shown ? "Hide" : "Show"}
        </Button>
        <CopyButton value={password} label="Copy password" />
      </div>
    </div>
  );
}
