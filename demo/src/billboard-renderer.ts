import * as Cesium from 'cesium';
import { type BasePointRecord } from '../../src/types';

export type RecordType = 'aircraft' | 'ship' | 'earthquake';

export interface LayerDefinition {
  type: RecordType;
  label: string;
  textureName: string;
  spritePath: string;
  spriteWidth: number;
  spriteHeight: number;
  pointScale: number;
  minPointSize?: number;
  maxPointSize?: number;
  rotationEnabled: boolean;
  alignWithGround?: boolean;
  enableAnimation: boolean;
  headingOffsetRadians: number;
  defaultAltitudeMeters: number;
  drawOrder: number;
}

interface BillboardMotionState {
  billboard: Cesium.Billboard;
  baseLatitude: number;
  baseLongitude: number;
  altitudeMeters: number;
  directionX: number;
  directionY: number;
  headingRadians: number;
  speedMetersPerSecond: number;
}

export interface BillboardRendererOptions {
  viewer: Cesium.Viewer;
  assetUrl: (path: string) => string;
  definitions: ReadonlyArray<LayerDefinition>;
}

const EARTH_RADIUS_METERS = Cesium.Ellipsoid.WGS84.maximumRadius;

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const isFinitePositive = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0;

export class BillboardRenderer {
  private readonly viewer: Cesium.Viewer;
  private readonly definitions: Array<LayerDefinition>;
  private readonly assetUrl: (path: string) => string;
  private readonly playbackStartSeconds = performance.now() / 1000;

  private readonly collectionByType = new Map<RecordType, Cesium.BillboardCollection>();
  private readonly recordsByType = new Map<RecordType, Array<BasePointRecord>>();
  private readonly statesByType = new Map<RecordType, Array<BillboardMotionState>>();
  private readonly allStates: Array<BillboardMotionState> = [];

  private readonly animatedPositionScratch = new Cesium.Cartographic();
  private readonly animatedCartesianScratch = new Cesium.Cartesian3();

  private readonly toRadians = (degrees: number): number => Cesium.Math.toRadians(degrees);
  private readonly normalizeHeading = (heading: number): number => Cesium.Math.zeroToTwoPi(heading);

  constructor(options: BillboardRendererOptions) {
    this.viewer = options.viewer;
    this.assetUrl = options.assetUrl;
    this.definitions = [...options.definitions].sort((left, right) => left.drawOrder - right.drawOrder);

    for (const definition of this.definitions) {
      const billboardCollection = new Cesium.BillboardCollection({
        scene: this.viewer.scene,
        blendOption: Cesium.BlendOption.OPAQUE,
      });
      billboardCollection.show = false;
      this.collectionByType.set(definition.type, billboardCollection);
      this.statesByType.set(definition.type, []);
      this.viewer.scene.primitives.add(billboardCollection);
    }
  }

  public setVisible(visible: boolean): void {
    for (const collection of this.collectionByType.values()) {
      collection.show = visible;
    }
  }

  public setRecords(recordsByType: ReadonlyMap<RecordType, Array<BasePointRecord>>): void {
    this.recordsByType.clear();
    for (const [type, records] of recordsByType.entries()) {
      this.recordsByType.set(type, [...records]);
    }
    this.syncAll();
  }

  private syncAll(): void {
    this.allStates.length = 0;
    for (const definition of this.definitions) {
      this.fillBillboardCollection(definition);
      const layerStates = this.statesByType.get(definition.type);
      if (layerStates) {
        this.allStates.push(...layerStates);
      }
    }
  }

  private fillBillboardCollection(definition: LayerDefinition): void {
    const collection = this.collectionByType.get(definition.type);
    const records = this.recordsByType.get(definition.type) ?? [];
    if (!collection) {
      return;
    }

    collection.removeAll();
    this.statesByType.set(definition.type, []);
    const states = this.statesByType.get(definition.type);
    if (!states) {
      return;
    }

    const spriteUrl = this.assetUrl(definition.spritePath);
    const rotationOffset = definition.rotationEnabled ? definition.headingOffsetRadians : 0;

    for (const record of records) {
      const heading = isFiniteNumber(record.headingRadians) ? record.headingRadians : 0;
      const headingNormalized = this.normalizeHeading(heading);
      const hasHeading = isFiniteNumber(record.headingRadians);
      const altitudeMeters = isFiniteNumber(record.altitudeMeters)
        ? record.altitudeMeters
        : definition.defaultAltitudeMeters;
      const speedMetersPerSecond =
        definition.enableAnimation && isFinitePositive(record.speedMetersPerSecond)
          && hasHeading
          ? record.speedMetersPerSecond
          : 0;
      const directionX = speedMetersPerSecond > 0 && hasHeading ? Math.cos(headingNormalized) : 0;
      const directionY = speedMetersPerSecond > 0 && hasHeading ? Math.sin(headingNormalized) : 0;

      const position = Cesium.Cartesian3.fromDegrees(
        record.longitude,
        record.latitude,
        altitudeMeters,
      );

      const billboard = collection.add({
        id: record.id,
        image: spriteUrl,
        position,
        width: definition.spriteWidth,
        height: definition.spriteHeight,
        // I tried disabling depth test, but it produced worse performance
        disableDepthTestDistance: 0,
        alignedAxis: Cesium.Cartesian3.ZERO,
        rotation: definition.rotationEnabled ? heading + rotationOffset : 0,
        scaleByDistance: new Cesium.NearFarScalar(1_150_000, 0.5, 4_333_000, 0.1),
      });

      const state: BillboardMotionState = {
        billboard,
        baseLatitude: this.toRadians(record.latitude),
        baseLongitude: this.toRadians(record.longitude),
        altitudeMeters,
        directionX,
        directionY,
        headingRadians: headingNormalized,
        speedMetersPerSecond,
      };
      states.push(state);
      billboard.show = true;
    }
  }

  public update(): void {
    const elapsedSeconds = performance.now() / 1000 - this.playbackStartSeconds;

    for (const state of this.allStates) {
      if (state.speedMetersPerSecond > 0 && elapsedSeconds > 0) {
        const traveledMeters = state.speedMetersPerSecond * elapsedSeconds;
        const latitude = Cesium.Math.clamp(
          state.baseLatitude +
          (state.directionY * traveledMeters) / EARTH_RADIUS_METERS,
          -Math.PI / 2,
          Math.PI / 2,
        );
        const longitude =
          state.baseLongitude +
          (state.directionX * traveledMeters) /
          (EARTH_RADIUS_METERS * Math.max(Math.cos(state.baseLatitude), 1e-6));

        this.animatedPositionScratch.longitude = Cesium.Math.zeroToTwoPi(longitude);
        this.animatedPositionScratch.latitude = latitude;
        this.animatedPositionScratch.height = state.altitudeMeters;

        Cesium.Cartographic.toCartesian(
          this.animatedPositionScratch,
          Cesium.Ellipsoid.WGS84,
          this.animatedCartesianScratch,
        );
        // Cloning without changing `state.billboard.position` is not working.
        // state.billboard.position.clone(this.animatedCartesianScratch);
        state.billboard.position = Cesium.Cartesian3.clone(this.animatedCartesianScratch);
      }
    }
  }
}
