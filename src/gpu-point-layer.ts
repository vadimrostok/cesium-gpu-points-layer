import * as Cesium from 'cesium';
import type { Primitive } from 'cesium';
import { buildPointShaders } from './shaders/point-shaders.js';
import { CesiumPointTextureLayer } from './point-texture-layer.js';
import {
  DEFAULT_POINT_SHADER_CONFIG,
  isFiniteNumber,
  normalizeTextureName,
  resolveShaderConfig,
} from './cpu-pipeline/point-pipeline.js';
import {
  DEFAULT_ATTRIBUTE_INDEX,
  DEFAULT_ATTRIBUTE_NAME_SUFFIX,
  DEFAULT_BOUNDING_SPHERE,
  DEFAULT_LAYER_NAME,
  DEFAULT_MAX_EXTRAPOLATION_SECONDS,
  DEFAULT_MAX_POINT_SIZE,
  DEFAULT_MIN_POINT_SIZE,
  DEFAULT_POINT_ALTITUDE_METERS,
  DEFAULT_POINT_CULL_DOT_THRESHOLD,
  DEFAULT_POINT_HEADING_RADIANS,
  DEFAULT_POINT_SCALE,
} from './constants.js';
import type {
  BasePointRecord,
  CesiumGpuPointLayerDescriptor,
  CesiumGpuPointLayerUniforms,
  GpuPointLayerDescriptor,
  GpuPointLayerOptions,
  PreparedPointRecord,
  SpriteTextureAtlas,
} from './types.js';
import type { SvgSpriteRasterized } from './sprite-texture.js';

interface GpuPreparedPoint
  extends Omit<
    BasePointRecord,
    'altitudeMeters' | 'rotationRadians' | 'movementDirectionRadians'
  >,
    PreparedPointRecord {
  altitudeMeters: number;
  headingRadians: number;
  speedMetersPerSecond: number;
  directionX: number;
  directionY: number;
  timestampSeconds: number;
}


/**
 * Generic GPU point layer with optional rotation and optional motion extrapolation.
 */
export class GpuPointLayer<TPoint extends BasePointRecord> {
  public readonly primitive: Primitive;
  public readonly drawOrder: number;

  private readonly pointLayer: CesiumPointTextureLayer<TPoint, GpuPreparedPoint>;
  private readonly defaultAltitudeMeters: number;
  private readonly defaultHeadingRadians: number;
  private readonly enableAnimation: boolean;
  private readonly cullDotThreshold: number;
  private readonly playbackStartSeconds = performance.now() / 1000;
  private readonly motionAnchorSeconds = 0.0001;

  public constructor(points: readonly TPoint[] = [], options: GpuPointLayerOptions) {
    this.drawOrder = options.drawOrder ?? 0;
    const resolvedDescriptor = this.resolveDescriptor(options);
    this.defaultAltitudeMeters = options.defaultAltitudeMeters ?? DEFAULT_POINT_ALTITUDE_METERS;
    this.defaultHeadingRadians = options.defaultHeadingRadians ?? DEFAULT_POINT_HEADING_RADIANS;
    this.enableAnimation = options.enableAnimation ?? true;
    this.cullDotThreshold =
      options.cullDotThreshold ?? DEFAULT_POINT_CULL_DOT_THRESHOLD;
    this.pointLayer = this.createPointLayer(resolvedDescriptor, options);
    this.pointLayer.setRecords(points);
    this.primitive = this.pointLayer.primitive;
  }

  public setRecords(points: readonly TPoint[]): void {
    this.pointLayer.setRecords(points);
  }

  public setSprite(sprite: SvgSpriteRasterized): void {
    this.pointLayer.setSprite(this.normalizeSpriteInput(sprite));
  }

  public setVisiblePointIds(visiblePointIds: Iterable<string> | null): void {
    this.pointLayer.setVisiblePointIds(visiblePointIds);
  }

  public destroy(): void {
    this.pointLayer.destroy();
  }

