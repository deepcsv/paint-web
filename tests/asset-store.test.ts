import { afterEach, describe, expect, it } from "vitest";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AssetStore, InvalidAssetError } from "../server/asset-store.js";
import { createHttpServer } from "../server/http-server.js";

const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

const tempDirs: string[] = [];

async function createStore(): Promise<{ store: AssetStore; directory: string }> {
  const directory = await mkdtemp(join(tmpdir(), "paint-web-assets-"));
  tempDirs.push(directory);
  const store = new AssetStore(directory);
  await store.init();
  return { store, directory };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("AssetStore", () => {
  it("stores raster assets by content hash and deduplicates them", async () => {
    const { store } = await createStore();
    const first = await store.put({ data: PNG_1X1, mimeType: "image/png", name: "pixel" });
    const second = await store.put({ data: PNG_1X1, mimeType: "image/png", name: "duplicate" });

    expect(first.id).toMatch(/^A_[a-f0-9]{64}$/);
    expect(first).toMatchObject({ existing: false, width: 1, height: 1, name: "pixel" });
    expect(second).toMatchObject({ id: first.id, existing: true, name: "pixel" });
    expect(store.list()).toHaveLength(1);
    expect((await store.read(first.id)).buffer.toString("base64")).toBe(PNG_1X1);
  });

  it("recovers the manifest and serves self-contained data URLs", async () => {
    const { store, directory } = await createStore();
    const asset = await store.put({ data: PNG_1X1, mimeType: "image/png" });
    const reloaded = new AssetStore(directory);
    await reloaded.init();

    expect(reloaded.get(asset.id)).toMatchObject({ id: asset.id, width: 1, height: 1 });
    expect(await reloaded.dataUrl(asset.id)).toBe(`data:image/png;base64,${PNG_1X1}`);
  });

  it("rejects data whose signature does not match the declared media type", async () => {
    const { store } = await createStore();
    await expect(
      store.put({ data: Buffer.from("not an image").toString("base64"), mimeType: "image/png" }),
    ).rejects.toBeInstanceOf(InvalidAssetError);
  });

  it("falls back to the backup manifest after primary JSON corruption", async () => {
    const { store, directory } = await createStore();
    const first = await store.put({ data: PNG_1X1, mimeType: "image/png" });
    await copyFile(join(directory, "manifest.json"), join(directory, "manifest.json.bak"));
    await writeFile(join(directory, "manifest.json"), "{broken", "utf8");
    const recovered = new AssetStore(directory);
    await recovered.init();

    expect(recovered.get(first.id).id).toBe(first.id);
  });

  it("repairs a corrupted content blob when the original bytes are uploaded again", async () => {
    const { store, directory } = await createStore();
    const asset = await store.put({ data: PNG_1X1, mimeType: "image/png" });
    await writeFile(join(directory, `${asset.sha256}.blob`), "corrupted");

    const repaired = await store.put({ data: PNG_1X1, mimeType: "image/png" });

    expect(repaired).toMatchObject({ id: asset.id, existing: true });
    expect((await store.read(asset.id)).buffer.toString("base64")).toBe(PNG_1X1);
  });

  it("serves immutable assets with their verified media type", async () => {
    const { store } = await createStore();
    const asset = await store.put({ data: PNG_1X1, mimeType: "image/png" });
    const server = createHttpServer(undefined, store);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });

    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected a TCP test server");
      const response = await fetch(`http://127.0.0.1:${address.port}${asset.url}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/png");
      expect(response.headers.get("cache-control")).toContain("immutable");
      expect(response.headers.get("etag")).toBe(`"${asset.sha256}"`);
      expect(Buffer.from(await response.arrayBuffer()).toString("base64")).toBe(PNG_1X1);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
