/**
 * Two build targets from one codebase.
 *
 * The default `next build` is unchanged — server-rendered, deployed as usual.
 * Setting `JARVIS_NATIVE=1` switches to a fully static export instead, which is
 * what the packaged apps need: Capacitor and Tauri both serve plain files from
 * inside the bundle and have no Node server to render on.
 *
 * Gating it on an env var rather than switching the default keeps the web build
 * exactly as it was. A static export silently disables server features, so
 * making it unconditional would be a quiet downgrade for the browser app.
 */

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  ...(process.env.JARVIS_NATIVE === "1"
    ? {
        output: "export",
        // The export has no server, so there is nothing to optimise images on
        // the fly; without this the build fails rather than degrading.
        images: { unoptimized: true },
        // Capacitor and Tauri load from the filesystem, where `/route` does not
        // resolve but `/route/index.html` does.
        trailingSlash: true,
      }
    : {}),
};

export default nextConfig;
