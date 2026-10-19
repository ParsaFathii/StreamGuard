import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Providers } from "@/components/streamguard/providers";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "StreamGuard Console",
  description:
    "StreamGuard — real-time event processing, security analytics and AI-assisted incident investigation. Demo edition (simulator data).",
  applicationName: "StreamGuard Console",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      { url: "/icons/icon-16.png", sizes: "16x16", type: "image/png" },
      { url: "/icons/icon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: "/icons/apple-touch-icon.png",
  },
  openGraph: {
    title: "StreamGuard Console",
    description:
      "Real-time event processing, security analytics and AI-assisted incident investigation.",
    type: "website",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "StreamGuard Console" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "StreamGuard Console",
    description:
      "Real-time event processing, security analytics and AI-assisted incident investigation.",
    images: ["/og.png"],
  },
};

export const viewport: Viewport = {
  themeColor: "#0A0E0D",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" dir="ltr" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
