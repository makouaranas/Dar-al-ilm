import { mkdirSync, writeFileSync } from "node:fs";

import { expect, test, type Page } from "@playwright/test";

import type { Box } from "../src/lib/hallLayout";

// US-09: the 3D hall, walking, collision, Home, adaptive quality and the debug overlay.
const SHOTS = "e2e/screenshots/us-09";
mkdirSync(`${SHOTS}/frames`, { recursive: true });

const CLIENT = { "X-Dar-Client": "1" };
const RADIUS = 0.3;

async function openHall(page: Page): Promise<void> {
  await page.goto("/?test=1");
  await page.waitForFunction(
    () => (window.__DAR__?.renderInfo()?.calls ?? 0) > 0 && window.__DAR__?.extra.hall !== undefined,
    null,
    { timeout: 60_000 },
  );
  // Textures load behind Suspense: wait until the room itself is drawn (more than a few calls).
  await page.waitForFunction(() => window.__DAR__!.renderInfo()!.calls >= 10, null, { timeout: 60_000 });
}

const pose = (page: Page) => page.evaluate(() => window.__DAR__!.extra.hall!.pose());
const colliders = (page: Page) => page.evaluate(() => window.__DAR__!.extra.hall!.colliders());

async function teleport(page: Page, x: number, z: number, yaw: number, pitch = 0): Promise<void> {
  await page.evaluate(([a, b, c, d]) => window.__DAR__!.extra.hall!.teleport(a!, b!, c, d), [x, z, yaw, pitch]);
}

async function hold(page: Page, keys: string[], ms: number): Promise<void> {
  for (const key of keys) await page.keyboard.down(key);
  await page.waitForTimeout(ms);
  for (const key of keys) await page.keyboard.up(key);
}

/**
 * Hold `keys` until `done` holds for the camera pose (at most 30 s), whatever the frame rate:
 * movement is integrated per frame (at most 0.1 s each), so a slow software renderer covers far
 * less ground per second of wall time than a GPU.
 */
async function holdUntil(page: Page, keys: string[], done: (p: Awaited<ReturnType<typeof pose>>) => boolean): Promise<number> {
  const started = Date.now();
  for (const key of keys) await page.keyboard.down(key);
  for (let i = 0; i < 300 && !done(await pose(page)); i += 1) await page.waitForTimeout(100);
  for (const key of keys) await page.keyboard.up(key);
  return (Date.now() - started) / 1000;
}

async function waitStill(page: Page): Promise<void> {
  await page.waitForFunction(() => !window.__DAR__!.extra.hall!.pose().moving && !window.__DAR__!.extra.hall!.pose().flying, null, {
    timeout: 20_000,
  });
}

function distance(x: number, z: number, box: Box): number {
  const dx = Math.max(box.minX - x, 0, x - box.maxX);
  const dz = Math.max(box.minZ - z, 0, z - box.maxZ);
  return Math.hypot(dx, dz);
}

/** Sample the camera every ~50 ms while `action` runs. */
async function sampleWhile(page: Page, action: () => Promise<void>): Promise<{ x: number; z: number }[]> {
  await page.evaluate(() => {
    const w = window as unknown as { __samples: { x: number; z: number }[]; __sampling: boolean };
    w.__samples = [];
    w.__sampling = true;
    const tick = () => {
      if (!w.__sampling) return;
      const p = window.__DAR__!.extra.hall!.pose();
      w.__samples.push({ x: p.x, z: p.z });
      setTimeout(tick, 50);
    };
    tick();
  });
  await action();
  return page.evaluate(() => {
    const w = window as unknown as { __samples: { x: number; z: number }[]; __sampling: boolean };
    w.__sampling = false;
    return w.__samples;
  });
}

