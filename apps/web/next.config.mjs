/** @type {import('next').NextConfig} */
const nextConfig = {
  // Workspace packages ship raw TypeScript; Next compiles them with the app.
  transpilePackages: ["@seo/db", "@seo/shared", "@seo/playbook"],

  experimental: {
    serverActions: { bodySizeLimit: "4mb" },
  },

  images: {
    remotePatterns: [
      { protocol: "https", hostname: "*.public.blob.vercel-storage.com" },
    ],
  },

  webpack: (config) => {
    // The workspace packages use ESM-correct `./foo.js` specifiers that point
    // at `./foo.ts` sources. TypeScript and tsx resolve those natively;
    // webpack needs to be told.
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      ".js": [".ts", ".tsx", ".js"],
    };
    return config;
  },

  turbopack: {
    resolveExtensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".json"],
  },
};

export default nextConfig;
