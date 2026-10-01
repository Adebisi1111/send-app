import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  // relative base so the app works when served from a subpath (GitHub Pages)
  base: './',
  plugins: [react()],
})
