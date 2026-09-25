import type { NextConfig } from "next";

// Site-wide hardening headers. vinext applies these to every App Router response (pages and API routes)
// without overwriting headers a route already set, so document downloads keep their stricter CSP.
// No script-src/default-src: the app relies on inline RSC scripts. Field capture uses camera, mic and location.
const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Permissions-Policy", value: "camera=(self), microphone=(self), geolocation=(self)" },
];

const nextConfig: NextConfig = {
  async headers() {
    // "/(.*)" rather than "/:path*": vinext's matcher does not match "/" with "/:path*".
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
};

export default nextConfig;
