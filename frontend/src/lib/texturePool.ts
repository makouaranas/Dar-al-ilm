/**
 * Page texture pool with progressive quality (docs/ARCHITECTURE.md section 11.3, FR-13).
 *
 * - GPU textures exist only for the pages of the previous, current and next spreads.
 *   Everything else is disposed (`texture.dispose()` and `image.close()`).
 * - Every window page gets a `low` (768 px) texture first. Pages that are visible get a
 *   `high` (2048 px) texture once the book is settled; no high texture is created while a
 *   leaf is moving. The component cross-fades low -> high, then calls `releaseLow()`.
 * - Decoded `low` images for the next spreads in reading order are kept in RAM (not on the
 *   GPU), so turning quickly never waits for the network.
 *
 * The pool is framework-free: decoding and texture creation are injected, so it is unit-tested
 * without a browser.
 */

export type Quality = "low" | "high";

export interface DecodedImage {
  width: number;
  height: number;
  close(): void;
}

export interface TextureHandle<T> {
  texture: T;
  dispose(): void;
}

export interface TexturePoolDeps<T> {
  url(page: number, quality: Quality): string;
  decode(url: string, signal: AbortSignal): Promise<DecodedImage>;
  createTexture(image: DecodedImage): TextureHandle<T>;
  /** Called after any texture appears or disappears. */
  onChange(): void;
}

export interface PoolWindow {
  /** Pages on screen (current spread, or the pages involved in a turn). */
  visible: number[];
  /** Other pages of the previous, current and next spreads. */
  neighbours: number[];
  /** Pages whose low image should be decoded ahead, in priority order. */
  prefetch: number[];
  /** False while a leaf moves: no new high-quality textures then. */
  settled: boolean;
}

export interface PageTextures<T> {
  low?: T;
  high?: T;
  /** Width / height of the page image, once known. */
  aspect?: number;
}

interface Entry<T> {
  low?: TextureHandle<T>;
  high?: TextureHandle<T>;
  highImage?: DecodedImage;
}

const MAX_CONCURRENT = 4;

export class TexturePool<T> {
  private readonly deps: TexturePoolDeps<T>;
  private readonly entries = new Map<number, Entry<T>>();
  private readonly lowImages = new Map<number, DecodedImage>();
  private readonly aspects = new Map<number, number>();
  private readonly pending = new Map<string, AbortController>();
  private readonly queue: { page: number; quality: Quality }[] = [];
  private running = 0;
  private window: PoolWindow = { visible: [], neighbours: [], prefetch: [], settled: true };
  private disposed = false;

  constructor(deps: TexturePoolDeps<T>) {
    this.deps = deps;
  }

  private gpuPages(): Set<number> {
    return new Set([...this.window.visible, ...this.window.neighbours]);
  }

  private ramPages(): Set<number> {
    return new Set([...this.window.visible, ...this.window.neighbours, ...this.window.prefetch]);
  }

  setWindow(window: PoolWindow): void {
    if (this.disposed) return;
    this.window = window;
    const gpu = this.gpuPages();
    const ram = this.ramPages();
    const visible = new Set(window.visible);
    let changed = false;

    // 1. GPU textures outside the window go away.
    for (const [page, entry] of this.entries) {
      if (gpu.has(page)) continue;
      this.disposeEntry(entry);
      this.entries.delete(page);
      changed = true;
    }
    // 2. Decoded low images outside the RAM window are closed.
    for (const [page, image] of this.lowImages) {
      if (ram.has(page)) continue;
      image.close();
      this.lowImages.delete(page);
    }
    // 3. Requests nobody needs any more are cancelled (high ones too once a leaf moves).
    const highNeeded = (page: number) => window.settled && visible.has(page);
    for (const [key, controller] of this.pending) {
      const [pageText, quality] = key.split(":");
      const page = Number(pageText);
      const needed = quality === "low" ? ram.has(page) : highNeeded(page);
      if (!needed) {
        controller.abort();
        this.pending.delete(key);
      }
    }
    for (let i = this.queue.length - 1; i >= 0; i -= 1) {
      const item = this.queue[i]!;
      const needed = item.quality === "low" ? ram.has(item.page) : highNeeded(item.page);
      if (!needed) this.queue.splice(i, 1);
    }
    // 4. Low textures for window pages whose image is already decoded.
    for (const page of gpu) changed = this.ensureLowTexture(page) || changed;
    // 5. Requests, in priority order: visible low, visible high (settled), neighbours, prefetch.
    for (const page of window.visible) this.request(page, "low");
    if (window.settled) for (const page of window.visible) this.request(page, "high");
    for (const page of window.neighbours) this.request(page, "low");
    for (const page of window.prefetch) this.request(page, "low");
    this.pump();
    if (changed) this.deps.onChange();
  }

