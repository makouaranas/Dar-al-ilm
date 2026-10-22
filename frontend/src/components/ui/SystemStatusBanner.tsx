"use client";

/**
 * System banners (docs/DESIGN.md 10.3 and 12.3), top centre under the top bar:
 *
 * - Software rendering (amber): graphics acceleration is off; per-browser steps to turn it
 *   on. Dismissible, remembered per device.
 * - Library service stopped (red): `GET /api/health` failed. It retries by itself after 3, 6,
 *   12, then every 30 s, and disappears when the service answers; Retry checks at once.
 *
 * Also the health monitor itself, and the full-screen page shown when WebGL2 is missing.
 */

import { ChevronDown, CircleAlert, TriangleAlert, X } from "lucide-react";
import { useEffect, useId, useState } from "react";

import * as api from "@/lib/api";
import { t, type Language } from "@/lib/i18n";
import { registerTestHook } from "@/lib/testApi";
import { useLibraryStore } from "@/store/useLibraryStore";

import { buttonClass } from "./Modal";

/** Backoff after a failed health check (docs: 3 s, 6 s, 12 s, then at most 30 s). */
export const RETRY_DELAYS_MS = [3000, 6000, 12_000, 30_000] as const;
/** How often a connected app checks that the service is still there. */
export const HEALTH_POLL_MS = 10_000;
export const SOFTWARE_DISMISSED_KEY = "dar.banner.software.dismissed";

const healthDebug: { checks: number; delays: number[]; nextAt: number | null } = { checks: 0, delays: [], nextAt: null };
let checkNow: () => void = () => undefined;
registerTestHook("health", () => ({ checks: healthDebug.checks, delays: [...healthDebug.delays], nextAt: healthDebug.nextAt }));
registerTestHook("healthCheckNow", () => checkNow());

/**
 * Checks `GET /api/health` every 10 s while connected, and with backoff while not. When the
 * service comes back after a failed start, the library loads.
 */
export function useHealthMonitor(): { nextRetryAt: number | null } {
  const [nextRetryAt, setNextRetryAt] = useState<number | null>(null);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let failures = 0;
    let stopped = false;
    let running = false;
    const schedule = (ms: number, retrying: boolean) => {
      if (timer) clearTimeout(timer);
      healthDebug.nextAt = performance.now() + ms;
      setNextRetryAt(retrying ? Date.now() + ms : null);
      timer = setTimeout(() => void check(), ms);
    };
    const check = async () => {
      if (stopped || running) return;
      running = true;
      healthDebug.checks += 1;
      try {
        await api.getHealth();
        failures = 0;
        const state = useLibraryStore.getState();
        if (state.connection !== "connected") state.setConnection("connected");
        if (!state.loaded) await state.fetchBootstrap();
        if (!stopped) schedule(HEALTH_POLL_MS, false);
      } catch {
        useLibraryStore.getState().setConnection("disconnected");
        const delay = RETRY_DELAYS_MS[Math.min(failures, RETRY_DELAYS_MS.length - 1)]!;
        failures += 1;
        healthDebug.delays.push(delay);
        if (!stopped) schedule(delay, true);
      } finally {
        running = false;
      }
    };
    checkNow = () => {
      if (timer) clearTimeout(timer);
      void check();
    };
    // The bootstrap request runs first; the first check follows shortly after it.
    schedule(useLibraryStore.getState().connection === "disconnected" ? 0 : HEALTH_POLL_MS, false);
    const unsubscribe = useLibraryStore.subscribe((state, previous) => {
      // A failed bootstrap: start the backoff now rather than in 10 s.
      if (state.connection === "disconnected" && previous.connection === "checking") checkNow();
    });
    const onWake = () => checkNow();
    window.addEventListener("online", onWake);
    window.addEventListener("focus", onWake);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      unsubscribe();
      window.removeEventListener("online", onWake);
      window.removeEventListener("focus", onWake);
      checkNow = () => undefined;
    };
  }, []);
  return { nextRetryAt };
}

function Banner(props: { tone: "warning" | "error"; children: React.ReactNode; testId: string }) {
  const { tone, children, testId } = props;
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      data-testid={testId}
      className={`panel pointer-events-auto flex w-full max-w-[640px] items-start gap-3 rounded-control border-s-[3px] py-3 ps-4 pe-2 text-14 text-ink ${
        tone === "error" ? "border-s-rubric" : "border-s-ochre"
      }`}
    >
      {tone === "error" ? (
        <CircleAlert size={20} strokeWidth={1.5} className="mt-px shrink-0 text-rubric" aria-hidden="true" />
      ) : (
        <TriangleAlert size={20} strokeWidth={1.5} className="mt-px shrink-0 text-ochre" aria-hidden="true" />
      )}
      {children}
    </div>
  );
}

