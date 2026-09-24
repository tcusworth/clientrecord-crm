import type { Metadata } from "next";
import Script from "next/script";
import "./globals.css";

export const metadata: Metadata = {
  title: "ClientRecord CRM",
  description: "Manage client records, relationships, follow-ups, deals, and targeted email campaigns.",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable:true, title:"ClientRecord", statusBarStyle:"black-translucent" },
  icons: {
    icon: "/brand/clientrecord-icon.png",
    shortcut: "/brand/clientrecord-icon.png",
    apple: "/brand/clientrecord-icon.png",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}<Script id="clientrecord-pwa" strategy="afterInteractive">{`if('serviceWorker' in navigator){navigator.serviceWorker.register('/sw.js').catch(()=>{})}`}</Script></body>
    </html>
  );
}
