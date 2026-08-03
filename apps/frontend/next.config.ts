import type { NextConfig } from "next";
import { resolvePublicApiUrl } from "./src/lib/public-api-url";

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
  }
};

export default nextConfig;
