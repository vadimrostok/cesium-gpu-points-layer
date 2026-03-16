import type { BasePointRecord } from '../../src/types';

interface RawDirection {
  x?: number | null;
  y?: number | null;
  z?: number | null;
}

export type RecordType = 'aircraft' | 'ship' | 'earthquake';

export interface RawGlobeRecord {
  id: string;
  type: RecordType;
  longitude: number;
  latitude: number;
  direction?: RawDirection | null;
  details?: {
    altitudeMeters?: number | null;
    speedMps?: number | null;
    category?: number | null;
  };
}

export interface GlobeResponse {
  records: RawGlobeRecord[];
  limitPerType: number | null;
}

export interface PreparedGlobePoints {
  planes: BasePointRecord[];
  ships: BasePointRecord[];
  earthquakes: BasePointRecord[];
}

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const isBasePointRecord = (value: unknown): value is BasePointRecord => {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const point = value as BasePointRecord;
  return (
    typeof point.id === 'string' &&
    isFiniteNumber(point.longitude) &&
    isFiniteNumber(point.latitude) &&
    (!('altitudeMeters' in point) || isFiniteNumber(point.altitudeMeters)) &&
    (!('headingRadians' in point) || isFiniteNumber(point.headingRadians)) &&
    (!('speedMetersPerSecond' in point) || isFiniteNumber(point.speedMetersPerSecond))
  );
};

/**
 * WIP (work in progress) check for prepared snapshot payload.
 */
export const isPreparedGlobePoints = (value: unknown): value is PreparedGlobePoints => {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as PreparedGlobePoints;
  return (
    Array.isArray(candidate.planes) &&
    candidate.planes.every(isBasePointRecord) &&
    Array.isArray(candidate.ships) &&
    candidate.ships.every(isBasePointRecord) &&
    Array.isArray(candidate.earthquakes) &&
    candidate.earthquakes.every(isBasePointRecord)
  );
};

/**
 * WIP (work in progress) response shape check.
 */
export const isGlobeResponse = (value: unknown): value is GlobeResponse => {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as GlobeResponse;
  const hasRecords = Array.isArray(candidate.records);
  const hasLimit = Object.prototype.hasOwnProperty.call(candidate, 'limitPerType');
  return hasRecords && hasLimit;
};
