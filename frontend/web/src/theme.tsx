import {
  preferencesChanged,
  preferenceKey,
  readPreference,
  writePreference,
} from './user-preferences';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

type Theme = 'system' | 'light' | 'dark';
const KEY = 'wildstring-theme';
function savedTheme(): Theme {
  try {
    const value = readPreference(KEY);
    return value === 'light' || value === 'dark' ? value : 'system';
  } catch {
    return 'system';
  }
}
function apply(theme: Theme) {
  const dark =
    theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', dark ? '#171716' : '#f6f3ed');
}
// Apply before React mounts; the small bootstrap in index.html also prevents a first-paint flash.
apply(savedTheme());
if (typeof window !== 'undefined') {
  window.addEventListener(preferencesChanged, () => apply(savedTheme()));
  const systemMedia = window.matchMedia('(prefers-color-scheme: dark)');
  systemMedia.addEventListener('change', () => {
    if (savedTheme() === 'system') apply('system');
  });
  window.addEventListener('wildstring:theme-changed', (event: Event) => {
    if (event instanceof CustomEvent && ['system', 'light', 'dark'].includes(event.detail)) {
      writePreference(KEY, event.detail);
      apply(event.detail);
    }
  });
}
export function ThemeControl() {
  const { t } = useTranslation();
  const [theme, setTheme] = useState<Theme>(savedTheme);
  useEffect(() => {
    const system = matchMedia('(prefers-color-scheme: dark)');
    const update = () => apply(theme);
    const sync = (event: StorageEvent) => {
      if (event.key === preferenceKey(KEY) || event.key === null) setTheme(savedTheme());
    };
    const changed = (event: Event) => {
      if (event instanceof CustomEvent && ['system', 'light', 'dark'].includes(event.detail))
        setTheme(event.detail);
    };
    const accountChanged = () => setTheme(savedTheme());
    window.addEventListener(preferencesChanged, accountChanged);
    update();
    window.addEventListener('wildstring:theme-changed', changed);
    system.addEventListener('change', update);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(preferencesChanged, accountChanged);
      system.removeEventListener('change', update);
      window.removeEventListener('storage', sync);
      window.removeEventListener('wildstring:theme-changed', changed);
    };
  }, [theme]);
  return (
    <label className="theme-control">
      <span>{t('theme.label')}</span>
      <select
        aria-label={t('theme.aria')}
        value={theme}
        onChange={(event) => {
          const value = event.target.value as Theme;
          setTheme(value);
          apply(value);
          try {
            writePreference(KEY, value);
          } catch {
            /* Device storage may be disabled. */
          }
          window.dispatchEvent(new CustomEvent('wildstring:theme-changed', { detail: value }));
        }}
      >
        <option value="system">{t('theme.system')}</option>
        <option value="light">{t('theme.light')}</option>
        <option value="dark">{t('theme.dark')}</option>
      </select>
    </label>
  );
}

export function ThemeToggleCompact() {
  const { t } = useTranslation();
  const [theme, setTheme] = useState<Theme>(savedTheme);
  useEffect(() => {
    const sync = () => setTheme(savedTheme());
    window.addEventListener(preferencesChanged, sync);
    window.addEventListener('wildstring:theme-changed', sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(preferencesChanged, sync);
      window.removeEventListener('wildstring:theme-changed', sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  const next = () => {
    const cycle: Record<Theme, Theme> = { system: 'dark', dark: 'light', light: 'system' };
    const target = cycle[theme] || 'dark';
    setTheme(target);
    apply(target);
    try {
      writePreference(KEY, target);
    } catch {
      /* Device storage may be disabled. */
    }
    window.dispatchEvent(new CustomEvent('wildstring:theme-changed', { detail: target }));
  };

  const label = t(`theme.${theme}`);
  return (
    <button
      type="button"
      className="theme-toggle-compact"
      onClick={next}
      title={t('theme.compactTitle', { label })}
      aria-label={t('theme.compactAria', { label })}
    >
      <span className="theme-toggle-dot" />
      <span>{label}</span>
    </button>
  );
}
