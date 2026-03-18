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

const buildCartographicNormalFunction = (): string => `\
vec3 cartographicDegreesToGeodeticNormal(vec3 pointCartographic) {\
    vec2 lonLatRadians = radians(pointCartographic.xy);\
    float cosLatitude = cos(lonLatRadians.y);\
    return normalize(vec3(\
        cosLatitude * cos(lonLatRadians.x),\
        cosLatitude * sin(lonLatRadians.x),\
        sin(lonLatRadians.y)\
    ));\
}
`;

const buildGroundAlignmentVaryings = (
  qualifier: 'out' | 'varying' | 'in',
  alignWithGround: boolean,
): string =>
  alignWithGround
    ? `${qualifier} float v_groundAlignment;\n${qualifier} vec2 v_flattenAxisScreen;`
    : '';

const buildGroundAlignmentVertexComputation = (alignWithGround: boolean): string =>
  alignWithGround
    ? `
    // The local "ground plane" is the ellipsoid tangent plane at this point.
    vec3 pointNormalWC = cartographicDegreesToGeodeticNormal(pointCartographic);
    vec3 pointNormalEC = normalize((czm_view * vec4(pointNormalWC, 0.0)).xyz);
    vec3 viewDirectionEC = normalize(-positionEC.xyz);
    // This is the amount the image would be compressed due to viewing angle.
    v_groundAlignment = clamp(abs(dot(pointNormalEC, viewDirectionEC)), 0.0, 1.0);
    // This is just the projection of the camera direction onto the tangent plane.
    vec3 flattenAxisEC = viewDirectionEC - pointNormalEC * dot(pointNormalEC, viewDirectionEC);
    float flattenAxisLength = length(flattenAxisEC);
    if (flattenAxisLength > 0.0001) {
        flattenAxisEC /= flattenAxisLength;
        vec3 lineAxisEC = normalize(cross(pointNormalEC, flattenAxisEC));
        // Offset the point a little along that direction, project both positions, and
        // subtract them to get the corresponding screen-space direction.
        vec4 shiftedPositionEC = vec4(
            positionEC.xyz + lineAxisEC * max(1000.0, length(positionEC.xyz) * 0.01),
            1.0
        );
        vec4 shiftedClip = czm_projection * shiftedPositionEC;
        vec2 projectedLineAxis = (shiftedClip.xy / shiftedClip.w) - (gl_Position.xy / gl_Position.w);
        float projectedLineAxisLength = length(projectedLineAxis);
        if (projectedLineAxisLength > 0.0001) {
            vec2 lineAxisScreen = projectedLineAxis / projectedLineAxisLength;
            // projectedLineAxis uses projected screen coordinates where +Y points up.
            // gl_PointCoord uses point-sprite coordinates with origin at the upper-left,
            // so +Y points down. Convert between those spaces before taking the perpendicular.
            vec2 lineAxisPointCoord = vec2(lineAxisScreen.x, -lineAxisScreen.y);
            // The flatten axis is perpendicular to the visible tangent line.
            v_flattenAxisScreen = vec2(lineAxisPointCoord.y, -lineAxisPointCoord.x);
        } else {
            v_flattenAxisScreen = vec2(0.0, 0.0);
        }
    } else {
        v_flattenAxisScreen = vec2(0.0, 0.0);
    }
`
    : '';

const buildGroundAlignmentFragmentComputation = (alignWithGround: boolean): string =>
  alignWithGround
    ? `
    // Degenerate cases render poorly, so skip them entirely.
    if (v_flattenAxisScreen.x == 0.0 && v_flattenAxisScreen.y == 0.0) {
      discard;
    }
    float groundAlignment = max(v_groundAlignment, 0.001);
    vec2 flattenAxisScreen = normalize(v_flattenAxisScreen);
    vec2 lineAxisScreen = vec2(-flattenAxisScreen.y, flattenAxisScreen.x);
    float compressedAxisCoordinate = dot(centered, flattenAxisScreen);
    float lineAxisCoordinate = dot(centered, lineAxisScreen);
    if (abs(compressedAxisCoordinate) > 0.5 * groundAlignment) {
        discard;
    }
    float expandedAxisCoordinate = compressedAxisCoordinate / groundAlignment;
    vec2 uncompressed = flattenAxisScreen * expandedAxisCoordinate + lineAxisScreen * lineAxisCoordinate;
    vec2 uv = inverseRotation * uncompressed + vec2(0.5);
`
    : `
    vec2 uv = inverseRotation * centered + vec2(0.5);
`;

