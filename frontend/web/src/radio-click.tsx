import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { preferencesChanged, readPreference, writePreference } from './user-preferences';

const KEY = 'wildstring:radio-click-sound';
const changed = 'wildstring:radio-click-sound-changed';

export function radioClickSoundEnabled(): boolean {
  return readPreference(KEY) === 'true';
}

let context: AudioContext | null = null;

function audioContext(): AudioContext | null {
  if (context) return context;
  try {
    if (typeof AudioContext === 'undefined') return null;
    context = new AudioContext();
  } catch {
    return null;
  }
  return context;
}

/** Short synthesized power-switch click for the retro radio transport. */
export function playRadioClick() {
  const ctx = audioContext();
  if (!ctx) return;
  if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
  const now = ctx.currentTime;

  const thump = ctx.createOscillator();
  const thumpGain = ctx.createGain();
  thump.type = 'sine';
  thump.frequency.setValueAtTime(88, now);
  thump.frequency.exponentialRampToValueAtTime(56, now + 0.09);
  thumpGain.gain.setValueAtTime(0.0001, now);
  thumpGain.gain.exponentialRampToValueAtTime(0.2, now + 0.008);
  thumpGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.11);
  thump.connect(thumpGain).connect(ctx.destination);
  thump.start(now);
  thump.stop(now + 0.12);

  const length = Math.floor(ctx.sampleRate * 0.02);
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const samples = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) samples[i] = (Math.random() * 2 - 1) * (1 - i / length);
  const click = ctx.createBufferSource();
  click.buffer = buffer;
  const highpass = ctx.createBiquadFilter();
  highpass.type = 'highpass';
  highpass.frequency.value = 2400;
  const clickGain = ctx.createGain();
  clickGain.gain.setValueAtTime(0.12, now);
  clickGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.03);
  click.connect(highpass).connect(clickGain).connect(ctx.destination);
  click.start(now);
}

/** Play the radio click only when the account preference is enabled. */
export function maybePlayRadioClick() {
  if (radioClickSoundEnabled()) playRadioClick();
}

export function useRadioClickSound() {
  const [enabled, setEnabled] = useState(radioClickSoundEnabled);
  useEffect(() => {
    const update = () => setEnabled(radioClickSoundEnabled());
    window.addEventListener(changed, update);
    window.addEventListener(preferencesChanged, update);
    return () => {
      window.removeEventListener(changed, update);
      window.removeEventListener(preferencesChanged, update);
    };
  }, []);
  function update(value: boolean) {
    writePreference(KEY, String(value));
    window.dispatchEvent(new Event(changed));
  }
  return [enabled, update] as const;
}

export function RadioClickControl() {
  const { t } = useTranslation();
  const [enabled, update] = useRadioClickSound();
  return (
    <>
      <label className="settings-check">
        <input
          type="checkbox"
          aria-label={t('settings.radioClickSound')}
          checked={enabled}
          onChange={(event) => update(event.target.checked)}
        />
        {t('settings.radioClickSound')}
      </label>
      <p className="muted">{t('settings.radioClickSoundDescription')}</p>
    </>
  );
}
