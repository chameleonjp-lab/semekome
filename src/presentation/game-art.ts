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

/** Four upright views; never rotate the entire robot or its labels sideways. */
export type ActorArtFacing = 'up' | 'down' | 'left' | 'right';
export type ActorArtName = 'hero' | 'helper' | 'gunner' | 'guard' | 'carrier' | 'soldier';
export function actorArtFacing(direction: { x: number; y: number }): ActorArtFacing {
  if (Math.abs(direction.x) >= Math.abs(direction.y) && direction.x !== 0) return direction.x < 0 ? 'left' : 'right';
  return direction.y < 0 ? 'up' : direction.y > 0 ? 'down' : 'right';
}

/** Code-authored front/back views keep role colors and equipment without new assets. */
export function drawDirectionalActorArt(
  context: CanvasRenderingContext2D, name: ActorArtName, facing: ActorArtFacing,
  x: number, y: number, size: number,
): void {
  context.save(); context.translate(x, y);
  if (facing === 'left' || facing === 'right') {
    context.scale(facing === 'left' ? -1 : 1, 1);
    if (drawGameArt(context, name, -size / 2, -size / 2, size, size)) { context.restore(); return; }
  }
  // An upright articulated robot: shoulders, two wheel-feet, torso and helmet.
  // Front has two luminous eyes; rear has a solid armor plate and exhaust slats.
  const accent = { hero: '#4ca9a5', helper: '#84ba9f', gunner: '#b28c65', guard: '#8b9fb9', carrier: '#d9ae57', soldier: '#ad7772' }[name];
  const side = facing === 'left' || facing === 'right';
  const back = facing === 'up';
  context.scale(size, size);
  context.strokeStyle = '#172a2f'; context.lineWidth = 0.055;
  context.fillStyle = '#243e44';
  for (const dx of [-0.22, 0.22]) {
    context.beginPath(); context.roundRect(dx - 0.1, 0.2, 0.2, 0.25, 0.06); context.fill(); context.stroke();
  }
  context.fillStyle = accent;
  context.beginPath(); context.roundRect(-0.28, -0.02, 0.56, 0.35, 0.1); context.fill(); context.stroke();
  context.fillStyle = '#e4d8b8';
  for (const dx of [-0.36, 0.36]) {
    context.beginPath(); context.arc(dx, 0.1, 0.105, 0, Math.PI * 2); context.fill(); context.stroke();
  }
  context.beginPath(); context.roundRect(-0.32, -0.43, 0.64, 0.47, 0.18); context.fill(); context.stroke();
  if (back) {
    context.fillStyle = '#b4a580';
    context.beginPath(); context.roundRect(-0.23, -0.35, 0.46, 0.3, 0.1); context.fill();
    context.fillStyle = '#4b5b59';
    for (let index = 0; index < 3; index += 1) context.fillRect(-0.13, -0.28 + index * 0.07, 0.26, 0.035);
    context.fillStyle = accent; context.fillRect(-0.09, 0.06, 0.18, 0.23);
  } else {
    context.fillStyle = '#153e46';
    context.beginPath(); context.roundRect(side ? 0 : -0.25, -0.34, side ? 0.29 : 0.5, 0.28, 0.1); context.fill();
    context.fillStyle = '#ffe5a0';
    for (const dx of side ? [0.18] : [-0.13, 0.13]) {
      context.beginPath(); context.ellipse(dx, -0.19, 0.035, 0.065, 0, 0, Math.PI * 2); context.fill();
    }
  }
  // Roles remain distinguishable in front/back views, including without images.
  if (name === 'carrier') {
    context.fillStyle = '#e4b862'; context.fillRect(-0.24, 0.13, 0.48, 0.19); context.strokeRect(-0.24, 0.13, 0.48, 0.19);
  } else if (name === 'guard') {
    context.fillStyle = '#a6bfd8'; context.beginPath(); context.moveTo(-0.44, 0); context.lineTo(-0.25, 0); context.lineTo(-0.25, 0.27); context.lineTo(-0.35, 0.35); context.lineTo(-0.44, 0.27); context.closePath(); context.fill(); context.stroke();
  } else if (name === 'gunner' || name === 'soldier') {
    context.fillStyle = '#6e7d7b'; context.fillRect(0.29, -0.05, 0.13, 0.31); context.strokeRect(0.29, -0.05, 0.13, 0.31);
  } else if (name === 'hero') {
    context.fillStyle = accent; context.fillRect(-0.31, 0.01, 0.62, 0.075);
  } else {
    context.fillStyle = '#f2ecce'; context.fillRect(-0.04, 0.1, 0.08, 0.17); context.fillRect(-0.085, 0.145, 0.17, 0.06);
  }
  context.restore();
}