test("arrows and WASD walk and turn; dragging looks around without pointer lock", async ({ page }) => {
  await openHall(page);
  await page.screenshot({ path: `${SHOTS}/entrance.png` });
  expect(await page.evaluate(() => document.pointerLockElement)).toBeNull();

  await teleport(page, 0, 6.2, 180);
  const start = await pose(page);
  // Walk forward until 0.5 m are covered (frame-rate independent); never faster than 1.4 m/s,
  // plus the 200 ms stop after the key is released.
  const walked = await holdUntil(page, ["ArrowUp"], (p) => p.z - start.z >= 0.5);
  await waitStill(page);
  const forward = await pose(page);
  expect(forward.z - start.z).toBeGreaterThanOrEqual(0.5);
  expect(forward.z - start.z).toBeLessThan(1.4 * walked + 0.3);
  expect(Math.abs(forward.x - start.x)).toBeLessThan(0.01);
  expect(forward.yaw).toBeCloseTo(180, 5);

  await holdUntil(page, ["KeyS"], (p) => p.z < forward.z - 0.1);
  await waitStill(page);
  const back = await pose(page);
  expect(back.z).toBeLessThan(forward.z - 0.1);

  // Facing +Z, the right-hand side is -X.
  await holdUntil(page, ["KeyD"], (p) => p.x < back.x - 0.15);
  await waitStill(page);
  const strafed = await pose(page);
  expect(strafed.x).toBeLessThan(back.x - 0.15);
  await holdUntil(page, ["KeyA"], (p) => p.x > strafed.x + 0.15);
  await waitStill(page);
  expect((await pose(page)).x).toBeGreaterThan(strafed.x + 0.15);

  await holdUntil(page, ["KeyW", "ShiftLeft"], (p) => p.z > back.z + 0.3);
  await waitStill(page);
  expect((await pose(page)).z).toBeGreaterThan(back.z + 0.3);

  // Turning at 90 degrees per second: stop once past 10 degrees.
  await holdUntil(page, ["ArrowLeft"], (p) => p.yaw - 180 > 10);
  await waitStill(page);
  const turned = await pose(page);
  expect(turned.yaw - 180).toBeGreaterThan(10);
  expect(turned.yaw - 180).toBeLessThan(60);

  // Drag: 0.25 degrees per pixel, pitch clamped to +-35 degrees.
  await page.mouse.move(720, 450);
  await page.mouse.down();
  await page.mouse.move(820, 450, { steps: 5 });
  await page.mouse.up();
  expect((await pose(page)).yaw).toBeCloseTo(turned.yaw - 25, 3);
  await page.mouse.move(720, 200);
  await page.mouse.down();
  await page.mouse.move(720, 890, { steps: 10 });
  await page.mouse.up();
  expect((await pose(page)).pitch).toBeCloseTo(-35, 3);
  expect(await page.evaluate(() => document.pointerLockElement)).toBeNull();
});

test("walking into a bookcase and a wall for 3 s never enters a collision box, and slides", async ({ page }) => {
  await openHall(page);
  const boxes = await colliders(page);
  const bookcase = boxes.find((box) => box.kind === "bookcase" && box.minX < 0)!;
  const wall = boxes.find((box) => box.kind === "wall" && box.minX > 0)!;

  // The first bookcase faces +Z: stand in its aisle, face it (yaw 0 looks toward -Z) and push.
  await teleport(page, (bookcase.minX + bookcase.maxX) / 2, bookcase.maxZ + 0.6, 0);
  const intoBookcase = await sampleWhile(page, () => hold(page, ["ArrowUp"], 3000));
  await waitStill(page);
  const atBookcase = await pose(page);
  expect(atBookcase.z).toBeCloseTo(bookcase.maxZ + RADIUS, 2);

  // The right outer wall at the back of the first bay (the entrance zone's wall has a window
  // seat since US-19), walking diagonally into it (W + D while facing +X): slide along it.
  await teleport(page, wall.minX - 0.6, 9.0, -90);
  const intoWall = await sampleWhile(page, () => hold(page, ["KeyW", "KeyD"], 3000));
  await waitStill(page);
  const atWall = await pose(page);
  expect(atWall.x).toBeCloseTo(wall.minX - RADIUS, 2);
  expect(atWall.z).toBeGreaterThan(9.5);

  const samples = [...intoBookcase, ...intoWall, atBookcase, atWall];
  expect(samples.length).toBeGreaterThan(10);
  for (const sample of samples) {
    for (const box of boxes) expect(distance(sample.x, sample.z, box)).toBeGreaterThanOrEqual(RADIUS - 1e-3);
  }
});

