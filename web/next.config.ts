import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // No ESLint config in this project; don't let its absence fail `next build`.
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
