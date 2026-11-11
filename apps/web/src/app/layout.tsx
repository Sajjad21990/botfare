import type { Metadata } from "next";
import { SmoothScroll } from "@/components/smooth-scroll";
import { Toaster } from "@/components/ui/sonner";
import { bodySans, codeMono, displaySans } from "@/lib/fonts";
import "./globals.css";

export const metadata: Metadata = {
  title: "BotFare",
  metadataBase: new URL(
    process.env.BOTFARE_URL || process.env.RENDER_EXTERNAL_URL || "http://localhost:3000",
  ),
  description: "AI agents pay websites a few cents a page through PayPal. People still read free.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${bodySans.variable} ${displaySans.variable} ${codeMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        {children}
        <SmoothScroll />
        <Toaster richColors />
      </body>
    </html>
  );
}
