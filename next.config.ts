import type { NextConfig } from "next";

// The console is a static export; the API is server/main.ts (an Effect HTTP server).
const nextConfig: NextConfig = {
  output: "export",
  poweredByHeader: false,
};

export default nextConfig;
