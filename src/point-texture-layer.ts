import * as Cesium from 'cesium';
import type { Primitive } from 'cesium';
import { computePointTextureLayout } from './cpu-pipeline/point-pipeline.js';
import {
  CAMERA_DIRECTION_EPSILON,
  DEFAULT_LAYOUT,
  DEFAULT_MAX_EXTRAPOLATION_SECONDS,
  DEFAULT_MAX_POINT_SIZE,
  DEFAULT_MIN_POINT_SIZE,
  DEFAULT_POINT_CULL_DOT_THRESHOLD,
  DEFAULT_POINT_SCALE,
  DEFAULT_ROTATION_ENABLED,
} from './constants.js';
import { rasterizeSvgToTexture, type SvgSpriteRasterized } from './sprite-texture.js';
import type {
  BasePointRecord,
  BufferLike,
  CesiumGpuPointLayerDescriptor,
  CesiumGpuPointLayerFrameState,
  CesiumGpuPointLayerShaders,
  DrawCommandLike,
  PointLayerSpriteSource,
  PointTextureLayout,
  PreparedPointRecord,
  ShaderProgramLike,
  SpriteTextureAtlas,
  TextureLike,
  VertexArrayLike,
  CesiumRuntimeModule,
  ContextLike,
} from './types.js';

const CesiumRuntime = Cesium as CesiumRuntimeModule;

const scratchCameraDirection = new Cesium.Cartesian3();

const toErrorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }

  return 'Unknown sprite layer error';
};

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
  private readonly depthTestEnabled: boolean;
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
    this.depthTestEnabled = descriptor.options?.depthTest ?? true;
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
        enabled: descriptor.options?.depthTest ?? true,
      },
      depthMask: descriptor.options?.depthMask ?? true,
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

    const cameraDirection = this.depthTestEnabled
      ? null
      : Cesium.Cartesian3.normalize(frameState.camera.positionWC, scratchCameraDirection);
    const shouldRebuildPoints =
      this.pointsDirty ||
      this.visibilityDirty ||
      (!this.depthTestEnabled &&
        hasCameraDirectionChanged(cameraDirection, this.lastCameraDirection));

    if (shouldRebuildPoints) {
      this.rebuildVisiblePoints(cameraDirection);
      this.uploadMainTextures(frameState.context);
      this.uploadSpriteTexture(frameState.context);
      if (!this.depthTestEnabled && cameraDirection) {
        Cesium.Cartesian3.clone(cameraDirection, this.lastCameraDirection);
      }
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

  private rebuildVisiblePoints(cameraDirection: Cesium.Cartesian3 | null): void {
    let packedPointIndex = 0;

    for (const point of this.allPoints) {
      if (this.visiblePointIds && !this.visiblePointIds.has(point.id)) {
        continue;
      }

      if (
        cameraDirection !== null &&
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
  nextDirection: Cesium.Cartesian3 | null,
  previousDirection: Cesium.Cartesian3,
): boolean =>
  nextDirection === null
    ? false
    : !Cesium.Cartesian3.equalsEpsilon(
      nextDirection,
      previousDirection,
      CAMERA_DIRECTION_EPSILON,
      CAMERA_DIRECTION_EPSILON,
    );

/**
 * Backward-compatible export name kept from earlier internal API.
 */
export { CesiumPointTextureLayer as CesiumGpuPointLayer };
