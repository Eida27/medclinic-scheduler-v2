import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: { authInterrupts: true },
  serverExternalPackages: ["pdfkit"],
  outputFileTracingRoot: process.cwd(),
  outputFileTracingIncludes: { "/*": ["./node_modules/dejavu-fonts-ttf/ttf/*.ttf"] },
  turbopack: { root: process.cwd() },
};

export default nextConfig;
