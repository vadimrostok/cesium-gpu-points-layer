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
  const extrapolateCall = hasMotion
    ? `cartographicDegreesToCartesian(extrapolatePointCartographic(pointData, motionData))`
    : 'cartographicDegreesToCartesian(pointData.rgb)';
  const groundAlignmentVarying = alignWithGround ? 'out float v_groundAlignment;' : '';
  const groundAxisVarying = alignWithGround ? 'out vec2 v_groundAxis;' : '';
  const groundAlignmentComputation = alignWithGround
    ? `
    vec3 viewDirectionEC = normalize(-positionEC.xyz);
    vec3 pointNormalEC = normalize((czm_view * vec4(normalize(positionWC), 0.0)).xyz);
    // This is the amount the image would be compressed due to viewing angle
    v_groundAlignment = clamp(abs(dot(pointNormalEC, viewDirectionEC)), 0.0, 1.0);
    // Compress along the tangent-plane direction that points toward the camera.
    // The perpendicular in-plane direction stays visible as the "thin line" near the limb.
    vec3 flattenAxisEC = viewDirectionEC - pointNormalEC * dot(pointNormalEC, viewDirectionEC);
    float flattenAxisLength = length(flattenAxisEC);
    if (flattenAxisLength > 0.0001) {
        flattenAxisEC /= flattenAxisLength;
    } else {
        flattenAxisEC = vec3(1.0, 0.0, 0.0);
    }
    vec4 shiftedPositionEC = vec4(
        positionEC.xyz + flattenAxisEC * max(1000.0, length(positionEC.xyz) * 0.01),
        1.0
    );
    vec4 shiftedClip = czm_projection * shiftedPositionEC;
    vec2 projectedFlattenAxis = (shiftedClip.xy / shiftedClip.w) - (gl_Position.xy / gl_Position.w);
    float projectedFlattenAxisLength = length(projectedFlattenAxis);
    if (projectedFlattenAxisLength > 0.0001) {
        v_groundAxis = projectedFlattenAxisLength / projectedFlattenAxis; // vec2(0.5, 0.5); // projectedFlattenAxis / projectedFlattenAxisLength;
        // Rotate counterclockwise
        v_groundAxis = vec2(-v_groundAxis.y, v_groundAxis.x);
    } else {
        v_groundAxis = vec2(0.0, 0.0);
    }
`
    : '';

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
    // directionX is north component; directionY is east component in local tangent space.
    vec3 direction = normalize(northUnit * motionData.y + eastUnit * motionData.z);
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
${groundAxisVarying}

