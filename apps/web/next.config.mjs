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
};

export default nextConfig;
