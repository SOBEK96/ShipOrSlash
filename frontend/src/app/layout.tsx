import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "ShipOrSlash",
  description:
    "Milestone-bound token vesting. Tranches unlock when signed, CI-passing releases are corroborated by three independent mirrors, not when the calendar says so.",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
