import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, errorCodeMessage } from './api';
import { ImportFolderDialog, type ImportSelection } from './import-folder-dialog';
import type { MusicLibrary } from './music-libraries';
import './music-rebind.css';

type Outcome = 'exact' | 'equivalent' | 'bind' | 'keep' | 'linked';
export type RebindItem = {
  track_id: string;
  title: string;
  path: string;
  action: Outcome;
  source_id?: string;
  source_path?: string;
  token?: string;
  reason?: string;
  changes: Record<string, { source: unknown; value: unknown }>;
};
type RebindJob = { id: string; status: string; error?: string };

export function approvedBinding(item: RebindItem, bindOnly = false) {
  return {
    track_id: item.track_id,
    source_id: item.source_id,
    source_path: item.source_path,
    token: item.token,
    bind_only: bindOnly,
  };
}

function tagValue(value: unknown) {
  if (Array.isArray(value)) return value.join(', ');
  if (value && typeof value === 'object') return JSON.stringify(value);
  return String(value ?? '');
}

const fieldKeys: Record<string, string> = {
  title: 'fieldTitle',
  artists: 'fieldArtists',
  album: 'fieldAlbum',
  album_artists: 'fieldAlbumArtists',
  artist_credit: 'fieldArtistCredit',
  album_artist_credit: 'fieldAlbumArtistCredit',
  track_number: 'fieldTrackNumber',
  disc_number: 'fieldDiscNumber',
  track_total: 'fieldTrackTotal',
  disc_total: 'fieldDiscTotal',
  composers: 'fieldComposers',
  lyricists: 'fieldLyricists',
  arrangers: 'fieldArrangers',
  vocalists: 'fieldVocalists',
  genres: 'fieldGenres',
  release_date: 'fieldReleaseDate',
  original_date: 'fieldOriginalDate',
};

function RebindDetails({ item }: { item: RebindItem }) {
  const { t } = useTranslation();
  return (
    <>
      {item.source_path && <code className="storage-path">{item.source_path}</code>}
      {item.reason && <small>{t(`musicRebind.${item.reason}`)}</small>}
      {Object.keys(item.changes).length > 0 && (
        <details>
          <summary>{t('musicRebind.tagChanges')}</summary>
          <dl className="rebind-changes">
            {Object.entries(item.changes).map(([field, change]) => (
              <div key={field}>
                <dt>
                  {field === 'lyrics'
                    ? t('musicRebind.embeddedLyrics')
                    : fieldKeys[field]
                      ? t(`metadataEditor.${fieldKeys[field]}`)
                      : field}
                </dt>
                <dd className={field === 'lyrics' ? 'rebind-lyric-change' : undefined}>
                  {t('musicRebind.tagDifference', {
                    source: tagValue(change.source) || t('musicRebind.emptyTag'),
                    retained: tagValue(change.value) || t('musicRebind.emptyTag'),
                  })}
                </dd>
              </div>
            ))}
          </dl>
        </details>
      )}
    </>
  );
}

const outcomes: Outcome[] = ['exact', 'equivalent', 'bind', 'keep', 'linked'];

function ReviewGroup({
  outcome,
  items,
  skipped,
  onSkip,
  busy,
}: {
  outcome: Outcome;
  items: RebindItem[];
  skipped: Set<string>;
  onSkip: (track: string, skip: boolean) => void;
  busy: boolean;
}) {
  const { t } = useTranslation();
  const [limit, setLimit] = useState(25);
  return (
    <details className="rebind-group">
      <summary>
        {t(`musicRebind.${outcome}`)} · {items.length}
      </summary>
      <ul className="rebind-list">
        {items.slice(0, limit).map((item) => (
          <li key={item.track_id}>
            {item.token && item.action !== 'linked' ? (
              <label className="rebind-track-choice">
                <input
                  type="checkbox"
                  disabled={busy}
                  checked={!skipped.has(item.track_id)}
                  onChange={(event) => onSkip(item.track_id, !event.target.checked)}
                />
                {item.title}
              </label>
            ) : (
              <strong>{item.title}</strong>
            )}
            <RebindDetails item={item} />
          </li>
        ))}
      </ul>
      {limit < items.length && (
        <button type="button" onClick={() => setLimit((value) => value + 25)}>
          {t('musicRebind.showMore')}
        </button>
      )}
    </details>
  );
}

export function RebindReview({
  items,
  skipped,
  onSkip,
  busy,
}: {
  items: RebindItem[];
  skipped: Set<string>;
  onSkip: (track: string, skip: boolean) => void;
  busy: boolean;
}) {
  const { t } = useTranslation();
  return (
    <section className="rebind-review" aria-label={t('musicRebind.preview')}>
      <p className="muted">{t('musicRebind.sharedFile')}</p>
      {items.length === 0 && <p role="status">{t('musicRebind.emptyReview')}</p>}
      {outcomes.map((outcome) => {
        const matches = items.filter((item) => item.action === outcome);
        return (
          matches.length > 0 && (
            <ReviewGroup
              key={outcome}
              outcome={outcome}
              items={matches}
              skipped={skipped}
              onSkip={onSkip}
              busy={busy}
            />
          )
        );
      })}
    </section>
  );
}