test("Home flies back to the Entrance Desk pose in at most 0.8 s, around obstacles", async ({ page }) => {
  await openHall(page);
  const boxes = await colliders(page);
  const bookcase = boxes.find((box) => box.kind === "bookcase" && box.minX > 0)!;
  // Deep in a bay aisle, looking at the shelves.
  const startX = (bookcase.minX + bookcase.maxX) / 2;
  const startZ = bookcase.maxZ + 1.0;
  await teleport(page, startX, startZ, 90, 10);
  const samples = await sampleWhile(page, async () => {
    await page.keyboard.press("Home");
    await page.waitForFunction(() => window.__DAR__!.extra.hall!.lastFlight()?.end != null, null, { timeout: 10_000 });
  });
  const flight = (await page.evaluate(() => window.__DAR__!.extra.hall!.lastFlight()))!;
  expect(flight.duration).toBeLessThanOrEqual(800);
  // The flight is timed by the clock: it lands on the first frame at or after its duration
  // (however slow the frames are; software rendering here manages only a few per second).
  const due = flight.start + flight.duration;
  expect(flight.end).toBe(flight.frames.at(-1));
  expect(flight.end!).toBeGreaterThanOrEqual(due);
  expect(flight.frames.slice(0, -1).every((time) => time < due)).toBe(true);
  const home = await pose(page);
  expect(home.x).toBeCloseTo(0, 3);
  expect(home.z).toBeCloseTo(0.7, 3);
  expect(home.yaw).toBeCloseTo(180, 3);
  expect(home.pitch).toBeCloseTo((Math.atan2(1.0 - 1.62, 6.5 - 0.7) * 180) / Math.PI, 3);
  // Every sampled point stays in walkable space (half the player radius of margin for flights).
  for (const sample of samples) {
    for (const box of boxes) expect(distance(sample.x, sample.z, box)).toBeGreaterThanOrEqual(RADIUS / 2 - 1e-3);
  }
  writeFileSync(`${SHOTS}/home-flight.txt`, `${JSON.stringify(flight)}\n`);
});

test("reduced motion: Home is a 300 ms fade cut", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openHall(page);
  await teleport(page, 1.5, 12, 0);
  await page.keyboard.press("Home");
  await page.waitForFunction(() => window.__DAR__!.extra.hall!.lastFlight()?.end != null, null, { timeout: 10_000 });
  const flight = (await page.evaluate(() => window.__DAR__!.extra.hall!.lastFlight()))!;
  expect(flight.duration).toBe(300);
  expect((await pose(page)).z).toBeCloseTo(0.7, 3);
});

test("no frames are rendered once walking stops", async ({ page }) => {
  await openHall(page);
  await teleport(page, 0, 6.2, 180);
  await hold(page, ["ArrowUp"], 500);
  await waitStill(page);
  await page.waitForTimeout(300);
  const before = await page.evaluate(() => window.__DAR__!.frames());
  await page.waitForTimeout(2000);
  expect(await page.evaluate(() => window.__DAR__!.frames())).toBe(before);
});

test("the demo hall stays within the draw-call and triangle budgets", async ({ page }) => {
  const urls: string[] = [];
  page.on("request", (request) => urls.push(request.url()));
  await openHall(page);
  const views: [string, number, number, number, number][] = [
    ["entrance", 0, 0.7, 180, -6],
    ["nave", 0, 6.2, 180, -4],
    ["bay", -1.2, 9.7, 90, 0],
    ["back", 0, 15, 0, 8],
  ];
  const lines: string[] = [];
  for (const [name, x, z, yaw, pitch] of views) {
    await teleport(page, x, z, yaw, pitch);
    await page.waitForTimeout(600);
    const info = (await page.evaluate(() => window.__DAR__!.renderInfo()))!;
    lines.push(`${name}: calls=${info.calls} triangles=${info.triangles} textures=${info.textures} geometries=${info.geometries}`);
    expect(info.calls).toBeLessThan(150);
    expect(info.triangles).toBeLessThan(300_000);
    if (name === "nave") await page.screenshot({ path: `${SHOTS}/nave.png` });
    if (name === "back") await page.screenshot({ path: `${SHOTS}/toward-entrance.png` });
  }
  writeFileSync(`${SHOTS}/budget.txt`, `${lines.join("\n")}\n`);
  // Everything comes from 127.0.0.1: textures, fonts, scripts.
  const external = urls.filter((url) => !/^(data:|blob:|http:\/\/127\.0\.0\.1[:/])/.test(url));
  expect(external).toEqual([]);
  expect(urls.some((url) => url.includes("/textures/floor-light.webp"))).toBe(true);
});