export const buildPointVertexShaderWebGL2 = (
  config: CesiumGpuPointLayerShaderBuildInput,
): string => {
  const headingOffset = shaderFloatLiteral(config.headingOffsetRadians ?? 0);
  const hasMotion = config.hasMotionExtrapolation ?? false;
  const alignWithGround = config.alignWithGround ?? false;
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
  const groundAlignmentVarying = buildGroundAlignmentVaryings('out', alignWithGround);
  const groundAlignmentComputation = buildGroundAlignmentVertexComputation(alignWithGround);

  const extrapolateFunction = hasMotion
    ? `
vec3 extrapolatePointCartographic(vec4 pointData, vec4 motionData) {
    if (motionData.x <= 0.0 || motionData.w <= 0.0) {
        return pointData.rgb;
    }
    if (motionData.y == 0.0 && motionData.z == 0.0) {
        return pointData.rgb;
    }

    float elapsedSeconds = clamp(
        ${nowSecondsUniform} - motionData.w,
        0.0,
        ${maxExtrapolationSecondsUniform}
    );
    float traveledDistanceMeters = motionData.x * elapsedSeconds;
    float angularDistance = traveledDistanceMeters / 6378137.0;

    float latitudeRadians = radians(pointData.y);
    float longitudeRadians = radians(pointData.x);
    float angularDistanceSin = sin(angularDistance);
    float angularDistanceCos = cos(angularDistance);

    float cosLatitude = cos(latitudeRadians);
    vec3 baseNormal = vec3(
        cosLatitude * cos(longitudeRadians),
        cosLatitude * sin(longitudeRadians),
        sin(latitudeRadians)
    );
    vec3 eastUnit = normalize(vec3(
        -sin(longitudeRadians),
        cos(longitudeRadians),
        0.0
    ));
    vec3 northUnit = normalize(vec3(
        -sin(latitudeRadians) * cos(longitudeRadians),
        -sin(latitudeRadians) * sin(longitudeRadians),
        cosLatitude
    ));
    // directionX is east component; directionY is north component in local tangent space.
    vec3 direction = normalize(eastUnit * motionData.y + northUnit * motionData.z);
    vec3 nextNormal = baseNormal * angularDistanceCos + direction * angularDistanceSin;

    return vec3(
        mod(degrees(atan(nextNormal.y, nextNormal.x)) + 180.0, 360.0) - 180.0,
        degrees(asin(clamp(nextNormal.z, -1.0, 1.0))),
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
${groundAlignmentVarying}

${buildCartographicNormalFunction()}

vec3 cartographicDegreesToCartesian(vec3 pointCartographic) {
    vec3 geodeticNormal = cartographicDegreesToGeodeticNormal(pointCartographic);

    vec3 radiiSquared = czm_ellipsoidRadii * czm_ellipsoidRadii;
    vec3 k = radiiSquared * geodeticNormal / sqrt(dot(radiiSquared * geodeticNormal, geodeticNormal));

    return k + geodeticNormal * pointCartographic.z;
}

${extrapolateFunction}

void main() {
    int pointIndex = gl_VertexID + int(${config.attributeName} * 0.0);
    vec4 pointData = texelFetch(${config.dataTextureUniform}, ${textureCoordinates}, 0);
    ${motionTextureRead}
    vec3 pointCartographic = ${hasMotion
      ? 'extrapolatePointCartographic(pointData, motionData)'
      : 'pointData.rgb'};
    vec3 positionWC = cartographicDegreesToCartesian(pointCartographic); // WC = world coordinates in Cesium's Earth-fixed Cartesian frame.
    vec4 positionEC = czm_view * vec4(positionWC, 1.0); // EC = eye coordinates, also called camera/view space.

    gl_Position = czm_projection * positionEC;

    float cameraDistance = max(1.0, length(positionEC.xyz));
    gl_PointSize = clamp(u_pointScale / cameraDistance, u_minPointSize, u_maxPointSize);
    v_headingRadians = pointData.a + (${headingOffset});
    ${groundAlignmentComputation}
}`;
};

