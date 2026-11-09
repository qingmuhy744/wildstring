import { useTranslation } from 'react-i18next';
import { HelpLabel, HelpText } from './desktop-help';
import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import { OnlineLyrics } from './source-plugins';

const levelKeys = [
  'lyricScans.levelNone',
  'lyricScans.levelStatic',
  'lyricScans.levelSyncedLine',
  'lyricScans.levelBilingualLine',
  'lyricScans.levelSyncedWord',
  'lyricScans.levelBilingualWord',
];
const statusKeys: Record<string, string> = {
  running: 'lyricScans.statusRunning',
  queued: 'lyricScans.statusQueued',
  paused: 'lyricScans.statusPaused',
  completed: 'lyricScans.statusCompleted',
  cancelled: 'lyricScans.statusCancelled',
  ready: 'lyricScans.statusReady',
  review: 'lyricScans.statusReview',
  no_match: 'lyricScans.statusNoMatch',
  failed: 'lyricScans.statusFailed',
  locked: 'lyricScans.statusLocked',
  skipped_goal: 'lyricScans.statusSkippedGoal',
  skipped_scanned: 'lyricScans.statusSkippedScanned',
  stale: 'lyricScans.statusStale',
  applied: 'lyricScans.statusApplied',
  restored: 'lyricScans.statusRestored',
};
const getStatusLabel = (status: string, t: (k: string) => string) =>
  statusKeys[status] ? t(statusKeys[status]) : status;
const rateProfileKeyMap = {
  low: 'lyricScans.rateLabelLow',
  medium: 'lyricScans.rateLabelMedium',
  high: 'lyricScans.rateLabelHigh',
} as const;
type RateSettings = {
  default_profile: string;
  low_seconds: number;
  medium_seconds: number;
  high_seconds: number;
  version: number;
};
type Quality = {
  level: number;
  label: string;
  word_coverage: number;
  translation_coverage: number;
};
type ScanItem = {
  id: string;
  track_id: string;
  title: string;
  status: string;
  error: string | null;
  baseline: Quality | null;
  quality: Quality | null;
  results: Record<string, { status: string; error?: string }>;
};
type Scan = {
  id: string;
  status: string;
  total: number;
  created_at: number;
  counts: Record<string, number>;
  items: ScanItem[];
  options: { scope: string; scope_id: string | null; goal: number; interval_seconds: number };
  cooldowns: { plugin_id: string; cooldown_until: number; reason: string }[];
};

