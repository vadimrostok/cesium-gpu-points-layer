import assert from 'node:assert/strict';
import test from 'node:test';

import * as lib from '../../dist/index.js';

test('library exports all primary public APIs', () => {
  assert.equal(typeof lib.GpuPointLayer, 'function');
  assert.equal(typeof lib.CesiumPointTextureLayer, 'function');
  assert.equal(typeof lib.CesiumGpuPointLayer, 'function');
  assert.equal(typeof lib.computePointTextureLayout, 'function');
  assert.equal(typeof lib.buildPointShaders, 'function');
  assert.equal(typeof lib.packPointsIntoFloatTexture, 'function');
  assert.equal(typeof lib.normalizeTextureName, 'function');
  assert.equal(typeof lib.resolveShaderConfig, 'function');
  assert.equal(typeof lib.DEFAULT_POINT_SCALE, 'number');
  assert.equal(typeof lib.DEFAULT_POINT_ALTITUDE_METERS, 'number');
});
