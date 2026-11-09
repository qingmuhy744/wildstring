import { useTranslation } from 'react-i18next';
import { hints } from './help-content';
import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import { JobDiagnostics, jobStatus, type ProviderJob } from './provider-diagnostics';
import { DialogCloseButton } from './dialog-close';

export type RefreshTarget = { scope: 'track' | 'album' | 'library'; id?: string; label: string };
interface RefreshBatch {
  total: number;
  queued: number;
  running: number;
  completed: number;
  failed: number;
  no_match: number;
  stale: number;
  items: ProviderJob[];
  truncated: boolean;
}
export function MetadataRefreshDialog({
  target,
  onClose,
  onQueued,
}: {
  target: RefreshTarget;
  onClose: () => void;
  onQueued?: () => void;
}) {
  const { t } = useTranslation();
  const dialog = useRef<HTMLDialogElement>(null),
    pending = useRef(false);
  const progress = useRef<HTMLParagraphElement>(null);
  const [mode, setMode] = useState('missing'),
    [force, setForce] = useState(false);
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState(''),
    [done, setDone] = useState(false);
  const [batchId, setBatchId] = useState(''),
    [batch, setBatch] = useState<RefreshBatch | null>(null);
  const [statusError, setStatusError] = useState(''),
    [retry, setRetry] = useState(0);
  useEffect(() => {
    if (done) {
      progress.current?.focus({ preventScroll: true });
      if (dialog.current) dialog.current.scrollTop = 0;
    }
  }, [done]);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const node = dialog.current;
    node?.showModal();
    return () => {
      node?.close();
      previous?.focus({ preventScroll: true });
    };
  }, []);
  useEffect(() => {
    if (!batchId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    setStatusError('');
    async function load() {
      try {
        const response = await api<RefreshBatch>(
          `/manage/providers/refresh/${encodeURIComponent(batchId)}`,
          { signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        setBatch(response);
        setStatusError('');
        if (response.queued + response.running > 0) timer = setTimeout(() => void load(), 2000);
      } catch {
        if (!controller.signal.aborted) setStatusError(t('metadataRefresh.statusReadError'));
      }
    }
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [batchId, retry]);
  async function submit() {
    if (pending.current || done) return;
    pending.current = true;
    setBusy(true);
    setMessage(t('metadataRefresh.submitting'));
    try {
      const result = await api<{
        queued: number;
        already_active: number;
        total: number;
        batch_id: string;
      }>('/manage/providers/refresh', {
        method: 'POST',
        body: JSON.stringify({
          scope: target.scope,
          ...(target.id ? { id: target.id } : {}),
          mode,
          force,
        }),
      });
      const upgraded = (result as { upgraded?: number }).upgraded || 0;
      const intents = (result as { refresh_intents?: number }).refresh_intents || 0;
      setMessage(
        result.total
          ? result.queued === 0 && result.already_active === result.total && !upgraded && !intents
            ? t('metadataRefresh.allAlreadyQueued', { total: result.total })
            : t('metadataRefresh.queuedNotice', {
                queued: result.queued,
                alreadyActive: result.already_active,
                intentSuffix:
                  upgraded || intents
                    ? t('metadataRefresh.refreshIntentUpdated', { count: upgraded + intents })
                    : '',
              })
          : t('metadataRefresh.noTracksToUpdate'),
      );
      setDone(true);
      setBatchId(result.batch_id || '');
      onQueued?.();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t('metadataRefresh.submitFailed'));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  const active = !!batchId && (!batch || batch.queued + batch.running > 0);
  const finished = batch ? batch.completed + batch.failed + batch.no_match + batch.stale : 0;
  return (
    <dialog
      className="metadata-refresh-dialog"
      ref={dialog}
      aria-label={t('metadataRefresh.dialogAria')}
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!busy) onClose();
      }}
    >
      <header>
        <h2>{t('metadataRefresh.heading')}</h2>
        <DialogCloseButton
          aria-label={t('metadataRefresh.closeAria')}
          disabled={busy}
          onClick={onClose}
        />
      </header>
      <p>{target.label}</p>
      {!done ? (
        <fieldset disabled={busy}>
          <label>
            {t('metadataRefresh.updateMode')}
            <select value={mode} onChange={(e) => setMode(e.target.value)}>
              <option value="missing">{t('metadataRefresh.modeMissing')}</option>
              <option value="all">{t('metadataRefresh.modeAll')}</option>
            </select>
          </label>
          <label className="check-label">
            <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
            {t('metadataRefresh.forceRequery')}
          </label>
          <p className="muted">{t('metadataRefresh.forceRequeryHelp')}</p>
        </fieldset>
      ) : (
        <p className="muted">
          {t('metadataRefresh.currentSettingsSummary', {
            mode: mode === 'all' ? t('metadataRefresh.modeAll') : t('metadataRefresh.modeMissing'),
            force: force
              ? t('metadataRefresh.forceOnlineLabel')
              : t('metadataRefresh.reuseRecentLabel'),
          })}
        </p>
      )}
      <p className="muted">{t('metadataRefresh.noticeSuggestionsFirst')}</p>
      <p ref={progress} tabIndex={-1} role="status" aria-live="polite">
        {batch ? t('metadataRefresh.batchSubmitted') : message}
        {batchId && (
          <>
            <br />
            {batch
              ? t('metadataRefresh.batchProgress', {
                  total: batch.total,
                  finished,
                  queued: batch.queued,
                  running: batch.running,
                })
              : t('metadataRefresh.loadingProgress')}
            {batch && !active ? t('metadataRefresh.batchCompletedSuffix') : ''}
          </>
        )}
      </p>
      {batch && (
        <section
          className="metadata-batch-results"
          aria-label={t('metadataRefresh.batchResultsAria')}
        >
          <progress
            aria-label={t('metadataRefresh.batchProgressAria')}
            max={batch.total || 1}
            value={finished}
          />
          <p className="muted">
            {t('metadataRefresh.batchStats', {
              completed: batch.completed,
              failed: batch.failed,
              noMatch: batch.no_match,
              stale: batch.stale,
            })}
          </p>
          <ul className="metadata-batch-tracks">
            {batch.items.map((job) => (
              <li key={job.id}>
                <strong>{job.title || t('metadataRefresh.defaultTrackTitle')}</strong>
                <span>{t(jobStatus[job.status] || 'providerDiagnostics.statusUnknown')}</span>
                <JobDiagnostics job={job} />
              </li>
            ))}
          </ul>
          {batch.truncated && (
            <p className="muted">
              {t('metadataRefresh.truncatedNotice', { count: batch.items.length })}
            </p>
          )}
        </section>
      )}
      {statusError && (
        <div className="error" role="alert">
          <p>{statusError}</p>
          <button onClick={() => setRetry((value) => value + 1)}>
            {t('metadataRefresh.retryProgress')}
          </button>
        </div>
      )}
      {done && active && (
        <p className="muted">{t('metadataRefresh.backgroundContinuationNotice')}</p>
      )}
      <footer>
        <button onClick={onClose} disabled={busy}>
          {done
            ? active
              ? t('metadataRefresh.closeBackground')
              : t('metadataRefresh.doneButton')
            : t('metadataRefresh.cancelButton')}
        </button>
        {!done && (
          <button className="primary" disabled={busy} onClick={() => void submit()}>
            {busy ? t('metadataRefresh.submittingButton') : t('metadataRefresh.startButton')}
          </button>
        )}
      </footer>
    </dialog>
  );
}
const names: Record<string, string> = { musicbrainz: 'MusicBrainz', lastfm: 'Last.fm' };
export function ProviderPriority({
  value,
  onChange,
}: {
  value: string[];
  onChange: (value: string[]) => void;
}) {
  const { t } = useTranslation();
  const list = useRef<HTMLOListElement>(null);
  const drag = useRef<{ from: number; to: number; pointer: number; centers: number[] } | null>(
    null,
  );
  const [over, setOver] = useState<number | null>(null);
  function move(from: number, to: number) {
    if (from === to || to < 0 || to >= value.length) return;
    const next = [...value];
    next.splice(to, 0, next.splice(from, 1)[0]);
    onChange(next);
    requestAnimationFrame(() =>
      list.current?.querySelectorAll<HTMLButtonElement>('button')[to]?.focus(),
    );
  }
  return (
    <>
      <p id="provider-priority-help" className="muted">
        {t('metadataRefresh.providerPriorityHelp')}
      </p>
      <ol
        ref={list}
        className="provider-priority"
        aria-label={t('metadataRefresh.providerPriorityAria')}
        data-help={hints.providerPriority}
      >
        {value.map((source, index) => (
          <li key={source} className={over === index ? 'priority-target' : ''}>
            <button
              className="icon-button"
              aria-label={t('metadataRefresh.dragPriorityAria', {
                source: names[source] || source,
              })}
              aria-describedby="provider-priority-help"
              onPointerDown={(event) => {
                if (!event.isPrimary || event.button !== 0) return;
                event.preventDefault();
                event.currentTarget.setPointerCapture(event.pointerId);
                drag.current = {
                  from: index,
                  to: index,
                  pointer: event.pointerId,
                  centers: Array.from(list.current!.children, (node) => {
                    const b = node.getBoundingClientRect();
                    return (b.top + b.bottom) / 2;
                  }),
                };
                setOver(index);
              }}
              onPointerMove={(event) => {
                const current = drag.current;
                if (!current || event.pointerId !== current.pointer) return;
                current.to = current.centers.reduce(
                  (best, center, i) =>
                    Math.abs(center - event.clientY) <
                    Math.abs(current.centers[best] - event.clientY)
                      ? i
                      : best,
                  0,
                );
                setOver(current.to);
              }}
              onPointerUp={(event) => {
                const current = drag.current;
                if (!current || event.pointerId !== current.pointer) return;
                drag.current = null;
                setOver(null);
                move(current.from, current.to);
              }}
              onPointerCancel={() => {
                drag.current = null;
                setOver(null);
              }}
              onLostPointerCapture={() => {
                drag.current = null;
                setOver(null);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  drag.current = null;
                  setOver(null);
                  return;
                }
                const direction = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0;
                if (direction) {
                  event.preventDefault();
                  move(index, index + direction);
                }
              }}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
                <path d="M5 7h14M5 12h14M5 17h14" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
            </button>
            <span>
              {index + 1}. {names[source]}
            </span>
          </li>
        ))}
      </ol>
    </>
  );
}
