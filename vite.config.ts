import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

const developmentHumanCapability = process.env.SINAPSIS_DEV_HUMAN_CAPABILITY?.trim()

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:4174',
        changeOrigin: true,
        configure(proxy) {
          proxy.on('proxyReq', (request) => {
            if (developmentHumanCapability) request.setHeader('x-sinapsis-human-capability', developmentHumanCapability)
          })
        },
      },
      '/events': 'http://127.0.0.1:4174',
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
    globals: true,
  },
})
