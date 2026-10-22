"use client";

/**
 * Settings (UC-01): every change applies at once and is saved.
 *
 * - Language: the whole UI switches language and direction immediately (<html lang dir>).
 * - Graphics preset: remounts the hall canvas with the preset's options (ARCHITECTURE 10.3).
 * - Ambient light: the hall's exposure follows the slider live; saved when it settles.
 * - Default reading direction for new books.
 * - Categories (CategoryManager).
 */

import { useEffect, useId, useRef, useState } from "react";

import type { GraphicsQuality, ReadingDirection, SettingsPatch, UiLanguage } from "@/lib/api";
import { formatNumber, t } from "@/lib/i18n";
import { useLibraryStore } from "@/store/useLibraryStore";

import { CategoryManager } from "./CategoryManager";
import { FieldError, Modal, Segmented } from "./Modal";

export const AMBIENT_MIN = 0.4;
export const AMBIENT_MAX = 1.5;
const AMBIENT_STEP = 0.05;
/** The slider saves this long after the last move (it previews live meanwhile). */
const AMBIENT_SAVE_MS = 300;

/** Language names are written in their own script in both UIs. */
const LANGUAGES: { value: UiLanguage; label: string }[] = [
  { value: "en", label: "English" },
  { value: "ar", label: "العربية" },
];

export function SettingsModal() {
  const open = useLibraryStore((state) => state.settingsOpen);
  const settings = useLibraryStore((state) => state.settings);
  const language = settings.ui_language;
  const [error, setError] = useState<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ids = { language: useId(), graphics: useId(), graphicsHint: useId(), ambient: useId(), direction: useId(), directionHint: useId(), categories: useId() };

  useEffect(() => {
    if (open) setError(null);
  }, [open]);

  const apply = (patch: SettingsPatch) => {
    setError(null);
    useLibraryStore
      .getState()
      .updateSettings(patch)
      .catch(() => setError(t("settings.saveFailed", {}, useLibraryStore.getState().settings.ui_language)));
  };

  const flushAmbient = () => {
    if (!saveTimer.current) return;
    clearTimeout(saveTimer.current);
    saveTimer.current = null;
    apply({ ambient_light: useLibraryStore.getState().settings.ambient_light });
  };

  const onAmbient = (value: number) => {
    useLibraryStore.getState().previewSettings({ ambient_light: value });
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(flushAmbient, AMBIENT_SAVE_MS);
  };

  // Closing never loses a pending slider value.
  useEffect(() => {
    if (!open) flushAmbient();
  }, [open]);

  const close = () => useLibraryStore.getState().openSettings(false);
  const presetHint = t(settings.graphics_quality === "auto" ? "preset.autoHint" : settings.graphics_quality === "performance" ? "preset.performanceHint" : "preset.highHint", {}, language);
  const percent = Math.round(settings.ambient_light * 100);
  const label = language === "ar" ? "text-14 font-semibold text-ink" : "text-14 font-medium text-ink";

  return (
    <Modal open={open} onClose={close} title={t("settings.title", {}, language)} testId="settings-modal" language={language}>
      <div className="flex flex-col gap-6">
        <section className="flex flex-col gap-5">
          <div className="flex flex-col gap-1.5">
            <span id={ids.language} className={label}>
              {t("settings.language", {}, language)}
            </span>
            <Segmented
              value={language}
              labelledBy={ids.language}
              options={LANGUAGES}
              onChange={(value) => apply({ ui_language: value })}
              testId="settings-language"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <span id={ids.graphics} className={label}>
              {t("settings.graphics", {}, language)}
            </span>
            <Segmented<GraphicsQuality>
              value={settings.graphics_quality}
              labelledBy={ids.graphics}
              describedBy={ids.graphicsHint}
              options={[
                { value: "auto", label: t("preset.auto", {}, language) },
                { value: "performance", label: t("preset.performance", {}, language) },
                { value: "high", label: t("preset.high", {}, language) },
              ]}
              onChange={(value) => apply({ graphics_quality: value })}
              testId="settings-graphics"
            />
            <p id={ids.graphicsHint} className="text-12 text-slate">
              {presetHint}
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <div className="flex items-baseline justify-between gap-3">
              <label htmlFor={ids.ambient} className={label}>
                {t("settings.ambient", {}, language)}
              </label>
              <bdi className="tabular text-14 text-slate" dir="ltr" data-testid="settings-ambient-value">
                {formatNumber(percent, language)}%
              </bdi>
            </div>
            <input
              id={ids.ambient}
              type="range"
              min={AMBIENT_MIN}
              max={AMBIENT_MAX}
              step={AMBIENT_STEP}
              value={settings.ambient_light}
              aria-valuetext={`${percent}%`}
              onChange={(event) => onAmbient(Number(event.target.value))}
              onPointerUp={flushAmbient}
              onBlur={flushAmbient}
              className="h-6 w-full cursor-pointer accent-lapis"
              data-testid="settings-ambient"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <span id={ids.direction} className={label}>
              {t("settings.defaultDirection", {}, language)}
            </span>
            <Segmented<ReadingDirection>
              value={settings.default_direction}
              labelledBy={ids.direction}
              describedBy={ids.directionHint}
              options={[
                { value: "LTR", label: t("direction.LTR", {}, language) },
                { value: "RTL", label: t("direction.RTL", {}, language) },
              ]}
              onChange={(value) => apply({ default_direction: value })}
              testId="settings-direction"
            />
            <p id={ids.directionHint} className="text-12 text-slate">
              {t("settings.defaultDirectionHint", {}, language)}
            </p>
          </div>
          {error ? <FieldError>{error}</FieldError> : null}
        </section>

        <section className="flex flex-col gap-3 border-t border-ink/8 pt-5" aria-labelledby={ids.categories}>
          <h3 id={ids.categories} className={language === "ar" ? "text-18 font-bold" : "text-18 font-semibold"}>
            {t("settings.categories", {}, language)}
          </h3>
          <CategoryManager language={language} />
        </section>
      </div>
    </Modal>
  );
}
