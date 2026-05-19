import * as Cesium from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import './styles.css';
import Stats from 'stats.js';
import { BillboardRenderer, type LayerDefinition, type RecordType } from './billboard-renderer';
import { isPreparedGlobePoints, type PreparedGlobePoints } from './globe-data';
import { GpuPointLayer, type BasePointRecord } from '../../src/index';

console.log('import.meta.env', import.meta.env);
Cesium.Ion.defaultAccessToken = import.meta.env.VITE_CESIUM_ION_ACCESS_TOKEN;

const STATUS_MESSAGE_ID = 'gpu-playground-status';
const HUD_ID = 'gpu-playground-hud';

type RenderMode = 'gpu' | 'billboard';
type PerformanceMode = 'high' | 'mid' | 'low';

interface PerformanceProfile {
  resolutionScale: number;
  maximumScreenSpaceError: number;
  pointSizeScale: number;
}

const DEFAULT_MIN_POINT_SIZE = 30;
const DEFAULT_MAX_POINT_SIZE = 128;

interface GpuLayerHandle {
  type: RecordType;
  layer: GpuPointLayer<BasePointRecord>;
}

const PERFORMANCE_PROFILES: Record<PerformanceMode, PerformanceProfile> = {
  high: {
    resolutionScale: window.devicePixelRatio || 1,
    maximumScreenSpaceError: 1,
    pointSizeScale: window.devicePixelRatio || 1,
  },
  mid: {
    resolutionScale: 1,
    maximumScreenSpaceError: 2,
    pointSizeScale: 1,
  },
  low: {
    resolutionScale: 0.5,
    maximumScreenSpaceError: 4,
    pointSizeScale: 0.5,
  },
};

const LAYERS: Array<LayerDefinition> = [
  {
    type: 'earthquake',
    label: 'EarthquakeLayer',
    textureName: 'earthquake',
    spritePath: 'svgs/earthquake.svg',
    spriteWidth: 256,
    spriteHeight: 256,
    pointScale: 40_000_000,
    minPointSize: 128,
    maxPointSize: 256,
    rotationEnabled: false,
    alignWithGround: false,
    enableAnimation: false,
    headingOffsetRadians: 0,
    defaultAltitudeMeters: 1_000,
    drawOrder: 0,
  },
  {
    type: 'ship',
    label: 'ShipLayer',
    textureName: 'ship',
    spritePath: 'svgs/ship.svg',
    spriteWidth: 192,
    spriteHeight: 192,
    minPointSize: 30,
    maxPointSize: 192,
    pointScale: 100_000_000,
    rotationEnabled: false,
    alignWithGround: false,
    enableAnimation: false,
    headingOffsetRadians: 0,
    defaultAltitudeMeters: 1_000,
    drawOrder: 1,
  },
  {
    type: 'aircraft',
    label: 'PlaneLayer',
    textureName: 'plane',
    spritePath: 'svgs/medium-plane-2.svg',
    spriteWidth: 128,
    spriteHeight: 128,
    pointScale: 70_000_000,
    minPointSize: 30,
    maxPointSize: 128,
    rotationEnabled: true,
    alignWithGround: false,
    enableAnimation: true,
    headingOffsetRadians: -Math.PI / 2,
    defaultAltitudeMeters: 500,
    drawOrder: 2,
  },
];


