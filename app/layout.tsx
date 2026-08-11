import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "M59 Field Command",
  description: "A strategy-game command surface for an m59-harness fleet.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

