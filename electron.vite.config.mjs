import { builtinModules } from 'node:module';
import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import { build as viteBuild } from 'vite';

const NODE_BUILTINS = new Set([...builtinModules, ...builtinModules.map((mod) => `node:${mod}`)]);

function bundleStandaloneScannerPlugin() {
  return {
    name: 'bundle-standalone-scanner',
    apply: 'build',
    async closeBundle() {
      await viteBuild({
        configFile: false,
        logLevel: 'info',
        build: {
          outDir: resolve('out/scanner'),
          emptyOutDir: true,
          ssr: true,
          target: 'node22',
          minify: false,
          rollupOptions: {
            input: resolve('src/scanner/scanner.mjs'),
            external: (id) => id.startsWith('node:') || NODE_BUILTINS.has(id),
            output: {
              format: 'es',
              entryFileNames: 'scanner.mjs',
            },
          },
        },
      });
    },
  };
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin(), bundleStandaloneScannerPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/main/index.js'),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/preload/index.js'),
        },
        output: {
          // Zwingend CommonJS, weil BrowserWindow mit sandbox: true läuft
          format: 'cjs',
        },
      },
    },
  },
  renderer: {
    root: resolve('src/renderer'),
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
        },
      },
    },
  },
});
