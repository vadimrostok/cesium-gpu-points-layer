import { computePointTextureLayout } from '../dist/index.js';

const layout = computePointTextureLayout(17);
if (!layout || layout.capacity < 17) {
  throw new Error('computePointTextureLayout() returned too-small capacity');
}

console.log('[cesium-gpu-points-layer] smoke ok', layout);