const mount = async (): Promise<void> => {
  const assetUrl = (path: string): string =>
    `${import.meta.env.BASE_URL}${path.startsWith('/') ? path.substring(1) : path}`;

  const host = document.getElementById('app');
  if (!host) {
    throw new Error('Root app container is missing.');
  }

  const hudEl = document.createElement('div');
  hudEl.id = HUD_ID;
  hudEl.className = 'gpu-playground-hud';
  host.appendChild(hudEl);

  const controlRow = document.createElement('div');
  controlRow.className = 'gpu-playground-controls';

  const modeLabel = document.createElement('label');
  modeLabel.textContent = 'Renderer';
  modeLabel.setAttribute('for', 'gpu-playground-render-mode');
  controlRow.appendChild(modeLabel);

  const modeSelector = document.createElement('select');
  modeSelector.id = 'gpu-playground-render-mode';
  modeSelector.className = 'gpu-playground-select';
  const gpuModeOption = document.createElement('option');
  gpuModeOption.value = 'gpu';
  gpuModeOption.textContent = 'GPU points (default)';
  const billboardModeOption = document.createElement('option');
  billboardModeOption.value = 'billboard';
  billboardModeOption.textContent = 'Cesium Billboards';
  modeSelector.append(gpuModeOption, billboardModeOption);
  modeSelector.value = 'gpu';
  controlRow.appendChild(modeSelector);

  const performanceLabel = document.createElement('label');
  performanceLabel.textContent = 'Performance';
  performanceLabel.setAttribute('for', 'gpu-playground-performance-mode');
  controlRow.appendChild(performanceLabel);

  const performanceSelector = document.createElement('select');
  performanceSelector.id = 'gpu-playground-performance-mode';
  performanceSelector.className = 'gpu-playground-select';
  const highPerformanceOption = document.createElement('option');
  highPerformanceOption.value = 'high';
  highPerformanceOption.textContent = 'high';
  const midPerformanceOption = document.createElement('option');
  midPerformanceOption.value = 'mid';
  midPerformanceOption.textContent = 'mid';
  const lowPerformanceOption = document.createElement('option');
  lowPerformanceOption.value = 'low';
  lowPerformanceOption.textContent = 'low';
  performanceSelector.append(highPerformanceOption, midPerformanceOption, lowPerformanceOption);
  performanceSelector.value = 'high';
  controlRow.appendChild(performanceSelector);

  const statusEl = document.createElement('div');
  statusEl.id = STATUS_MESSAGE_ID;
  statusEl.className = 'gpu-playground-status';
  statusEl.textContent = 'loading snapshot...';

  const fpsCounter = new Stats();
  fpsCounter.showPanel(0);
  fpsCounter.dom.id = 'gpu-playground-fps';
  fpsCounter.dom.className = 'gpu-playground-stats';
  fpsCounter.dom.style.position = 'static';
  fpsCounter.dom.style.pointerEvents = 'none';

  hudEl.append(controlRow, statusEl, fpsCounter.dom);

  const viewerHost = document.createElement('div');
  viewerHost.id = 'globe-host';
  host.appendChild(viewerHost);

  const viewer = new Cesium.Viewer(viewerHost, {
    animation: false,
    timeline: false,
    baseLayerPicker: false,
    geocoder: false,
    sceneModePicker: false,
    navigationHelpButton: true,
    fullscreenButton: true,
    infoBox: false,
    selectionIndicator: false,
    homeButton: false,
    shouldAnimate: true,
    useBrowserRecommendedResolution: false,
    msaaSamples: 2,
  });

  viewer.scene.globe.maximumScreenSpaceError = PERFORMANCE_PROFILES.high.maximumScreenSpaceError;
  viewer.scene.globe.depthTestAgainstTerrain = false;
  viewer.scene.screenSpaceCameraController.enableTilt = true;
  viewer.scene.screenSpaceCameraController.enableZoom = true;
  viewer.scene.screenSpaceCameraController.enableRotate = true;
  viewer.scene.screenSpaceCameraController.minimumZoomDistance = 30_000;
  viewer.scene.screenSpaceCameraController.maximumZoomDistance = 34_000_000;
  viewer.scene.globe.showGroundAtmosphere = true;
  viewer.scene.globe.enableLighting = true;
  viewer.scene.globe.dynamicAtmosphereLighting = true;
  viewer.scene.globe.dynamicAtmosphereLightingFromSun = true;
  viewer.scene.requestRenderMode = false;
  viewer.clock.shouldAnimate = true;
  viewer.clock.multiplier = 1;

  const sortedLayerDefinitions = [...LAYERS].sort((left, right) => left.drawOrder - right.drawOrder);
  const activeRecords = new Map<RecordType, Array<BasePointRecord>>();

  const getRecords = (payload: PreparedGlobePoints): Map<RecordType, Array<BasePointRecord>> => {
    const grouped = new Map<RecordType, Array<BasePointRecord>>();
    grouped.set('aircraft', payload.planes);
    grouped.set('ship', payload.ships);
    grouped.set('earthquake', payload.earthquakes);
    return grouped;
  };
  const billboardRenderer = new BillboardRenderer({
    viewer,
    assetUrl,
    definitions: sortedLayerDefinitions,
  });

  const scalePointSize = (value: number, scale: number): number =>
    Math.max(1, Math.round(value * scale));

  const createGpuLayers = (profile: PerformanceProfile): Array<GpuLayerHandle> =>
    sortedLayerDefinitions.map((definition: LayerDefinition): GpuLayerHandle => {
      const minPointSize = scalePointSize(
        definition.minPointSize ?? DEFAULT_MIN_POINT_SIZE,
        profile.pointSizeScale,
      );
      const maxPointSize = scalePointSize(
        definition.maxPointSize ?? DEFAULT_MAX_POINT_SIZE,
        profile.pointSizeScale,
      );

      const layer = new GpuPointLayer<BasePointRecord>([], {
        name: definition.label,
        textureName: definition.textureName,
        headingOffsetRadians: definition.headingOffsetRadians,
        sprite: {
          url: assetUrl(definition.spritePath),
          width: definition.spriteWidth,
          height: definition.spriteHeight,
        },
        pointScale: definition.pointScale,
        minPointSize,
        maxPointSize,
        rotationEnabled: definition.rotationEnabled,
        alignWithGround: definition.alignWithGround,
        enableAnimation: definition.enableAnimation,
        maxExtrapolationSeconds: 60 * 60 * 24 * 365,
        defaultAltitudeMeters: definition.defaultAltitudeMeters,
        drawOrder: definition.drawOrder,
        depthTest: true,
        depthMask: true,
      });
      viewer.scene.primitives.add(layer.primitive);
      return { type: definition.type, layer };
    });

  let gpuLayers = createGpuLayers(PERFORMANCE_PROFILES.high);
  viewer.resolutionScale = PERFORMANCE_PROFILES.high.resolutionScale;
  for (const handle of gpuLayers) {
    handle.layer.primitive.show = true;
  }

  let activeRenderMode: RenderMode = 'gpu';
  let activePerformanceMode: PerformanceMode = 'high';

  const applyPerformanceMode = (mode: PerformanceMode): void => {
    activePerformanceMode = mode;
    const profile = PERFORMANCE_PROFILES[mode];
    viewer.resolutionScale = profile.resolutionScale;
    viewer.scene.globe.maximumScreenSpaceError = profile.maximumScreenSpaceError;

    const previousLayers = gpuLayers;
    const recordMap = new Map(activeRecords);
    for (const previous of previousLayers) {
      viewer.scene.primitives.remove(previous.layer.primitive);
      previous.layer.destroy();
    }

    gpuLayers = createGpuLayers(profile);

    for (const handle of gpuLayers) {
      const records = recordMap.get(handle.type) ?? [];
      handle.layer.setRecords(records);
      handle.layer.primitive.show = activeRenderMode === 'gpu';
    }
    setRendererMode(activeRenderMode);
  };

  const setRendererMode = (mode: RenderMode): void => {
    activeRenderMode = mode;
    const useBillboard = mode === 'billboard';

    for (const handle of gpuLayers) {
      handle.layer.primitive.show = !useBillboard;
    }
    billboardRenderer.setVisible(useBillboard);

    const totals = [
      ['aircraft', activeRecords.get('aircraft')?.length ?? 0],
      ['ship', activeRecords.get('ship')?.length ?? 0],
      ['earthquake', activeRecords.get('earthquake')?.length ?? 0],
    ];
    const totalCount = totals.reduce((acc, [, count]) => acc + Number(count), 0);
    const label = mode === 'billboard' ? 'Cesium Billboards' : 'GPU points';
    statusEl.textContent = `${label}: ${totalCount} points (aircraft ${totals[0]?.[1] ?? 0}, ships ${totals[1]?.[1] ?? 0}, earthquakes ${totals[2]?.[1] ?? 0})`;
  };

  modeSelector.addEventListener('change', () => {
    setRendererMode(modeSelector.value as RenderMode);
  });
  performanceSelector.addEventListener('change', () => {
    applyPerformanceMode(performanceSelector.value as PerformanceMode);
  });

  const onPostRender = (): void => {
    fpsCounter.update();
    if (activeRenderMode === 'billboard') {
      billboardRenderer.update();
    }
  };
  viewer.scene.preRender.addEventListener(onPostRender);

  viewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(10, 28, 20_000_000),
  });

  const applySnapshot = async (): Promise<void> => {
    const response = await fetch(assetUrl('be-globe-layer-points.json'));
    if (!response.ok) {
      throw new Error(`Failed to load snapshot: ${response.status} ${response.statusText}`);
    }

    const payload = (await response.json()) as PreparedGlobePoints;
    if (!isPreparedGlobePoints(payload)) {
      throw new Error('Snapshot does not contain a valid prepared layer payload.');
    }

    const groupedRecords = getRecords(payload);
    activeRecords.clear();
    for (const [type, records] of groupedRecords.entries()) {
      let tinyCounter = 0;
      const step = 200/records.length;
      for (const record of records) {
        // Reduce flickering over massive overlaps at some zoom levels
        record.altitudeMeters += tinyCounter;
        tinyCounter += step;
      }
      activeRecords.set(type, records);
    }

    billboardRenderer.setRecords(groupedRecords);
    applyPerformanceMode(activePerformanceMode);
    setRendererMode(activeRenderMode);
  };

  try {
    await applySnapshot();
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    console.error('[gpu-playground] failed to load static snapshot', details);
    statusEl.textContent = 'failed to load be-globe-layer-points.json';
  }

  const cleanup = (): void => {
    viewer.scene.preRender.removeEventListener(onPostRender);
    viewer.destroy();
    window.removeEventListener('beforeunload', cleanup);
  };

  window.addEventListener('beforeunload', cleanup);
};

void mount();