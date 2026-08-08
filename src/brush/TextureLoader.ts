/**
 * TextureLoader — async loader for brush stamp textures.
 *
 * Loads PNG files from /textures/ as ImageBitmap for fast Canvas2D stamping.
 * Caches loaded textures to avoid re-fetching.
 */

const cache = new Map<string, ImageBitmap | null>();
const loading = new Map<string, Promise<ImageBitmap | undefined>>();

/**
 * Load a texture by name (without path/extension).
 * Returns undefined if the texture can't be loaded.
 */
export async function loadTexture(name: string): Promise<ImageBitmap | undefined> {
  if (!name) return undefined;
  if (cache.has(name)) return cache.get(name) ?? undefined;
  if (loading.has(name)) return loading.get(name);

  const promise = (async () => {
    try {
      const response = await fetch(`/textures/${name}.png`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blob = await response.blob();
      const bitmap = await createImageBitmap(blob);
      cache.set(name, bitmap);
      return bitmap;
    } catch (err) {
      console.debug(`[TextureLoader] "${name}" unavailable; using procedural fallback`, err);
      cache.set(name, null);
      return undefined;
    } finally {
      loading.delete(name);
    }
  })();

  loading.set(name, promise);
  return promise;
}

/**
 * Preload all textures needed by a list of brush presets.
 * Call this on app startup or when switching brush packages.
 */
export async function preloadTextures(names: Iterable<string>): Promise<void> {
  const all = Array.from(names).map((n) => loadTexture(n));
  await Promise.all(all);
}

/**
 * Get a cached texture (must have been loaded already).
 * Returns undefined if not loaded or not found.
 */
export function getTexture(name: string): ImageBitmap | undefined {
  if (!name) return undefined;
  return cache.get(name) ?? undefined;
}

/** Clear the texture cache (for testing). */
export function clearCache(): void {
  for (const bitmap of cache.values()) bitmap?.close();
  cache.clear();
  loading.clear();
}
