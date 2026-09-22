import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ClientRecord CRM",
  description: "Manage client records, relationships, follow-ups, deals, and targeted email campaigns.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
