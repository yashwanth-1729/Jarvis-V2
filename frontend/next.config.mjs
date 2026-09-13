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

  // Lets webpack resolve imports that reach outside this project directory --
  // specifically `src/lib/sldtRemote.ts` importing `jarvis-oss/sldt/src/`,
  // a sibling package this same repo (not node_modules) holds for the
  // open-source variant's sync engine. Off by default in Next, since it's
  // normally a sign of an accidental monorepo path; here it's deliberate and
  // the only thing crossing the boundary is that one file. Everything else
  // about this build is unaffected.
  experimental: {
    externalDir: true,
  },

  // jarvis-oss/sldt is authored as standard ESM TypeScript: its own relative
  // imports end in ".js" (e.g. `from "./errors.js"`) pointing at ".ts" source
  // files -- the normal convention for a package meant to run directly under
  // Node's ESM loader or tsx without a build step, and it needs to stay that
  // way for its own toolchain. Webpack's resolver doesn't know that
  // convention out of the box (it looks for a literal errors.js), so
  // `resolve.extensionAlias` teaches it: try the .ts source when a ".js"
  // specifier doesn't exist. Scoped to extension resolution only -- nothing
  // about the app's own source resolution changes.
  webpack(config) {
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      ".js": [".ts", ".tsx", ".js"],
    };
    return config;
  },

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
