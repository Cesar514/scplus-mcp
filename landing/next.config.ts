// summary: Defines Next.js build and runtime configuration for the scplus landing site.
// FEATURE: Landing application build settings for the marketing frontend.
// inputs: Next.js build-time environment and framework configuration hooks.
// outputs: Exported Next.js configuration for the landing application.
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    optimizePackageImports: ["@mui/material", "@mui/icons-material"],
  },
};

export default nextConfig;
