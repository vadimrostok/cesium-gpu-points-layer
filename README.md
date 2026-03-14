# cesium-gpu-points-layer

High-performance Cesium point rendering for dense clouds of markers using GPU point sprites and packed float textures.

This library is designed for telemetry-like workloads: thousands to millions of points with lightweight per-point metadata, optional rotation, and optional motion extrapolation.

It is a reusable extraction from a production Cesium demo and focuses on one goal:

**reduce per-frame CPU overhead and avoid expensive Cesium billboard entity overhead for large point sets.**

## Why this exists

`Cesium.BillboardCollection`/`Entity` workflows are convenient but become expensive when:

- point counts are very large (tens/hundreds of thousands),
- points update frequently,
- you need predictable per-frame GPU work instead of growing JS object churn.

This library keeps data in texture memory and updates only GPU textures + uniforms, letting Cesium submit a single primitive for each layer.

## Package layout

- `GpuPointLayer` / `CesiumGpuPointLayer`
  - public entry point with record preparation, packing hooks, and ready-to-add Cesium primitive.
- `CesiumPointTextureLayer`
  - lower-level primitive wrapper around draw-command/texture/pipeline internals.
- `src/shaders/point-shaders.ts`
  - GLSL builder functions for WebGL1/WebGL2 paths.
- `src/cpu-pipeline`
  - CPU-side packing helpers, viewport/visibility helpers, and shader-config defaults.
- `src/types.ts`
  - shared API contracts and public types.

## How it works (low-level)

1. **Prepare input records**
   - `BasePointRecord` is the required minimum input contract.
   - `GpuPointLayer` converts each record into an internal prepared record with:
     - normalized world direction vector (`directionFromEarthCenter`)
     - optional speed components (`speedMetersPerSecond`, `directionX`, `directionY`)
     - defaulted altitude/heading values when optional fields are missing.

2. **Pack into float textures**
   - Point attributes are packed into an RGBA float texture:
     - `R`: longitude
     - `G`: latitude
     - `B`: altitude (meters)
     - `A`: heading (radians)
   - One float texture for all points means a single draw primitive can represent many points.
   - A second motion texture is optionally allocated when animation is enabled:
     - `R`: speed (m/s)
     - `G`: direction X
     - `B`: direction Y
     - `A`: anchor timestamp seconds

3. **Visibility and culling**
   - Optional per-frame visibility filtering uses camera direction + precomputed normalized Earth direction vectors.
   - `cullDotThreshold` controls hemisphere/backface visibility cut.

4. **Shader path**
   - Vertex shader reads point attributes from packed texture by index (WebGL1 and WebGL2 variants).
   - Optional motion path computes extrapolated geographic position when speed/time data exists.
   - Fragment shader samples the provided sprite texture and applies optional rotation.

5. **Runtime updates**
   - GPU upload includes:
     - data texture update each frame only when visibility/records changed,
     - sprite texture upload on sprite/source changes,
     - draw command submit with uniforms for camera-scaled point size.

## Installation

```bash
npm install cesium-gpu-points-layer
```

## Quick start

```ts
import * as Cesium from 'cesium';
import {
  GpuPointLayer,
  type BasePointRecord,
} from 'cesium-gpu-points-layer';

const sprite = {
  width: 64,
  height: 64,
  pixels: new Uint8Array([
    255, 255, 255, 255,
    255, 255, 255, 255,
    255, 255, 255, 255,
    255, 255, 255, 255,
  ]),
};

const points: BasePointRecord[] = [
  {
    id: 'ship-1',
    longitude: -122.4,
    latitude: 37.8,
    altitudeMeters: 10_000,
    headingRadians: 1.3,
    speedMetersPerSecond: 120,
  },
  {
    id: 'marker-2',
    longitude: -122.5,
    latitude: 37.82,
  },
];

const layer = new GpuPointLayer(points, {
  name: 'ships',
  textureName: 'ships',
  sprite,
  pointScale: 40_000_000,
  minPointSize: 16,
  maxPointSize: 96,
  drawOrder: 10,
  rotationEnabled: true,
  enableAnimation: true,
});

viewer.scene.primitives.add(layer.primitive);
```

## API reference (important)

### `GpuPointLayer<TPoint extends BasePointRecord>`

High-level layer wrapper:

- `constructor(points = [], options)`
- `setRecords(points)` updates and reparses records
- `setVisiblePointIds(ids | null)` filters visible IDs without rebuilding inputs
- `setSprite(spriteRasterized)` sets a pre-rasterized sprite atlas
- `destroy()`

