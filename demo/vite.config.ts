import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';

const demoRoot = dirname(fileURLToPath(import.meta.url));

export default defineConfig(() => {
  const envBase = process.env.VITE_PAGES_BASE_PATH?.trim();
  const base = envBase ?? '/';
  const sanitizedBase = base.endsWith('/') ? base : `${base}/`;

  return {
    root: demoRoot,
    base: sanitizedBase,
    plugins: [
      viteStaticCopy({
        targets: [
          {
            src: '../node_modules/cesium/Build/Cesium/Workers',
            dest: 'cesium',
          },
          {
            src: '../node_modules/cesium/Build/Cesium/Assets',
            dest: 'cesium',
          },
          {
            src: '../node_modules/cesium/Build/Cesium/ThirdParty',
            dest: 'cesium',
          },
          {
            src: '../node_modules/cesium/Build/Cesium/Widgets',
            dest: 'cesium',
          },
        ],
      }),
    ],
    define: {
      CESIUM_BASE_URL: JSON.stringify(`${sanitizedBase}cesium`),
    },
  };
});
