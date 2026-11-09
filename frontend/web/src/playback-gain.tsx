import { HelpLabel, HelpText } from './desktop-help';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from './api';

export type GainRecord = {
  track_id: string;
  album_id: string | null;
  factor: number;
  requested_db: number;
  applied_db: number;
  limited: boolean;
  peak_known: boolean;
  can_analyze?: boolean;
  settings: { version: number; mode: string; preamp_db: number; prevent_clipping: boolean };
  track: { version: number; gain_db: number };
  album: { version: number; gain_db: number };
  analysis: { status: string; error: string | null };
};

type Meter = { analyser: AnalyserNode; buffer: Float32Array<ArrayBuffer> };
let meter: Meter | null = null;

/** Output sample peak in 0..1 (-60..0 dBFS), plus a sampled full-scale warning. */
export function readAudioPeak(): [number, boolean] {
  if (!meter) return [0, false];
  meter.analyser.getFloatTimeDomainData(meter.buffer);
  let peak = 0;
  for (const sample of meter.buffer) {
    const magnitude = Math.abs(sample);
    if (magnitude > peak) peak = magnitude;
  }
  const level = peak > 0 ? Math.max(0, Math.min(1, (20 * Math.log10(peak) + 60) / 60)) : 0;
  return [level, peak >= 1];
}

export function usePlaybackGain(
  audio: RefObject<HTMLAudioElement | null>,
  trackId: string | undefined,
  userId: string,
  volume: number,
) {
  const graph = useRef<{ context: AudioContext; gain: GainNode } | null>(null);
  const factor = useRef(1),
    desiredVolume = useRef(volume);
  desiredVolume.current = volume;
  function apply() {
    const element = audio.current;
    if (!element) return;
    element.volume = Math.max(
      0,
      Math.min(1, desiredVolume.current * (graph.current ? 1 : Math.min(1, factor.current))),
    );
    if (graph.current)
      graph.current.gain.gain.setTargetAtTime(
        factor.current,
        graph.current.context.currentTime,
        0.03,
      );
  }
  function prepare() {
    if (!audio.current) return;
    if (!graph.current && typeof AudioContext !== 'undefined') {
      try {
        const context = new AudioContext();
        const gain = context.createGain();
        context.createMediaElementSource(audio.current).connect(gain);
        gain.connect(context.destination);
        try {
          // Analysis tap: a single analyser down-mixes to the mono signal.
          const analyser = context.createAnalyser();
          analyser.fftSize = 1024;
          gain.connect(analyser);
          meter = { analyser, buffer: new Float32Array(analyser.fftSize) };
        } catch {
          /* Metering is optional; playback must not depend on it. */
        }
        graph.current = { context, gain };
        apply();
      } catch {
        /* Base playback remains available when Web Audio is unsupported. */
      }
    }
    void graph.current?.context.resume().catch(() => {});
    apply();
  }
  useEffect(() => {
    apply();
  }, [volume]);
  useEffect(() => {
    const controller = new AbortController();
    factor.current = 1;
    apply();
    const load = () => {
      if (!trackId || trackId.startsWith('podcast_ep_')) return;
      void api<GainRecord>(`/tracks/${trackId}/playback-gain`, { signal: controller.signal })
        .then((value) => {
          if (!controller.signal.aborted) {
            factor.current = Number.isFinite(value.factor)
              ? Math.max(0.001, Math.min(32, value.factor))
              : 1;
            apply();
          }
        })
        .catch(() => {});
    };
    load();
    window.addEventListener('wildstring:gain-updated', load);
    return () => {
      controller.abort();
      window.removeEventListener('wildstring:gain-updated', load);
    };
  }, [trackId, userId]);
  useEffect(
    () => () => {
      meter = null;
      void graph.current?.context.close().catch(() => {});
    },
    [],
  );
  return { prepare };
}