  get(page: number): PageTextures<T> {
    const entry = this.entries.get(page);
    return { low: entry?.low?.texture, high: entry?.high?.texture, aspect: this.aspects.get(page) };
  }

  /** The cross-fade to the high texture finished: the low texture can go. */
  releaseLow(page: number): void {
    const entry = this.entries.get(page);
    if (!entry?.high || !entry.low) return;
    entry.low.dispose();
    entry.low = undefined;
    this.deps.onChange();
  }

  stats(): { gpuPages: number; gpuTextures: number; qualities: Record<number, Quality>; prefetched: number[] } {
    const qualities: Record<number, Quality> = {};
    let gpuTextures = 0;
    for (const [page, entry] of this.entries) {
      if (entry.low) gpuTextures += 1;
      if (entry.high) gpuTextures += 1;
      if (entry.high) qualities[page] = "high";
      else if (entry.low) qualities[page] = "low";
    }
    return {
      gpuPages: Object.keys(qualities).length,
      gpuTextures,
      qualities,
      prefetched: [...this.lowImages.keys()].sort((a, b) => a - b),
    };
  }

  dispose(): void {
    this.disposed = true;
    for (const controller of this.pending.values()) controller.abort();
    this.pending.clear();
    this.queue.length = 0;
    for (const entry of this.entries.values()) this.disposeEntry(entry);
    this.entries.clear();
    for (const image of this.lowImages.values()) image.close();
    this.lowImages.clear();
  }

  // --- internals ---------------------------------------------------------------------

  private disposeEntry(entry: Entry<T>): void {
    entry.low?.dispose();
    entry.high?.dispose();
    entry.highImage?.close();
  }

  private ensureLowTexture(page: number): boolean {
    const image = this.lowImages.get(page);
    if (!image) return false;
    const entry = this.entries.get(page) ?? {};
    if (entry.low || entry.high) return false;
    entry.low = this.deps.createTexture(image);
    this.entries.set(page, entry);
    return true;
  }

  private has(page: number, quality: Quality): boolean {
    if (quality === "low") return this.lowImages.has(page) || Boolean(this.entries.get(page)?.high);
    return Boolean(this.entries.get(page)?.high);
  }

  private request(page: number, quality: Quality): void {
    const key = `${page}:${quality}`;
    if (this.has(page, quality) || this.pending.has(key)) return;
    if (this.queue.some((item) => item.page === page && item.quality === quality)) return;
    this.queue.push({ page, quality });
  }

  private pump(): void {
    while (this.running < MAX_CONCURRENT && this.queue.length > 0) {
      const { page, quality } = this.queue.shift()!;
      const key = `${page}:${quality}`;
      if (this.has(page, quality) || this.pending.has(key)) continue;
      const controller = new AbortController();
      this.pending.set(key, controller);
      this.running += 1;
      this.deps
        .decode(this.deps.url(page, quality), controller.signal)
        .then((image) => this.accept(page, quality, image, controller))
        .catch(() => undefined)
        .finally(() => {
          this.running -= 1;
          if (this.pending.get(key) === controller) this.pending.delete(key);
          this.pump();
        });
    }
  }

  private accept(page: number, quality: Quality, image: DecodedImage, controller: AbortController): void {
    if (this.disposed || controller.signal.aborted) {
      image.close();
      return;
    }
    this.aspects.set(page, image.width / image.height);
    if (quality === "low") {
      if (!this.ramPages().has(page)) {
        image.close();
        return;
      }
      this.lowImages.get(page)?.close();
      this.lowImages.set(page, image);
      if (this.gpuPages().has(page) && this.ensureLowTexture(page)) this.deps.onChange();
      return;
    }
    // High quality: only for pages still visible, and never while a leaf moves (the answer
    // may arrive after the turn started; the settled window asks again).
    if (!this.window.settled || !this.window.visible.includes(page)) {
      image.close();
      return;
    }
    const entry = this.entries.get(page) ?? {};
    entry.high?.dispose();
    entry.highImage?.close();
    entry.high = this.deps.createTexture(image);
    entry.highImage = image;
    this.entries.set(page, entry);
    this.deps.onChange();
  }
}
