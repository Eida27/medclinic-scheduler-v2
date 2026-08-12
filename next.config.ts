import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["dejavu-fonts-ttf", "pdfkit"],
  outputFileTracingRoot: process.cwd(),
  turbopack: { root: process.cwd() },
};

export default nextConfig;
