import type { Metadata } from "next";
import { Toaster } from "@/components/ui/sonner";
import { bodySans, codeMono, displaySans } from "@/lib/fonts";
import "./globals.css";

export const metadata: Metadata = {
  title: "BotFare",
  description: "Every bot pays its fare. Pay-per-request for AI agents, settled on PayPal.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${bodySans.variable} ${displaySans.variable} ${codeMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        {children}
        <Toaster richColors />
      </body>
    </html>
  );
}
