import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@atlas/shared", "@atlas/ui"],
  typedRoutes: true
};

export default nextConfig;