  private createPointLayer(
    descriptor: GpuPointLayerDescriptor,
    options: GpuPointLayerOptions,
  ): CesiumPointTextureLayer<TPoint, GpuPreparedPoint> {
    const enableAnimation = options.enableAnimation ?? true;
    const resolvedAttributeName = descriptor.attributeName ?? `a_${normalizeTextureName(
      options.textureName ?? options.name ?? 'point',
    )}${DEFAULT_ATTRIBUTE_NAME_SUFFIX}`;
    const shaderConfig = resolveShaderConfig(descriptor.shaderConfig);
    const shaders =
      descriptor.shaders ??
      buildPointShaders({
        attributeName: resolvedAttributeName,
        dataTextureUniform: shaderConfig.dataTextureUniform,
        dataTextureDimensionsUniform: shaderConfig.dataTextureDimensionsUniform,
        spriteTextureUniform: shaderConfig.spriteTextureUniform,
        headingOffsetRadians: descriptor.headingOffsetRadians ?? 0,
        alignWithGround: options.alignWithGround,
        hasMotionExtrapolation: enableAnimation,
        motionTextureUniform: shaderConfig.motionTextureUniform,
        nowSecondsUniform: shaderConfig.nowSecondsUniform,
        maxExtrapolationSecondsUniform: shaderConfig.maxExtrapolationSecondsUniform,
      });

    const cesiumUniforms: CesiumGpuPointLayerUniforms = {
      dataTexture: shaderConfig.dataTextureUniform,
      dataTextureDimensions: shaderConfig.dataTextureDimensionsUniform,
      motionTexture: shaderConfig.motionTextureUniform,
      nowSeconds: shaderConfig.nowSecondsUniform,
      maxExtrapolationSeconds: shaderConfig.maxExtrapolationSecondsUniform,
      spriteTexture: shaderConfig.spriteTextureUniform,
      rotationEnabled: shaderConfig.rotationEnabledUniform,
    };

    const layerDescriptor: CesiumGpuPointLayerDescriptor<TPoint, GpuPreparedPoint> = {
      name: descriptor.name ?? DEFAULT_LAYER_NAME,
      shaders,
      uniforms: cesiumUniforms,
      indexAttributeName: resolvedAttributeName,
      indexAttributeLocation: descriptor.indexAttributeLocation ?? DEFAULT_ATTRIBUTE_INDEX,
      boundingSphere:
        descriptor.boundingSphere ??
        new Cesium.BoundingSphere(
          Cesium.Cartesian3.ZERO,
          Cesium.Ellipsoid.WGS84.maximumRadius + 1_000_000,
        ),
      options: {
        pointScale: options.pointScale ?? DEFAULT_POINT_SCALE,
        minPointSize: options.minPointSize ?? DEFAULT_MIN_POINT_SIZE,
        maxPointSize: options.maxPointSize ?? DEFAULT_MAX_POINT_SIZE,
        maxExtrapolationSeconds:
          options.maxExtrapolationSeconds ?? DEFAULT_MAX_EXTRAPOLATION_SECONDS,
        sprite: options.sprite,
        rotationEnabled: options.rotationEnabled,
        alignWithGround: options.alignWithGround,
        depthTest: options.depthTest,
        depthMask: options.depthMask,
      },
      cullDotThreshold: this.cullDotThreshold,
      prepareRecord: (point) => this.preparePointForRendering(point),
      packMainData: (point, output, valueOffset): void => {
        output[valueOffset] = point.longitude;
        output[valueOffset + 1] = point.latitude;
        output[valueOffset + 2] = point.altitudeMeters;
        output[valueOffset + 3] = point.headingRadians;
      },
      packMotionData: enableAnimation
        ? (point, output, valueOffset): void => {
            output[valueOffset] = point.speedMetersPerSecond;
            output[valueOffset + 1] = point.directionX;
            output[valueOffset + 2] = point.directionY;
            output[valueOffset + 3] = point.timestampSeconds;
          }
        : undefined,
      getNowSeconds: (frameState) => {
        void frameState;
        return performance.now() / 1000 - this.playbackStartSeconds;
      },
    };

    return new CesiumPointTextureLayer(layerDescriptor);
  }

  private normalizeSpriteInput(sprite: SvgSpriteRasterized): SpriteTextureAtlas {
    return {
      width: sprite.width,
      height: sprite.height,
      pixels: sprite.pixels,
    };
  }

