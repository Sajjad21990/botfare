import { CircleAlert } from "lucide-react";
import Link from "next/link";
import { PayPalLoginButton, PersonaButtons } from "@/components/app/persona-buttons";
import { BotFareMark } from "@/components/brand/bot-fare-mark";
import styles from "@/components/landing/landing.module.css";
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

const textLink = `${styles.focusRing} rounded-sm font-medium text-foreground underline underline-offset-4`;

export default async function SignInPage({ searchParams }: PageProps<"/signin">) {
  const error = loginError((await searchParams).error);
  const paypal = paypalLoginEnabled();

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <header className="border-b">
        <div className="mx-auto flex h-14 w-full max-w-3xl items-center px-4 sm:px-6">
          <Link
            href="/"
            className={`${styles.focusRing} inline-flex items-center gap-2 rounded-md text-lg font-bold tracking-tight`}
          >
            <BotFareMark className="size-7" />
            BotFare
          </Link>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center gap-8 px-4 py-12 sm:px-6 sm:py-16">
        <div className="space-y-2">
          <h1 className="text-3xl font-extrabold tracking-[-0.03em] sm:text-4xl">
            Sign in to BotFare
          </h1>
          <p className="text-lg leading-relaxed">
            A PayPal sandbox demo. Pick a side; no password needed.
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
        <div className="space-y-1.5 text-sm">
          <p className="text-muted-foreground">
            Shared demo accounts: prices reset when you sign in.
          </p>
          <p>
            Judging?{" "}
            <Link href="/judge" className={textLink}>
              Try it in 2 minutes
            </Link>
            .
          </p>
        </div>
        {paypal && (
          <div className="space-y-4">
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              <span aria-hidden className="h-px flex-1 bg-border" />
              or
              <span aria-hidden className="h-px flex-1 bg-border" />
            </div>
            <PayPalLoginButton />
          </div>
        )}
      </main>
    </div>
  );
}
