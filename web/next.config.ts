import type { NextConfig } from "next";

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
];

const nextConfig: NextConfig = {
  output: "standalone",
  /* config options here */
  typescript: {
    // tsc is clean for the app tree; CI additionally runs a dedicated
    // typecheck job. Fail the build on type errors instead of ignoring them.
    ignoreBuildErrors: false,
  },
  reactStrictMode: false,
  // The floating dev-tools indicator covers the bottom-left tab-bar "More"
  // button in FA (RTL) mobile layouts during `next dev` — disable it.
  devIndicators: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
