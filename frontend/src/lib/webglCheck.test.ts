import { describe, expect, it } from "vitest";

import { classifyRenderer, framesLookSoftware, median } from "./webglCheck";

describe("classifyRenderer", () => {
  it("recognises software rasterizers", () => {
    expect(classifyRenderer("ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)")).toBe(true);
    expect(classifyRenderer("llvmpipe (LLVM 15.0.7, 256 bits)")).toBe(true);
    expect(classifyRenderer("ANGLE (Microsoft, Microsoft Basic Render Driver Direct3D11 vs_5_0 ps_5_0)")).toBe(true);
    expect(classifyRenderer("Software Rasterizer")).toBe(true);
  });

  it("accepts real GPUs and leaves masked strings to the probe", () => {
    expect(classifyRenderer("ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0)")).toBe(false);
    expect(classifyRenderer("Apple M2")).toBe(false);
    expect(classifyRenderer("Mesa Intel(R) UHD Graphics 620 (KBL GT2)")).toBe(false);
    expect(classifyRenderer(null)).toBeNull();
    expect(classifyRenderer("Mozilla")).toBeNull();
    expect(classifyRenderer("WebKit WebGL")).toBeNull();
  });
});

describe("frame probe", () => {
  it("is software when the median of the first 30 frames is above 33 ms", () => {
    expect(median([1, 5, 3])).toBe(3);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(framesLookSoftware(Array.from({ length: 30 }, () => 2))).toBe(false);
    expect(framesLookSoftware(Array.from({ length: 30 }, (_, i) => (i < 14 ? 120 : 4)))).toBe(false);
    expect(framesLookSoftware(Array.from({ length: 30 }, (_, i) => (i < 16 ? 120 : 4)))).toBe(true);
    // Only the first 30 count.
    expect(framesLookSoftware([...Array.from({ length: 30 }, () => 3), ...Array.from({ length: 40 }, () => 200)])).toBe(false);
  });
});
