import type { NextConfig } from "next";
import { resolvePublicApiUrl } from "./src/lib/resolve-public-api-url";

/**
 * Development convenience: allow a localhost API origin when the root .env omits
 * NEXT_PUBLIC_API_URL. Production builds must supply a public https origin and fail closed.
 */
if (process.env.NODE_ENV !== "production" && !process.env.NEXT_PUBLIC_API_URL?.trim()) {
  process.env.NEXT_PUBLIC_API_URL = "http://localhost:4000";
}

const nextPublicApiUrl = resolvePublicApiUrl({
  explicit: true,
  nextPublicApiUrl: process.env.NEXT_PUBLIC_API_URL,
  nodeEnv: process.env.NODE_ENV
});

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@atlas/shared", "@atlas/ui"],
  typedRoutes: true,
  env: {
    NEXT_PUBLIC_API_URL: nextPublicApiUrl
  },
  async headers() {
    // Same-origin media proxy: allow img/video/audio from 'self' + blob: (recordings).
    // Do not allow private MinIO / localhost origins.
    const apiOrigin = new URL(nextPublicApiUrl);
    const wsOrigin = `${apiOrigin.protocol === "https:" ? "wss" : "ws"}://${apiOrigin.host}`;
    const csp = [
      "default-src 'self'",
      "img-src 'self' data: blob:",
      "media-src 'self' blob:",
      `connect-src 'self' ${nextPublicApiUrl} ${wsOrigin}`,
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "font-src 'self' data:",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'"
    ].join("; ");
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "X-Content-Type-Options", value: "nosniff" }
        ]
      }
    ];
  }
};

export default nextConfig;
