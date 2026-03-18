import * as Cesium from 'cesium';

export interface ContextLike {
  defaultTexture: unknown;
  floatingPointTexture: boolean;
  webgl2: boolean;
}

export interface BufferLike {
  destroy(): void;
}

export interface TextureLike {
  copyFrom(options: {
    source: {
      arrayBufferView: Float32Array | Uint8Array;
      height: number;
      width: number;
    };
  }): void;
  destroy(): void;
}

export interface VertexArrayLike {
  destroy(): void;
}

export interface ShaderProgramLike {
  destroy(): void;
}

export interface DrawCommandLike {
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

export interface PointLayerSpriteSource {
  url: string;
  width?: number;
  height?: number;
  resolution?: number;
}

export interface SpriteTextureAtlas {
  width: number;
  height: number;
  pixels: Uint8Array;
}

export interface PointTextureLayout {
  width: number;
  height: number;
  capacity: number;
}

export interface PackedPointTexture {
  data: Float32Array;
  layout: PointTextureLayout;
  count: number;
}

export interface BasePointRecord {
  id: string;
  longitude: number;
  latitude: number;
  altitudeMeters?: number;
  headingRadians?: number;
  speedMetersPerSecond?: number;
}

export interface PreparedPointRecord extends BasePointRecord {
  directionFromEarthCenter: Cesium.Cartesian3;
}

export interface CesiumGpuPointLayerFrameState {
  time?: Cesium.JulianDate;
  camera: {
    positionWC: Cesium.Cartesian3;
  };
  commandList: unknown[];
  context: {
    defaultTexture: unknown;
    floatingPointTexture: boolean;
    webgl2: boolean;
  };
  mode: Cesium.SceneMode;
  passes: {
    render: boolean;
  };
  pixelRatio?: number;
}

export interface CesiumGpuPointLayerUniformInputs {
  dataTexture: () => {
    copyFrom(options: { source: { arrayBufferView: Float32Array; height: number; width: number } }): void;
    destroy(): void;
  } | null;
  motionTexture: () => {
    copyFrom(options: { source: { arrayBufferView: Float32Array; height: number; width: number } }): void;
    destroy(): void;
  } | null;
  dataTextureDimensions: () => PointTextureLayout;
  spriteTexture: () => {
    copyFrom(options: { source: { arrayBufferView: Uint8Array; height: number; width: number } }): void;
    destroy(): void;
  } | null;
  nowSeconds: () => number;
  context: () => {
    defaultTexture: unknown;
    floatingPointTexture: boolean;
    webgl2: boolean;
  } | null;
}

export interface CesiumGpuPointLayerUniforms {
  dataTexture: string;
  dataTextureDimensions: string;
  motionTexture?: string;
  nowSeconds?: string;
  maxExtrapolationSeconds?: string;
  spriteTexture?: string;
  rotationEnabled?: string;
}

export interface CesiumGpuPointLayerShaders {
  vertexWebGL2: string;
  vertexWebGL1: string;
  fragmentWebGL2: string;
  fragmentWebGL1: string;
}

export interface CesiumGpuPointLayerShaderBuildInput {
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

export interface GpuPointLayerShaderConfig {
  dataTextureUniform: string;
  dataTextureDimensionsUniform: string;
  spriteTextureUniform: string;
  motionTextureUniform: string;
  nowSecondsUniform: string;
  maxExtrapolationSecondsUniform: string;
  rotationEnabledUniform: string;
}

export interface GpuPointLayerDescriptor {
  name?: string;
  attributeName?: string;
  indexAttributeLocation?: number;
  boundingSphere?: Cesium.BoundingSphere;
  cullDotThreshold?: number;
  headingOffsetRadians?: number;
  shaders?: CesiumGpuPointLayerShaders;
  shaderConfig?: Partial<GpuPointLayerShaderConfig>;
}

export interface GpuPointLayerOptions {
  name?: string;
  textureName?: string;
  attributeName?: string;
  indexAttributeLocation?: number;
  boundingSphere?: Cesium.BoundingSphere;
  pointScale?: number;
  minPointSize?: number;
  maxPointSize?: number;
  maxExtrapolationSeconds?: number;
  cullDotThreshold?: number;
  rotationEnabled?: boolean;
  alignWithGround?: boolean;
  headingOffsetRadians?: number;
  sprite: SpriteTextureAtlas | PointLayerSpriteSource;
  enableAnimation?: boolean;
  defaultAltitudeMeters?: number;
  defaultHeadingRadians?: number;
  depthTest?: boolean;
  depthMask?: boolean;
  shaderConfig?: Partial<GpuPointLayerShaderConfig>;
  shaders?: CesiumGpuPointLayerShaders;
  /**
   * Lower values are rendered first, higher values are rendered later.
   */
  drawOrder?: number;
}

export interface CesiumGpuPointLayerOptions {
  pointScale?: number;
  minPointSize?: number;
  maxPointSize?: number;
  maxExtrapolationSeconds?: number;
  depthTest?: boolean;
  depthMask?: boolean;
  sprite?: SpriteTextureAtlas | PointLayerSpriteSource;
  rotationEnabled?: boolean;
  alignWithGround?: boolean;
}

export interface CesiumGpuPointLayerDescriptor<
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

export type CesiumGpuPointLayerShaderConfig = GpuPointLayerShaderConfig;
