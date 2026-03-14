export interface SvgSpriteRasterizationInput {
  url: string;
  width: number;
  height: number;
  resolution: number;
}

export interface SvgSpriteRasterized {
  width: number;
  height: number;
  pixels: Uint8Array;
}

export interface SvgSpriteRasterizeOptions {
  width?: number;
  height?: number;
  resolution?: number;
}

interface LoadedImageLike {
  onload: () => void;
  onerror: (event?: Error | Event | string) => void;
  src: string;
  naturalWidth: number;
  naturalHeight: number;
  width: number;
  height: number;
}

const DEFAULT_SIZE = 128;
const DEFAULT_RESOLUTION = 1;
const SVG_SPRITE_CACHE = new Map<string, Promise<SvgSpriteRasterized>>();

const resolveSize = (size: number | undefined, fallback: number): number => {
  const normalized = Math.floor(size ?? fallback);
  if (!Number.isFinite(normalized) || normalized <= 0) {
    return fallback;
  }
  return normalized;
};

const resolveResolution = (resolution: number | undefined): number => {
  const normalized = Math.floor(resolution ?? DEFAULT_RESOLUTION);
  if (!Number.isFinite(normalized) || normalized <= 0) {
    return DEFAULT_RESOLUTION;
  }

  return normalized;
};

const toErrorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === 'string') {
    return error;
  }

  return 'unknown error';
};

const buildSpriteCacheKey = (input: SvgSpriteRasterizationInput): string =>
  `${input.url}|${input.width}x${input.height}@${input.resolution}`;

const loadImage = async (imageUrl: string): Promise<LoadedImageLike> => {
  const image = new Image() as unknown as LoadedImageLike;

  return new Promise<LoadedImageLike>((resolve, reject) => {
    image.onload = () => {
      resolve(image);
    };

    image.onerror = (event) => {
      const reason = toErrorMessage(event);
      reject(new Error(`Failed to load SVG sprite '${imageUrl}'. ${reason}`));
    };

    image.src = imageUrl;
  });
};

/**
 * Cache by URL + target dimensions + DPR so each unique rasterization request is
 * performed once and then reused.
 */
const getOrCreateCache = (
  key: string,
  create: () => Promise<SvgSpriteRasterized>,
): Promise<SvgSpriteRasterized> => {
  const existing = SVG_SPRITE_CACHE.get(key);
  if (existing) {
    return existing;
  }

  const rasterized = create().catch((error: unknown) => {
    const message = toErrorMessage(error);
    SVG_SPRITE_CACHE.delete(key);
    throw new Error(`Failed to rasterize SVG sprite. ${message}`);
  });
  SVG_SPRITE_CACHE.set(key, rasterized);
  return rasterized;
};

/**
 * @remarks
 * "RGBA" means red-green-blue-alpha channels, one byte each.
 */
export const rasterizeSvgToTexture = async (
  url: string,
  options: SvgSpriteRasterizeOptions = {},
): Promise<SvgSpriteRasterized> => {
  const width = resolveSize(options.width, DEFAULT_SIZE);
  const height = resolveSize(options.height, DEFAULT_SIZE);
  const resolution = resolveResolution(options.resolution);
  const payload: SvgSpriteRasterizationInput = {
    url,
    width,
    height,
    resolution,
  };
  const key = buildSpriteCacheKey(payload);

  return getOrCreateCache(key, async () => {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(
        `Failed to fetch SVG sprite '${url}'. Status: ${response.status} ${response.statusText}`,
      );
    }

    const svgText = await response.text();
    const blob = new Blob([svgText], {
      type: 'image/svg+xml;charset=utf-8',
    });
    const blobUrl = URL.createObjectURL(blob);

    try {
      const image = await loadImage(blobUrl);
      const textureWidth = width * resolution;
      const textureHeight = height * resolution;
      const sourceWidth = Math.max(1, image.naturalWidth);
      const sourceHeight = Math.max(1, image.naturalHeight);
      const xScale = textureWidth / sourceWidth;
      const yScale = textureHeight / sourceHeight;
      const scale = Math.min(xScale, yScale);
      const scaledWidth = Math.max(1, Math.floor(sourceWidth * scale));
      const scaledHeight = Math.max(1, Math.floor(sourceHeight * scale));

      const canvas = document.createElement('canvas');
      canvas.width = textureWidth;
      canvas.height = textureHeight;

      const context = canvas.getContext('2d');
      if (!context) {
        throw new Error(`Unable to create 2d context for rasterizing '${url}'.`);
      }

      context.clearRect(0, 0, textureWidth, textureHeight);
      context.imageSmoothingEnabled = true;
      const drawX = (textureWidth - scaledWidth) / 2;
      const drawY = (textureHeight - scaledHeight) / 2;

      context.drawImage(image as never, drawX, drawY, scaledWidth, scaledHeight);

      const pixelData = context.getImageData(0, 0, textureWidth, textureHeight).data;

      return {
        width: textureWidth,
        height: textureHeight,
        pixels: new Uint8Array(pixelData),
      };
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
  });
};

export const clearSpriteRasterizationCache = (): void => {
  SVG_SPRITE_CACHE.clear();
};
