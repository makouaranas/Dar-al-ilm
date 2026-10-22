/**
 * Graphics capability check (risk R2): is WebGL2 there at all, and is it running on the GPU?
 *
 * - No WebGL2: the app shows a full-screen page with instructions and never starts the 3D hall.
 * - Software rendering: the `WEBGL_debug_renderer_info` renderer string names a software
 *   rasterizer (SwiftShader, llvmpipe, Microsoft Basic Render Driver...).
 * - When the browser masks that string (Firefox), a short probe renders 30 frames of a
 *   fill-heavy shader off screen and times each one; a median above 33 ms means no GPU. (The
 *   hall itself renders on demand, so its own first frames are not a steady sample.)
 */

export const SOFTWARE_RENDERER = /swiftshader|llvmpipe|software|basic render/i;
/** docs: median of the first 30 frames above 33 ms. */
export const SLOW_FRAME_MS = 33;
export const PROBE_FRAMES = 30;

export interface WebglInfo {
  webgl2: boolean;
  /** The unmasked renderer string, or null when the browser hides it. */
  renderer: string | null;
  /** true / false from the renderer string; null when it is masked (needs the probe). */
  software: boolean | null;
}

/** Strings browsers return instead of the real GPU name. */
const MASKED = /^(webkit webgl|mozilla|generic renderer|)$/i;

export function classifyRenderer(renderer: string | null): boolean | null {
  if (renderer === null || MASKED.test(renderer.trim())) return null;
  return SOFTWARE_RENDERER.test(renderer);
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** True when the frames are too slow for hardware rendering. */
export function framesLookSoftware(frameMs: readonly number[]): boolean {
  return median(frameMs.slice(0, PROBE_FRAMES)) > SLOW_FRAME_MS;
}

function releaseContext(gl: WebGL2RenderingContext): void {
  gl.getExtension("WEBGL_lose_context")?.loseContext();
}

export function detectWebgl(): WebglInfo {
  if (typeof document === "undefined") return { webgl2: false, renderer: null, software: null };
  const canvas = document.createElement("canvas");
  let gl: WebGL2RenderingContext | null = null;
  try {
    gl = canvas.getContext("webgl2");
  } catch {
    gl = null;
  }
  if (!gl) return { webgl2: false, renderer: null, software: null };
  const debug = gl.getExtension("WEBGL_debug_renderer_info");
  const renderer = debug ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)) : null;
  releaseContext(gl);
  return { webgl2: true, renderer, software: classifyRenderer(renderer) };
}

const PROBE_VERTEX = `#version 300 es
in vec2 position;
void main() { gl_Position = vec4(position, 0.0, 1.0); }`;

// A modest per-pixel loop: trivial for a GPU, slow for a CPU rasterizer.
const PROBE_FRAGMENT = `#version 300 es
precision highp float;
uniform float seed;
out vec4 color;
void main() {
  vec2 p = gl_FragCoord.xy / 1024.0;
  float v = seed;
  for (int i = 0; i < 48; i++) v = fract(sin(dot(p + v, vec2(12.9898, 78.233))) * 43758.5453);
  color = vec4(v, v, v, 1.0);
}`;

/** Times 30 frames of the probe (ms each), or null if the probe cannot run. */
export async function probeFrameTimes(size = 1024): Promise<number[] | null> {
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const gl = canvas.getContext("webgl2", { antialias: false, preserveDrawingBuffer: false });
  if (!gl) return null;
  const compile = (type: number, source: string) => {
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    return shader;
  };
  const program = gl.createProgram()!;
  gl.attachShader(program, compile(gl.VERTEX_SHADER, PROBE_VERTEX));
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, PROBE_FRAGMENT));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    releaseContext(gl);
    return null;
  }
  gl.useProgram(program);
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const location = gl.getAttribLocation(program, "position");
  gl.enableVertexAttribArray(location);
  gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0);
  const seed = gl.getUniformLocation(program, "seed");
  const pixel = new Uint8Array(4);
  const times: number[] = [];
  for (let frame = 0; frame < PROBE_FRAMES; frame += 1) {
    const start = performance.now();
    gl.uniform1f(seed, frame / PROBE_FRAMES);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    // Reading one pixel waits for the frame to finish.
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    times.push(performance.now() - start);
    // Let the page breathe between frames.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  releaseContext(gl);
  return times;
}

/** The full check: renderer string first, the probe only when the string is masked. */
export async function checkGraphics(): Promise<WebglInfo & { probeMs: number | null }> {
  const info = detectWebgl();
  if (!info.webgl2 || info.software !== null) return { ...info, probeMs: null };
  const times = await probeFrameTimes();
  if (!times) return { ...info, probeMs: null };
  return { ...info, software: framesLookSoftware(times), probeMs: median(times) };
}
