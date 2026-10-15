import { useEffect, useState } from 'react';

type Theme = 'system' | 'light' | 'dark';
const KEY = 'wildstring-theme';
function savedTheme(): Theme {
  try {
    const value = localStorage.getItem(KEY);
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
export function ThemeControl() {
  const [theme, setTheme] = useState<Theme>(savedTheme);
  useEffect(() => {
    const system = matchMedia('(prefers-color-scheme: dark)');
    const update = () => apply(theme);
    const sync = (event: StorageEvent) => {
      if (event.key === KEY || event.key === null) setTheme(savedTheme());
    };
    const changed = (event: Event) => {
      if (event instanceof CustomEvent && ['system', 'light', 'dark'].includes(event.detail))
        setTheme(event.detail);
    };
    update();
    window.addEventListener('wildstring:theme-changed', changed);
    system.addEventListener('change', update);
    window.addEventListener('storage', sync);
    return () => {
      system.removeEventListener('change', update);
      window.removeEventListener('storage', sync);
      window.removeEventListener('wildstring:theme-changed', changed);
    };
  }, [theme]);
  return (
    <label className="theme-control">
      <span>外观</span>
      <select
        aria-label="外观模式"
        value={theme}
        onChange={(event) => {
          const value = event.target.value as Theme;
          setTheme(value);
          apply(value);
          try {
            localStorage.setItem(KEY, value);
          } catch {
            /* Device storage may be disabled. */
          }
          window.dispatchEvent(new CustomEvent('wildstring:theme-changed', { detail: value }));
        }}
      >
        <option value="system">跟随系统</option>
        <option value="light">浅色</option>
        <option value="dark">深色</option>
      </select>
    </label>
  );
}
