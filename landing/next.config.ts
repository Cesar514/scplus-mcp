// Next.js application configuration for the Context+ landing site.
// FEATURE: Landing application build settings for the marketing frontend.
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    optimizePackageImports: ["@mui/material", "@mui/icons-material"],
  },
};

export default nextConfig;