/** Per-browser steps to turn graphics acceleration on. */
export function AccelerationSteps({ language, className = "" }: { language: Language; className?: string }) {
  return (
    <ul className={`flex list-disc flex-col gap-1.5 ps-5 ${className}`} data-testid="acceleration-steps">
      <li>{t("graphics.stepsChromium", {}, language)}</li>
      <li>{t("graphics.stepsFirefox", {}, language)}</li>
      <li>{t("graphics.stepsDriver", {}, language)}</li>
    </ul>
  );
}

function SoftwareBanner({ language }: { language: Language }) {
  const [dismissed, setDismissed] = useState(true);
  const [open, setOpen] = useState(false);
  const stepsId = useId();
  useEffect(() => {
    try {
      setDismissed(globalThis.localStorage?.getItem(SOFTWARE_DISMISSED_KEY) === "1");
    } catch {
      setDismissed(false);
    }
  }, []);
  if (dismissed) return null;
  const dismiss = () => {
    setDismissed(true);
    try {
      globalThis.localStorage?.setItem(SOFTWARE_DISMISSED_KEY, "1");
    } catch {
      // Without storage the banner simply returns next time.
    }
  };
  return (
    <Banner tone="warning" testId="software-banner">
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <p>{t("graphics.software", {}, language)}</p>
        <button type="button" className={`${buttonClass.link} self-start`} aria-expanded={open} aria-controls={stepsId} onClick={() => setOpen(!open)} data-testid="software-steps-toggle">
          {t("graphics.howTo", {}, language)}
          <ChevronDown size={16} strokeWidth={1.5} className={`transition-transform duration-(--motion-fast) ${open ? "rotate-180" : ""}`} aria-hidden="true" />
        </button>
        {open ? (
          <div id={stepsId} className="text-14 text-ink">
            <AccelerationSteps language={language} />
          </div>
        ) : null}
      </div>
      <button
        type="button"
        onClick={dismiss}
        aria-label={t("action.dismiss", {}, language)}
        className="flex size-8 shrink-0 items-center justify-center rounded-control text-slate transition-colors duration-(--motion-fast) ease-out hover:bg-ink/6 hover:text-ink"
        data-testid="software-dismiss"
      >
        <X size={18} strokeWidth={1.5} aria-hidden="true" />
      </button>
    </Banner>
  );
}

function ServiceBanner({ language, nextRetryAt }: { language: Language; nextRetryAt: number | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const seconds = nextRetryAt === null ? null : Math.max(0, Math.ceil((nextRetryAt - now) / 1000));
  return (
    <Banner tone="error" testId="service-banner">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p>{t("error.apiUnreachable", {}, language)}</p>
        {seconds !== null && seconds > 0 ? (
          <p className="tabular text-12 text-slate" data-testid="service-retry-in">
            {t("status.retryIn", { seconds }, language)}
          </p>
        ) : null}
      </div>
      <button type="button" className={`${buttonClass.secondary} h-8 shrink-0 px-3`} onClick={() => checkNow()} data-testid="service-retry">
        {t("action.retry", {}, language)}
      </button>
    </Banner>
  );
}

/** The banners, stacked top centre. `software` comes from the WebGL check. */
export function SystemStatusBanner({ software, children }: { software: boolean; children?: React.ReactNode }) {
  const connection = useLibraryStore((state) => state.connection);
  const language = useLibraryStore((state) => state.settings.ui_language);
  const { nextRetryAt } = useHealthMonitor();
  return (
    <div className="pointer-events-none absolute inset-x-0 top-[84px] z-30 flex flex-col items-center gap-2 px-4" data-testid="banners">
      {connection === "disconnected" ? <ServiceBanner language={language} nextRetryAt={nextRetryAt} /> : null}
      {software ? <SoftwareBanner language={language} /> : null}
      {children}
    </div>
  );
}

/** No WebGL2 at all: instructions instead of the hall (nothing 3D is attempted). */
export function NoWebglPage({ language }: { language: Language }) {
  return (
    <main className="flex min-h-dvh w-full items-center justify-center bg-ink p-6 text-paper" data-testid="no-webgl">
      <div className="flex max-w-[560px] flex-col gap-5">
        <p className={language === "ar" ? "text-24 font-bold" : "text-24 font-semibold"}>{t("app.name", {}, language)}</p>
        <p className="text-18 leading-relaxed">{t("error.noWebgl", {}, language)}</p>
        <AccelerationSteps language={language} className="text-16 text-paper/80" />
      </div>
    </main>
  );
}
