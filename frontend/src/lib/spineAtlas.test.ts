import * as THREE from "three";
import { describe, expect, it } from "vitest";

import { ATLAS_CONFIG, atlasPages, cellsPerLayer, labelInk, labelRegion, planResident, type AtlasBay } from "./spineAtlas";

const auto = ATLAS_CONFIG.auto;

function bay(key: string, x: number, z: number, books: number): AtlasBay {
  return {
    key,
    x,
    z,
    labels: Array.from({ length: books }, (_, i) => ({ id: i, title: `Book ${i}`, author: null, thickness: 0.03, height: 0.3 })),
  };
}

describe("atlas cells", () => {
  it("fits 128 labels per layer at 512 x 64 and 512 at 256 x 32", () => {
    expect(cellsPerLayer(auto)).toBe(128);
    expect(cellsPerLayer(ATLAS_CONFIG.performance)).toBe(512);
  });

  it("keeps the spine's aspect ratio inside the cell", () => {
    // 60 pages: 0.015 m thick, 0.303 m tall -> wider than the cell: full width, thin strip.
    const thin = labelRegion({ thickness: 0.015, height: 0.303 }, auto);
    expect(thin.width).toBe(512);
    expect(thin.height).toBe(Math.floor(512 / (0.303 / 0.015)));
    // 1500 pages: 0.079 m thick -> full height, narrower.
    const thick = labelRegion({ thickness: 0.079, height: 0.303 }, auto);
    expect(thick.height).toBe(64);
    expect(thick.width).toBe(Math.floor((0.303 / 0.079) * 64));
  });

  it("uses gilt on dark cloth and ink on light cloth", () => {
    expect(labelInk(new THREE.Color("#2b3a55"))).toBe("gilt");
    expect(labelInk(new THREE.Color("#7a1f1f"))).toBe("gilt");
    expect(labelInk(new THREE.Color("#e8dcc0"))).toBe("ink");
    expect(labelInk(new THREE.Color("#c9b27a"))).toBe("ink");
  });
});

describe("planResident", () => {
  it("builds bays within 18 m, nearest first, up to the layer limit", () => {
    const bays = [bay("a", 0, 5, 10), bay("b", 0, 12, 10), bay("c", 0, 30, 10), bay("d", 0, 17, 200)];
    const pages = atlasPages(bays, { x: 0, z: 0 }, auto);
    expect(pages.map((p) => p.key)).toEqual(["a:0", "b:0", "c:0", "d:0", "d:1"]);
    expect(planResident(pages, new Set(), auto)).toEqual(["a:0", "b:0", "d:0", "d:1"]);
    expect(planResident(pages, new Set(), { ...auto, layers: 2 })).toEqual(["a:0", "b:0"]);
  });

  it("keeps resident pages until 25 m (hysteresis), then releases them", () => {
    const at = (z: number) => atlasPages([bay("a", 0, 0, 10)], { x: 0, z }, auto);
    expect(planResident(at(20), new Set(), auto)).toEqual([]);
    expect(planResident(at(20), new Set(["a:0"]), auto)).toEqual(["a:0"]);
    expect(planResident(at(26), new Set(["a:0"]), auto)).toEqual([]);
  });
});
