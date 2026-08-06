import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type {
  AssetMetadata,
  AssetMimeType,
  AssetPutResult,
} from "../shared/protocol.js";

const MAX_ASSET_BYTES = 20 * 1024 * 1024;
const MAX_DIMENSION = 8192;

interface StoredAsset {
  id: string;
  sha256: string;
  mimeType: AssetMimeType;
  size: number;
  width: number;
  height: number;
  name?: string;
  createdAt: number;
}

interface AssetManifest {
  schemaVersion: 1;
  assets: Record<string, StoredAsset>;
}

function parseManifest(value: unknown): AssetManifest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as { schemaVersion?: unknown; assets?: unknown };
  if (
    candidate.schemaVersion !== 1 ||
    !candidate.assets ||
    typeof candidate.assets !== "object" ||
    Array.isArray(candidate.assets)
  ) {
    return null;
  }

  const assets: Record<string, StoredAsset> = {};
  for (const [key, raw] of Object.entries(candidate.assets)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const asset = raw as Partial<StoredAsset>;
    const sha256 = key.startsWith("A_") ? key.slice(2) : "";
    if (
      !/^A_[a-f0-9]{64}$/.test(key) ||
      asset.id !== key ||
      asset.sha256 !== sha256 ||
      (asset.mimeType !== "image/png" && asset.mimeType !== "image/jpeg") ||
      !Number.isInteger(asset.size) ||
      asset.size! <= 0 ||
      asset.size! > MAX_ASSET_BYTES ||
      !Number.isInteger(asset.width) ||
      asset.width! <= 0 ||
      asset.width! > MAX_DIMENSION ||
      !Number.isInteger(asset.height) ||
      asset.height! <= 0 ||
      asset.height! > MAX_DIMENSION ||
      typeof asset.createdAt !== "number" ||
      !Number.isFinite(asset.createdAt) ||
      asset.createdAt < 0 ||
      (asset.name !== undefined &&
        (typeof asset.name !== "string" || asset.name.length === 0 || asset.name.length > 128))
    ) {
      return null;
    }
    assets[key] = structuredClone(asset as StoredAsset);
  }
  return { schemaVersion: 1, assets };
}

export class AssetNotFoundError extends Error {
  constructor(public readonly assetId: string) {
    super(`Asset not found: ${assetId}`);
    this.name = "AssetNotFoundError";
  }
}

export class AssetTooLargeError extends Error {
  constructor(size: number) {
    super(`Asset exceeds ${MAX_ASSET_BYTES} bytes: ${size}`);
    this.name = "AssetTooLargeError";
  }
}

export class InvalidAssetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidAssetError";
  }
}

function digest(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function parsePngDimensions(buffer: Buffer): { width: number; height: number } | null {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(signature)) return null;
  if (buffer.toString("ascii", 12, 16) !== "IHDR") return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function parseJpegDimensions(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  const sof = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2;
  while (offset + 4 <= buffer.length) {
    while (offset < buffer.length && buffer[offset] !== 0xff) offset += 1;
    while (offset < buffer.length && buffer[offset] === 0xff) offset += 1;
    if (offset >= buffer.length) break;
    const marker = buffer[offset++]!;
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > buffer.length) break;
    const segmentLength = buffer.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > buffer.length) break;
    if (sof.has(marker)) {
      if (segmentLength < 7) break;
      return {
        height: buffer.readUInt16BE(offset + 3),
        width: buffer.readUInt16BE(offset + 5),
      };
    }
    offset += segmentLength;
  }
  return null;
}

function inspectImage(
  buffer: Buffer,
  mimeType: AssetMimeType,
): { width: number; height: number } {
  const dimensions =
    mimeType === "image/png" ? parsePngDimensions(buffer) : parseJpegDimensions(buffer);
  if (!dimensions) throw new InvalidAssetError(`Data does not match ${mimeType}`);
  if (
    dimensions.width <= 0 ||
    dimensions.height <= 0 ||
    dimensions.width > MAX_DIMENSION ||
    dimensions.height > MAX_DIMENSION
  ) {
    throw new InvalidAssetError(
      `Asset dimensions must be within ${MAX_DIMENSION}×${MAX_DIMENSION}`,
    );
  }
  return dimensions;
}

function decodeBase64(data: string): Buffer {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
    throw new InvalidAssetError("Asset data is not valid base64");
  }
  const buffer = Buffer.from(data, "base64");
  const normalizedInput = data.replace(/=+$/, "");
  const normalizedOutput = buffer.toString("base64").replace(/=+$/, "");
  if (!buffer.length || normalizedInput !== normalizedOutput) {
    throw new InvalidAssetError("Asset data is not canonical base64");
  }
  return buffer;
}

