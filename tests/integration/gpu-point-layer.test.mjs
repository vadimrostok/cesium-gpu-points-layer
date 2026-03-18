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

    const eastboundPoint = /** @type {any} */ (
      internal.pointLayer.descriptor.prepareRecord({
        id: 'eastbound',
        longitude: 1,
        latitude: 1,
        headingRadians: 0,
        speedMetersPerSecond: 10,
      })
    );
    assert.ok(eastboundPoint);
    assert.ok(eastboundPoint.directionX > 0.99);
    assert.ok(Math.abs(eastboundPoint.directionY) < 1e-12);
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
        alignWithGround: true,
      },
    );

    const internal = /** @type {{ pointLayer: any }} */ (layer);
    const pointLayer = internal.pointLayer;

    assert.equal(layer.drawOrder, 7);
    assert.equal(pointLayer.hasMotionTexture, false);
    assert.equal(pointLayer.rotationEnabled, false);
    assert.equal(pointLayer.descriptor.options.alignWithGround, true);

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

test('depthTest option propagates to render state', () => {
  const originalRenderStateFromCache = Cesium.RenderState.fromCache;
  const renderStateArgs = [];
  Cesium.RenderState.fromCache = (params) => {
    renderStateArgs.push(params);
    return {};
  };

  try {
    const defaultLayer = new GpuPointLayer([{ id: 'p1', longitude: 0, latitude: 0 }], {
      name: 'depth-default',
      textureName: 'plane',
      sprite,
    });
    const depthEnabledLayer = new GpuPointLayer(
      [{ id: 'p2', longitude: 1, latitude: 1 }],
      {
        name: 'depth-enabled',
        textureName: 'ship',
        sprite,
        depthTest: false,
      },
    );

    assert.equal(renderStateArgs[0].depthTest.enabled, true);
    assert.equal(renderStateArgs[1].depthTest.enabled, false);

    defaultLayer.destroy();
    depthEnabledLayer.destroy();
  } finally {
    Cesium.RenderState.fromCache = originalRenderStateFromCache;
  }
});

test('depthTest=true skips camera-direction-only rebuild work', () => {
  const originalRenderStateFromCache = Cesium.RenderState.fromCache;
  Cesium.RenderState.fromCache = () => ({});
  let layer;
  let pointLayer;
  try {
    layer = new GpuPointLayer(
      [
        { id: 'p1', longitude: 0, latitude: 0 },
        { id: 'p2', longitude: 1, latitude: 1 },
      ],
      {
        name: 'depth-camera-filter',
        textureName: 'plane',
        sprite,
        depthTest: true,
      },
    );
    const internal = /** @type {{ pointLayer: any }} */ (layer);
    pointLayer = internal.pointLayer;

    const originalRebuildVisiblePoints = pointLayer.rebuildVisiblePoints.bind(pointLayer);
    let rebuildCalls = 0;
    pointLayer.rebuildVisiblePoints = (cameraDirection) => {
      rebuildCalls += 1;
      originalRebuildVisiblePoints(cameraDirection);
    };

    const originalUploadMainTextures = pointLayer.uploadMainTextures.bind(pointLayer);
    const originalUploadSpriteTexture = pointLayer.uploadSpriteTexture.bind(pointLayer);
    const originalEnsureResources = pointLayer.ensureResources.bind(pointLayer);
    pointLayer.uploadMainTextures = () => {
      return;
    };
    pointLayer.uploadSpriteTexture = () => {
      return;
    };
    pointLayer.ensureResources = () => {
      return;
    };

    const frameStateA = {
      passes: { render: true },
      mode: Cesium.SceneMode.SCENE3D,
      camera: { positionWC: new Cesium.Cartesian3(7_000_000, 0, 0) },
      context: {},
      commandList: [],
    };

    const frameStateB = {
      passes: { render: true },
      mode: Cesium.SceneMode.SCENE3D,
      camera: { positionWC: new Cesium.Cartesian3(0, 0, 7_000_000) },
      context: {},
      commandList: [],
    };

    pointLayer.update(frameStateA);
    assert.equal(rebuildCalls, 1);

    pointLayer.visibleCount = 0;
    pointLayer.update(frameStateB);
    assert.equal(rebuildCalls, 1);

    pointLayer.rebuildVisiblePoints = originalRebuildVisiblePoints;
    pointLayer.uploadMainTextures = originalUploadMainTextures;
    pointLayer.uploadSpriteTexture = originalUploadSpriteTexture;
    pointLayer.ensureResources = originalEnsureResources;
  } finally {
    Cesium.RenderState.fromCache = originalRenderStateFromCache;
    if (layer && pointLayer) {
      layer.destroy();
    }
  }
});