export function LyricScans({
  albumId,
  initialBatchId,
}: {
  albumId?: string;
  initialBatchId?: string;
}) {
  const { t } = useTranslation();
  const [goal, setGoal] = useState(5),
    [mode, setMode] = useState('upgrade');
  const [preference, setPreference] = useState('timing'),
    [interval, setIntervalValue] = useState(5);
  const [rateProfile, setRateProfile] = useState('low');
  const [defaults, setDefaults] = useState<RateSettings | null>(null);
  const [force, setForce] = useState(false),
    [preview, setPreview] = useState<number | null>(null);
  const [scans, setScans] = useState<Scan[]>([]),
    [batch, setBatch] = useState<Scan | null>(null);
  const [offset, setOffset] = useState(0),
    [selected, setSelected] = useState<string[]>([]);
  const [expanded, setExpanded] = useState(''),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  const [confirmation, setConfirmation] = useState<'apply' | 'cancel' | null>(null);
  const endpoint = '/manage/lyric-scans';
  const options = {
    scope: albumId ? 'album' : 'library',
    scope_id: albumId ?? null,
    mode,
    goal: mode === 'missing' ? 1 : goal,
    preference,
    rate_profile: rateProfile,
    interval_seconds: interval,
    force,
  };
  const optionsKey = JSON.stringify(options);
  useEffect(() => setPreview(null), [optionsKey]);
  async function load(id = batch?.id, pageOffset = offset) {
    const list = await api<{ items: Scan[] }>(endpoint);
    setScans(list.items.filter((s) => !albumId || s.options.scope_id === albumId));
    if (id) setBatch(await api<Scan>(`${endpoint}/${id}?offset=${pageOffset}&limit=50`));
  }
  useEffect(() => {
    void load(initialBatchId).catch((error) => setMessage(String(error)));
    void api<RateSettings>('/manage/lyric-scan-settings')
      .then((value) => {
        setDefaults(value);
        setRateProfile(value.default_profile);
      })
      .catch((error) => setMessage(String(error)));
  }, [albumId, initialBatchId]);
  useEffect(() => {
    if (!batch || batch.status !== 'running') return;
    let disposed = false;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible')
        void api<Scan>(`${endpoint}/${batch.id}?offset=${offset}&limit=50`)
          .then((result) => {
            if (!disposed) setBatch(result);
          })
          .catch((error) => {
            if (!disposed) setMessage(String(error));
          });
    }, 2000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [batch?.id, batch?.status, offset]);
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setMessage('');
    try {
      await action();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t('lyricScans.actionFailed'));
    } finally {
      setBusy(false);
    }
  }
  async function control(action: string) {
    if (!batch) return;
    await run(async () => {
      setBatch(
        await api(`${endpoint}/${batch.id}/control`, {
          method: 'POST',
          body: JSON.stringify({ action }),
        }),
      );
      setConfirmation(null);
      await load();
    });
  }
  return (
    <section className="management-card lyric-scans" aria-label={t('lyricScans.sectionAria')}>
      <h3>{albumId ? t('lyricScans.albumHeader') : t('lyricScans.libraryHeader')}</h3>
      <p className="muted">{t('lyricScans.headingMuted')}</p>
      <fieldset disabled={busy || !defaults} className="lyric-scan-options">
        <label>
          <HelpLabel hint="scanMode">{t('lyricScans.scanMode')}</HelpLabel>
          <select value={mode} onChange={(e) => setMode(e.target.value)}>
            <option value="upgrade">{t('lyricScans.modeUpgrade')}</option>
            <option value="missing">{t('lyricScans.modeMissing')}</option>
          </select>
        </label>
        {mode === 'upgrade' && (
          <label>
            <HelpLabel hint="lyricGoal">{t('lyricScans.targetGoal')}</HelpLabel>
            <select value={goal} onChange={(e) => setGoal(Number(e.target.value))}>
              {levelKeys.slice(1).map((key, i) => (
                <option value={i + 1} key={key}>
                  {t(key)}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          <HelpLabel hint="lyricPreference">{t('lyricScans.preference')}</HelpLabel>
          <select value={preference} onChange={(e) => setPreference(e.target.value)}>
            <option value="timing">{t('lyricScans.prefTiming')}</option>
            <option value="bilingual">{t('lyricScans.prefBilingual')}</option>
          </select>
        </label>
        <label>
          <HelpLabel hint="scanRate">{t('lyricScans.requestRate')}</HelpLabel>
          <select value={rateProfile} onChange={(e) => setRateProfile(e.target.value)}>
            <option value="low">
              {t('lyricScans.rateLow', { seconds: defaults?.low_seconds ?? 10 })}
            </option>
            <option value="medium">
              {t('lyricScans.rateMedium', { seconds: defaults?.medium_seconds ?? 5 })}
            </option>
            <option value="high">
              {t('lyricScans.rateHigh', { seconds: defaults?.high_seconds ?? 2 })}
            </option>
            <option value="custom">{t('lyricScans.rateCustom')}</option>
          </select>
        </label>
        {rateProfile === 'custom' && (
          <label>
            <HelpLabel hint="scanRate">{t('lyricScans.customIntervalLabel')}</HelpLabel>
            <input
              type="number"
              min={1}
              max={120}
              value={interval}
              onChange={(e) => setIntervalValue(Number(e.target.value))}
            />
          </label>
        )}
        <label className="check">
          <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
          <HelpLabel hint="scanForce">{t('lyricScans.forceRescan')}</HelpLabel>
        </label>
      </fieldset>
      <p className="muted">{t('lyricScans.rateExplanation')}</p>
      <div className="button-row">
        <button
          disabled={busy || interval < 1 || interval > 120 || !Number.isInteger(interval)}
          onClick={() =>
            void run(async () => {
              const result = await api<{ total: number }>(`${endpoint}/preview`, {
                method: 'POST',
                body: optionsKey,
              });
              setPreview(result.total);
            })
          }
        >
          {t('lyricScans.checkScope')}
        </button>
        {preview !== null && (
          <>
            <span>{t('lyricScans.scopeCount', { count: preview })}</span>
            <button
              className="primary"
              disabled={busy || preview === 0}
              onClick={() =>
                void run(async () => {
                  const result = await api<Scan>(endpoint, { method: 'POST', body: optionsKey });
                  setBatch(result);
                  setOffset(0);
                  setSelected([]);
                  await load(result.id, 0);
                })
              }
            >
              {t('lyricScans.startScan')}
            </button>
          </>
        )}
        <button disabled={busy} onClick={() => void run(() => load())}>
          {t('lyricScans.refreshTasks')}
        </button>
      </div>
      <p role="status">{message}</p>
      {defaults && (
        <details>
          <summary>{t('lyricScans.rateDefaultsSummary')}</summary>
          <fieldset disabled={busy} className="lyric-scan-options">
            {(['low', 'medium', 'high'] as const).map((key) => {
              const field = `${key}_seconds` as 'low_seconds' | 'medium_seconds' | 'high_seconds';
              return (
                <label key={key}>
                  {t('lyricScans.rateIntervalLabel', { rate: t(rateProfileKeyMap[key]) })}
                  <input
                    type="number"
                    min={1}
                    max={120}
                    value={defaults[field]}
                    onChange={(e) => setDefaults({ ...defaults, [field]: Number(e.target.value) })}
                  />
                </label>
              );
            })}
            <label>
              {t('lyricScans.defaultRateLabel')}
              <select
                value={defaults.default_profile}
                onChange={(e) => setDefaults({ ...defaults, default_profile: e.target.value })}
              >
                <option value="low">{t('lyricScans.rateLabelLow')}</option>
                <option value="medium">{t('lyricScans.rateLabelMedium')}</option>
                <option value="high">{t('lyricScans.rateLabelHigh')}</option>
              </select>
            </label>
            <button
              disabled={
                busy ||
                defaults.low_seconds < defaults.medium_seconds ||
                defaults.medium_seconds < defaults.high_seconds ||
                [defaults.low_seconds, defaults.medium_seconds, defaults.high_seconds].some(
                  (v) => !Number.isInteger(v) || v < 1 || v > 120,
                )
              }
              onClick={() =>
                void run(async () => {
                  setDefaults(
                    await api<RateSettings>('/manage/lyric-scan-settings', {
                      method: 'PUT',
                      body: JSON.stringify(defaults),
                    }),
                  );
                  setMessage(t('lyricScans.defaultsSaved'));
                })
              }
            >
              {t('lyricScans.saveDefaults')}
            </button>
          </fieldset>
        </details>
      )}
      {scans.length > 0 && (
        <details open={!batch}>
          <summary>{t('lyricScans.recentTasksSummary')}</summary>
          <div className="lyric-scan-history">
            {scans.map((scan) => (
              <button
                key={scan.id}
                onClick={() =>
                  void run(async () => {
                    setOffset(0);
                    setSelected([]);
                    setExpanded('');
                    await load(scan.id, 0);
                  })
                }
              >
                {t('lyricScans.recentTaskItem', {
                  time: new Date(scan.created_at * 1000).toLocaleString(),
                  total: scan.total,
                  status: getStatusLabel(scan.status, t),
                })}
              </button>
            ))}
          </div>
        </details>
      )}
      {batch && (
        <div aria-label={t('lyricScans.scanProgressAria')}>
          <p className="muted">
            {t('lyricScans.intervalNotice', { seconds: batch.options.interval_seconds })}
          </p>
          <h4>
            {t('lyricScans.batchTitle', {
              status: getStatusLabel(batch.status, t),
              total: batch.total,
            })}
          </h4>
          <div className="lyric-scan-counts">
            {Object.entries(batch.counts).map(([state, count]) => (
              <HelpText
                key={state}
                hint={
                  state === 'ready' || state === 'review'
                    ? 'lyricReady'
                    : state === 'no_match'
                      ? 'lyricNoMatch'
                      : ['skipped_goal', 'skipped_scanned'].includes(state)
                        ? 'lyricSkipped'
                        : undefined
                }
              >
                {getStatusLabel(state, t)} {count}
              </HelpText>
            ))}
          </div>
          {batch.cooldowns.map((c) => (
            <p key={c.plugin_id}>
              {t('lyricScans.cooldownNotice', {
                pluginId: c.plugin_id,
                time: new Date(c.cooldown_until * 1000).toLocaleTimeString(),
                reason: c.reason,
              })}
            </p>
          ))}
          <div className="button-row">
            {batch.status === 'running' && (
              <button disabled={busy} onClick={() => void control('pause')}>
                {t('lyricScans.pauseScan')}
              </button>
            )}
            {batch.status === 'paused' && (
              <button disabled={busy} onClick={() => void control('resume')}>
                {t('lyricScans.resumeScan')}
              </button>
            )}
            {['running', 'paused'].includes(batch.status) && (
              <button disabled={busy} onClick={() => setConfirmation('cancel')}>
                {t('lyricScans.cancelTask')}
              </button>
            )}
            {batch.status !== 'running' && (
              <button disabled={busy} onClick={() => void control('retry_failed')}>
                {t('lyricScans.retryFailedOnly')}
              </button>
            )}
            <button
              disabled={busy || !batch.items.some((i) => i.status === 'ready')}
              onClick={() =>
                setSelected(batch.items.filter((i) => i.status === 'ready').map((i) => i.id))
              }
            >
              {t('lyricScans.selectReadyOnPage')}
            </button>
            <button disabled={busy || !selected.length} onClick={() => setConfirmation('apply')}>
              {t('lyricScans.confirmSelectedLyrics', { count: selected.length })}
            </button>
          </div>
          {confirmation && (
            <div
              className="lyric-scan-confirm"
              role="group"
              aria-label={t('lyricScans.confirmGroupAria')}
            >
              <p>
                {confirmation === 'apply'
                  ? t('lyricScans.confirmApplyPrompt', { count: selected.length })
                  : t('lyricScans.confirmCancelPrompt')}
              </p>
              <button
                disabled={busy}
                onClick={() =>
                  confirmation === 'cancel'
                    ? void control('cancel')
                    : void run(async () => {
                        const result = await api<{ items: { status: string }[] }>(
                          `${endpoint}/${batch.id}/apply`,
                          { method: 'POST', body: JSON.stringify({ item_ids: selected }) },
                        );
                        setMessage(
                          t('lyricScans.appliedResultNotice', {
                            appliedCount: result.items.filter((i) => i.status === 'applied').length,
                            conflictCount: result.items.filter((i) => i.status === 'conflict')
                              .length,
                          }),
                        );
                        setSelected([]);
                        setConfirmation(null);
                        batch.items.forEach((i) =>
                          window.dispatchEvent(
                            new CustomEvent('wildstring:lyrics-updated', { detail: i.track_id }),
                          ),
                        );
                        await load();
                      })
                }
              >
                {t('lyricScans.confirmButton')}
              </button>
              <button disabled={busy} onClick={() => setConfirmation(null)}>
                {t('lyricScans.backButton')}
              </button>
            </div>
          )}
          <ul className="lyric-scan-items">
            {batch.items.map((item) => (
              <li key={item.id}>
                <div className="lyric-scan-item-heading">
                  <label>
                    <input
                      type="checkbox"
                      aria-label={t('lyricScans.selectTrackAria', { title: item.title })}
                      disabled={item.status !== 'ready' || busy}
                      checked={selected.includes(item.id)}
                      onChange={(e) =>
                        setSelected((ids) =>
                          e.target.checked ? [...ids, item.id] : ids.filter((id) => id !== item.id),
                        )
                      }
                    />
                    <strong>{item.title}</strong>
                  </label>
                  <span>{getStatusLabel(item.status, t)}</span>
                </div>
                <p>
                  {item.baseline?.label ?? t('lyricScans.notCheckedYet')}
                  {item.quality && ` → ${item.quality.label}`}
                </p>
                {item.error && (
                  <p role="status">
                    {t('lyricScans.sourceIssuePrefix')}
                    {item.error}
                  </p>
                )}
                <div className="button-row">
                  <button
                    disabled={busy}
                    onClick={() => setExpanded(expanded === item.id ? '' : item.id)}
                  >
                    {t('lyricScans.previewCandidates')}
                  </button>
                  <button
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        const lock = await api<{ version: number; locked: boolean }>(
                          `/manage/tracks/${item.track_id}/lyric-lock`,
                        );
                        await api(`/manage/tracks/${item.track_id}/lyric-lock`, {
                          method: 'PUT',
                          body: JSON.stringify({ ...lock, locked: !lock.locked }),
                        });
                        setMessage(
                          lock.locked
                            ? t('lyricScans.unlockedNotice')
                            : t('lyricScans.lockedNotice'),
                        );
                      })
                    }
                  >
                    {t('lyricScans.toggleLock')}
                  </button>
                  {item.status === 'applied' && (
                    <button
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          await api(`/manage/lyric-scan-items/${item.id}/restore`, {
                            method: 'POST',
                          });
                          window.dispatchEvent(
                            new CustomEvent('wildstring:lyrics-updated', { detail: item.track_id }),
                          );
                          await load();
                        })
                      }
                    >
                      {t('lyricScans.restorePreCleanup')}
                    </button>
                  )}
                </div>
                {expanded === item.id && (
                  <OnlineLyrics
                    trackId={item.track_id}
                    applied={() => {
                      void load();
                    }}
                  />
                )}
              </li>
            ))}
          </ul>
          <div className="button-row">
            <button
              disabled={busy || offset === 0}
              onClick={() =>
                void run(async () => {
                  const value = Math.max(0, offset - 50);
                  setOffset(value);
                  setSelected([]);
                  await load(batch.id, value);
                })
              }
            >
              {t('lyricScans.prevPage')}
            </button>
            <span>
              {Math.min(offset + 1, batch.total)}–{Math.min(offset + 50, batch.total)} /{' '}
              {batch.total}
            </span>
            <button
              disabled={busy || offset + 50 >= batch.total}
              onClick={() =>
                void run(async () => {
                  const value = offset + 50;
                  setOffset(value);
                  setSelected([]);
                  await load(batch.id, value);
                })
              }
            >
              {t('lyricScans.nextPage')}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

export function LyricScanDialog({
  albumId,
  batchId,
  onClose,
}: {
  albumId?: string;
  batchId?: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    return () => {
      dialog.current?.close();
      previous?.focus();
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      className="metadata-refresh-dialog lyric-scan-dialog"
      aria-label={albumId ? t('lyricScans.albumHeader') : t('lyricScans.libraryHeader')}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <header className="lyric-scan-header">
        <strong>{albumId ? t('lyricScans.albumHeader') : t('lyricScans.libraryHeader')}</strong>
        <button onClick={onClose} aria-label={t('lyricScans.closeAria')}>
          {t('lyricScans.close')}
        </button>
      </header>
      <LyricScans albumId={albumId} initialBatchId={batchId} />
    </dialog>
  );
}

export function LyricScanEntry() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <section className="management-card">
      <h2>{t('lyricScans.entryTitle')}</h2>
      <p className="muted">{t('lyricScans.entryMuted')}</p>
      <button onClick={() => setOpen(true)}>{t('lyricScans.openLyricScans')}</button>
      {open && <LyricScanDialog onClose={() => setOpen(false)} />}
    </section>
  );
}