/** Immutable, append-only, content-addressed raster asset library. */
export class AssetStore {
  private readonly rootDir: string;
  private readonly manifestPath: string;
  private manifest: AssetManifest = { schemaVersion: 1, assets: {} };
  private queue = Promise.resolve();

  constructor(rootDir = resolve(process.cwd(), "data", "assets")) {
    this.rootDir = rootDir;
    this.manifestPath = join(rootDir, "manifest.json");
  }

  async init(): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
    for (const path of [this.manifestPath, `${this.manifestPath}.bak`]) {
      try {
        const parsed = parseManifest(JSON.parse(await readFile(path, "utf8")));
        if (parsed) {
          this.manifest = parsed;
          return;
        }
      } catch {
        // Try the backup; an empty library is valid on first launch.
      }
    }
  }

  async put(args: {
    data: string;
    mimeType: AssetMimeType;
    name?: string;
  }): Promise<AssetPutResult> {
    return this.exclusive(async () => {
      const buffer = decodeBase64(args.data);
      if (buffer.byteLength > MAX_ASSET_BYTES) throw new AssetTooLargeError(buffer.byteLength);
      const dimensions = inspectImage(buffer, args.mimeType);
      const sha256 = digest(buffer);
      const id = `A_${sha256}`;
      const existing = this.manifest.assets[id];
      if (existing) {
        try {
          const stored = await readFile(this.blobPath(existing.sha256));
          if (digest(stored) !== existing.sha256) {
            await this.atomicBlobWrite(existing.sha256, buffer);
          }
        } catch {
          await this.atomicBlobWrite(existing.sha256, buffer);
        }
        return { ...this.toPublic(existing), existing: true };
      }

      const stored: StoredAsset = {
        id,
        sha256,
        mimeType: args.mimeType,
        size: buffer.byteLength,
        width: dimensions.width,
        height: dimensions.height,
        ...(args.name ? { name: args.name } : {}),
        createdAt: Date.now(),
      };
      await this.atomicBlobWrite(sha256, buffer);
      this.manifest.assets[id] = stored;
      await this.persistManifest();
      return { ...this.toPublic(stored), existing: false };
    });
  }

  has(assetId: string): boolean {
    return Boolean(this.manifest.assets[assetId]);
  }

  get(assetId: string): AssetMetadata {
    const asset = this.manifest.assets[assetId];
    if (!asset) throw new AssetNotFoundError(assetId);
    return this.toPublic(asset);
  }

  list(limit = 100): AssetMetadata[] {
    return Object.values(this.manifest.assets)
      .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
      .slice(0, limit)
      .map((asset) => this.toPublic(asset));
  }

  async read(assetId: string): Promise<{ metadata: AssetMetadata; buffer: Buffer }> {
    const metadata = this.get(assetId);
    let buffer: Buffer;
    try {
      buffer = await readFile(this.blobPath(metadata.sha256));
    } catch {
      throw new AssetNotFoundError(assetId);
    }
    if (digest(buffer) !== metadata.sha256) {
      throw new InvalidAssetError(`Asset checksum mismatch: ${assetId}`);
    }
    return { metadata, buffer };
  }

  async dataUrl(assetId: string): Promise<string> {
    const { metadata, buffer } = await this.read(assetId);
    return `data:${metadata.mimeType};base64,${buffer.toString("base64")}`;
  }

  url(assetId: string): string {
    return `/asset/${assetId}`;
  }

  private toPublic(asset: StoredAsset): AssetMetadata {
    return { ...structuredClone(asset), url: this.url(asset.id) };
  }

  private blobPath(sha256: string): string {
    return join(this.rootDir, `${sha256}.blob`);
  }

  private async atomicBlobWrite(sha256: string, buffer: Buffer): Promise<void> {
    const target = this.blobPath(sha256);
    const tmp = join(this.rootDir, `${sha256}.${randomUUID()}.tmp`);
    await writeFile(tmp, buffer);
    await rename(tmp, target);
  }

  private async persistManifest(): Promise<void> {
    const tmp = `${this.manifestPath}.tmp`;
    const backup = `${this.manifestPath}.bak`;
    try {
      await copyFile(this.manifestPath, backup);
    } catch {
      // First write has no previous manifest.
    }
    await writeFile(tmp, JSON.stringify(this.manifest), "utf8");
    await rename(tmp, this.manifestPath);
  }

  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task, task);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export { MAX_ASSET_BYTES };
