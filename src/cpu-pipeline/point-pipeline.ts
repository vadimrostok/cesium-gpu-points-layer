import * as Cesium from 'cesium';
import { type BasePointRecord, type PointTextureLayout, type GpuPointLayerShaderConfig, type PackedPointTexture } from '../types.js';

export const DEFAULT_POINT_SHADER_CONFIG: GpuPointLayerShaderConfig = {
  dataTextureUniform: 'u_pointTexture',
  dataTextureDimensionsUniform: 'u_pointTextureDimensions',
  spriteTextureUniform: 'u_spriteTexture',
  motionTextureUniform: 'u_pointMotionTexture',
  nowSecondsUniform: 'u_nowSeconds',
  maxExtrapolationSecondsUniform: 'u_maxExtrapolationSeconds',
  rotationEnabledUniform: 'u_rotationEnabled',
};

export const resolveShaderConfig = (
  raw?: Partial<GpuPointLayerShaderConfig>,
): GpuPointLayerShaderConfig => ({
  dataTextureUniform: raw?.dataTextureUniform ?? DEFAULT_POINT_SHADER_CONFIG.dataTextureUniform,
  dataTextureDimensionsUniform:
    raw?.dataTextureDimensionsUniform ?? DEFAULT_POINT_SHADER_CONFIG.dataTextureDimensionsUniform,
  spriteTextureUniform: raw?.spriteTextureUniform ?? DEFAULT_POINT_SHADER_CONFIG.spriteTextureUniform,
  motionTextureUniform: raw?.motionTextureUniform ?? DEFAULT_POINT_SHADER_CONFIG.motionTextureUniform,
  nowSecondsUniform: raw?.nowSecondsUniform ?? DEFAULT_POINT_SHADER_CONFIG.nowSecondsUniform,
  maxExtrapolationSecondsUniform:
    raw?.maxExtrapolationSecondsUniform ??
    DEFAULT_POINT_SHADER_CONFIG.maxExtrapolationSecondsUniform,
  rotationEnabledUniform:
    raw?.rotationEnabledUniform ?? DEFAULT_POINT_SHADER_CONFIG.rotationEnabledUniform,
});

export const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

export const computePointTextureLayout = (capacity: number): PointTextureLayout => {
  const safeCapacity = Math.max(1, Math.ceil(capacity));
  const width = Math.ceil(Math.sqrt(safeCapacity));
  const height = Math.ceil(safeCapacity / width);

  return {
    width,
    height,
    capacity: width * height,
  };
};

/**
 * Reuse a single float texture and grow it only when the requested capacity increases.
 */
export const packPointsIntoFloatTexture = <TRecord extends BasePointRecord>(
  points: readonly TRecord[],
  previousData: Float32Array | undefined,
  previousLayout: PointTextureLayout | undefined,
  writePoint: (out: Float32Array, point: TRecord, valueOffset: number) => void,
): PackedPointTexture => {
  const layout =
    previousLayout && previousLayout.capacity >= Math.max(1, points.length)
      ? previousLayout
      : computePointTextureLayout(points.length);
  const requiredLength = layout.capacity * 4;
  const data =
    previousData && previousData.length === requiredLength
      ? previousData
      : new Float32Array(requiredLength);

  for (let pointIndex = 0; pointIndex < points.length; pointIndex += 1) {
    const point = points[pointIndex];
    writePoint(data, point, pointIndex * 4);
  }

  return {
    data,
    layout,
    count: points.length,
  };
};

/**
 * Tests and callers can use this helper for fast broad-hemisphere filtering.
 */
export const isPointInVisibleHemisphere = (
  point: BasePointRecord,
  cameraDirection: Cesium.Cartesian3,
  scratchDirection = new Cesium.Cartesian3(),
  scratchCartesian = new Cesium.Cartesian3(),
): boolean => {
  const pointCartesian = Cesium.Cartesian3.fromDegrees(
    point.longitude,
    point.latitude,
    point.altitudeMeters ?? 0,
    Cesium.Ellipsoid.WGS84,
    scratchCartesian,
  );
  const pointDirection = Cesium.Cartesian3.normalize(pointCartesian, scratchDirection);

  return Cesium.Cartesian3.dot(cameraDirection, pointDirection) > 0;
};

export const filterPointsForVisibleHemisphere = <TPoint extends BasePointRecord>(
  points: readonly TPoint[],
  cameraDirection: Cesium.Cartesian3,
): TPoint[] => {
  const visiblePoints: TPoint[] = [];

  for (const point of points) {
    if (isPointInVisibleHemisphere(point, cameraDirection)) {
      visiblePoints.push(point);
    }
  }

  return visiblePoints;
};

export const normalizeTextureName = (textureName: string): string =>
  textureName.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_') || 'point';
