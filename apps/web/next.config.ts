import type { NextConfig } from 'next';

// Static security headers. The per-request CSP (with a script nonce) is set in
// src/middleware.ts so Next can attach the nonce to its own scripts.
const SECURITY_HEADERS = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'no-referrer' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
  { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
];

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ['@belflow/sdk', '@belflow/x402'],
  async headers() {
    // Proof and checkout pages show disclosed amounts: never cache them.
    const noStore = [{ key: 'Cache-Control', value: 'no-store, private' }];
    return [
      { source: '/:path*', headers: SECURITY_HEADERS },
      { source: '/verify/:path*', headers: noStore },
      { source: '/pay/:path*', headers: noStore },
    ];
  },
};

export default config;
