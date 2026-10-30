import i18n from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import { initReactI18next } from 'react-i18next';
import en from './locales/en.json' with { type: 'json' };
import zh from './locales/zh-CN.json' with { type: 'json' };

/** Account setting stored on the server; `auto` follows the browser language. */
export type LanguagePreference = 'auto' | 'zh' | 'en';
export type UiLanguage = 'zh' | 'en';

export const languagePreferences: LanguagePreference[] = ['auto', 'zh', 'en'];

/** Chinese variants map to zh, every other language falls back to English. */
export function uiLanguage(tag: string | null | undefined): UiLanguage {
  return (tag || '').toLowerCase().split(/[-_]/)[0] === 'zh' ? 'zh' : 'en';
}

function systemLanguage(): UiLanguage {
  const detected = i18n.services.languageDetector?.detect();
  const tags = Array.isArray(detected) ? detected : detected ? [detected] : [];
  // Only the browser's primary language counts: zh* → zh, anything else → en.
  return uiLanguage(tags[0]);
}

function syncDocument(language: string) {
  if (typeof document === 'undefined') return;
  const ui = uiLanguage(language);
  document.documentElement.lang = ui === 'zh' ? 'zh-CN' : 'en';
  document.title = ui === 'zh' ? '野弦 WildString' : 'WildString';
}

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: { zh: { translation: zh }, en: { translation: en } },
    supportedLngs: ['zh', 'en'],
    nonExplicitSupportedLngs: true,
    load: 'languageOnly',
    fallbackLng: 'en',
    // Before sign-in the browser language decides; the account setting is
    // applied after /auth/status or login, so nothing is cached locally.
    detection: { order: ['navigator'], caches: [] },
    interpolation: { escapeValue: false },
    initAsync: false,
  });
i18n.on('languageChanged', syncDocument);
// The detector would pick the first *supported* tag (e.g. zh for "fr, zh");
// the product rule is primary language only, so settle it explicitly.
if (uiLanguage(i18n.language) !== systemLanguage()) void i18n.changeLanguage(systemLanguage());
syncDocument(i18n.language);

/** Apply the account's language preference (or the system language for `auto`). */
export function applyLanguagePreference(preference: LanguagePreference | null | undefined) {
  const target = preference === 'zh' || preference === 'en' ? preference : systemLanguage();
  if (uiLanguage(i18n.language) !== target) void i18n.changeLanguage(target);
}

export default i18n;
