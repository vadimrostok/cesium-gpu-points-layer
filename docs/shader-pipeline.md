# Shader Pipeline Overview

This document explains how the point-sprite shader setup works at a high level.
It is written for developers who are comfortable with TypeScript and basic vector math, but do not spend much time in GLSL.

## Big Picture

The library renders many points with one GPU draw call by packing point data into textures.

Each point stores:

- longitude
- latitude
- altitude
- heading
- optional motion data

The shader then:

1. reads a point record from a texture
2. turns lon/lat/alt into a Cartesian position
3. places a square point primitive on screen with `gl_PointSize`
4. samples the sprite image inside that square in the fragment shader

This means the GPU draws a lot of sprite-like markers without creating one Cesium billboard/entity per item.

## Coordinate Spaces

You will see a few different coordinate spaces in the shader:

- cartographic: longitude, latitude, altitude
- `WC`: world coordinates
- `EC`: eye coordinates
- clip space: the projected coordinates written to `gl_Position`

In this codebase:

- `positionWC` means world coordinates in Cesium's Earth-fixed Cartesian frame
- `positionEC` means eye coordinates, also called view space or camera space

The normal flow is:

`cartographic -> world -> eye -> clip`

## How Points Reach the Shader

Point data is stored in a float texture.

For each point:

- `R`: longitude
- `G`: latitude
- `B`: altitude
- `A`: heading

The vertex shader uses `gl_VertexID` in WebGL2, or an attribute index in WebGL1, to fetch the right texel from the data texture.

## Vertex Shader Responsibilities

The vertex shader does the heavy geometric work.

### 1. Read Point Data

The shader fetches the packed point record from the data texture.

If motion extrapolation is enabled, it also reads motion data and computes a future cartographic position from speed and direction.

### 2. Convert to Cartesian World Position

The function `cartographicDegreesToCartesian(...)` converts longitude/latitude/altitude into a world Cartesian position on or above the ellipsoid.

That uses the geodetic normal of the ellipsoid:

- first compute the ellipsoid normal from lon/lat
- then scale it to the ellipsoid surface
- then add altitude along the normal

### 3. Move into Camera Space

The shader computes:

- `positionWC`: world position
- `positionEC`: eye/view position with `czm_view * vec4(positionWC, 1.0)`
- `gl_Position`: clip-space position with `czm_projection * positionEC`

It also computes `gl_PointSize`, which controls the on-screen size of the square point primitive.

### 4. Pass Heading to the Fragment Shader

The point heading is passed through a varying so the fragment shader can rotate the sprite image.

## Fragment Shader Responsibilities

The fragment shader treats each point as a square image area.

`gl_PointCoord` is the current pixel coordinate inside that square, in the range `[0, 1]`.

The shader:

1. recenters it around zero
2. rotates it by the inverse of the point heading
3. uses the result as UV coordinates for the sprite texture
4. discards pixels outside the sprite or with very low alpha

That is how a square point primitive becomes a rotated plane icon.

## How `alignWithGround` Works

`alignWithGround` changes both the vertex shader and the fragment shader.

The goal is:

- top-down views: keep the sprite close to normal
- edge-of-globe views: flatten the sprite until it looks like it is lying on the globe

### Step 1: Build the Local Ground Plane

The shader does not read terrain triangles.

Instead, it uses the ellipsoid tangent plane at the point.

That plane is defined by the geodetic normal at the point:

- the normal is "up"
- every direction perpendicular to that normal lies in the local ground plane

### Step 2: Measure How Obliquely the Ground Plane Is Viewed

The shader computes:

- `pointNormalEC`: local up vector in eye space
- `viewDirectionEC`: direction from the point toward the camera

Then it measures:

`abs(dot(pointNormalEC, viewDirectionEC))`

This becomes `v_groundAlignment`.

Interpretation:

- near `1.0`: camera is looking more straight down at the ground plane
- near `0.0`: camera is looking almost parallel to the ground plane, so the sprite should collapse into a thin line

### Step 3: Find the In-Plane Direction Toward the Camera

The shader projects the camera direction onto the tangent plane:

`flattenAxisEC = viewDirectionEC - pointNormalEC * dot(pointNormalEC, viewDirectionEC)`

This removes the "up/down" part and leaves only the part of the view direction that lies in the ground plane.

This is the direction along which the sprite should be flattened.

### Step 4: Find the Visible Tangent-Line Direction

Inside the ground plane, the direction perpendicular to the flatten axis stays visible as the thin line.

That direction is:

`lineAxisEC = cross(pointNormalEC, flattenAxisEC)`

### Step 5: Project That Direction to Screen Space

A 3D tangent direction is not automatically the same as the 2D direction that appears on screen.

So the shader:

1. offsets the point a little along `lineAxisEC`
2. projects both the original and shifted point
3. subtracts the projected positions

The difference is the screen-space version of the visible tangent-line direction.

Then the shader rotates that by 90 degrees to get `v_flattenAxisScreen`, which is the axis used for flattening in the fragment shader.

This projection step is important because perspective can rotate and skew directions across the screen.

## What the Fragment Shader Does with `alignWithGround`

The fragment shader receives:

- `v_groundAlignment`: how strong the flattening should be
- `v_flattenAxisScreen`: which on-screen axis to flatten along

One subtle detail:

- the projected screen-space axis coming out of clip/NDC math uses a coordinate system where positive Y points up
- `gl_PointCoord` uses point-sprite coordinates with origin at the upper-left, so positive Y points down

That means the shader must flip the Y component before converting the visible tangent-line direction into the flattening axis used inside the point sprite.

Then it:

1. decomposes the local point pixel coordinate into:
   - the flatten axis
   - the perpendicular line axis
2. keeps only a narrow strip around the center along the flatten axis
3. expands that strip back into the full sprite UV range

That last part is important.

It means the whole image is squeezed into a thin strip, instead of simply cropping pieces away.

The rest of the point square is discarded, which makes it transparent.

## Why Degenerate Cases Are Discarded

Sometimes the flatten direction becomes numerically unstable, for example if the projected axis is too small to trust.

In those cases this implementation discards the point instead of falling back to the normal sprite.

That is intentional in this project because the fallback looked visually worse than skipping the point.

## Why WebGL1 and WebGL2 Both Exist

The library supports both WebGL1 and WebGL2.

The logic is meant to stay the same across both paths, but the syntax differs:

- WebGL2 uses `in` / `out`, `texelFetch`, and `gl_VertexID`
- WebGL1 uses `attribute` / `varying`, `texture2D`, and an explicit attribute index

The TypeScript builder generates two shader variants from the same conceptual pipeline.

## Practical Debugging Tips

If `alignWithGround` looks wrong:

- check whether the flatten axis or the preserved line axis is the one being projected
- check whether the screen-space axis is being normalized correctly
- check whether the fragment shader is flattening along the intended axis or its perpendicular
- check whether the sprite is being squeezed or accidentally cropped
- check whether heading rotation happens before or after the flattening remap

Most visual bugs in this feature come from mixing up those last two axes:

- the axis that gets flattened
- the axis that remains visible as the thin line
