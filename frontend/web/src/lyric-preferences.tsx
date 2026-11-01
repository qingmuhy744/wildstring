import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { preferencesChanged, readPreference, writePreference } from './user-preferences';

type LyricPreferences = {
  size: 'small' | 'medium' | 'large';
  translation: boolean;
  romanization: boolean;
};
const changed = 'wildstring:lyric-preferences';
function read(): LyricPreferences {
  const size = readPreference('wildstring-lyric-size');
  return {
    size: size === 'small' || size === 'large' ? size : 'medium',
    translation: readPreference('wildstring:lyric-translation') !== 'false',
    romanization: readPreference('wildstring:lyric-romanization') === 'true',
  };
}
export function useLyricPreferences() {
  const [value, setValue] = useState(read);
  useEffect(() => {
    const update = () => setValue(read());
    window.addEventListener(changed, update);
    window.addEventListener(preferencesChanged, update);
    return () => {
      window.removeEventListener(changed, update);
      window.removeEventListener(preferencesChanged, update);
    };
  }, []);
  function update(next: Partial<LyricPreferences>) {
    if (next.size !== undefined) writePreference('wildstring-lyric-size', next.size);
    if (next.translation !== undefined)
      writePreference('wildstring:lyric-translation', String(next.translation));
    if (next.romanization !== undefined)
      writePreference('wildstring:lyric-romanization', String(next.romanization));
    window.dispatchEvent(new Event(changed));
  }
  return [value, update] as const;
}
export function LyricPreferenceControls() {
  const { t } = useTranslation();
  const [value, update] = useLyricPreferences();
  return (
    <>
      <label className="theme-control">
        <span>{t('settings.lyricSize')}</span>
        <select
          aria-label={t('settings.lyricSize')}
          value={value.size}
          onChange={(event) => update({ size: event.target.value as LyricPreferences['size'] })}
        >
          {(['small', 'medium', 'large'] as const).map((size) => (
            <option key={size} value={size}>
              {t(`settings.${size}`)}
            </option>
          ))}
        </select>
      </label>
      <label className="settings-check">
        <input
          type="checkbox"
          checked={value.translation}
          onChange={(event) => update({ translation: event.target.checked })}
        />
        {t('settings.translation')}
      </label>
      <label className="settings-check">
        <input
          type="checkbox"
          checked={value.romanization}
          onChange={(event) => update({ romanization: event.target.checked })}
        />
        {t('settings.romanization')}
      </label>
      <p className="muted">{t('settings.lyricNote')}</p>
    </>
  );
}
