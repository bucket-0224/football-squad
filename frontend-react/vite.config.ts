import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // Dev-only bridge: player/team card images (~115MB) still live under
      // frontend/img, served by the vanilla frontend's static server on
      // :8080. Avoids duplicating that directory into this project during
      // the migration — at final cutover, frontend/img is moved (not
      // copied) into this project's public/img instead.
      '/img': 'http://localhost:8080',
    },
  },
})