export function TrackSourceRebind({
  trackId,
  libraryId,
  onApplied,
}: {
  trackId: string;
  libraryId: string;
  onApplied: () => void;
}) {
  const { t } = useTranslation();
  const [library, setLibrary] = useState<MusicLibrary>();
  const [picking, setPicking] = useState(false);
  const [review, setReview] = useState<RebindItem>();
  const [job, setJob] = useState<RebindJob>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const applied = useRef(onApplied);
  const previewRegion = useRef<HTMLDivElement>(null);
  applied.current = onApplied;
  const endpoint = `/libraries/${encodeURIComponent(libraryId)}`;
  const moving = job?.status === 'queued' || job?.status === 'running';

  useEffect(() => {
    if (review && !moving) previewRegion.current?.scrollIntoView({ block: 'nearest' });
  }, [review, moving]);

  useEffect(() => {
    if (!moving || !job) return;
    const controller = new AbortController();
    const timer = window.setInterval(() => {
      void api<{ items: RebindJob[] }>(`${endpoint}/migrations`, { signal: controller.signal })
        .then(({ items }) => {
          const next = items.find((item) => item.id === job.id);
          if (!next || controller.signal.aborted) return;
          setJob(next);
          if (next.status === 'completed') {
            setReview(undefined);
            setMessage(t('musicRebind.completed'));
            applied.current();
          } else if (next.status === 'failed') {
            setError(errorCodeMessage(next.error || ''));
          }
        })
        .catch((cause: Error) => {
          if (!controller.signal.aborted) setError(cause.message);
        });
    }, 1000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [endpoint, moving, job?.id, t]);

  async function openPicker() {
    setBusy(true);
    setError('');
    setMessage('');
    setReview(undefined);
    setJob(undefined);
    try {
      const current = (await api<MusicLibrary[]>('/libraries')).find(
        (item) => item.id === libraryId,
      );
      if (!current?.sources?.length) {
        setMessage(t('musicRebind.noSources'));
        return;
      }
      setLibrary(current);
      setPicking(true);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function preview(selection: ImportSelection) {
    if (!library) return;
    setPicking(false);
    setBusy(true);
    try {
      const result = await api<{ items: RebindItem[] }>(`${endpoint}/rebind/preview`, {
        method: 'POST',
        body: JSON.stringify({
          version: library.version,
          choice: {
            track_id: trackId,
            source_id: selection.source_id,
            source_path: selection.path,
          },
        }),
      });
      setReview(result.items[0]);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function apply(bindOnly = false, retry = false) {
    if (!review || !library) return;
    setBusy(true);
    setError('');
    try {
      setJob(
        await api<RebindJob>(
          retry ? `${endpoint}/migrations/${job?.id}/retry` : `${endpoint}/rebind`,
          {
            method: 'POST',
            ...(retry
              ? {}
              : {
                  body: JSON.stringify({
                    version: library.version,
                    selections: [approvedBinding(review, bindOnly)],
                  }),
                }),
          },
        ),
      );
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const sources = library?.sources?.map((source) => ({
    id: source.id,
    name: source.root,
  }));
  return (
    <section className="file-info-section rebind-track">
      <button type="button" onClick={() => void openPicker()} disabled={busy || moving}>
        {t('musicRebind.singleTitle')}
      </button>
      {picking && sources?.length && (
        <ImportFolderDialog
          sources={sources}
          initial={{ source_id: sources[0].id, path: '.' }}
          file={{ libraryId, onSelect: (selection) => void preview(selection) }}
          onClose={() => setPicking(false)}
        />
      )}
      {(busy || moving) && (
        <p role="status">{t(moving ? 'musicRebind.applying' : 'musicRebind.checking')}</p>
      )}
      {message && <p role="status">{message}</p>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {review && !moving && (
        <div className="rebind-review" ref={previewRegion}>
          <strong>{t(`musicRebind.${review.action}`)}</strong>
          <RebindDetails item={review} />
          {['exact', 'equivalent'].includes(review.action) && (
            <p className="muted">{t('musicRebind.sharedFile')}</p>
          )}
          <div className="rebind-actions">
            {job?.status === 'failed' ? (
              <button type="button" disabled={busy} onClick={() => void apply(false, true)}>
                {t('libraryStorage.retryMigration')}
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className="primary"
                  disabled={busy}
                  onClick={() => void apply()}
                >
                  {t(
                    review.action === 'bind' || review.action === 'linked'
                      ? 'musicRebind.applyBinding'
                      : 'musicRebind.applyLink',
                  )}
                </button>
                {['exact', 'equivalent'].includes(review.action) && (
                  <button type="button" disabled={busy} onClick={() => void apply(true)}>
                    {t('musicRebind.bind')}
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
