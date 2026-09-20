import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  serverExternalPackages: ["@compootor/effective-jev", "drizzle-orm"],
};

export default nextConfig;