export const buildPointVertexShaderWebGL1 = (
  config: CesiumGpuPointLayerShaderBuildInput,
): string => {
  const headingOffset = shaderFloatLiteral(config.headingOffsetRadians ?? 0);
  const hasMotion = config.hasMotionExtrapolation ?? false;
  const alignWithGround = config.alignWithGround ?? false;
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
  const groundAlignmentVarying = buildGroundAlignmentVaryings('varying', alignWithGround);
  const groundAlignmentComputation = buildGroundAlignmentVertexComputation(alignWithGround);
  const extrapolateFunction = hasMotion
    ? `
vec3 extrapolatePointCartographic(vec4 pointData, vec4 motionData) {
    if (motionData.x <= 0.0 || motionData.w <= 0.0) {
        return pointData.rgb;
    }
    if (motionData.y == 0.0 && motionData.z == 0.0) {
        return pointData.rgb;
    }

    float elapsedSeconds = clamp(
        ${nowSecondsUniform} - motionData.w,
        0.0,
        ${maxExtrapolationSecondsUniform}
    );
    float traveledDistanceMeters = motionData.x * elapsedSeconds;
    float angularDistance = traveledDistanceMeters / 6378137.0;

    float latitudeRadians = radians(pointData.y);
    float longitudeRadians = radians(pointData.x);
    float angularDistanceSin = sin(angularDistance);
    float angularDistanceCos = cos(angularDistance);

    float cosLatitude = cos(latitudeRadians);
    vec3 baseNormal = vec3(
        cosLatitude * cos(longitudeRadians),
        cosLatitude * sin(longitudeRadians),
        sin(latitudeRadians)
    );
    vec3 eastUnit = normalize(vec3(
        -sin(longitudeRadians),
        cos(longitudeRadians),
        0.0
    ));
    vec3 northUnit = normalize(vec3(
        -sin(latitudeRadians) * cos(longitudeRadians),
        -sin(latitudeRadians) * sin(longitudeRadians),
        cosLatitude
    ));
    // directionX is east component; directionY is north component in local tangent space.
    vec3 direction = normalize(eastUnit * motionData.y + northUnit * motionData.z);
    vec3 nextNormal = baseNormal * angularDistanceCos + direction * angularDistanceSin;

    return vec3(
        mod(degrees(atan(nextNormal.y, nextNormal.x)) + 180.0, 360.0) - 180.0,
        degrees(asin(clamp(nextNormal.z, -1.0, 1.0))),
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
${groundAlignmentVarying}

${coordinates}

${buildCartographicNormalFunction()}

vec3 cartographicDegreesToCartesian(vec3 pointCartographic) {
    vec3 geodeticNormal = cartographicDegreesToGeodeticNormal(pointCartographic);

    vec3 radiiSquared = czm_ellipsoidRadii * czm_ellipsoidRadii;
    vec3 k = radiiSquared * geodeticNormal / sqrt(dot(radiiSquared * geodeticNormal, geodeticNormal));

    return k + geodeticNormal * pointCartographic.z;
}

${extrapolateFunction}

void main() {
    vec4 pointData = texture2D(${config.dataTextureUniform}, pointTextureCoordinates(${config.attributeName}));
    ${motionDataRead}
    vec3 pointCartographic = ${hasMotion
      ? 'extrapolatePointCartographic(pointData, motionData)'
      : 'pointData.rgb'};
    vec3 positionWC = cartographicDegreesToCartesian(pointCartographic); // WC = world coordinates in Cesium's Earth-fixed Cartesian frame.
    vec4 positionEC = czm_view * vec4(positionWC, 1.0); // EC = eye coordinates, also called camera/view space.

    gl_Position = czm_projection * positionEC;

    float cameraDistance = max(1.0, length(positionEC.xyz));
    gl_PointSize = clamp(u_pointScale / cameraDistance, u_minPointSize, u_maxPointSize);
    v_headingRadians = pointData.a + (${headingOffset});
    ${groundAlignmentComputation}
}`;
};

export const buildPointFragmentShaderWebGL2 = (
  spriteTextureUniform = 'u_spriteTexture',
  alignWithGround = false,
): string => `precision highp float;

uniform sampler2D ${spriteTextureUniform};
uniform float u_rotationEnabled;

in float v_headingRadians;
${buildGroundAlignmentVaryings('in', alignWithGround)}

void main() {
    vec2 centered = gl_PointCoord - vec2(0.5);
    float sine = sin(v_headingRadians);
    float cosine = cos(v_headingRadians);
    sine = mix(0.0, sine, u_rotationEnabled);
    cosine = mix(1.0, cosine, u_rotationEnabled);
    mat2 inverseRotation = mat2(cosine, sine, -sine, cosine);
${buildGroundAlignmentFragmentComputation(alignWithGround)}

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
  alignWithGround = false,
): string => `precision highp float;

uniform sampler2D ${spriteTextureUniform};
uniform float u_rotationEnabled;

varying float v_headingRadians;
${buildGroundAlignmentVaryings('varying', alignWithGround)}

void main() {
    vec2 centered = gl_PointCoord - vec2(0.5);
    float sine = sin(v_headingRadians);
    float cosine = cos(v_headingRadians);
    sine = mix(0.0, sine, u_rotationEnabled);
    cosine = mix(1.0, cosine, u_rotationEnabled);
    mat2 inverseRotation = mat2(cosine, sine, -sine, cosine);
${buildGroundAlignmentFragmentComputation(alignWithGround)}

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
  fragmentWebGL2: buildPointFragmentShaderWebGL2(
    config.spriteTextureUniform,
    config.alignWithGround,
  ),
  fragmentWebGL1: buildPointFragmentShaderWebGL1(
    config.spriteTextureUniform,
    config.alignWithGround,
  ),
});
