import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["better-sqlite3"],
  allowedDevOrigins: ["*.trycloudflare.com"],
  async redirects() {
    return [
      { source: "/", destination: "/executive", permanent: false },
      { source: "/login", destination: "/executive", permanent: false },
    ];
  },
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "**.fbcdn.net",
      },
    ],
  },
};

export default nextConfig;
