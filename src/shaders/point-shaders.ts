import { type CesiumGpuPointLayerShaderBuildInput, type CesiumGpuPointLayerShaders } from '../types.js';

const shaderFloatLiteral = (value: number): string => {
  if (!Number.isFinite(value)) {
    return '0.0';
  }

  if (Number.isInteger(value)) {
    return `${value.toFixed(1)}`;
  }

  return `${value}`;
};

const formatPointTextureCoordinates = (
  pointIndex: string,
  textureDimensionsUniform: string,
): string =>
  `ivec2(${pointIndex} % int(${textureDimensionsUniform}.x), ${pointIndex} / int(${textureDimensionsUniform}.x))`;

const buildPointTextureCoordinates = (
  pointIndex: string,
  textureDimensionsUniform: string,
): string => `\
vec2 pointTextureCoordinates(float pointIndex) {\
    float textureWidth = ${textureDimensionsUniform}.x;\
    float x = mod(pointIndex, textureWidth);\
    float y = floor(pointIndex / textureWidth);\
    return (vec2(x, y) + 0.5) / ${textureDimensionsUniform};\
}
`;

export const buildPointVertexShaderWebGL2 = (
  config: CesiumGpuPointLayerShaderBuildInput,
): string => {
  const headingOffset = shaderFloatLiteral(config.headingOffsetRadians ?? 0);
  const hasMotion = config.hasMotionExtrapolation ?? false;
  const motionTextureUniform = config.motionTextureUniform ?? 'u_motionTexture';
  const nowSecondsUniform = config.nowSecondsUniform ?? 'u_nowSeconds';
  const maxExtrapolationSecondsUniform =
    config.maxExtrapolationSecondsUniform ?? 'u_maxExtrapolationSeconds';
  const textureCoordinates = formatPointTextureCoordinates(
    'pointIndex',
    config.dataTextureDimensionsUniform,
  );

  const motionTextureRead = hasMotion
    ? `vec4 motionData = texelFetch(${motionTextureUniform}, ${textureCoordinates}, 0);`
    : '';
  const motionUniforms = hasMotion
    ? `
uniform float ${nowSecondsUniform};
uniform float ${maxExtrapolationSecondsUniform};
`
    : '';
  const motionTextureUniformDeclaration = hasMotion
    ? `uniform highp sampler2D ${motionTextureUniform};\n`
    : '';
  const extrapolateCall = hasMotion
    ? `cartographicDegreesToCartesian(extrapolatePointCartographic(pointData, motionData))`
    : 'cartographicDegreesToCartesian(pointData.rgb)';

  const extrapolateFunction = hasMotion
    ? `
vec3 extrapolatePointCartographic(vec4 pointData, vec4 motionData) {
    if (motionData.x <= 0.0 || motionData.w <= 0.0) {
        return pointData.rgb;
    }

    float elapsedSeconds = clamp(
        ${nowSecondsUniform} - motionData.w,
        0.0,
        ${maxExtrapolationSecondsUniform}
    );
    float traveledDistanceMeters = motionData.x * elapsedSeconds;
    float northMeters = motionData.z * traveledDistanceMeters;
    float eastMeters = motionData.y * traveledDistanceMeters;
    float deltaLatitudeDegrees = degrees(northMeters / 6378137.0);
    float latitudeRadians = radians(pointData.y);
    float longitudeScale = max(cos(latitudeRadians), 1e-6);
    float deltaLongitudeDegrees = degrees(eastMeters / (6378137.0 * longitudeScale));

    return vec3(
        mod(pointData.x + 540.0, 360.0) - 180.0 + deltaLongitudeDegrees,
        clamp(pointData.y + deltaLatitudeDegrees, -90.0, 90.0),
        pointData.z
    );
}
`
    : '';

  return `precision highp float;
precision highp int;

in float ${config.attributeName};

uniform highp sampler2D ${config.dataTextureUniform};
${motionTextureUniformDeclaration}
uniform vec2 ${config.dataTextureDimensionsUniform};
uniform float u_maxPointSize;
uniform float u_minPointSize;
uniform float u_pointScale;
${motionUniforms}

out float v_headingRadians;

vec3 cartographicDegreesToCartesian(vec3 pointCartographic) {
    vec2 lonLatRadians = radians(pointCartographic.xy);
    float cosLatitude = cos(lonLatRadians.y);
    vec3 direction = vec3(
        cosLatitude * cos(lonLatRadians.x),
        cosLatitude * sin(lonLatRadians.x),
        sin(lonLatRadians.y)
    );

    vec3 radiiSquared = czm_ellipsoidRadii * czm_ellipsoidRadii;
    vec3 oneOverRadiiSquared = 1.0 / radiiSquared;
    vec3 surfaceSample = direction * czm_ellipsoidRadii;
    vec3 normal = czm_geodeticSurfaceNormal(surfaceSample, vec3(0.0), oneOverRadiiSquared);
    vec3 k = radiiSquared * normal / sqrt(dot(radiiSquared * normal, normal));

    return k + normal * pointCartographic.z;
}

${extrapolateFunction}

void main() {
    int pointIndex = gl_VertexID + int(${config.attributeName} * 0.0);
    vec4 pointData = texelFetch(${config.dataTextureUniform}, ${textureCoordinates}, 0);
    ${motionTextureRead}
    vec3 positionWC = ${extrapolateCall};
    vec4 positionEC = czm_view * vec4(positionWC, 1.0);

    gl_Position = czm_projection * positionEC;

    float cameraDistance = max(1.0, length(positionEC.xyz));
    gl_PointSize = clamp(u_pointScale / cameraDistance, u_minPointSize, u_maxPointSize);
    v_headingRadians = pointData.a + (${headingOffset});
}`;
};

