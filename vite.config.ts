import { defineConfig } from 'vitest/config';

// BASE_PATH nastavuje workflow pro GitHub Pages (např. /gg/). Lokálně je "/".
export default defineConfig({
  base: process.env.BASE_PATH ?? '/',
  optimizeDeps: {
    include: ['maplibre-gl', 'mapillary-js', '@mapbox/vector-tile', 'pbf'],
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
  },
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.ts'],
  },
});
