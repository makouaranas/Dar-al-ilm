import type { NextConfig } from "next";

// Static export: FastAPI serves frontend/out/ on 127.0.0.1:8000 (docs/ARCHITECTURE.md section 1).
const nextConfig: NextConfig = {
  output: "export",
  // dev/reader -> dev/reader/index.html, which FastAPI's static files serve directly.
  trailingSlash: true,
  images: { unoptimized: true },
  reactStrictMode: true,
  poweredByHeader: false,
  // `next dev` would otherwise write its own frontend/AGENTS.md; the project's agent contract is
  // the root AGENTS.md.
  agentRules: false,
};

export default nextConfig;
