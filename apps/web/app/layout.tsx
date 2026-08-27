import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "SEO Article Generator",
  description:
    "Keyword research, content gap analysis, and brand-aware SEO article generation.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-screen">{children}</body>
    </html>
  );
}
