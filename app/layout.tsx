import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Reader AI",
  description: "A calm reading companion for understanding language in context."
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
