import type { NextConfig } from "next";

const buildCpus = Number(process.env.SL_BUILD_CPUS || 0);

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // the deploy scripts limit build workers on small servers so the live site stays responsive while updating
  ...(buildCpus > 0 ? { experimental: { cpus: buildCpus } } : {}),
  // a server build (the deploy scripts set SL_BUILD_CPUS) skips the type check: it is the slowest, most
  // memory-hungry step on a 1.6 GB server, and CI already type-checks every commit (`tsc --noEmit`)
  ...(buildCpus > 0 ? { typescript: { ignoreBuildErrors: true } } : {}),
};

export default nextConfig;
