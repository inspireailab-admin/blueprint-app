import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
// Wails embeds frontend/dist via go:embed at build time. Keep the build
// output here and stay vanilla — Wails injects its own runtime layer
// into the served HTML at app startup.
export default defineConfig({
    plugins: [react(), tailwindcss()],
});
