import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  root: '.',
  base: './',
  resolve: {
    alias: {
      // 让组件内 import from '../../shared/types' 能正确解析
      '../shared': path.resolve(__dirname, '../shared'),
    },
  },
  server: {
    port: 5174,
    open: true,
  },
})