  private preparePointForRendering(point: TPoint): GpuPreparedPoint | null {
    const altitudeMeters = isFiniteNumber(point.altitudeMeters)
      ? point.altitudeMeters
      : this.defaultAltitudeMeters;
    const hasRotationRadians = isFiniteNumber(point.rotationRadians);
    // Marker rotation defaults when not explicitly set.
    const rawRotationRadians = hasRotationRadians
      ? point.rotationRadians
      : this.defaultHeadingRadians;
    const normalizedRotationRadians = isFiniteNumber(rawRotationRadians)
      ? rawRotationRadians
      : this.defaultHeadingRadians;
    const headingRadians = Cesium.Math.zeroToTwoPi(normalizedRotationRadians);

    if (
      !isFiniteNumber(point.longitude) ||
      !isFiniteNumber(point.latitude) ||
      !isFiniteNumber(altitudeMeters) ||
      !isFiniteNumber(headingRadians)
    ) {
      return null;
    }

    const directionFromEarthCenter = Cesium.Cartesian3.fromDegrees(
      point.longitude,
      point.latitude,
      altitudeMeters,
      Cesium.Ellipsoid.WGS84,
      new Cesium.Cartesian3(),
    );
    Cesium.Cartesian3.normalize(directionFromEarthCenter, directionFromEarthCenter);

    const speedMetersPerSecond =
      this.enableAnimation && isFiniteNumber(point.speedMetersPerSecond)
        ? Math.max(point.speedMetersPerSecond, 0)
        : 0;
    // If movement direction is not explicitly provided, inherit marker rotation for motion.
    const hasMovementRadians = isFiniteNumber(point.movementDirectionRadians) || hasRotationRadians;
    const rawMovementRadians = isFiniteNumber(point.movementDirectionRadians)
      ? point.movementDirectionRadians
      : headingRadians;
    const movementRadians = hasMovementRadians
      ? Cesium.Math.zeroToTwoPi(rawMovementRadians)
      : 0;
    const directionX = speedMetersPerSecond > 0 && hasMovementRadians ? Math.cos(movementRadians) : 0;
    const directionY = speedMetersPerSecond > 0 && hasMovementRadians ? Math.sin(movementRadians) : 0;

    return {
      id: point.id,
      longitude: point.longitude,
      latitude: point.latitude,
      altitudeMeters,
      headingRadians,
      speedMetersPerSecond,
      directionX,
      directionY,
      directionFromEarthCenter,
      timestampSeconds: this.motionAnchorSeconds,
    };
  }

  private resolveDescriptor(options: GpuPointLayerOptions): GpuPointLayerDescriptor {
    const normalizedTextureName = normalizeTextureName(
      options.textureName ?? options.name ?? 'point',
    );
    const prefix = `u_${normalizedTextureName}`;

    return {
      name: options.name ?? DEFAULT_LAYER_NAME,
      attributeName:
        options.attributeName ?? `a_${normalizedTextureName}${DEFAULT_ATTRIBUTE_NAME_SUFFIX}`,
      indexAttributeLocation: options.indexAttributeLocation ?? DEFAULT_ATTRIBUTE_INDEX,
      boundingSphere: options.boundingSphere ?? DEFAULT_BOUNDING_SPHERE,
      cullDotThreshold: options.cullDotThreshold ?? DEFAULT_POINT_CULL_DOT_THRESHOLD,
      headingOffsetRadians: options.headingOffsetRadians,
      shaderConfig: {
        ...resolveShaderConfig(options.shaderConfig),
        dataTextureUniform: options.shaderConfig?.dataTextureUniform ?? `${prefix}Texture`,
        dataTextureDimensionsUniform:
          options.shaderConfig?.dataTextureDimensionsUniform ?? `${prefix}TextureDimensions`,
        spriteTextureUniform:
          options.shaderConfig?.spriteTextureUniform ??
          DEFAULT_POINT_SHADER_CONFIG.spriteTextureUniform,
        motionTextureUniform:
          options.shaderConfig?.motionTextureUniform ?? `${prefix}MotionTexture`,
        nowSecondsUniform:
          options.shaderConfig?.nowSecondsUniform ??
          DEFAULT_POINT_SHADER_CONFIG.nowSecondsUniform,
        maxExtrapolationSecondsUniform:
          options.shaderConfig?.maxExtrapolationSecondsUniform ??
          DEFAULT_POINT_SHADER_CONFIG.maxExtrapolationSecondsUniform,
        rotationEnabledUniform:
          options.shaderConfig?.rotationEnabledUniform ??
          DEFAULT_POINT_SHADER_CONFIG.rotationEnabledUniform,
      },
      shaders: options.shaders ?? undefined,
    };
  }
}
