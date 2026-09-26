const imageFallbacks = new WeakMap<HTMLImageElement, HTMLSpanElement>();
const watchedImages = new WeakSet<HTMLImageElement>();

function markImageFailed(image: HTMLImageElement, fallbackText: string): void {
  image.hidden = true;
  image.dataset.artUnavailable = 'true';
  let fallback = imageFallbacks.get(image);
  if (!fallback) {
    fallback = document.createElement('span');
    fallback.className = `${image.className} art-image-fallback`.trim();
    fallback.setAttribute('aria-hidden', 'true');
    fallback.textContent = fallbackText;
    imageFallbacks.set(image, fallback);
  }
  if (!fallback.isConnected && image.parentNode) image.parentNode.insertBefore(fallback, image.nextSibling);
}

export function watchArtImage(image: HTMLImageElement, fallbackText = '◇'): void {
  if (!watchedImages.has(image)) {
    watchedImages.add(image);
    image.addEventListener('error', () => markImageFailed(image, fallbackText));
    image.addEventListener('load', () => {
      imageFallbacks.get(image)?.remove();
      delete image.dataset.artUnavailable;
    });
  }
  if (image.getAttribute('src') && image.complete && image.naturalWidth === 0) markImageFailed(image, fallbackText);
}

export function bindArtImageFallbacks(root: ParentNode, fallbackText = '◇'): void {
  for (const image of root.querySelectorAll<HTMLImageElement>('img')) watchArtImage(image, fallbackText);
}

export function setArtImageSource(image: HTMLImageElement, source: string, fallbackText = '◇'): void {
  watchArtImage(image, fallbackText);
  if (image.getAttribute('src') === source) {
    const unavailable = image.dataset.artUnavailable === 'true';
    image.hidden = unavailable;
    const existingFallback = imageFallbacks.get(image);
    if (existingFallback) existingFallback.hidden = !unavailable;
    return;
  }
  imageFallbacks.get(image)?.remove();
  image.hidden = false;
  delete image.dataset.artUnavailable;
  image.src = source;
  if (image.complete && image.naturalWidth === 0) markImageFailed(image, fallbackText);
}

export function setArtImageVisible(image: HTMLImageElement, visible: boolean): void {
  image.hidden = !visible;
  const fallback = imageFallbacks.get(image);
  if (fallback) fallback.hidden = !visible;
}