export const buildPointVertexShaderWebGL1 = (
  config: CesiumGpuPointLayerShaderBuildInput,
): string => {
  const headingOffset = shaderFloatLiteral(config.headingOffsetRadians ?? 0);
  const hasMotion = config.hasMotionExtrapolation ?? false;
  const motionTextureUniform = config.motionTextureUniform ?? 'u_motionTexture';
  const nowSecondsUniform = config.nowSecondsUniform ?? 'u_nowSeconds';
  const maxExtrapolationSecondsUniform =
    config.maxExtrapolationSecondsUniform ?? 'u_maxExtrapolationSeconds';
  const coordinates = buildPointTextureCoordinates('index', config.dataTextureDimensionsUniform);
  const motionUniforms = hasMotion
    ? `
uniform sampler2D ${motionTextureUniform};
uniform float ${nowSecondsUniform};
uniform float ${maxExtrapolationSecondsUniform};
`
    : '';
  const motionDataRead = hasMotion
    ? `vec4 motionData = texture2D(${motionTextureUniform}, pointTextureCoordinates(${config.attributeName}));`
    : '';
  const extrapolateCall = hasMotion
    ? 'cartographicDegreesToCartesian(extrapolatePointCartographic(pointData, motionData))'
    : 'cartographicDegreesToCartesian(pointData.rgb)';
  const extrapolateFunction = hasMotion
    ? `
vec3 extrapolatePointCartographic(vec4 pointData, vec4 motionData) {
    if (motionData.x <= 0.0 || motionData.w <= 0.0) {
        return pointData.rgb;
    }

    float elapsedSeconds = clamp(
        ${nowSecondsUniform} - motionData.w,
        0.0,
        ${maxExtrapolationSecondsUniform}
    );
    float traveledDistanceMeters = motionData.x * elapsedSeconds;
    float northMeters = motionData.z * traveledDistanceMeters;
    float eastMeters = motionData.y * traveledDistanceMeters;
    float deltaLatitudeDegrees = degrees(northMeters / 6378137.0);
    float latitudeRadians = radians(pointData.y);
    float longitudeScale = max(cos(latitudeRadians), 1e-6);
    float deltaLongitudeDegrees = degrees(eastMeters / (6378137.0 * longitudeScale));

    return vec3(
        mod(pointData.x + 540.0, 360.0) - 180.0 + deltaLongitudeDegrees,
        clamp(pointData.y + deltaLatitudeDegrees, -90.0, 90.0),
        pointData.z
    );
}
`
    : '';

  return `precision highp float;

attribute float ${config.attributeName};

uniform sampler2D ${config.dataTextureUniform};
${motionUniforms}
uniform vec2 ${config.dataTextureDimensionsUniform};
uniform float u_maxPointSize;
uniform float u_minPointSize;
uniform float u_pointScale;

varying float v_headingRadians;

${coordinates}

vec3 cartographicDegreesToCartesian(vec3 pointCartographic) {
    vec2 lonLatRadians = radians(pointCartographic.xy);
    float cosLatitude = cos(lonLatRadians.y);
    vec3 direction = vec3(
        cosLatitude * cos(lonLatRadians.x),
        cosLatitude * sin(lonLatRadians.x),
        sin(lonLatRadians.y)
    );

    vec3 radiiSquared = czm_ellipsoidRadii * czm_ellipsoidRadii;
    vec3 oneOverRadiiSquared = 1.0 / radiiSquared;
    vec3 surfaceSample = direction * czm_ellipsoidRadii;
    vec3 normal = czm_geodeticSurfaceNormal(surfaceSample, vec3(0.0), oneOverRadiiSquared);
    vec3 k = radiiSquared * normal / sqrt(dot(radiiSquared * normal, normal));

    return k + normal * pointCartographic.z;
}

${extrapolateFunction}

void main() {
    vec4 pointData = texture2D(${config.dataTextureUniform}, pointTextureCoordinates(${config.attributeName}));
    ${motionDataRead}
    vec3 positionWC = ${extrapolateCall};
    vec4 positionEC = czm_view * vec4(positionWC, 1.0);

    gl_Position = czm_projection * positionEC;

    float cameraDistance = max(1.0, length(positionEC.xyz));
    gl_PointSize = clamp(u_pointScale / cameraDistance, u_minPointSize, u_maxPointSize);
    v_headingRadians = pointData.a + (${headingOffset});
}`;
};