export function GainControls({ trackId }: { trackId?: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (open && dialog.current && !dialog.current.open) dialog.current.showModal();
  }, [open]);
  const [record, setRecord] = useState<GainRecord | null>(null);
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  async function load() {
    if (trackId) setRecord(await api(`/tracks/${trackId}/playback-gain`));
  }
  useEffect(() => {
    setRecord(null);
    if (open) void load().catch((error) => setMessage(error.message));
  }, [open, trackId]);
  const scanning = record && ['queued', 'running'].includes(record.analysis.status);
  useEffect(() => {
    if (!open || !scanning) return;
    const timer = setInterval(() => {
      void load().catch(() => {});
    }, 2000);
    return () => clearInterval(timer);
  }, [open, scanning, trackId]);
  async function run(work: () => Promise<unknown>, success: string) {
    if (busy) return;
    setBusy(true);
    setMessage('');
    try {
      await work();
      await load();
      window.dispatchEvent(new Event('wildstring:gain-updated'));
      setMessage(success);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t('playbackGain.notSaved'));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <button disabled={!trackId} onClick={() => setOpen(true)}>
        {t('playbackGain.loudness')}
      </button>
      {open && (
        <dialog
          ref={dialog}
          onCancel={(event) => {
            event.preventDefault();
            setOpen(false);
          }}
          aria-label={t('playbackGain.dialogAria')}
          className="playlist-editor gain-dialog"
          style={{ maxHeight: '90dvh', overflow: 'auto' }}
        >
          <div className="editor-heading">
            <div>
              <span className="eyebrow">PLAYBACK GAIN</span>
              <h2>{t('playbackGain.dialogTitle')}</h2>
              <p className="muted">{t('playbackGain.dialogDescription')}</p>
            </div>
            <button
              type="button"
              className="icon-button"
              aria-label={t('playbackGain.close')}
              tabIndex={-1}
              onClick={() => setOpen(false)}
            >
              ×
            </button>
          </div>
          <p role="status">{message}</p>
          {record && (
            <fieldset disabled={busy}>
              <label>
                <HelpLabel hint="replayGain">{t('playbackGain.autoReplayGain')}</HelpLabel>
                <select
                  value={record.settings.mode}
                  onChange={(e) =>
                    setRecord({
                      ...record,
                      settings: { ...record.settings, mode: e.target.value },
                    })
                  }
                >
                  <option value="off">{t('playbackGain.off')}</option>
                  <option value="track">{t('playbackGain.trackGain')}</option>
                  <option value="album">{t('playbackGain.albumGain')}</option>
                </select>
              </label>
              <label>
                <HelpLabel hint="gainPreamp">{t('playbackGain.gainPreamp')}</HelpLabel>
                <input
                  type="number"
                  min="-12"
                  max="12"
                  step="0.5"
                  value={record.settings.preamp_db}
                  onChange={(e) =>
                    setRecord({
                      ...record,
                      settings: { ...record.settings, preamp_db: Number(e.target.value) },
                    })
                  }
                />
              </label>
              <label className="check-label">
                <input
                  type="checkbox"
                  checked={record.settings.prevent_clipping}
                  onChange={(e) =>
                    setRecord({
                      ...record,
                      settings: { ...record.settings, prevent_clipping: e.target.checked },
                    })
                  }
                />
                <HelpLabel hint="clipping">{t('playbackGain.preventClipping')}</HelpLabel>
              </label>
              <button
                onClick={() =>
                  void run(
                    () =>
                      api('/playback/gain-settings', {
                        method: 'PUT',
                        body: JSON.stringify(record.settings),
                      }),
                    t('playbackGain.eqSaved'),
                  )
                }
              >
                {t('playbackGain.saveEq')}
              </button>
              {(['album', 'track'] as const).map((scope) => (
                <div key={scope}>
                  <label>
                    <HelpLabel hint={scope === 'album' ? 'albumGain' : 'trackGain'}>
                      {scope === 'album'
                        ? t('playbackGain.albumGainLabel')
                        : t('playbackGain.trackGainLabel')}
                    </HelpLabel>
                    <input
                      type="number"
                      aria-label={
                        scope === 'album'
                          ? t('playbackGain.albumGainAria')
                          : t('playbackGain.trackGainAria')
                      }
                      min="-12"
                      max="12"
                      step="0.5"
                      disabled={scope === 'album' && !record.album_id}
                      value={record[scope].gain_db}
                      onChange={(e) =>
                        setRecord({
                          ...record,
                          [scope]: { ...record[scope], gain_db: Number(e.target.value) },
                        })
                      }
                    />
                  </label>
                  <button
                    disabled={scope === 'album' && !record.album_id}
                    onClick={() =>
                      void run(
                        () =>
                          api(`/tracks/${trackId}/playback-gain`, {
                            method: 'PUT',
                            body: JSON.stringify({ scope, ...record[scope] }),
                          }),
                        t('playbackGain.manualGainSaved'),
                      )
                    }
                  >
                    {scope === 'album'
                      ? t('playbackGain.saveAlbumGain')
                      : t('playbackGain.saveTrackGain')}
                  </button>
                  <button
                    disabled={scope === 'album' && !record.album_id}
                    onClick={() =>
                      void run(
                        () =>
                          api(`/tracks/${trackId}/playback-gain`, {
                            method: 'PUT',
                            body: JSON.stringify({
                              scope,
                              version: record[scope].version,
                              gain_db: 0,
                            }),
                          }),
                        t('playbackGain.resetNotice'),
                      )
                    }
                  >
                    {scope === 'album'
                      ? t('playbackGain.resetAlbum')
                      : t('playbackGain.resetTrack')}
                  </button>
                </div>
              ))}
              <p>
                <HelpText hint="gainResult">
                  {t('playbackGain.gainStats', {
                    requested: record.requested_db.toFixed(1),
                    applied: record.applied_db.toFixed(1),
                    limited: record.limited ? t('playbackGain.peakLimited') : '',
                    peak: record.peak_known
                      ? t('playbackGain.peakKnown')
                      : t('playbackGain.peakUnknown'),
                  })}
                </HelpText>
              </p>
              {record.can_analyze && (
                <button
                  disabled={!!scanning}
                  onClick={() =>
                    void run(
                      () => api(`/manage/tracks/${trackId}/analyze-loudness`, { method: 'POST' }),
                      t('playbackGain.analysisEnqueued'),
                    )
                  }
                >
                  {scanning ? t('playbackGain.analyzing') : t('playbackGain.analyzeLoudness')}
                </button>
              )}
              {record.analysis.error && (
                <p>
                  {t('playbackGain.analysisIncomplete', {
                    error: record.analysis.error,
                  })}
                </p>
              )}
            </fieldset>
          )}
          <div className="editor-footer">
            <button type="button" onClick={() => setOpen(false)}>
              {t('playbackGain.closeSettings')}
            </button>
          </div>
        </dialog>
      )}
    </>
  );
}