test("with no categories the hall shows the entrance, the desk and one empty bay outline", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const real = await (await page.request.get("/api/bootstrap")).json();
  await page.route("**/api/bootstrap", (route) =>
    route.fulfill({ json: { ...real, categories: [], books: [], currently_reading: [] } }),
  );
  await openHall(page);
  const boxes = await colliders(page);
  expect(boxes.filter((box) => box.kind === "bookcase")).toEqual([]);
  // The arcade is architecture: its columns stand at the empty bay's boundaries and in the
  // entrance zone (US-19), on both sides.
  const columnZs = [...new Set(boxes.filter((box) => box.kind === "column").map((box) => +((box.minZ + box.maxZ) / 2).toFixed(4)))];
  expect(columnZs.sort((a, b) => a - b)).toEqual([8 / 3, 16 / 3, 8, 11.4].map((z) => expect.closeTo(z, 3)));
  expect(boxes.some((box) => box.kind === "desk")).toBe(true);
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${SHOTS}/empty-hall.png` });
  // Turn toward the empty bay outline on the -X side.
  await teleport(page, 0.6, 7.2, 125, -18);
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${SHOTS}/empty-bay.png` });
  expect(errors).toEqual([]);
});

test("F2 toggles the debug overlay with live renderer numbers", async ({ page }) => {
  await openHall(page);
  await expect(page.getByTestId("debug-hud")).toHaveCount(0);
  await page.keyboard.press("F2");
  const hud = page.getByTestId("debug-hud");
  await expect(hud).toBeVisible();
  await teleport(page, 0, 6.2, 180);
  await hold(page, ["ArrowUp"], 1500);
  await waitStill(page);
  await expect(hud.locator('[data-stat="draw calls"]')).not.toHaveText("0");
  await expect(hud.locator('[data-stat="FPS (motion)"]')).not.toHaveText("–");
  for (const label of ["triangles", "textures", "geometries", "dpr", "level", "preset", "frame ms (last)"]) {
    await expect(hud.locator(`[data-stat="${label}"]`)).toBeVisible();
  }
  await page.screenshot({ path: `${SHOTS}/debug-hud.png` });
  await page.keyboard.press("F2");
  await expect(hud).toHaveCount(0);
});

test("graphics presets and ambient light configure the renderer", async ({ page }) => {
  // Three hall loads; software rendering draws the US-19 hall at about 2 s per frame.
  test.setTimeout(180_000);
  const set = (data: Record<string, unknown>) => page.request.patch("/api/settings", { headers: CLIENT, data });
  try {
    await set({ graphics_quality: "performance", ambient_light: 0.6 });
    await openHall(page);
    const performance = await page.evaluate(() => window.__DAR__!.extra.canvas!());
    expect(performance).toMatchObject({ preset: "performance", antialias: false, shadows: false, toneMapping: "AgX" });
    expect(performance.exposure).toBeCloseTo(0.6, 5);
    expect(performance.dpr).toBeLessThanOrEqual(1);

    await set({ graphics_quality: "high", ambient_light: 1.0 });
    await openHall(page);
    const high = await page.evaluate(() => window.__DAR__!.extra.canvas!());
    expect(high).toMatchObject({ preset: "high", antialias: true, shadows: true, exposure: 1 });
  } finally {
    await set({ graphics_quality: "auto", ambient_light: 1.0 });
  }
  await openHall(page);
  expect(await page.evaluate(() => window.__DAR__!.extra.canvas!())).toMatchObject({ preset: "auto", antialias: true, shadows: true });
});

test("frame sequence of a walk down the nave", async ({ page }) => {
  // Sixteen rendered frames at about 2 s each with software rendering (US-19 hall).
  test.setTimeout(180_000);
  // Browser video needs a newer ffmpeg than the cloud container has (D68): frames instead.
  await openHall(page);
  await teleport(page, 0, 0.7, 180, -6);
  for (let step = 0; step < 16; step += 1) {
    await teleport(page, 1.3 + Math.sin(step / 5) * 0.15, 0.7 + step * 0.55, 180 - Math.sin(step / 4) * 8, -6 + step * 0.2);
    await page.waitForTimeout(250);
    await page.screenshot({ path: `${SHOTS}/frames/walk-${String(step).padStart(2, "0")}.png` });
  }
});
