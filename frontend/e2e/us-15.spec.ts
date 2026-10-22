import { mkdirSync } from "node:fs";

import { expect, test, type Page } from "@playwright/test";

// US-15: the software-rendering banner, the no-WebGL page, the API outage banner and the badge.
// The cloud container renders WebGL with SwiftShader, so the software banner is expected here.
const SHOTS = "e2e/screenshots/us-15";
mkdirSync(SHOTS, { recursive: true });
const CLIENT = { "X-Dar-Client": "1" };

type Extra = Record<string, (...args: unknown[]) => unknown>;
const extra = <T,>(page: Page, key: string, ...args: unknown[]) =>
  page.evaluate(([k, a]) => (window.__DAR__!.extra as unknown as Extra)[k as string]!(...(a as unknown[])), [key, args] as const) as Promise<T>;

async function openHall(page: Page): Promise<void> {
  await page.goto("/?test=1");
  await page.waitForFunction(
    () => {
      const atlas = (window.__DAR__?.extra as unknown as Extra | undefined)?.atlas?.() as { resident: string[]; queued: number } | undefined;
      return atlas !== undefined && atlas.resident.length > 0 && atlas.queued === 0;
    },
    null,
    { timeout: 60_000 },
  );
}

test.afterEach(async ({ page }) => {
  await page.request.patch("/api/settings", { headers: CLIENT, data: { ui_language: "en" } });
});

test("software rendering shows a dismissible amber banner with per-browser steps; the dismissal is remembered", async ({ page }) => {
  await openHall(page);
  const graphics = await extra<{ webgl2: boolean; renderer: string | null; software: boolean | null }>(page, "graphics");
  expect(graphics.webgl2).toBe(true);
  expect(graphics.renderer).toMatch(/swiftshader/i);
  expect(graphics.software).toBe(true);

  const banner = page.getByTestId("software-banner");
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("Graphics acceleration is off, so 3D will be slow.");
  await page.getByTestId("software-steps-toggle").click();
  await expect(page.getByTestId("software-steps-toggle")).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByTestId("acceleration-steps").locator("li")).toHaveCount(3);
  await expect(page.getByTestId("acceleration-steps")).toContainText("Use graphics acceleration when available");
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/software-banner.png` });

  await page.getByTestId("software-dismiss").click();
  await expect(banner).toHaveCount(0);
  await openHall(page);
  await expect(page.getByTestId("software-banner")).toHaveCount(0);
  // Another device (cleared storage) sees it again.
  await page.evaluate(() => localStorage.removeItem("dar.banner.software.dismissed"));
  await openHall(page);
  await expect(page.getByTestId("software-banner")).toBeVisible();
  // The badge says the service is connected.
  await expect(page.getByTestId("connection-badge")).toHaveAttribute("data-state", "connected");
});

test("no WebGL2: a full-screen page with instructions, and no 3D at all", async ({ page }) => {
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    // Simulates a browser without WebGL2 (or with it blocked).
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...args: unknown[]) {
      if (type === "webgl2" || type === "webgl") return null;
      return (original as (...a: unknown[]) => unknown).call(this, type, ...args);
    } as typeof original;
  });
  await page.goto("/?test=1");
  const screen = page.getByTestId("no-webgl");
  await expect(screen).toBeVisible({ timeout: 30_000 });
  await expect(screen).toContainText("This browser can't display 3D. Open Dar al Ilm in Chrome, Edge, Brave or Firefox with graphics acceleration on.");
  await expect(screen.getByTestId("acceleration-steps").locator("li")).toHaveCount(3);
  await expect(page.locator("canvas")).toHaveCount(0);
  await expect(page.getByTestId("hall")).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/no-webgl.png` });
});

test("API outage: a red banner says how to restart, retries with backoff, and clears when the service returns", async ({ page }) => {
  test.setTimeout(120_000);
  await openHall(page);
  await page.evaluate(() => localStorage.setItem("dar.banner.software.dismissed", "1"));
  await openHall(page);
  await expect(page.getByTestId("connection-badge")).toHaveAttribute("data-state", "connected");

  // The service stops: every /api request fails.
  await page.route("**/api/**", (route) => route.abort("connectionrefused"));
  await extra(page, "healthCheckNow");
  const banner = page.getByTestId("service-banner");
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("The library service stopped. Run ./start.sh to restart it.");
  await expect(page.getByTestId("connection-badge")).toHaveAttribute("data-state", "disconnected");
  await expect(page.getByTestId("connection-badge")).toContainText("Reconnecting");
  // Backoff: 3 s, then 6 s (then 12 s, at most 30 s).
  await expect.poll(async () => (await extra<{ delays: number[] }>(page, "health")).delays.slice(-2), { timeout: 20_000 }).toEqual([3000, 6000]);
  await expect(page.getByTestId("service-retry-in")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/api-down.png` });
  // The hall stays usable meanwhile (the banner does not cover it).
  const before = await page.evaluate(() => window.__DAR__!.extra.hall!.pose());
  await page.keyboard.down("ArrowUp");
  await page.waitForTimeout(600);
  await page.keyboard.up("ArrowUp");
  expect((await page.evaluate(() => window.__DAR__!.extra.hall!.pose())).z).toBeGreaterThan(before.z + 0.1);

  // The service returns: the next retry clears the banner (Retry checks at once).
  await page.unroute("**/api/**");
  await page.getByTestId("service-retry").click();
  await expect(banner).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByTestId("connection-badge")).toHaveAttribute("data-state", "connected");
});

test("Arabic: the banners and the no-WebGL page are translated", async ({ page }) => {
  await page.request.patch("/api/settings", { headers: CLIENT, data: { ui_language: "ar" } });
  await openHall(page);
  await page.evaluate(() => localStorage.removeItem("dar.banner.software.dismissed"));
  await openHall(page);
  await expect(page.getByTestId("software-banner")).toContainText("تسريع الرسوميات معطّل، لذا سيكون العرض ثلاثي الأبعاد بطيئًا.");
  await page.route("**/api/**", (route) => route.abort("connectionrefused"));
  await extra(page, "healthCheckNow");
  await expect(page.getByTestId("service-banner")).toContainText("توقفت خدمة المكتبة.");
  await page.unroute("**/api/**");
});
