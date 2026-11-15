import type { Metadata } from "next";
import { Geist_Mono, Montserrat } from "next/font/google";
import "./globals.css";
import { ConvexClientProvider } from "./ConvexClientProvider";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { cn } from "@/lib/utils";

const montserrat = Montserrat({ subsets: ["latin"], variable: "--font-sans" });

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Job Hunter",
  description: "Personal job-hunting system of record",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // Dark, always — the owner's choice, so there is no theme provider, no
    // switch, and no client-side theme state to hydrate against. The class is
    // in the server-rendered HTML, which is the only way to guarantee no light
    // frame is ever painted.
    <html
      lang="en"
      className={cn("dark h-full antialiased", montserrat.variable, geistMono.variable)}
    >
      <body className="flex min-h-full flex-col bg-background font-sans text-foreground">
        <ConvexClientProvider>
          <TooltipProvider delayDuration={300}>{children}</TooltipProvider>
          <Toaster position="bottom-right" />
        </ConvexClientProvider>
      </body>
    </html>
  );
}
