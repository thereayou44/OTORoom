import { defineConfig } from 'vite';
import { resolve } from 'path';

// Собираем один самодостаточный файл в формате IIFE: его можно подключить
// обычным <script> из room.html, никаких модулей и импортов в браузере.
// Всё, что нужно снаружи, кладётся в window.OTO.
export default defineConfig({
  build: {
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      name: 'OTO',
      formats: ['iife'],
      fileName: () => 'oto-collab.js',
    },
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2020',
    cssCodeSplit: false,
  },
});
