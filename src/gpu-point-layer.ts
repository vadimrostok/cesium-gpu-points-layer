import * as Cesium from 'cesium';
import type { Primitive } from 'cesium';
import { buildPointShaders } from './shaders/point-shaders.js';
import { rasterizeSvgToTexture, SvgSpriteRasterized } from './sprite-texture.js';
import {
  DEFAULT_POINT_SHADER_CONFIG,
  computePointTextureLayout,
  isFiniteNumber,
  normalizeTextureName,
  resolveShaderConfig,
} from './cpu-pipeline/point-pipeline.js';
import type {
  BasePointRecord,
  CesiumGpuPointLayerDescriptor,
  CesiumGpuPointLayerFrameState,
  CesiumGpuPointLayerShaders,
  CesiumGpuPointLayerUniformInputs,
  CesiumGpuPointLayerUniforms,
  GpuPointLayerDescriptor,
  GpuPointLayerOptions,
  GpuPointLayerShaderConfig,
  PointLayerSpriteSource,
  PreparedPointRecord,
  PointTextureLayout,
  SpriteTextureAtlas,
} from './types.js';

interface ContextLike {
  defaultTexture: unknown;
  floatingPointTexture: boolean;
  webgl2: boolean;
}

interface BufferLike {
  destroy(): void;
}

interface TextureLike {
  copyFrom(options: {
    source: {
      arrayBufferView: Float32Array | Uint8Array;
      height: number;
      width: number;
    };
  }): void;
  destroy(): void;
}

interface VertexArrayLike {
  destroy(): void;
}

interface ShaderProgramLike {
  destroy(): void;
}

interface DrawCommandLike {
  boundingVolume?: Cesium.BoundingSphere;
  count: number;
  cull: boolean;
  owner?: unknown;
  pass: unknown;
  primitiveType: unknown;
  renderState?: unknown;
  shaderProgram?: ShaderProgramLike;
  uniformMap?: Record<string, () => unknown>;
  vertexArray?: VertexArrayLike;
}

export type CesiumRuntimeModule = typeof Cesium & {
  Buffer: {
    createVertexBuffer(options: {
      context: ContextLike;
      typedArray: Float32Array;
      usage: unknown;
    }): BufferLike;
  };
  BufferUsage: {
    STATIC_DRAW: unknown;
  };
  DrawCommand: new (options?: Partial<DrawCommandLike>) => DrawCommandLike;
  Pass: {
    OPAQUE: unknown;
  };
  RenderState: {
    fromCache(options: {
      depthMask?: boolean;
      depthTest?: {
        enabled: boolean;
      };
    }): unknown;
  };
  Sampler: new (options: {
    magnificationFilter: Cesium.TextureMagnificationFilter;
    minificationFilter: Cesium.TextureMinificationFilter;
  }) => unknown;
  ShaderProgram: {
    fromCache(options: {
      attributeLocations: Record<string, number>;
      context: ContextLike;
      fragmentShaderSource: string;
      vertexShaderSource: string;
    }): ShaderProgramLike;
  };
  Texture: new (options: {
    context: ContextLike;
    flipY?: boolean;
    height: number;
    pixelDatatype: Cesium.PixelDatatype;
    pixelFormat: Cesium.PixelFormat;
    sampler: unknown;
    source: {
      arrayBufferView: Float32Array | Uint8Array;
      height: number;
      width: number;
    };
    width: number;
  }) => TextureLike;
  VertexArray: new (options: {
    attributes: Array<{
      componentDatatype: Cesium.ComponentDatatype;
      componentsPerAttribute: number;
      index: number;
      vertexBuffer: BufferLike;
    }>;
    context: ContextLike;
  }) => VertexArrayLike;
};

const CesiumRuntime = Cesium as CesiumRuntimeModule;
const CAMERA_DIRECTION_EPSILON = 1e-6;
const DEFAULT_LAYOUT = {
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
const DEFAULT_ROTATION_ENABLED = true;

const scratchCameraDirection = new Cesium.Cartesian3();

const toErrorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }

  return 'Unknown sprite layer error';
};

