import type { NextConfig } from "next";

const buildCpus = Number(process.env.SL_BUILD_CPUS || 0);

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // the deploy scripts limit build workers on small servers so the live site stays responsive while updating
  ...(buildCpus > 0 ? { experimental: { cpus: buildCpus } } : {}),
};

export default nextConfig;
