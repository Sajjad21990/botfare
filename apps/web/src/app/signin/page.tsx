import { PersonaButtons } from "@/components/app/persona-buttons";

export const metadata = { title: "Sign in · BotFare" };

export default function SignInPage() {
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
      <PersonaButtons />
    </main>
  );
}
