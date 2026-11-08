import { CircleAlert } from "lucide-react";
import Link from "next/link";
import { PayPalLoginButton, PersonaButtons } from "@/components/app/persona-buttons";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  PAYPAL_LOGIN_ERRORS,
  type PayPalLoginErrorCode,
  paypalLoginEnabled,
} from "@/lib/server/paypal-login";

export const metadata = { title: "Sign in · BotFare" };

// PAYPAL_LOGIN_ENABLED is read per request, not baked in at build time.
export const dynamic = "force-dynamic";

function loginError(value: string | string[] | undefined): string | null {
  const code = Array.isArray(value) ? value[0] : value;
  return code && code in PAYPAL_LOGIN_ERRORS
    ? PAYPAL_LOGIN_ERRORS[code as PayPalLoginErrorCode]
    : null;
}

export default async function SignInPage({ searchParams }: PageProps<"/signin">) {
  const error = loginError((await searchParams).error);
  const paypal = paypalLoginEnabled();

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center gap-8 px-6 py-16">
      <div className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">Sign in to BotFare</h1>
        <p className="text-muted-foreground">
          This is a PayPal sandbox demo. Pick a role to explore; no password needed.
        </p>
        <p className="text-sm text-muted-foreground">
          Everyone shares these demo accounts, so the demo site&apos;s prices reset when you sign
          in, and its secret, payout account and seeded agent keys stay locked.
        </p>
      </div>
      {error && (
        <Alert variant="destructive">
          <CircleAlert aria-hidden />
          <AlertTitle>Could not log in with PayPal</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <PersonaButtons />
      {paypal && <PayPalLoginButton />}
      <p className="text-sm text-muted-foreground">
        Judging the hackathon?{" "}
        <Link href="/judge" className="font-medium text-foreground underline underline-offset-4">
          Take the two-minute tour
        </Link>
        .
      </p>
    </main>
  );
}
