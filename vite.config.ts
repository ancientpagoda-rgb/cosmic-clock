import { defineConfig } from 'vite'

// For GitHub Pages, Vite needs the correct base path.
// This repo assumes it will be deployed at https://<user>.github.io/cosmic-clock/
export default defineConfig({
  base: '/cosmic-clock/',
})
