import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'fs'
import path from 'path'

// Read the key fresh from .env.local on every request — no restart needed when it changes
function getAnthropicKey() {
  try {
    const envPath = path.resolve(process.cwd(), '.env.local')
    const content = fs.readFileSync(envPath, 'utf-8')
    const match = content.match(/^ANTHROPIC_API_KEY=(.+)$/m)
    return match ? match[1].trim() : ''
  } catch {
    return ''
  }
}

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api/anthropic': {
        target: 'https://api.anthropic.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/anthropic/, ''),
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            const key = getAnthropicKey()
            // Strip any client-sent key, inject the real one from disk
            proxyReq.setHeader('x-api-key', key)
            proxyReq.setHeader('anthropic-version', '2023-06-01')
          })
        },
      },
    },
  },
})