`drawOrder`:

- Lower values draw earlier.
- Use it to order dense groups when depth test is disabled (e.g., earthquakes → ships → planes).

#### `GpuPointLayerOptions`

| prop | type | default | meaning |
| --- | --- | --- | --- |
| `name` | `string` | `GpuPointLayer` | Layer name |
| `textureName` | `string` | derived from `name` | Prefix for generated uniform names |
| `sprite` | `SpriteTextureAtlas \| PointLayerSpriteSource` | required | Atlas bytes (`width`, `height`, `pixels`) or remote URL source |
| `pointScale` | `number` | `40_000_000` | Controls pixel-size falloff with distance |
| `minPointSize` | `number` | `30` | Minimum rendered symbol size in pixels |
| `maxPointSize` | `number` | `128` | Maximum rendered symbol size in pixels |
| `maxExtrapolationSeconds` | `number` | one-year | Clamp for motion extrapolation |
| `cullDotThreshold` | `number` | `0.5` | Hemisphere culling threshold |
| `rotationEnabled` | `boolean` | `true` | Enable per-point sprite rotation |
| `headingOffsetRadians` | `number` | `0` | Constant heading offset added in shader |
| `enableAnimation` | `boolean` | `true` | Enables speed-based extrapolation path |
| `defaultAltitudeMeters` | `number` | `10` | Used when input records do not provide altitude |
| `defaultHeadingRadians` | `number` | `0` | Used when heading is missing |
| `drawOrder` | `number` | `0` | Primitive ordering for same scene without depth test |
| `shaderConfig` | `Partial<GpuPointLayerShaderConfig>` | internal defaults | Override uniform names |

### `CesiumPointTextureLayer<TInput, TPrepared>`

Lower-level renderer that `GpuPointLayer` uses internally. Useful if you need full control over descriptor hooks.

- `setRecords(points)`
- `setVisiblePointIds(ids | null)`
- `setSprite(atlas)`
- `setSpriteSource(spriteSource)`
- `update(frameState)`
- `destroy()`

### Helpers

### `computePointTextureLayout(capacity): PointTextureLayout`
Computes compact texture dimensions that fit at least `capacity` points.

### `packPointsIntoFloatTexture(points, previousData, previousLayout, writePoint)`
Reusable packing helper to avoid reallocation when capacity is unchanged.

### `filterPointsForVisibleHemisphere(points, cameraDirection)`
Filters points in front hemisphere.

### `isPointInVisibleHemisphere(point, cameraDirection)`
Single-point hemisphere predicate.

### Shader builders

- `buildPointShaders(config)`
- `buildPointVertexShaderWebGL1/2(config)`
- `buildPointFragmentShaderWebGL1/2(spriteTextureUniform?)`

### Defaults and constants

- `DEFAULT_POINT_SCALE`
- `DEFAULT_MIN_POINT_SIZE`
- `DEFAULT_MAX_POINT_SIZE`
- `DEFAULT_MAX_EXTRAPOLATION_SECONDS`
- `DEFAULT_POINT_ALTITUDE_METERS`
- `DEFAULT_POINT_HEADING_RADIANS`
- `DEFAULT_POINT_CULL_DOT_THRESHOLD`

### Types and contracts

- `BasePointRecord`
- `PreparedPointRecord`
- `PointLayerSpriteSource`
- `SpriteTextureAtlas`
- `PointTextureLayout`
- `PackedPointTexture`
- `GpuPointLayerShaderConfig`
- `CesiumGpuPointLayerDescriptor`
- `CesiumGpuPointLayerUniforms`
- `CesiumGpuPointLayerShaderBuildInput`

## Testing

- `npm run test` runs TypeScript build and all unit + integration tests.
- `npm run test:unit` isolates utility helpers and shader generation tests.
- `npm run test:integration` validates layer integration with prepared records and runtime behavior.

## Compatibility notes

- `CesiumGpuPointLayer` is exported as a compatibility alias for older internal names.
- The library targets modern Node/ESM for package consumers and `Cesium` as a peer dependency.
- Public API preserves the same external shape as the previous monolith while improving maintainability.

## Use cases

This module is most beneficial for:

- dense aircraft/ship/marker maps,
- simulated telemetry overlays,
- repeated per-frame updates where full entity objects are too heavy,
- any scenario where you need stable frame-time with huge point sets.
