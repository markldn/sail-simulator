import { defineConfig } from 'vite';

/**
 * Vite configuration.
 *
 * Notes:
 * - We use `@dimforge/rapier3d-compat`, which ships its WASM blob embedded as
 *   base64 inside the JS bundle. That means NO wasm/top-level-await plugins
 *   are required — it "just works" with Vite dev and build. The trade-off is
 *   a slightly larger bundle; we can switch to the plain `rapier3d` package
 *   (+ vite-plugin-wasm) later if load size becomes a concern.
 * - `target: 'esnext'` keeps modern output (async/await untouched, smaller).
 */
export default defineConfig({
  build: {
    target: 'esnext',
    // Rapier's embedded WASM makes the vendor chunk big; raise the warning
    // threshold so builds stay quiet. Not a functional setting.
    chunkSizeWarningLimit: 4000,
  },
  server: {
    host: true, // expose on LAN so it can be tested from other devices
    open: false,
  },
});
