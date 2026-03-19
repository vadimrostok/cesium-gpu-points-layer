import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';

import {
  computePointTextureLayout,
  filterPointsForVisibleHemisphere,
  isPointInVisibleHemisphere,
  packPointsIntoFloatTexture,
} from '../../dist/index.js';

test('computePointTextureLayout returns stable capacities for point counts', () => {
  const layouts = [
    computePointTextureLayout(1),
    computePointTextureLayout(2),
    computePointTextureLayout(3),
    computePointTextureLayout(4),
    computePointTextureLayout(5),
  ];

  assert.deepEqual(layouts[0], { width: 1, height: 1, capacity: 1 });
  assert.deepEqual(layouts[1], { width: 2, height: 1, capacity: 2 });
  assert.deepEqual(layouts[2], { width: 2, height: 2, capacity: 4 });
  assert.deepEqual(layouts[3], { width: 2, height: 2, capacity: 4 });
  assert.deepEqual(layouts[4], { width: 3, height: 2, capacity: 6 });
});

test('packPointsIntoFloatTexture reuses compatible storage', () => {
  const writePoint = (out, point, offset) => {
    out[offset] = point.longitude;
    out[offset + 1] = point.latitude;
    out[offset + 2] = point.altitudeMeters;
    out[offset + 3] = point.rotationRadians;
  };

  const first = packPointsIntoFloatTexture(
    [
      { id: 'a', longitude: 1, latitude: 2, altitudeMeters: 3, rotationRadians: 4 },
      { id: 'b', longitude: 5, latitude: 6, altitudeMeters: 7, rotationRadians: 8 },
    ],
    undefined,
    undefined,
    writePoint,
  );

  assert.equal(first.count, 2);
  assert.equal(first.layout.width, 2);
  assert.equal(first.layout.height, 1);
  assert.equal(first.layout.capacity, 2);
  assert.equal(first.data[0], 1);
  assert.equal(first.data[4], 5);

  const second = packPointsIntoFloatTexture(
    [{ id: 'c', longitude: 9, latitude: 10, altitudeMeters: 11, rotationRadians: 12 }],
    first.data,
    first.layout,
    writePoint,
  );

  assert.equal(second.count, 1);
  assert.equal(second.data, first.data, 'data buffer should be reused when capacity still fits');
  assert.equal(second.data[0], 9);
  assert.equal(second.layout.width, 2);
});

test('point-hemisphere helpers keep only visible side points', () => {
  const cameraDirection = Cesium.Cartesian3.fromDegrees(0, 0, 0, Cesium.Ellipsoid.WGS84);
  const visible = { id: 'visible', longitude: 0, latitude: 0 };
  const hidden = { id: 'hidden', longitude: 180, latitude: 0 };

  assert.equal(isPointInVisibleHemisphere(visible, cameraDirection), true);
  assert.equal(isPointInVisibleHemisphere(hidden, cameraDirection), false);

  const filtered = filterPointsForVisibleHemisphere(
    [
      { id: 'visible', longitude: 0, latitude: 0 },
      { id: 'hidden', longitude: 180, latitude: 0 },
      { id: 'again', longitude: 10, latitude: 0 },
    ],
    cameraDirection,
  );

  assert.equal(filtered.length, 2);
  assert.deepEqual(filtered.map((point) => point.id), ['visible', 'again']);
});
