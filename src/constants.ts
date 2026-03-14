import * as Cesium from 'cesium';

export const CAMERA_DIRECTION_EPSILON = 1e-6;
export const DEFAULT_LAYOUT = {
  width: 1,
  height: 1,
  capacity: 1,
};
export const DEFAULT_POINT_SCALE = 40_000_000;
export const DEFAULT_MIN_POINT_SIZE = 30;
export const DEFAULT_MAX_POINT_SIZE = 128;
export const DEFAULT_MAX_EXTRAPOLATION_SECONDS = 60 * 60 * 24 * 365;
export const DEFAULT_POINT_ALTITUDE_METERS = 10;
export const DEFAULT_POINT_HEADING_RADIANS = 0;
export const DEFAULT_POINT_CULL_DOT_THRESHOLD = 0.5;
export const DEFAULT_ROTATION_ENABLED = true;
export const DEFAULT_LAYER_NAME = 'GpuPointLayer';
export const DEFAULT_ATTRIBUTE_NAME_SUFFIX = 'Index';
export const DEFAULT_ATTRIBUTE_INDEX = 0;
export const DEFAULT_BOUNDING_SPHERE = new Cesium.BoundingSphere(
  Cesium.Cartesian3.ZERO,
  Cesium.Ellipsoid.WGS84.maximumRadius + 1_000_000,
);
