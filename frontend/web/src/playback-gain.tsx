import { useEffect, useRef, useState, type RefObject } from 'react';
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
      if (!trackId) return;
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
      void graph.current?.context.close().catch(() => {});
    },
    [],
  );
  return { prepare };
}

export function GainControls({ trackId }: { trackId?: string }) {
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
      setMessage(error instanceof Error ? error.message : '调整未保存。');
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <button disabled={!trackId} onClick={() => setOpen(true)}>
        响度
      </button>
      {open && (
        <dialog
          ref={dialog}
          onCancel={(event) => {
            event.preventDefault();
            setOpen(false);
          }}
          aria-label="响度均衡与手动调整"
          className="playlist-editor gain-dialog"
          style={{ maxHeight: '90dvh', overflow: 'auto' }}
        >
          <h2>响度均衡与手动调整</h2>
          <p>按账号保存，不修改音频。专辑整体调整与单曲额外微调叠加；自动均衡可独立关闭。</p>
          <p role="status">{message}</p>
          {record && (
            <fieldset disabled={busy}>
              <label>
                自动响度均衡
                <select
                  value={record.settings.mode}
                  onChange={(e) =>
                    setRecord({
                      ...record,
                      settings: { ...record.settings, mode: e.target.value },
                    })
                  }
                >
                  <option value="off">关闭</option>
                  <option value="track">单曲 ReplayGain</option>
                  <option value="album">专辑 ReplayGain（缺少时使用单曲值）</option>
                </select>
              </label>
              <label>
                自动均衡前级（dB）
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
                根据峰值防止削波（未知峰值时只衰减）
              </label>
              <button
                onClick={() =>
                  void run(
                    () =>
                      api('/playback/gain-settings', {
                        method: 'PUT',
                        body: JSON.stringify(record.settings),
                      }),
                    '均衡设置已保存。',
                  )
                }
              >
                保存均衡设置
              </button>
              {(['album', 'track'] as const).map((scope) => (
                <div key={scope}>
                  <label>
                    {scope === 'album' ? '整张专辑增减（dB）' : '本曲额外微调（dB）'}
                    <input
                      type="number"
                      aria-label={scope === 'album' ? '专辑增益 dB' : '单曲增益 dB'}
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
                        '手动增益已保存。',
                      )
                    }
                  >
                    保存{scope === 'album' ? '专辑' : '单曲'}调整
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
                        '此项已归零。',
                      )
                    }
                  >
                    归零{scope === 'album' ? '专辑' : '单曲'}
                  </button>
                </div>
              ))}
              <p>
                请求增益 {record.requested_db.toFixed(1)} dB · 实际 {record.applied_db.toFixed(1)}{' '}
                dB{record.limited ? '（受峰值保护限制）' : ''} · 峰值
                {record.peak_known ? '已知' : '未知'}
              </p>
              {record.can_analyze && (
                <button
                  disabled={!!scanning}
                  onClick={() =>
                    void run(
                      () => api(`/manage/tracks/${trackId}/analyze-loudness`, { method: 'POST' }),
                      '已加入后台响度分析，不改写文件。',
                    )
                  }
                >
                  {scanning ? '正在分析…' : '分析本曲响度与峰值'}
                </button>
              )}
              {record.analysis.error && <p>分析未完成：{record.analysis.error}</p>}
            </fieldset>
          )}
          <button onClick={() => setOpen(false)}>关闭响度设置</button>
        </dialog>
      )}
    </>
  );
}
