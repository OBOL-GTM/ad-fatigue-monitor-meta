import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { cookies } from "next/headers";
import { auth } from "@/lib/auth";
import { getSessionOrPublic } from "@/lib/sessionOrPublic";
import SidebarLayout from "@/components/SidebarLayout";
import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
});

export const metadata: Metadata = {
  title: "OD",
  description: "Your source of truth for ad performance, fatigue detection, and lead analytics",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // App is open-access (no login required). Determine if user has a real
  // auth session for UI hints (e.g. showing logout vs login button).
  const session = await getSessionOrPublic();
  const realAuth = await auth();
  const isPublic = !realAuth;

  return (
    <html
      lang="en"
      className={`${inter.variable} h-full antialiased`}
    >
      <body className="min-h-full">
        <SidebarLayout isPublic={isPublic}>{children}</SidebarLayout>
      </body>
    </html>
  );
}
