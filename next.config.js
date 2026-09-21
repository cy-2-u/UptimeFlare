/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async headers() {
    return [
      {
        source: '/',
        headers: [{ key: 'Cache-Control', value: 'private, no-store' }],
      },
      {
        source: '/login',
        headers: [{ key: 'Cache-Control', value: 'private, no-store' }],
      },
      {
        source: '/manage',
        headers: [{ key: 'Cache-Control', value: 'private, no-store' }],
      },
    ]
  },
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'image.thum.io',
      },
      {
        protocol: 'https',
        hostname: '**',
      },
    ],
  },
}

module.exports = nextConfig

if (process.env.NODE_ENV === 'development') {
  const { setupDevPlatform } = require('@cloudflare/next-on-pages/next-dev')
  setupDevPlatform({
    persist: { path: '.wrangler/state/v3' },
  })
}
