# cesium-gpu-points-layer

A lightweight Cesium helper for rendering **massive counts of 2D points** using GPU point sprites and packed textures.

The intent is to provide a performant alternative to Cesium billboards when you need to display many
static or animated points (aircraft, ships, markers, etc.) with simple per-point metadata.

## Why this approach

Billboard primitives are convenient but can be heavy when rendering very large point sets.
This module uses:

- single float textures for point attributes,
- GPU packing for fast upload and updates,
- optional motion extrapolation,
- optional sprite rotation,
- configurable draw order and per-layer uniforms.

That makes it a practical default for dense telemetry-style data layers.

## Install

```bash
npm install cesium-gpu-points-layer
```

## Quick start

```ts
import * as Cesium from 'cesium';
import { GpuPointLayer, type BasePointRecord } from 'cesium-gpu-points-layer';

const layer = new GpuPointLayer<BasePointRecord>([], {
  name: 'ExampleLayer',
  textureName: 'example',
  sprite: {
    url: '/sprites/point.svg',
    width: 64,
    height: 64,
    resolution: 2,
  },
  pointScale: 40_000_000,
  minPointSize: 20,
  maxPointSize: 120,
  drawOrder: 1,
});

const points: BasePointRecord[] = [
  {
    id: 'p-1',
    longitude: -122.41,
    latitude: 37.78,
    altitudeMeters: 1000,
    headingRadians: 1.0,
    speedMetersPerSecond: 120,
  },
];

layer.setRecords(points);
viewer.scene.primitives.add(layer.primitive);
```

## API surface

Exports include:

- `GpuPointLayer`
- `CesiumPointTextureLayer` (low-level wrapper)
- `CesiumGpuPointLayer` (backward-compatible alias)
- `BasePointRecord`
- `DEFAULT_POINT_*` constants
- shader/helper exports (`buildPointShaders`, etc.)

## Notes

- Rotation is optional via `rotationEnabled`.
- Animation is optional via `enableAnimation` (driven by `speedMetersPerSecond` and `headingRadians`).
- The library is intentionally response-agnostic; preprocess your backend payload in app code.
