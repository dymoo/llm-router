import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "LLM Router",
  description: "Issue and control inference API keys.",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  colorScheme: "dark",
  themeColor: "#18181a",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <a
          className="sr-only z-50 rounded-full bg-primary px-5 py-3 text-primary-foreground focus:not-sr-only focus:fixed focus:top-[calc(var(--safe-top)+0.5rem)] focus:left-4"
          href="#main"
        >
          Skip to Content
        </a>
        {children}
      </body>
    </html>
  );
}