interface GpuPreparedPoint
  extends Omit<BasePointRecord, 'altitudeMeters' | 'headingRadians'>,
    PreparedPointRecord {
  altitudeMeters: number;
  headingRadians: number;
  speedMetersPerSecond: number;
  directionX: number;
  directionY: number;
  timestampSeconds: number;
}

const DEFAULT_LAYER_NAME = 'GpuPointLayer';
const DEFAULT_ATTRIBUTE_NAME_SUFFIX = 'Index';
const DEFAULT_ATTRIBUTE_INDEX = 0;
const DEFAULT_BOUNDING_SPHERE = new Cesium.BoundingSphere(
  Cesium.Cartesian3.ZERO,
  Cesium.Ellipsoid.WGS84.maximumRadius + 1_000_000,
);

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
        depthTest: false,
        depthMask: false,
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
    const rawHeadingRadians = isFiniteNumber(point.headingRadians)
      ? point.headingRadians
      : this.defaultHeadingRadians;
    const hasHeading = isFiniteNumber(point.headingRadians);
    const headingRadians = Cesium.Math.zeroToTwoPi(rawHeadingRadians);

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
    const directionX = speedMetersPerSecond > 0 && hasHeading ? Math.cos(headingRadians) : 0;
    const directionY = speedMetersPerSecond > 0 && hasHeading ? Math.sin(headingRadians) : 0;

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
    };
  }
}

/**
 * Reusable Cesium primitive wrapper that renders packed points from RGBA float textures.
 */
export class CesiumPointTextureLayer<
  TInput extends BasePointRecord,
  TPrepared extends PreparedPointRecord,