export const buildPointFragmentShaderWebGL2 = (
  spriteTextureUniform = 'u_spriteTexture',
): string => `precision highp float;

uniform sampler2D ${spriteTextureUniform};
uniform float u_rotationEnabled;

in float v_headingRadians;

void main() {
    vec2 centered = gl_PointCoord - vec2(0.5);
    float sine = sin(v_headingRadians);
    float cosine = cos(v_headingRadians);
    sine = mix(0.0, sine, u_rotationEnabled);
    cosine = mix(1.0, cosine, u_rotationEnabled);
    mat2 inverseRotation = mat2(cosine, sine, -sine, cosine);
    vec2 uv = inverseRotation * centered + vec2(0.5);

    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
        discard;
    }

    vec4 sprite = texture(${spriteTextureUniform}, uv);
    if (sprite.a < 0.01) {
        discard;
    }

    out_FragColor = sprite;
}`;

export const buildPointFragmentShaderWebGL1 = (
  spriteTextureUniform = 'u_spriteTexture',
): string => `precision highp float;

uniform sampler2D ${spriteTextureUniform};
uniform float u_rotationEnabled;

varying float v_headingRadians;

void main() {
    vec2 centered = gl_PointCoord - vec2(0.5);
    float sine = sin(v_headingRadians);
    float cosine = cos(v_headingRadians);
    sine = mix(0.0, sine, u_rotationEnabled);
    cosine = mix(1.0, cosine, u_rotationEnabled);
    mat2 inverseRotation = mat2(cosine, sine, -sine, cosine);
    vec2 uv = inverseRotation * centered + vec2(0.5);

    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
        discard;
    }

    vec4 sprite = texture2D(${spriteTextureUniform}, uv);
    if (sprite.a < 0.01) {
        discard;
    }

    gl_FragColor = sprite;
}`;

export const buildPointShaders = (
  config: CesiumGpuPointLayerShaderBuildInput,
): CesiumGpuPointLayerShaders => ({
  vertexWebGL2: buildPointVertexShaderWebGL2(config),
  vertexWebGL1: buildPointVertexShaderWebGL1(config),
  fragmentWebGL2: buildPointFragmentShaderWebGL2(config.spriteTextureUniform),
  fragmentWebGL1: buildPointFragmentShaderWebGL1(config.spriteTextureUniform),
});
