import type { NextConfig } from "next";

const config: NextConfig = {
  output: "standalone",
  // PDFs de até 50 MB chegam em base64 (+33%) na server action.
  experimental: { serverActions: { bodySizeLimit: "70mb" } },
};

export default config;
