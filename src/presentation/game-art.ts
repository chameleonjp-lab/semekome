/**
 * Asset URLs and a tiny image cache for the game presentation layer.
 * Image objects are created once per asset, never from the render loop.
 */
export const GAME_ART_NAMES = [
  'hero', 'helper', 'gunner', 'guard', 'carrier', 'soldier',
  'turret', 'supply', 'core', 'gate', 'repair', 'floor', 'stage',
  'standard_slug', 'dense_payload', 'screen_panel', 'fast_dart',
  'split_payload', 'disruption_pack', 'breach_lance', 'adhesive_pod', 'impact',
] as const;

export type GameArtName = (typeof GAME_ART_NAMES)[number];

// `BASE_URL` is injected by Vite when running the app. Optional access also
// keeps this presentation module importable in plain Node tests.
const viteBase = (import.meta as ImportMeta & { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/';
const basePath = viteBase.endsWith('/') ? viteBase : `${viteBase}/`;

export const GAME_ART_URLS: Readonly<Record<GameArtName, string>> = Object.freeze(
  Object.fromEntries(GAME_ART_NAMES.map((name) => [name, `${basePath}assets/generated/${name === 'stage' ? 'stage-v2' : name}.webp`])) as Record<GameArtName, string>,
);

export function gameArtUrl(name: GameArtName): string {
  return GAME_ART_URLS[name];
}

const imageCache = new Map<GameArtName, HTMLImageElement | null>();
let imageRevision = 0;

/** Monotonically increases when any game image finishes loading or fails. */
export function getGameArtRevision(): number {
  return imageRevision;
}

/** Returns the cached image only after it decoded successfully. */
export function getGameArt(name: GameArtName): HTMLImageElement | undefined {
  if (!imageCache.has(name)) {
    if (typeof Image === 'undefined') {
      imageCache.set(name, null);
      return undefined;
    }
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => { imageRevision += 1; };
    image.onerror = () => { imageCache.set(name, null); imageRevision += 1; };
    imageCache.set(name, image);
    image.src = GAME_ART_URLS[name];
  }
  const image = imageCache.get(name);
  return image && image.complete && image.naturalWidth > 0 ? image : undefined;
}

/** Draws a loaded image and reports whether the caller can skip its fallback. */
export function drawGameArt(
  context: CanvasRenderingContext2D,
  name: GameArtName,
  x: number,
  y: number,
  width: number,
  height: number,
  alpha = 1,
): boolean {
  const image = getGameArt(name);
  if (!image) return false;
  const previousAlpha = context.globalAlpha;
  try {
    context.globalAlpha = previousAlpha * alpha;
    context.drawImage(image, x, y, width, height);
    return true;
  } catch {
    // An image can become unavailable between the complete check and draw.
    return false;
  } finally {
    context.globalAlpha = previousAlpha;
  }
}

/** Starts loading all visual assets without waiting for them. */
export function requestGameArtLoad(): void {
  for (const name of GAME_ART_NAMES) getGameArt(name);
}
