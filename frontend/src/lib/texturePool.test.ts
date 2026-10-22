import { describe, expect, it, vi } from "vitest";

import { TexturePool, type DecodedImage, type PoolWindow, type Quality } from "./texturePool";

interface FakeTexture {
  id: string;
  disposed: boolean;
}

function setup(options: { manual?: boolean } = {}) {
  const images: (DecodedImage & { url: string; closed: boolean })[] = [];
  const textures: FakeTexture[] = [];
  const resolvers: { url: string; resolve: () => void; signal: AbortSignal }[] = [];
  const onChange = vi.fn();
  const pool = new TexturePool<FakeTexture>({
    url: (page: number, quality: Quality) => `${page}-${quality}`,
    decode: (url, signal) =>
      new Promise((resolve, reject) => {
        const image = {
          url,
          width: 700,
          height: 1000,
          closed: false,
          close() {
            if (this.closed) throw new Error(`double close of ${url}`);
            this.closed = true;
          },
        };
        images.push(image);
        const done = () => (signal.aborted ? reject(new Error("aborted")) : resolve(image));
        if (options.manual) resolvers.push({ url, resolve: done, signal });
        else queueMicrotask(done);
      }),
    createTexture: (image) => {
      const texture = { id: (image as DecodedImage & { url: string }).url, disposed: false };
      textures.push(texture);
      return {
        texture,
        dispose() {
          if (texture.disposed) throw new Error(`double dispose of ${texture.id}`);
          texture.disposed = true;
        },
      };
    },
    onChange,
  });
  return { pool, images, textures, resolvers, onChange };
}

const flush = async () => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

const live = (textures: FakeTexture[]) => textures.filter((t) => !t.disposed).map((t) => t.id).sort();

function window(visible: number[], neighbours: number[], prefetch: number[] = [], settled = true): PoolWindow {
  return { visible, neighbours, prefetch, settled };
}

describe("TexturePool", () => {
  it("loads low for the window and high for visible pages when settled", async () => {
    const { pool, textures } = setup();
    pool.setWindow(window([4, 5], [2, 3, 6, 7], [8, 9]));
    await flush();
    pool.setWindow(window([4, 5], [2, 3, 6, 7], [8, 9]));
    await flush();
    expect(pool.get(4).high?.id).toBe("4-high");
    expect(pool.get(4).low?.id).toBe("4-low");
    expect(pool.get(2).low?.id).toBe("2-low");
    expect(pool.get(2).high).toBeUndefined();
    expect(pool.get(8)).toEqual({ low: undefined, high: undefined, aspect: 0.7 });
    expect(pool.stats().prefetched).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
    expect(live(textures)).toEqual(["2-low", "3-low", "4-high", "4-low", "5-high", "5-low", "6-low", "7-low"]);
  });

  it("creates no high textures while a leaf moves", async () => {
    const { pool } = setup();
    pool.setWindow(window([4, 5], [2, 3], [], false));
    await flush();
    expect(pool.stats().qualities).toEqual({ 2: "low", 3: "low", 4: "low", 5: "low" });
  });

  it("releases the low texture after the cross-fade", async () => {
    const { pool, textures } = setup();
    pool.setWindow(window([4], []));
    await flush();
    expect(live(textures)).toEqual(["4-high", "4-low"]);
    pool.releaseLow(4);
    pool.releaseLow(4); // no double dispose
    expect(live(textures)).toEqual(["4-high"]);
    expect(pool.stats()).toMatchObject({ gpuPages: 1, gpuTextures: 1, qualities: { 4: "high" } });
  });

  it("disposes textures and closes images outside the window", async () => {
    const { pool, textures, images } = setup();
    pool.setWindow(window([4, 5], [2, 3, 6, 7]));
    await flush();
    pool.setWindow(window([20, 21], [18, 19, 22, 23]));
    await flush();
    expect(live(textures).filter((id) => Number(id.split("-")[0]) < 10)).toEqual([]);
    expect(images.filter((i) => Number(i.url.split("-")[0]) < 10).every((i) => i.closed)).toBe(true);
    expect(pool.stats().gpuPages).toBeLessThanOrEqual(6);
  });

  it("keeps at most six pages on the GPU while turning through a book", async () => {
    const { pool } = setup();
    for (let spread = 1; spread < 40; spread += 1) {
      const visible = [2 * spread, 2 * spread + 1];
      const neighbours = [2 * spread - 2, 2 * spread - 1, 2 * spread + 2, 2 * spread + 3];
      const prefetch = [2 * spread + 4, 2 * spread + 5, 2 * spread + 6, 2 * spread + 7];
      pool.setWindow(window(visible, neighbours, prefetch, spread % 2 === 0));
      await flush();
      expect(pool.stats().gpuPages).toBeLessThanOrEqual(6);
    }
  });

  it("uses decoded prefetch images without another request", async () => {
    const { pool, images } = setup();
    pool.setWindow(window([4, 5], [], [6, 7]));
    await flush();
    const requests = images.length;
    pool.setWindow(window([6, 7], [4, 5], [], false));
    await flush();
    expect(images.length).toBe(requests);
    expect(pool.stats().qualities[6]).toBe("low");
  });

  it("a high image requested while settled never lands on a page that has started to turn", async () => {
    const { pool, resolvers } = setup({ manual: true });
    pool.setWindow(window([4, 5], [2, 3]));
    for (const r of resolvers.filter((r) => r.url.endsWith("-low"))) r.resolve();
    await flush();
    // Settled: the high requests for pages 4 and 5 go out (at most four requests run at once).
    for (const r of resolvers.filter((r) => r.url.endsWith("-low"))) r.resolve();
    await flush();
    expect(resolvers.some((r) => r.url === "4-high")).toBe(true);
    // A turn starts while page 4 stays visible (it is the leaf's front).
    pool.setWindow(window([4, 5, 6, 7], [2, 3], [], false));
    for (const r of resolvers) r.resolve();
    await flush();
    expect(Object.values(pool.stats().qualities)).not.toContain("high");
    // Settled again: the high textures come.
    pool.setWindow(window([6, 7], [4, 5]));
    for (const r of resolvers) r.resolve();
    await flush();
    for (const r of resolvers) r.resolve();
    await flush();
    expect(pool.stats().qualities).toMatchObject({ 6: "high", 7: "high" });
  });

  it("cancels requests that leave the window", async () => {
    const { pool, resolvers, textures } = setup({ manual: true });
    pool.setWindow(window([4, 5], [2, 3]));
    pool.setWindow(window([40, 41], []));
    expect(resolvers.filter((r) => r.url.startsWith("4-")).every((r) => r.signal.aborted)).toBe(true);
    for (const r of resolvers) r.resolve();
    await flush();
    expect(live(textures).every((id) => id.startsWith("4"))).toBe(true);
    expect(live(textures).some((id) => id === "4-low")).toBe(false);
  });

  it("dispose() releases everything", async () => {
    const { pool, textures, images } = setup();
    pool.setWindow(window([4, 5], [2, 3], [6]));
    await flush();
    pool.dispose();
    expect(live(textures)).toEqual([]);
    expect(images.every((image) => image.closed)).toBe(true);
  });
});
