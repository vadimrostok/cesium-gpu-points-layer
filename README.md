# Cesium GPU points layer

High-performance Cesium marker rendering with rasterized image sprites (2D icons) packed into GPU float textures.

This library is designed for dense marker layers with frequent updates: roughly 50-100k points is a practical target (larger counts may work depending on the device), with optional per-point rotation and optional movement animation.

This was made to provide a lightweight overlay path for dense icon clouds that stays responsive when `Entity`/billboard APIs start to show overhead.

[https://vadimrostok.github.io/cesium-gpu-points-layer-demo/](https://vadimrostok.github.io/cesium-gpu-points-layer-demo/)

![example](https://github.com/user-attachments/assets/d7528977-1602-4528-a1d4-d86778de7e20)

## Why this was made

`Cesium.BillboardCollection`/`Entity` workflows are convenient, but can become expensive when:

- point counts are high (tens/hundreds of thousands),
- data changes every frame or near-real-time,
- marker payloads are mostly fixed metadata with position and direction, not full entity behavior.

The renderer keeps per-marker payload in packed textures and submits one primitive per layer. In practice, the runtime tends to do less per-frame work because updates are focused on compact texture + uniform uploads.

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
   - All rendering inputs are ultimately packed as numeric channels; sprite visuals come from a rasterized image atlas (`SpriteTextureAtlas`).
   - `GpuPointLayer` converts each record into an internal prepared record with:
     - normalized world direction vector (`directionFromEarthCenter`)
     - optional speed components (`speedMetersPerSecond`, `directionX`, `directionY`, where `directionX` is east and `directionY` is north in the local tangent plane)
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
     - `G`: direction X (east)
     - `B`: direction Y (north)
     - `A`: anchor timestamp seconds

3. **Visibility and culling**
   - Optional per-frame visibility filtering uses camera direction + precomputed normalized Earth direction vectors.
   - `cullDotThreshold` controls hemisphere/backface visibility cut.

4. **Shader path**
 - Vertex shader reads point attributes from packed texture by index (WebGL1 and WebGL2 variants).
 - Optional motion path computes extrapolated geographic position when speed/time data exists.
 - Fragment shader samples the provided sprite texture and applies optional rotation.
 - Optional `alignWithGround` derives a local tangent-plane basis from the ellipsoid normal, projects that basis to screen space, and compresses the sprite so near-edge views become a thin line while top-of-view points stay largely unchanged.

5. **Runtime updates**
   - GPU upload includes:
     - data texture updates when visibility or records change,
     - sprite texture upload on sprite/source changes,
     - draw command submission with uniforms for camera-scaled sprite size.

6. **Sprite composition and output**
   - Fragment shader samples the configured sprite atlas texture directly from a texture uniform.
   - Optional motion path projects each marker forward from `speedMetersPerSecond`.
   - Optional `rotationEnabled` rotates sprite samples in shader space so heading is visually respected.

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
| `alignWithGround` | `boolean` | `false` | At glancing angles, compress the sprite along the local ground-horizon axis and keep the rest of the point area transparent for a thin line profile |
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
- See `docs/shader-pipeline.md` for a high-level explanation of the shader setup.

### Defaults and constants

- `DEFAULT_POINT_SCALE`
- `DEFAULT_MIN_POINT_SIZE`
- `DEFAULT_MAX_POINT_SIZE`
- `DEFAULT_MAX_EXTRAPOLATION_SECONDS`
- `DEFAULT_POINT_ALTITUDE_METERS`
- `DEFAULT_POINT_HEADING_RADIANS`
- `DEFAULT_POINT_CULL_DOT_THRESHOLD`

### Types and contracts

### `BasePointRecord`

Minimum input shape accepted by `GpuPointLayer`.

```ts
interface BasePointRecord {
  id: string;
  longitude: number;
  latitude: number;
  altitudeMeters?: number;
  headingRadians?: number;
  speedMetersPerSecond?: number;
}
```

### `PreparedPointRecord`

Prepared record shape used internally by the lower-level renderer after CPU-side preprocessing.

```ts
interface PreparedPointRecord extends BasePointRecord {
  directionFromEarthCenter: Cesium.Cartesian3;
}
```

### `PointLayerSpriteSource`

Remote sprite source definition. The layer rasterizes the image and uploads it as a texture.

```ts
interface PointLayerSpriteSource {
  url: string;
  width?: number;
  height?: number;
  resolution?: number;
}
```

### `SpriteTextureAtlas`

Pre-rasterized sprite bytes ready to upload to the GPU.

```ts
interface SpriteTextureAtlas {
  width: number;
  height: number;
  pixels: Uint8Array;
}
```

### `PointTextureLayout`

Texture dimensions used for packed point data.

```ts
interface PointTextureLayout {
  width: number;
  height: number;
  capacity: number;
}
```

### `PackedPointTexture`

Return shape used by packing helpers.

```ts
interface PackedPointTexture {
  data: Float32Array;
  layout: PointTextureLayout;
  count: number;
}
```

### `GpuPointLayerShaderConfig`

Uniform names used by the generated shaders.

```ts
interface GpuPointLayerShaderConfig {
  dataTextureUniform: string;
  dataTextureDimensionsUniform: string;
  spriteTextureUniform: string;
  motionTextureUniform: string;
  nowSecondsUniform: string;
  maxExtrapolationSecondsUniform: string;
  rotationEnabledUniform: string;
}
```

### `CesiumGpuPointLayerUniforms`

Uniform-name mapping consumed by the low-level Cesium draw-command wrapper.

```ts
interface CesiumGpuPointLayerUniforms {
  dataTexture: string;
  dataTextureDimensions: string;
  motionTexture?: string;
  nowSeconds?: string;
  maxExtrapolationSeconds?: string;
  spriteTexture?: string;
  rotationEnabled?: string;
}
```

### `CesiumGpuPointLayerShaderBuildInput`

Input passed into the shader builder functions.

```ts
interface CesiumGpuPointLayerShaderBuildInput {
  attributeName: string;
  dataTextureUniform: string;
  dataTextureDimensionsUniform: string;
  spriteTextureUniform?: string;
  headingOffsetRadians?: number;
  hasMotionExtrapolation?: boolean;
  motionTextureUniform?: string;
  nowSecondsUniform?: string;
  maxExtrapolationSecondsUniform?: string;
  alignWithGround?: boolean;
}
```

### `CesiumGpuPointLayerDescriptor<TInput, TPrepared>`

Low-level renderer descriptor used by `CesiumPointTextureLayer`.

```ts
interface CesiumGpuPointLayerDescriptor<
  TInput extends BasePointRecord,
  TPrepared extends PreparedPointRecord,
> {
  name: string;
  shaders: CesiumGpuPointLayerShaders;
  uniforms: CesiumGpuPointLayerUniforms;
  indexAttributeName: string;
  indexAttributeLocation: number;
  boundingSphere: Cesium.BoundingSphere;
  prepareRecord: (input: TInput) => TPrepared | null;
  packMainData: (
    record: TPrepared,
    output: Float32Array,
    valueOffset: number,
  ) => void;
  packMotionData?: (
    record: TPrepared,
    output: Float32Array,
    valueOffset: number,
  ) => void;
  cullDotThreshold?: number;
  options?: CesiumGpuPointLayerOptions;
  getNowSeconds?: (frameState: CesiumGpuPointLayerFrameState) => number;
  extraUniformMap?: (
    input: CesiumGpuPointLayerUniformInputs,
  ) => Record<string, () => unknown>;
}
```

### `CesiumGpuPointLayerShaders`

Generated shader source bundle for both WebGL versions.

```ts
interface CesiumGpuPointLayerShaders {
  vertexWebGL2: string;
  vertexWebGL1: string;
  fragmentWebGL2: string;
  fragmentWebGL1: string;
}
```

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

- movement-style overlays (aircraft, ships, vehicles, weather markers),
- datasets with near-real-time position updates,
- repeated updates where full entities are too heavy,
- scenarios where a flat sprite texture atlas per layer is a good semantic fit.

## Rendering benchmarks

Benchmark numbers below are copied from the sibling demo project `cesium-gpu-dots`, which renders the same library in a real Cesium scene.

> 34833 points: aircraft 6559, ships 28264, earthquakes 10; Images based on SVG sources.

| Setting | Scenario | Improvement (low-high fps) | Billboards | GPU dots |
| --- | --- | --- | --- | --- |
| high / no throttling | static | `27.7% - 17.5%` | `36-40 fps` | `46-47 fps` |
| high / no throttling | moving | `33.3% - 30.3%` | `30-33 fps` | `40-43 fps` |
| high / no throttling | scrolling in and out (Europe) | `38.4% - 11.1%` | `26-45 fps` | `36-50 fps` |
| high / CPU throttling x6 | static | `53% - 51.6%` | `30-31 fps` | `46-47 fps` |
| high / CPU throttling x6 | moving | `16.6% - 90.9%` | `21-22 fps` | `38-42 fps` |
| high / CPU throttling x6 | scrolling in-out | `62.5% - 61.9%` | `16-21 fps` | `26-34 fps` |