> {
  public readonly primitive: Primitive;
  public show = true;

  private readonly dataTextureName: string;
  private readonly dataTextureDimensionName: string;
  private readonly motionTextureName: string | undefined;
  private readonly nowSecondsName: string | undefined;
  private readonly maxExtrapolationSecondsName: string | undefined;
  private readonly spriteTextureName: string;
  private readonly rotationEnabledName: string | undefined;
  private readonly pointScale: number;
  private readonly minPointSize: number;
  private readonly maxPointSize: number;
  private readonly maxExtrapolationSeconds: number;
  private readonly cullDotThreshold: number;
  private readonly drawCommand: DrawCommandLike;
  private readonly sampler: unknown;
  private readonly renderState: unknown;
  private readonly indexAttributeName: string;
  private readonly indexAttributeLocation: number;
  private readonly shaderSources: CesiumGpuPointLayerShaders;
  private readonly descriptor: CesiumGpuPointLayerDescriptor<TInput, TPrepared>;
  private readonly getNowSeconds: (frameState: CesiumGpuPointLayerFrameState) => number;
  private readonly hasMotionTexture: boolean;
  private readonly rotationEnabled: boolean;

  private allPoints: TPrepared[] = [];
  private visibleCount = 0;
  private visiblePointIds: Set<string> | null = null;
  private pointTextureLayout = DEFAULT_LAYOUT;
  private packedMainTextureData = new Float32Array(DEFAULT_LAYOUT.capacity * 4);
  private packedMotionTextureData = new Float32Array(DEFAULT_LAYOUT.capacity * 4);
  private pointTexture: TextureLike | null = null;
  private motionTexture: TextureLike | null = null;
  private pointIndexBuffer: BufferLike | null = null;
  private vertexArray: VertexArrayLike | null = null;
  private commandContext: ContextLike | null = null;
  private shaderProgram: ShaderProgramLike | null = null;
  private shaderProgramUsesWebGL2: boolean | null = null;
  private uniformMap: Record<string, () => unknown>;
  private spriteTexture: TextureLike | null = null;
  private spriteTextureData: SpriteTextureAtlas | null = null;
  private spriteTextureDirty = false;
  private currentNowSeconds = 0;
  private currentPixelRatio = 1;
  private isDestroyedFlag = false;
  private resourcesDirty = true;
  private visibilityDirty = true;
  private pointsDirty = true;
  private spriteRequestId = 0;
  private lastCameraDirection = new Cesium.Cartesian3(Number.NaN, Number.NaN, Number.NaN);

  public constructor(descriptor: CesiumGpuPointLayerDescriptor<TInput, TPrepared>) {
    this.descriptor = descriptor;
    this.dataTextureName = descriptor.uniforms.dataTexture;
    this.dataTextureDimensionName = descriptor.uniforms.dataTextureDimensions;
    this.motionTextureName = descriptor.uniforms.motionTexture;
    this.nowSecondsName = descriptor.uniforms.nowSeconds;
    this.maxExtrapolationSecondsName = descriptor.uniforms.maxExtrapolationSeconds;
    this.spriteTextureName = descriptor.uniforms.spriteTexture ?? 'u_spriteTexture';
    this.rotationEnabledName = descriptor.uniforms.rotationEnabled;
    this.pointScale = descriptor.options?.pointScale ?? DEFAULT_POINT_SCALE;
    this.minPointSize = descriptor.options?.minPointSize ?? DEFAULT_MIN_POINT_SIZE;
    this.maxPointSize = descriptor.options?.maxPointSize ?? DEFAULT_MAX_POINT_SIZE;
    this.maxExtrapolationSeconds =
      descriptor.options?.maxExtrapolationSeconds ?? DEFAULT_MAX_EXTRAPOLATION_SECONDS;
    this.cullDotThreshold = descriptor.cullDotThreshold ?? DEFAULT_POINT_CULL_DOT_THRESHOLD;
    this.hasMotionTexture = descriptor.packMotionData !== undefined;
    this.rotationEnabled = descriptor.options?.rotationEnabled ?? DEFAULT_ROTATION_ENABLED;
    this.getNowSeconds = descriptor.getNowSeconds ?? (() => 0);
    this.indexAttributeName = descriptor.indexAttributeName;
    this.indexAttributeLocation = descriptor.indexAttributeLocation;
    this.shaderSources = descriptor.shaders;

    this.sampler = new CesiumRuntime.Sampler({
      minificationFilter: Cesium.TextureMinificationFilter.NEAREST,
      magnificationFilter: Cesium.TextureMagnificationFilter.NEAREST,
    });
    this.renderState = CesiumRuntime.RenderState.fromCache({
      depthTest: {
        enabled: descriptor.options?.depthTest ?? false,
      },
      depthMask: descriptor.options?.depthMask ?? false,
    });
    this.drawCommand = new CesiumRuntime.DrawCommand({
      owner: this,
      primitiveType: Cesium.PrimitiveType.POINTS,
      pass: CesiumRuntime.Pass.OPAQUE,
      cull: false,
      count: 0,
      boundingVolume: descriptor.boundingSphere,
    });
    this.uniformMap = this.buildUniformMap();
    this.primitive = this as unknown as Primitive;
    this.setSpriteSource(descriptor.options?.sprite ?? null);
  }

  public setRecords(points: readonly TInput[]): void {
    const prepared: TPrepared[] = [];

    for (const point of points) {
      const preparedPoint = this.descriptor.prepareRecord(point);
      if (preparedPoint) {
        prepared.push(preparedPoint);
      }
    }

    this.allPoints = prepared;
    this.resizeStorage(computePointTextureLayout(prepared.length));
    this.pointsDirty = true;
    this.visibilityDirty = true;
  }

  public setVisiblePointIds(visiblePointIds: Iterable<string> | null): void {
    this.visiblePointIds = visiblePointIds ? new Set(visiblePointIds) : null;
    this.visibilityDirty = true;
  }

  public setSprite(sprite: SpriteTextureAtlas | null): void {
    if (
      this.spriteTextureData?.width === sprite?.width &&
      this.spriteTextureData?.height === sprite?.height &&
      this.spriteTextureData?.pixels === sprite?.pixels
    ) {
      return;
    }

    this.spriteTextureData = sprite;
    this.spriteTextureDirty = true;
  }

  public setSpriteSource(spriteSource: SpriteTextureAtlas | PointLayerSpriteSource | null): void {
    this.spriteRequestId += 1;
    const requestId = this.spriteRequestId;

    if (spriteSource == null) {
      this.setSprite(null);
      return;
    }

    if ('pixels' in spriteSource) {
      this.setSprite(spriteSource);
      return;
    }

    void rasterizeSvgToTexture(spriteSource.url, {
      width: spriteSource.width,
      height: spriteSource.height,
      resolution: spriteSource.resolution,
    })
      .then((sprite: SvgSpriteRasterized) => {
        if (requestId !== this.spriteRequestId || this.isDestroyed()) {
          return;
        }

        this.setSprite(sprite);
      })
      .catch((error: unknown) => {
        if (requestId === this.spriteRequestId && !this.isDestroyed()) {
          console.error('Failed to load sprite texture.', toErrorMessage(error));
        }
      });
  }

  public update(frameState: CesiumGpuPointLayerFrameState): void {
    if (
      this.isDestroyedFlag ||
      !this.show ||
      !frameState.passes.render ||
      (frameState.mode !== Cesium.SceneMode.SCENE3D &&
        frameState.mode !== Cesium.SceneMode.MORPHING)
    ) {
      return;
    }

    this.commandContext = frameState.context;
    this.currentPixelRatio = frameState.pixelRatio ?? 1;
    this.currentNowSeconds = this.getNowSeconds(frameState);
    this.ensureResources(frameState.context);

    const cameraDirection = Cesium.Cartesian3.normalize(
      frameState.camera.positionWC,
      scratchCameraDirection,
    );

    if (
      this.pointsDirty ||
      this.visibilityDirty ||
      hasCameraDirectionChanged(cameraDirection, this.lastCameraDirection)
    ) {
      this.rebuildVisiblePoints(cameraDirection);
      this.uploadMainTextures(frameState.context);
      this.uploadSpriteTexture(frameState.context);
      Cesium.Cartesian3.clone(cameraDirection, this.lastCameraDirection);
      this.pointsDirty = false;
      this.visibilityDirty = false;
    }

    if (this.spriteTextureDirty) {
      this.uploadSpriteTexture(frameState.context);
    }

    if (
      this.visibleCount === 0 ||
      !this.vertexArray ||
      !this.pointTexture ||
      (this.hasMotionTexture && !this.motionTexture)
    ) {
      return;
    }

    this.drawCommand.count = this.visibleCount;
    this.drawCommand.vertexArray = this.vertexArray;
    this.drawCommand.shaderProgram = this.ensureShaderProgram(frameState.context);
    this.drawCommand.renderState = this.renderState;
    this.drawCommand.uniformMap = this.uniformMap;
    frameState.commandList.push(this.drawCommand);
  }

  public isDestroyed(): boolean {
    return this.isDestroyedFlag;
  }

  public destroy(): undefined {
    if (this.isDestroyedFlag) {
      return undefined;
    }

    this.isDestroyedFlag = true;
    this.releaseGpuResources();

    if (this.shaderProgram) {
      this.shaderProgram.destroy();
      this.shaderProgram = null;
      this.shaderProgramUsesWebGL2 = null;
    }

    this.commandContext = null;
    this.spriteTextureData = null;
    return undefined;
  }

  private buildUniformMap(): Record<string, () => unknown> {
    const defaultUniforms: Record<string, () => unknown> = {
      [this.dataTextureName]: () => this.pointTexture ?? this.commandContext?.defaultTexture,
      [this.dataTextureDimensionName]: () =>
        new Cesium.Cartesian2(this.pointTextureLayout.width, this.pointTextureLayout.height),
      u_pointScale: () => this.pointScale * this.currentPixelRatio,
      u_minPointSize: () => this.minPointSize,
      u_maxPointSize: () => this.maxPointSize,
      [this.spriteTextureName]: () => this.spriteTexture ?? this.commandContext?.defaultTexture,
    };

    if (this.hasMotionTexture) {
      if (this.motionTextureName) {
        defaultUniforms[this.motionTextureName] = () =>
          this.motionTexture ?? this.commandContext?.defaultTexture;
      }

      if (this.nowSecondsName) {
        defaultUniforms[this.nowSecondsName] = () => this.currentNowSeconds;
      }

      if (this.maxExtrapolationSecondsName) {
        defaultUniforms[this.maxExtrapolationSecondsName] = () => this.maxExtrapolationSeconds;
      }
    }

    if (this.rotationEnabledName) {
      defaultUniforms[this.rotationEnabledName] = () => (this.rotationEnabled ? 1.0 : 0.0);
    }

    if (!this.descriptor.extraUniformMap) {
      return defaultUniforms;
    }

    return {
      ...defaultUniforms,
      ...this.descriptor.extraUniformMap({
        context: () => this.commandContext,
        dataTexture: () => this.pointTexture,
        dataTextureDimensions: () => this.pointTextureLayout,
        motionTexture: () => this.motionTexture,
        spriteTexture: () => this.spriteTexture,
        nowSeconds: () => this.currentNowSeconds,
      }),
    };
  }

  private ensureShaderProgram(context: ContextLike): ShaderProgramLike {
    const shouldUseWebGL2 = context.webgl2;
    if (this.shaderProgram && this.shaderProgramUsesWebGL2 === shouldUseWebGL2) {
      return this.shaderProgram;
    }

    if (this.shaderProgram) {
      this.shaderProgram.destroy();
      this.shaderProgram = null;
    }

    this.shaderProgramUsesWebGL2 = shouldUseWebGL2;
    this.shaderProgram = CesiumRuntime.ShaderProgram.fromCache({
      context,
      vertexShaderSource: shouldUseWebGL2
        ? this.shaderSources.vertexWebGL2
        : this.shaderSources.vertexWebGL1,
      fragmentShaderSource: shouldUseWebGL2
        ? this.shaderSources.fragmentWebGL2
        : this.shaderSources.fragmentWebGL1,
      attributeLocations: {
        [this.indexAttributeName]: this.indexAttributeLocation,
      },
    });

    return this.shaderProgram;
  }

  private ensureResources(context: ContextLike): void {
    if (!context.floatingPointTexture) {
      throw new Error(`${this.descriptor.name} requires floating-point texture support.`);
    }

    if (!this.resourcesDirty && this.pointTexture && this.vertexArray && this.pointIndexBuffer) {
      return;
    }

    this.releaseGpuResources();

    this.pointTexture = new CesiumRuntime.Texture({
      context,
      width: this.pointTextureLayout.width,
      height: this.pointTextureLayout.height,
      pixelFormat: Cesium.PixelFormat.RGBA,
      pixelDatatype: Cesium.PixelDatatype.FLOAT,
      sampler: this.sampler,
      flipY: false,
      source: {
        width: this.pointTextureLayout.width,
        height: this.pointTextureLayout.height,
        arrayBufferView: this.packedMainTextureData,
      },
    });

    if (this.hasMotionTexture) {
      this.motionTexture = new CesiumRuntime.Texture({
        context,
        width: this.pointTextureLayout.width,
        height: this.pointTextureLayout.height,
        pixelFormat: Cesium.PixelFormat.RGBA,
        pixelDatatype: Cesium.PixelDatatype.FLOAT,
        sampler: this.sampler,
        flipY: false,
        source: {
          width: this.pointTextureLayout.width,
          height: this.pointTextureLayout.height,
          arrayBufferView: this.packedMotionTextureData,
        },
      });
    }

    const pointIndices = new Float32Array(this.pointTextureLayout.capacity);
    for (let pointIndex = 0; pointIndex < pointIndices.length; pointIndex += 1) {
      pointIndices[pointIndex] = pointIndex;
    }

    this.pointIndexBuffer = CesiumRuntime.Buffer.createVertexBuffer({
      context,
      typedArray: pointIndices,
      usage: CesiumRuntime.BufferUsage.STATIC_DRAW,
    });
    this.vertexArray = new CesiumRuntime.VertexArray({
      context,
      attributes: [
        {
          index: this.indexAttributeLocation,
          vertexBuffer: this.pointIndexBuffer,
          componentsPerAttribute: 1,
          componentDatatype: Cesium.ComponentDatatype.FLOAT,
        },
      ],
    });

    this.resourcesDirty = false;
  }

  private uploadSpriteTexture(context: ContextLike): void {
    if (!this.spriteTextureDirty) {
      return;
    }

    this.spriteTextureDirty = false;

    if (!this.spriteTextureData) {
      if (this.spriteTexture) {
        this.spriteTexture.destroy();
        this.spriteTexture = null;
      }

      return;
    }

    if (this.spriteTexture) {
      this.spriteTexture.copyFrom({
        source: {
          width: this.spriteTextureData.width,
          height: this.spriteTextureData.height,
          arrayBufferView: this.spriteTextureData.pixels,
        },
      });

      return;
    }

    this.spriteTexture = new CesiumRuntime.Texture({
      context,
      width: this.spriteTextureData.width,
      height: this.spriteTextureData.height,
      pixelFormat: Cesium.PixelFormat.RGBA,
      pixelDatatype: Cesium.PixelDatatype.UNSIGNED_BYTE,
      sampler: this.sampler,
      flipY: false,
      source: {
        width: this.spriteTextureData.width,
        height: this.spriteTextureData.height,
        arrayBufferView: this.spriteTextureData.pixels,
      },
    });
  }

  private releaseGpuResources(): void {
    if (this.pointTexture) {
      this.pointTexture.destroy();
      this.pointTexture = null;
    }

    if (this.motionTexture) {
      this.motionTexture.destroy();
      this.motionTexture = null;
    }

    if (this.vertexArray) {
      this.vertexArray.destroy();
      this.vertexArray = null;
    }

    if (this.spriteTexture) {
      this.spriteTexture.destroy();
      this.spriteTexture = null;
    }

    this.pointIndexBuffer = null;
    this.resourcesDirty = true;
    this.spriteTextureDirty = this.spriteTextureData !== null;
  }

  private rebuildVisiblePoints(cameraDirection: Cesium.Cartesian3): void {
    let packedPointIndex = 0;

    for (const point of this.allPoints) {
      if (this.visiblePointIds && !this.visiblePointIds.has(point.id)) {
        continue;
      }

      if (
        Cesium.Cartesian3.dot(cameraDirection, point.directionFromEarthCenter) <=
        this.cullDotThreshold
      ) {
        continue;
      }

      const valueOffset = packedPointIndex * 4;
      this.descriptor.packMainData(point, this.packedMainTextureData, valueOffset);
      if (this.hasMotionTexture && this.descriptor.packMotionData) {
        this.descriptor.packMotionData(point, this.packedMotionTextureData, valueOffset);
      }

      packedPointIndex += 1;
    }

    this.visibleCount = packedPointIndex;
  }

  private resizeStorage(nextLayout: PointTextureLayout): void {
    if (
      this.pointTextureLayout.width === nextLayout.width &&
      this.pointTextureLayout.height === nextLayout.height
    ) {
      return;
    }

    this.pointTextureLayout = nextLayout;
    this.packedMainTextureData = new Float32Array(nextLayout.capacity * 4);
    this.packedMotionTextureData = new Float32Array(nextLayout.capacity * 4);
    this.resourcesDirty = true;
  }

  private uploadMainTextures(context: ContextLike): void {
    if (!this.pointTexture || (this.hasMotionTexture && !this.motionTexture)) {
      this.ensureResources(context);
    }

    this.pointTexture?.copyFrom({
      source: {
        width: this.pointTextureLayout.width,
        height: this.pointTextureLayout.height,
        arrayBufferView: this.packedMainTextureData,
      },
    });

    if (this.hasMotionTexture) {
      this.motionTexture?.copyFrom({
        source: {
          width: this.pointTextureLayout.width,
          height: this.pointTextureLayout.height,
          arrayBufferView: this.packedMotionTextureData,
        },
      });
    }
  }
}

const hasCameraDirectionChanged = (
  nextDirection: Cesium.Cartesian3,
  previousDirection: Cesium.Cartesian3,
): boolean =>
  !Cesium.Cartesian3.equalsEpsilon(
    nextDirection,
    previousDirection,
    CAMERA_DIRECTION_EPSILON,
    CAMERA_DIRECTION_EPSILON,
  );

/**
 * Backward-compatible export name kept from earlier internal API.
 */
export { CesiumPointTextureLayer as CesiumGpuPointLayer };
