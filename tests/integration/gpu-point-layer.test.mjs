import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';

import { GpuPointLayer } from '../../dist/index.js';

const sprite = {
  width: 2,
  height: 2,
  pixels: new Uint8Array([255, 255, 255, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
};

test('GpuPointLayer normalizes missing optional fields into defaults', () => {
  const originalRenderStateFromCache = Cesium.RenderState.fromCache;
  Cesium.RenderState.fromCache = () => ({});
  try {
    const layer = new GpuPointLayer(
      [
        { id: 'no-extra', longitude: 0, latitude: 0 },
        {
          id: 'with-motion',
          longitude: 1,
          latitude: 1,
          headingRadians: Math.PI / 2,
          speedMetersPerSecond: 10,
        },
        { id: 'invalid', longitude: Number.NaN, latitude: 0, altitudeMeters: 0 },
      ],
      {
        name: 'integration-base',
        textureName: 'plane',
        sprite,
      },
    );

    const internal = /** @type {{ pointLayer: any }} */ (layer);
    const pointLayer = internal.pointLayer;

    assert.equal(layer.drawOrder, 0);
    assert.equal(pointLayer.allPoints.length, 2);

    const noMotionPoint = pointLayer.allPoints.find((point) => point.id === 'no-extra');
    assert.ok(noMotionPoint);
    assert.equal(noMotionPoint.altitudeMeters, 10);
    assert.equal(noMotionPoint.headingRadians, 0);
    assert.ok(Math.abs(noMotionPoint.directionX) < 1e-12);
    assert.equal(noMotionPoint.directionY, 0);

    const withMotionPoint = pointLayer.allPoints.find((point) => point.id === 'with-motion');
    assert.ok(withMotionPoint);
    assert.ok(Math.abs(withMotionPoint.directionX) < 1e-12);
    assert.ok(withMotionPoint.directionY > 0.99);
    assert.equal(withMotionPoint.directionFromEarthCenter instanceof Cesium.Cartesian3, true);

    layer.destroy();
  } finally {
    Cesium.RenderState.fromCache = originalRenderStateFromCache;
  }
});

test('draw order and motion/rotation config propagate to internal layer', () => {
  const originalRenderStateFromCache = Cesium.RenderState.fromCache;
  Cesium.RenderState.fromCache = () => ({});
  try {
    const layer = new GpuPointLayer(
      [{ id: 'p1', longitude: 0, latitude: 0 }],
      {
        name: 'ordered-layer',
        textureName: 'ship',
        sprite,
        drawOrder: 7,
        enableAnimation: false,
        rotationEnabled: false,
      },
    );

    const internal = /** @type {{ pointLayer: any }} */ (layer);
    const pointLayer = internal.pointLayer;

    assert.equal(layer.drawOrder, 7);
    assert.equal(pointLayer.hasMotionTexture, false);
    assert.equal(pointLayer.rotationEnabled, false);

    layer.setVisiblePointIds(['p1']);
    assert.equal(pointLayer.visiblePointIds?.size, 1);

    const nextSprite = {
      width: 1,
      height: 1,
      pixels: new Uint8Array([10, 20, 30, 40]),
    };
    layer.setSprite(nextSprite);
    assert.equal(pointLayer.spriteTextureData.width, 1);
    assert.equal(pointLayer.spriteTextureData.height, 1);
    assert.deepEqual(
      Array.from(pointLayer.spriteTextureData.pixels),
      Array.from(nextSprite.pixels),
    );

    layer.destroy();
  } finally {
    Cesium.RenderState.fromCache = originalRenderStateFromCache;
  }
});