vec3 cartographicDegreesToCartesian(vec3 pointCartographic) {
    vec2 lonLatRadians = radians(pointCartographic.xy);
    float cosLatitude = cos(lonLatRadians.y);
    vec3 geodeticNormal = normalize(vec3(
        cosLatitude * cos(lonLatRadians.x),
        cosLatitude * sin(lonLatRadians.x),
        sin(lonLatRadians.y)
    ));

    vec3 radiiSquared = czm_ellipsoidRadii * czm_ellipsoidRadii;
    vec3 k = radiiSquared * geodeticNormal / sqrt(dot(radiiSquared * geodeticNormal, geodeticNormal));

    return k + geodeticNormal * pointCartographic.z;
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
  const extrapolateCall = hasMotion
    ? 'cartographicDegreesToCartesian(extrapolatePointCartographic(pointData, motionData))'
    : 'cartographicDegreesToCartesian(pointData.rgb)';
  const groundAlignmentVarying = alignWithGround ? 'varying float v_groundAlignment;' : '';
  const groundAxisVarying = alignWithGround ? 'varying vec2 v_groundAxis;' : '';
  const groundAlignmentComputation = alignWithGround
    ? `
    vec3 viewDirectionEC = normalize(-positionEC.xyz);
    vec3 pointNormalEC = normalize((czm_view * vec4(normalize(positionWC), 0.0)).xyz);
    v_groundAlignment = clamp(abs(dot(pointNormalEC, viewDirectionEC)), 0.0, 1.0);
    // Compress along the tangent-plane direction that points toward the camera.
    // The perpendicular in-plane direction stays visible as the "thin line" near the limb.
    vec3 flattenAxisEC = viewDirectionEC - pointNormalEC * dot(pointNormalEC, viewDirectionEC);
    float flattenAxisLength = length(flattenAxisEC);
    if (flattenAxisLength > 0.0001) {
        flattenAxisEC /= flattenAxisLength;
    } else {
        flattenAxisEC = vec3(1.0, 0.0, 0.0);
    }
    vec4 shiftedPositionEC = vec4(
        positionEC.xyz + flattenAxisEC * max(1000.0, length(positionEC.xyz) * 0.01),
        1.0
    );
    vec4 shiftedClip = czm_projection * shiftedPositionEC;
    vec2 projectedFlattenAxis = (shiftedClip.xy / shiftedClip.w) - (gl_Position.xy / gl_Position.w);
    float projectedFlattenAxisLength = length(projectedFlattenAxis);
    if (projectedFlattenAxisLength > 0.0001) {
        v_groundAxis = projectedFlattenAxisLength / projectedFlattenAxis;
        // Rotate counterclockwise
        v_groundAxis = vec2(-v_groundAxis.y, v_groundAxis.x);
    } else {
        v_groundAxis = vec2(0.0, 0.0);
    }
`
    : '';
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
    // directionX is north component; directionY is east component in local tangent space.
    vec3 direction = normalize(northUnit * motionData.y + eastUnit * motionData.z);
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
${groundAxisVarying}

${coordinates}

vec3 cartographicDegreesToCartesian(vec3 pointCartographic) {
    vec2 lonLatRadians = radians(pointCartographic.xy);
    float cosLatitude = cos(lonLatRadians.y);
    vec3 geodeticNormal = normalize(vec3(
        cosLatitude * cos(lonLatRadians.x),
        cosLatitude * sin(lonLatRadians.x),
        sin(lonLatRadians.y)
    ));

    vec3 radiiSquared = czm_ellipsoidRadii * czm_ellipsoidRadii;
    vec3 k = radiiSquared * geodeticNormal / sqrt(dot(radiiSquared * geodeticNormal, geodeticNormal));

    return k + geodeticNormal * pointCartographic.z;
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
${alignWithGround ? 'in float v_groundAlignment;' : ''}
${alignWithGround ? 'in vec2 v_groundAxis;' : ''}

void main() {
    vec2 centered = gl_PointCoord - vec2(0.5);
    float sine = sin(v_headingRadians);
    float cosine = cos(v_headingRadians);
    sine = mix(0.0, sine, u_rotationEnabled);
    cosine = mix(1.0, cosine, u_rotationEnabled);
    mat2 inverseRotation = mat2(cosine, sine, -sine, cosine);
${alignWithGround
      ? `
    if (v_groundAxis.x == 0.0 && v_groundAxis.y == 0.0) {
      discard;
    }
    float groundAlignment = max(v_groundAlignment, 0.001);
    vec2 groundAxis = normalize(v_groundAxis);
    vec2 groundAxisPerpendicular = vec2(-groundAxis.y, groundAxis.x);
    float compressedAxisCoordinate = dot(centered, groundAxis);
    float perpendicularCoordinate = dot(centered, groundAxisPerpendicular);
    if (abs(compressedAxisCoordinate) > 0.5 * groundAlignment) {
        discard;
    }
    float expandedAxisCoordinate = compressedAxisCoordinate / groundAlignment;
    vec2 uncompressed = groundAxis * expandedAxisCoordinate + groundAxisPerpendicular * perpendicularCoordinate;
    vec2 uv = inverseRotation * uncompressed + vec2(0.5);
`
      : `
    vec2 uv = inverseRotation * centered + vec2(0.5);
`}

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
${alignWithGround ? 'varying float v_groundAlignment;' : ''}
${alignWithGround ? 'varying vec2 v_groundAxis;' : ''}

void main() {
    vec2 centered = gl_PointCoord - vec2(0.5);
    float sine = sin(v_headingRadians);
    float cosine = cos(v_headingRadians);
    sine = mix(0.0, sine, u_rotationEnabled);
    cosine = mix(1.0, cosine, u_rotationEnabled);
    mat2 inverseRotation = mat2(cosine, sine, -sine, cosine);
${alignWithGround
      ? `
    if (v_groundAxis.x == 0.0 && v_groundAxis.y == 0.0) {
      discard;
    }
    float groundAlignment = max(v_groundAlignment, 0.001);
    vec2 groundAxis = normalize(v_groundAxis);
    vec2 groundAxisPerpendicular = vec2(-groundAxis.y, groundAxis.x);
    float compressedAxisCoordinate = dot(centered, groundAxis);
    float perpendicularCoordinate = dot(centered, groundAxisPerpendicular);
    if (abs(compressedAxisCoordinate) > 0.5 * groundAlignment) {
        discard;
    }
    float expandedAxisCoordinate = compressedAxisCoordinate / groundAlignment;
    vec2 uncompressed = groundAxis * expandedAxisCoordinate + groundAxisPerpendicular * perpendicularCoordinate;
    vec2 uv = inverseRotation * uncompressed + vec2(0.5);
`
      : `
    vec2 uv = inverseRotation * centered + vec2(0.5);
`}

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