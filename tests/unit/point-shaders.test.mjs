import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildPointFragmentShaderWebGL1,
  buildPointFragmentShaderWebGL2,
  buildPointShaders,
  buildPointVertexShaderWebGL1,
  buildPointVertexShaderWebGL2,
} from '../../dist/index.js';

test('shader generator emits WebGL1/WebGL2 variants', () => {
  const base = buildPointShaders({
    attributeName: 'a_index',
    dataTextureUniform: 'u_pointTexture',
    dataTextureDimensionsUniform: 'u_pointTextureDimensions',
    spriteTextureUniform: 'u_spriteTexture',
  });

  assert.ok(base.vertexWebGL1.includes('precision highp float'));
  assert.ok(base.vertexWebGL2.includes('in float a_index'));
  assert.ok(base.fragmentWebGL1.includes('texture2D('));
  assert.ok(base.fragmentWebGL2.includes('texture('));
  assert.equal(base.fragmentWebGL1, buildPointFragmentShaderWebGL1());
  assert.equal(base.fragmentWebGL2, buildPointFragmentShaderWebGL2());
});

test('shader generator supports optional motion extrapolation block', () => {
  const withMotion = buildPointShaders({
    attributeName: 'a_idx',
    dataTextureUniform: 'u_pointData',
    dataTextureDimensionsUniform: 'u_pointDataDimensions',
    spriteTextureUniform: 'u_spriteTexture',
    hasMotionExtrapolation: true,
    motionTextureUniform: 'u_motion',
    nowSecondsUniform: 'u_now',
    maxExtrapolationSecondsUniform: 'u_max',
  });

  const withoutMotion = buildPointShaders({
    attributeName: 'a_idx',
    dataTextureUniform: 'u_pointData',
    dataTextureDimensionsUniform: 'u_pointDataDimensions',
    spriteTextureUniform: 'u_spriteTexture',
    hasMotionExtrapolation: false,
  });

  assert.ok(withMotion.vertexWebGL2.includes('u_motion'));
  assert.ok(withMotion.vertexWebGL2.includes('extrapolatePointCartographic'));
  assert.ok(withMotion.vertexWebGL2.includes('float angularDistance'));
  assert.ok(withMotion.vertexWebGL2.includes('nextNormal'));
  assert.ok(withMotion.vertexWebGL2.includes('normalize(northUnit * motionData.y + eastUnit * motionData.z)'));
  assert.ok(withMotion.vertexWebGL1.includes('float angularDistance'));
  assert.ok(withMotion.vertexWebGL1.includes('nextNormal'));
  assert.ok(withMotion.vertexWebGL1.includes('normalize(northUnit * motionData.y + eastUnit * motionData.z)'));
  assert.ok(!withoutMotion.vertexWebGL2.includes('u_motion'));
  assert.ok(!withoutMotion.vertexWebGL2.includes('extrapolatePointCartographic'));
});
