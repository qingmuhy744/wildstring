import { useTranslation } from 'react-i18next';
import { HelpText } from './desktop-help';
import { hints } from './help-content';
import { HelpLabel } from './desktop-help';
import { useEffect, useRef, useState } from 'react';
import { api, eventId } from './api';
import type { AgentDraft, AgentPage } from './agent-api';
import { OnlineLyrics } from './source-plugins';
import { MetadataRefreshDialog } from './metadata-refresh';
import { errorText } from './workspace-ui';
import { JobDiagnostics, type ProviderJob } from './provider-diagnostics';
import './metadata-review.css';

type Values = Record<string, unknown>;
type Candidate = {
  id: string;
  metadata_version: number;
  fields: Values;
  provider: string;
  source_url: string | null;
  cover_url: string | null;
  candidate_digest: string;
  duplicate_count?: number;
  match: Record<string, unknown>;
  stale?: boolean;
  stale_reason?: string | null;
};
export type ReviewTrack = {
  id: string;
  title: string;
  album: string;
  album_id: string;
  artists: string[];
  metadata_version: number;
  has_cover: boolean;
  current: Values;
  original: Values;
  overrides: Values;
  suggestions: Candidate[];
  disc_number: number | null;
  track_number: number | null;
};
type Album = { id: string; title: string; artists: string[]; count: number };
type ReviewPage = AgentPage<ReviewTrack> & {
  album_id: string;
  batch_id?: string | null;
  provider_names: Record<string, string>;
  release_lock?: {
    album_id: string;
    provider: string;
    release_id: string;
    source_url: string;
    version: number;
    snapshot: Values;
  } | null;
};
type Choice = { source: string; fields: string[] };
const fieldKeys: Record<string, string> = {
  title: 'metadataReview.fieldTitle',
  artists: 'metadataReview.fieldArtists',
  album: 'metadataReview.fieldAlbum',
  album_artists: 'metadataReview.fieldAlbumArtists',
  artist_credit: 'metadataReview.fieldArtistCredit',
  album_artist_credit: 'metadataReview.fieldAlbumArtistCredit',
  track_number: 'metadataReview.fieldTrackNumber',
  disc_number: 'metadataReview.fieldDiscNumber',
  track_total: 'metadataReview.fieldTrackTotal',
  disc_total: 'metadataReview.fieldDiscTotal',
  release_date: 'metadataReview.fieldReleaseDate',
  original_date: 'metadataReview.fieldOriginalDate',
  composers: 'metadataReview.fieldComposers',
  lyricists: 'metadataReview.fieldLyricists',
  arrangers: 'metadataReview.fieldArrangers',
  vocalists: 'metadataReview.fieldVocalists',
  genres: 'metadataReview.fieldGenres',
  tags: 'metadataReview.fieldTags',
  external_ids: 'metadataReview.fieldExternalIds',
  description: 'metadataReview.fieldDescription',
};
const fieldName = (field: string, t: (key: string) => string) =>
  fieldKeys[field] ? t(fieldKeys[field]) : field;
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const candidateStale = (candidate: Candidate, track: ReviewTrack) =>
  candidate.stale ?? candidate.metadata_version !== track.metadata_version;
const display = (v: unknown, t: (key: string) => string): string =>
  v == null
    ? t('metadataReview.notSet')
    : Array.isArray(v)
      ? v.join(' / ') || t('metadataReview.notSet')
      : typeof v === 'object'
        ? JSON.stringify(v)
        : String(v);
function candidateLabel(
  candidate: Candidate,
  track: ReviewTrack,
  providers: Record<string, string>,
  t: (key: string, options?: Record<string, unknown>) => string,
) {
  const album =
    typeof candidate.fields.album === 'string' && candidate.fields.album
      ? candidate.fields.album
      : t('metadataReview.noAlbumProvided');
  const title =
    typeof candidate.fields.title === 'string' && candidate.fields.title !== track.title
      ? candidate.fields.title
      : '';
  const date =
    typeof candidate.fields.release_date === 'string' ? candidate.fields.release_date : '';
  const score = candidate.match.score;
  return [
    providers[candidate.provider] || candidate.provider,
    title,
    album,
    date,
    typeof score === 'number' && Number.isFinite(score)
      ? t('metadataReview.matchScore', { score: Math.round(score <= 1 ? score * 100 : score) })
      : '',
    candidate.match.album_release_lock ? t('metadataReview.conflictWithReleaseLock') : '',
    candidate.stale_reason ||
      (candidateStale(candidate, track) ? t('metadataReview.queryBasisChanged') : ''),
  ]
    .filter(Boolean)
    .join(' · ');
}

function defaultChoice(track: ReviewTrack): Choice {
  const source = track.suggestions.find((s) => !candidateStale(s, track));
  return {
    source: source?.id || '',
    fields: source
      ? Object.keys(source.fields).filter(
          (k) => !same(track.current[k], source.fields[k]) && !Object.hasOwn(track.overrides, k),
        )
      : [],
  };
}

function releaseId(candidate: Candidate | undefined): string {
  if (!candidate) return '';
  if (typeof candidate.match.release_id === 'string') return candidate.match.release_id;
  const external = candidate.fields.external_ids;
  return external && typeof external === 'object' && !Array.isArray(external)
    ? typeof (external as Values).release === 'string'
      ? ((external as Values).release as string)
      : ''
    : '';
}

export function MetadataReviewWorkbench({
  initialTrackId,
  initialBatchId,
  onApplied,
  onBusy,
  onClose,
}: {
  initialTrackId?: string;
  initialBatchId?: string;
  onClose?: () => void;
  onApplied?: () => void | Promise<void>;
  onBusy?: (busy: boolean) => void;
}) {
  const { t } = useTranslation();
  const [albums, setAlbums] = useState<Album[]>([]),
    [albumTotal, setAlbumTotal] = useState(0),
    [filter, setFilter] = useState('');
  const [page, setPage] = useState<ReviewPage | null>(null),
    [active, setActive] = useState(''),
    [choices, setChoices] = useState<Record<string, Choice>>({});
  const [loading, setLoading] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [onlyChanges, setOnlyChanges] = useState(true),
    [tab, setTab] = useState('fields'),
    [cover, setCover] = useState<AgentDraft | null>(null),
    [coverAll, setCoverAll] = useState(false),
    [coverReady, setCoverReady] = useState(false);
  const [showSongs, setShowSongs] = useState(false);
  const [refresh, setRefresh] = useState(false),
    [conflicts, setConflicts] = useState<Record<string, string>>({});
  const [lockBusy, setLockBusy] = useState(false);
  useEffect(() => {
    onBusy?.(busy);
    return () => onBusy?.(false);
  }, [busy, onBusy]);
  const [jobs, setJobs] = useState<ProviderJob[]>([]);
  useEffect(() => {
    const controller = new AbortController();
    setJobs([]);
    if (active)
      void api<{ jobs: ProviderJob[] }>(`/manage/providers/tracks/${encodeURIComponent(active)}`, {
        signal: controller.signal,
      })
        .then((value) => {
          if (!controller.signal.aborted) setJobs(value.jobs);
        })
        .catch(() => {});
    return () => controller.abort();
  }, [active, page]);
  const sequence = useRef(0),
    request = useRef(false),
    key = useRef({ signature: '', value: eventId() });
  const current = page?.items.find((t) => t.id === active),
    candidate = current?.suggestions.find((s) => s.id === choices[current.id]?.source);
  const selected = page?.items.filter((t) => (choices[t.id]?.fields.length || 0) > 0) || [];
  const fieldCount = selected.reduce((n, t) => n + choices[t.id].fields.length, 0);
  async function loadAlbums(append = false) {
    const result = await api<AgentPage<Album>>(
      `/agent/metadata-review/albums?limit=100&offset=${append ? albums.length : 0}`,
    );
    setAlbums((prior) => (append ? [...prior, ...result.items] : result.items));
    setAlbumTotal(result.total);
    return result.items;
  }
  async function load(query: string, next?: string, preserveOtherChoices = false) {
    const generation = ++sequence.current;
    setLoading(true);
    setError('');
    try {
      const result = await api<ReviewPage>(`/agent/metadata-review?limit=500&${query}`);
      if (generation !== sequence.current) return;
      setPage(result);
      setChoices((previous) =>
        Object.fromEntries(
          result.items.map((t) => {
            const choice = previous[t.id];
            if (
              preserveOtherChoices &&
              t.id !== next &&
              choice &&
              page?.items.find((old) => old.id === t.id)?.metadata_version === t.metadata_version &&
              t.suggestions.some((source) => source.id === choice.source)
            )
              return [t.id, choice];
            const fallback = defaultChoice(t);
            return [
              t.id,
              preserveOtherChoices && t.id === next ? { ...fallback, fields: [] } : fallback,
            ];
          }),
        ),
      );
      setActive(
        next && result.items.some((t) => t.id === next)
          ? next
          : result.items.find((t) => defaultChoice(t).fields.length)?.id ||
              result.items[0]?.id ||
              '',
      );
      setCover(null);
      setCoverReady(false);
      setConflicts({});
    } catch (reason) {
      if (generation === sequence.current) setError(errorText(reason));
    } finally {
      if (generation === sequence.current) setLoading(false);
    }
  }
  function pageQuery(value: ReviewPage, offset = value.offset) {
    return value.batch_id
      ? `batch_id=${encodeURIComponent(value.batch_id)}&offset=${offset}`
      : `album_id=${encodeURIComponent(value.album_id)}&offset=${offset}`;
  }
  useEffect(() => {
    let mounted = true;
    void loadAlbums()
      .then((items) => {
        if (!mounted) return;
        return load(
          initialTrackId
            ? `track_id=${encodeURIComponent(initialTrackId)}`
            : initialBatchId
              ? `batch_id=${encodeURIComponent(initialBatchId)}`
              : `album_id=${encodeURIComponent(items[0]?.id || '')}`,
          initialTrackId,
        );
      })
      .catch((e) => setError(errorText(e)));
    return () => {
      mounted = false;
      sequence.current++;
    };
  }, [initialTrackId, initialBatchId]);
  function choose(id: string, fields: string[]) {
    setChoices((old) => ({ ...old, [id]: { ...old[id], fields } }));
  }
  function nextItem() {
    if (!page || !current) return;
    setNotice('');
    setError('');
    const index = page.items.indexOf(current);
    setActive(page.items[(index + 1) % page.items.length]?.id || '');
    setTab('fields');
    setCover(null);
    setCoverReady(false);
  }
  async function rejectAlbum() {
    if (request.current || busy || loading || !page || !page.album_id) return;
    request.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await api('/agent/metadata-review/reject', {
        method: 'POST',
        body: JSON.stringify({ album_id: page.album_id }),
      });
      const updatedAlbums = await loadAlbums();
      setNotice(t('metadataReview.rejectAlbumNotice'));
      const next = updatedAlbums.find((a) => a.id !== page.album_id);
      if (next) {
        await load(`album_id=${encodeURIComponent(next.id)}`);
      } else {
        setPage(null);
      }
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      request.current = false;
      setBusy(false);
    }
  }
  async function rejectTrack(trackId: string) {
    if (request.current || busy || loading || !page) return;
    request.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await api('/agent/metadata-review/reject', {
        method: 'POST',
        body: JSON.stringify({ track_id: trackId }),
      });
      await load(pageQuery(page), undefined, true);
      await loadAlbums();
      setNotice(t('metadataReview.rejectTrackNotice'));
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      request.current = false;
      setBusy(false);
    }
  }
  async function rejectCurrent() {
    if (request.current || busy || loading || !current || !candidate || !page) return;
    request.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await api('/agent/metadata-review/reject', {
        method: 'POST',
        body: JSON.stringify({
          track_id: current.id,
          suggestion_id: candidate.id,
          metadata_version: current.metadata_version,
          candidate_digest: candidate.candidate_digest,
        }),
      });
      await load(pageQuery(page), active, true);
      await loadAlbums();
      setNotice(t('metadataReview.rejectCurrentNotice'));
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      request.current = false;
      setBusy(false);
    }
  }
  async function accept(single = false, goToNextAlbum = false) {
    if (request.current || busy || loading || !page || (cover && !coverReady)) return;
    const tracks = single ? selected.filter((t) => t.id === active) : selected;
    if (!tracks.length && !cover) return;
    request.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const items = tracks.map((t) => {
        const c = t.suggestions.find((s) => s.id === choices[t.id].source)!;
        return {
          track_id: t.id,
          suggestion_id: c.id,
          metadata_version: t.metadata_version,
          candidate_digest: c.candidate_digest,
          fields: choices[t.id].fields,
        };
      });
      const signature = JSON.stringify([items, cover?.id]);
      if (signature !== key.current.signature) key.current = { signature, value: eventId() };
      if (items.length) {
        const result = await api<{
          status: string;
          conflicts?: { track_id: string; error_code: string }[];
        }>('/agent/metadata-review/accept', {
          method: 'POST',
          body: JSON.stringify({
            items,
            idempotency_key: key.current.value,
            ...(cover ? { cover_draft_id: cover.id } : {}),
          }),
        });
        if (result.status !== 'applied') {
          setConflicts(
            Object.fromEntries((result.conflicts || []).map((c) => [c.track_id, c.error_code])),
          );
          setError(t('metadataReview.conflictError'));
          return;
        }
      } else if (cover)
        await api(`/agent/drafts/${cover.id}/accept`, {
          method: 'POST',
          body: JSON.stringify({
            version: cover.version,
            preview_digest: cover.preview_digest,
            idempotency_key: key.current.value,
          }),
        });
      window.dispatchEvent(new Event('wildstring:artwork-updated'));
      await onApplied?.();
      const updatedAlbums = await loadAlbums();
      if (goToNextAlbum) {
        const next = updatedAlbums.find((a) => a.id !== page.album_id);
        if (next) {
          await load(`album_id=${encodeURIComponent(next.id)}`);
        } else {
          setPage(null);
        }
      } else {
        const next = single
          ? page.items[(page.items.findIndex((t) => t.id === active) + 1) % page.items.length]?.id
          : undefined;
        await load(pageQuery(page), next);
      }
      setNotice(
        t('metadataReview.appliedNotice', {
          trackCount: tracks.length,
          fieldCount: items.reduce((n, i) => n + i.fields.length, 0),
          coverSuffix: cover ? t('metadataReview.coverSuffix') : '',
        }),
      );
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      request.current = false;
      setBusy(false);
    }
  }
  useEffect(() => {
    function shortcut(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        void accept();
      }
    }
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  });
  async function prepareCover() {
    if (!current || !candidate || busy || !page) return;
    setBusy(true);
    setError('');
    setCoverReady(false);
    try {
      const targets = (coverAll ? page.items : [current]).map((t) => ({
        track_id: t.id,
        metadata_version: t.metadata_version,
      }));
      const result = await api<AgentDraft>('/agent/metadata-review/cover', {
        method: 'POST',
        body: JSON.stringify({
          kind: 'cover',
          title: t('metadataReview.coverDraftTitle', { name: current.album || current.title }),
          payload: {
            suggestion_id: candidate.id,
            metadata_version: current.metadata_version,
            targets,
          },
        }),
      });
      setCover(result);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function updateReleaseLock(clear = false) {
    if (!page || lockBusy) return;
    setLockBusy(true);
    setError('');
    try {
      if (clear) {
        const query = page.release_lock ? `?version=${page.release_lock.version}` : '';
        await api(`/manage/albums/${encodeURIComponent(page.album_id)}/release-lock${query}`, {
          method: 'DELETE',
        });
      } else {
        const id = releaseId(candidate);
        if (!candidate || !id) {
          setError(t('metadataReview.noReleaseLockId'));
          return;
        }
        await api(`/manage/albums/${encodeURIComponent(page.album_id)}/release-lock`, {
          method: 'PUT',
          body: JSON.stringify({
            provider: candidate.provider,
            release_id: id,
            source_url: candidate.source_url || '',
            snapshot: { album: current?.album, track_count: page.total, match: candidate.match },
            ...(page.release_lock ? { version: page.release_lock.version } : {}),
          }),
        });
      }
      await load(pageQuery(page), active, true);
      setNotice(clear ? t('metadataReview.releaseLockCleared') : t('metadataReview.releaseLocked'));
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setLockBusy(false);
    }
  }
  async function purgeStale() {
    if (busy || loading) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const res = await api<{ status: string; purged_count: number; remaining_pending: number }>(
        '/agent/metadata-review/stale/purge',
        { method: 'POST' },
      );
      setNotice(
        res.purged_count > 0
          ? t('metadataReview.stalePurged', {
              purgedCount: res.purged_count,
              remainingPending: res.remaining_pending,
            })
          : t('metadataReview.noStaleCandidates'),
      );
      const updated = await loadAlbums();
      if (updated.length && page) {
        await load(pageQuery(page), active);
      } else if (!updated.length) {
        setPage(null);
      }
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  const disabled = busy || loading;
  return (
    <section className="metadata-review" aria-label={t('metadataReview.workbenchAria')}>
      <header className="review-heading">
        <div>
          <h2>{t('metadataReview.headingTitle')}</h2>
          <p className="muted">{t('metadataReview.headingMuted')}</p>
        </div>
        <div className="review-heading-actions">
          <button
            disabled={disabled}
            onClick={() => void purgeStale()}
            title={t('metadataReview.purgeStaleTitle')}
          >
            {t('metadataReview.purgeStale')}
          </button>
          <button disabled={disabled} onClick={() => page && void load(pageQuery(page), active)}>
            {t('metadataReview.reloadCandidates')}
          </button>
          <button disabled={disabled || !current} onClick={() => setRefresh(true)}>
            {t('metadataReview.requery')}
          </button>
          {onClose && (
            <button aria-label={t('metadataReview.closeAria')} disabled={busy} onClick={onClose}>
              {t('metadataReview.close')}
            </button>
          )}
        </div>
      </header>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      <div className="review-layout">
        <aside aria-label={t('metadataReview.albumsAsideAria')}>
          <label>
            {t('metadataReview.filterAlbumsLabel')}
            <input value={filter} onChange={(e) => setFilter(e.target.value)} />
          </label>
          <ul>
            {albums
              .filter((a) =>
                `${a.title} ${a.artists.join(' ')}`.toLowerCase().includes(filter.toLowerCase()),
              )
              .map((a) => (
                <li key={a.id}>
                  <button
                    disabled={disabled}
                    aria-pressed={page?.album_id === a.id}
                    onClick={() => void load(`album_id=${encodeURIComponent(a.id)}`)}
                  >
                    <strong>{a.title}</strong>
                    <small>
                      {a.artists.join(' / ')} ·{' '}
                      {t('metadataReview.tracksPending', { count: a.count })}
                    </small>
                  </button>
                </li>
              ))}
          </ul>
          {albums.length < albumTotal && (
            <button disabled={disabled} onClick={() => void loadAlbums(true)}>
              {t('metadataReview.moreAlbums')}
            </button>
          )}
        </aside>
        <main>
          <div className="review-album">
            <h3>
              {current?.album || page?.items[0]?.album || t('metadataReview.noPendingAlbums')}
            </h3>
            <p>
              {t('metadataReview.albumHeaderSummary', {
                total: page?.total || 0,
                count: page?.items.length || 0,
              })}
            </p>
            {!page?.batch_id && page?.release_lock ? (
              <p className="muted">
                {t('metadataReview.releaseLockedLabel', {
                  provider: page.release_lock.provider,
                  releaseId: page.release_lock.release_id,
                })}
                <button
                  disabled={disabled || lockBusy}
                  onClick={() => void updateReleaseLock(true)}
                >
                  {t('metadataReview.unlockRelease')}
                </button>
              </p>
            ) : !page?.batch_id ? (
              <p className="muted">
                {t('metadataReview.releaseNotLockedLabel')}
                <button
                  disabled={disabled || lockBusy || !releaseId(candidate)}
                  onClick={() => void updateReleaseLock()}
                >
                  {t('metadataReview.lockRelease')}
                </button>
              </p>
            ) : (
              <p className="muted">{t('metadataReview.batchSummaryNotice')}</p>
            )}
            <button
              disabled={disabled || !page?.items.length}
              onClick={() =>
                setChoices(
                  Object.fromEntries(
                    (page?.items || []).map((item) => [item.id, defaultChoice(item)]),
                  ),
                )
              }
            >
              {t('metadataReview.selectPageChanges')}
            </button>
            <button
              disabled={disabled}
              onClick={() =>
                setChoices((old) =>
                  Object.fromEntries(
                    Object.entries(old).map(([id, c]) => [id, { ...c, fields: [] }]),
                  ),
                )
              }
            >
              {t('metadataReview.clearSelection')}
            </button>
            <button
              className="review-song-toggle"
              aria-expanded={showSongs}
              onClick={() => setShowSongs(!showSongs)}
            >
              {showSongs
                ? t('metadataReview.collapseSongList')
                : t('metadataReview.selectSongs', { count: selected.length })}
            </button>
          </div>
          {loading && <p role="status">{t('metadataReview.loadingDiff')}</p>}
          {showSongs && (
            <div className="review-song-list" aria-label={t('metadataReview.albumSongsAria')}>
              {page?.items.map((trackItem) => (
                <div key={trackItem.id} className={active === trackItem.id ? 'active' : ''}>
                  <input
                    type="checkbox"
                    aria-label={t('metadataReview.selectTrackAria', { title: trackItem.title })}
                    checked={!!choices[trackItem.id]?.fields.length}
                    disabled={disabled}
                    onChange={(e) =>
                      choose(trackItem.id, e.target.checked ? defaultChoice(trackItem).fields : [])
                    }
                  />
                  <button
                    disabled={disabled}
                    onClick={() => {
                      setActive(trackItem.id);
                      setNotice('');
                      setError('');
                      setCover(null);
                      setCoverReady(false);
                    }}
                  >
                    <span>
                      {trackItem.disc_number || 1}.{trackItem.track_number || '—'} {trackItem.title}
                    </span>
                    <small>
                      {conflicts[trackItem.id]
                        ? t('metadataReview.conflictNotice')
                        : trackItem.suggestions.some((s) => !candidateStale(s, trackItem))
                          ? t('metadataReview.fieldsSelected', {
                              count: choices[trackItem.id]?.fields.length || 0,
                            })
                          : t('metadataReview.noValidCandidate')}
                    </small>
                  </button>
                </div>
              ))}
            </div>
          )}
          {page && page.total > page.limit && (
            <div className="workspace-actions">
              <button
                disabled={disabled || page.offset === 0}
                onClick={() => void load(pageQuery(page, Math.max(0, page.offset - page.limit)))}
              >
                {t('metadataReview.prevPage')}
              </button>
              <button
                disabled={disabled || page.offset + page.limit >= page.total}
                onClick={() => void load(pageQuery(page, page.offset + page.limit))}
              >
                {t('metadataReview.nextPage')}
              </button>
            </div>
          )}
          {current && (
            <article className="review-detail" aria-label={t('metadataReview.trackDiffAria')}>
              <h3>{current.title}</h3>
              <p>{current.artists.join(' / ')}</p>
              <div className="workspace-actions">
                <label>
                  <HelpLabel hint="candidate">{t('metadataReview.candidateSourceLabel')}</HelpLabel>
                  <select
                    aria-label={t('metadataReview.candidateSourceAria')}
                    value={choices[current.id]?.source || ''}
                    disabled={disabled}
                    onChange={(e) => {
                      setNotice('');
                      setError('');
                      const c = current.suggestions.find((s) => s.id === e.target.value)!;
                      setChoices((old) => ({
                        ...old,
                        [current.id]: {
                          source: c.id,
                          fields: !candidateStale(c, current)
                            ? Object.keys(c.fields).filter(
                                (k) =>
                                  !same(current.current[k], c.fields[k]) &&
                                  !Object.hasOwn(current.overrides, k),
                              )
                            : [],
                        },
                      }));
                      setCover(null);
                      setCoverReady(false);
                    }}
                  >
                    <option value="" disabled>
                      {t('metadataReview.selectSourcePlaceholder')}
                    </option>
                    {current.suggestions.map((c) => (
                      <option key={c.id} value={c.id}>
                        {candidateLabel(c, current, page?.provider_names || {}, t)}
                      </option>
                    ))}
                  </select>
                </label>
                <button disabled={disabled} onClick={() => setRefresh(true)}>
                  {t('metadataReview.updateMetadata')}
                </button>
                <button
                  disabled={disabled || !current}
                  className="text-button danger"
                  onClick={() => void rejectTrack(current.id)}
                  title={t('metadataReview.rejectTrackTitle')}
                >
                  {t('metadataReview.rejectTrack')}
                </button>
              </div>
              {candidate && (candidate.duplicate_count || 1) > 1 && (
                <p className="muted review-candidate-note">
                  {t('metadataReview.duplicateCountNote', { count: candidate.duplicate_count })}
                </p>
              )}
              {jobs.length > 0 && (
                <details open={jobs.some((j) => j.status === 'failed')}>
                  <summary>{t('metadataReview.recentQueries')}</summary>
                  {jobs.map((job) => (
                    <JobDiagnostics key={job.id} job={job} />
                  ))}
                </details>
              )}
              <nav className="workspace-tabs" aria-label={t('metadataReview.reviewContentAria')}>
                {[
                  ['fields', t('metadataReview.tabFields')],
                  ['cover', t('metadataReview.tabCover')],
                  ['lyrics', t('metadataReview.tabLyrics')],
                ].map(([id, label]) => (
                  <button key={id} aria-pressed={tab === id} onClick={() => setTab(id)}>
                    {label}
                  </button>
                ))}
              </nav>
              {tab === 'fields' && (
                <>
                  <label className="check-label">
                    <input
                      type="checkbox"
                      checked={onlyChanges}
                      onChange={(e) => setOnlyChanges(e.target.checked)}
                    />
                    {t('metadataReview.onlyChanges')}
                  </label>
                  {candidate && !candidateStale(candidate, current) ? (
                    <>
                      <p className="muted">
                        {t('metadataReview.candidateSourceHeader', {
                          provider: page?.provider_names[candidate.provider] || candidate.provider,
                          version: candidate.metadata_version,
                        })}
                        {candidate.stale_reason ? `（${candidate.stale_reason}）` : ''}
                      </p>
                      <table className="review-diff">
                        <thead>
                          <tr>
                            <th>{t('metadataReview.colField')}</th>
                            <th>{t('metadataReview.colCurrent')}</th>
                            <th>{t('metadataReview.colSuggested')}</th>
                            <th>{t('metadataReview.colSource')}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {Object.entries(candidate.fields)
                            .filter(([k, v]) => !onlyChanges || !same(current.current[k], v))
                            .map(([field, value]) => (
                              <tr key={field}>
                                <th>
                                  <label>
                                    <input
                                      type="checkbox"
                                      checked={choices[current.id]?.fields.includes(field) || false}
                                      aria-label={t('metadataReview.adoptFieldAria', {
                                        field: fieldName(field, t),
                                      })}
                                      disabled={disabled || candidateStale(candidate, current)}
                                      onChange={(e) =>
                                        choose(
                                          current.id,
                                          e.target.checked
                                            ? [...choices[current.id].fields, field]
                                            : choices[current.id].fields.filter((k) => k !== field),
                                        )
                                      }
                                    />
                                    {fieldName(field, t)}
                                  </label>
                                  {Object.hasOwn(current.overrides, field) && (
                                    <small>
                                      <HelpText hint="manualValue">
                                        {t('metadataReview.manualValue')}
                                      </HelpText>
                                    </small>
                                  )}
                                </th>
                                <td data-label={t('metadataReview.colCurrent')}>
                                  {display(current.current[field], t)}
                                </td>
                                <td data-label={t('metadataReview.colSuggested')}>
                                  {display(value, t)}
                                </td>
                                <td data-label={t('metadataReview.colSource')}>
                                  {candidate.source_url ? (
                                    <a href={candidate.source_url} target="_blank" rel="noreferrer">
                                      {page?.provider_names[candidate.provider] ||
                                        candidate.provider}{' '}
                                      ↗
                                    </a>
                                  ) : (
                                    candidate.provider
                                  )}
                                  <button
                                    disabled={disabled}
                                    onClick={() => {
                                      const on = !choices[current.id].fields.includes(field);
                                      setChoices((old) =>
                                        Object.fromEntries(
                                          (page?.items || []).map((item) => {
                                            const c = item.suggestions.find(
                                              (s) => s.id === old[item.id]?.source,
                                            );
                                            const fields = old[item.id]?.fields || [];
                                            return [
                                              item.id,
                                              {
                                                ...old[item.id],
                                                fields:
                                                  c && field in c.fields && !candidateStale(c, item)
                                                    ? on
                                                      ? [...new Set([...fields, field])]
                                                      : fields.filter((k) => k !== field)
                                                    : fields,
                                              },
                                            ];
                                          }),
                                        ),
                                      );
                                    }}
                                  >
                                    {t('metadataReview.batchFieldToggle', {
                                      action: choices[current.id].fields.includes(field)
                                        ? t('metadataReview.actionUncheck')
                                        : t('metadataReview.actionCheck'),
                                    })}
                                  </button>
                                </td>
                              </tr>
                            ))}
                        </tbody>
                      </table>
                      <details>
                        <summary>{t('metadataReview.originalValuesDetails')}</summary>
                        <dl>
                          {Object.entries(current.original).map(([k, v]) => (
                            <div key={k}>
                              <dt>{fieldName(k, t)}</dt>
                              <dd>{display(v, t)}</dd>
                            </div>
                          ))}
                        </dl>
                        <pre>{JSON.stringify(candidate.match, null, 2)}</pre>
                      </details>
                    </>
                  ) : current.suggestions.length ? (
                    <p className="review-stale-notice" role="status">
                      {t('metadataReview.staleCandidateNotice')}
                      <button disabled={disabled} onClick={() => setRefresh(true)}>
                        {t('metadataReview.requeryAlbum')}
                      </button>
                    </p>
                  ) : (
                    <p>{t('metadataReview.noCandidates')}</p>
                  )}
                </>
              )}
              {tab === 'cover' && (
                <>
                  <label className="check-label">
                    <input
                      type="checkbox"
                      checked={coverAll}
                      onChange={(e) => {
                        setCoverAll(e.target.checked);
                        setCover(null);
                        setCoverReady(false);
                      }}
                      disabled={disabled}
                    />
                    {t('metadataReview.applyCoverToAlbumTracks', {
                      count: coverAll ? page?.items.length : 1,
                    })}
                  </label>
                  {candidate?.cover_url ? (
                    <button
                      disabled={disabled || candidateStale(candidate, current)}
                      onClick={() => void prepareCover()}
                    >
                      {t('metadataReview.pinAndPreviewCover')}
                    </button>
                  ) : (
                    <p>{t('metadataReview.noCoverInCandidate')}</p>
                  )}
                  <div className="review-covers">
                    <figure>
                      {current.has_cover ? (
                        <img
                          src={`/api/v1/tracks/${current.id}/cover?size=320&v=${current.metadata_version}`}
                          alt={t('metadataReview.currentCoverAlt')}
                        />
                      ) : (
                        <div className="review-no-cover">{t('metadataReview.noCover')}</div>
                      )}
                      <figcaption>{t('metadataReview.currentCoverFigcaption')}</figcaption>
                    </figure>
                    <figure>
                      {cover ? (
                        <img
                          key={cover.id}
                          src={`/api/v1/agent/drafts/${cover.id}/cover-preview?v=${cover.version}`}
                          alt={t('metadataReview.pinnedCoverAlt')}
                          onLoad={() => setCoverReady(true)}
                          onError={() => {
                            setCoverReady(false);
                            setError(t('metadataReview.coverLoadError'));
                          }}
                        />
                      ) : (
                        <div className="review-no-cover">
                          {t('metadataReview.previewCandidateFirst')}
                        </div>
                      )}
                      <figcaption>
                        {t('metadataReview.coverToApplyFigcaption')}
                        {cover
                          ? t('metadataReview.coverTracksCount', {
                              count: Array.isArray(cover.payload.targets)
                                ? cover.payload.targets.length
                                : 1,
                            })
                          : ''}
                      </figcaption>
                    </figure>
                  </div>
                </>
              )}
              {tab === 'lyrics' && (
                <OnlineLyrics
                  trackId={current.id}
                  applied={() => {
                    void onApplied?.();
                  }}
                />
              )}
            </article>
          )}
        </main>
      </div>
      <footer className="review-actions">
        <span>
          {t('metadataReview.selectedSummary', {
            trackCount: selected.length,
            fieldCount,
            coverSuffix: cover ? t('metadataReview.coverPreviewedSuffix') : '',
          })}
        </span>
        <div>
          <button
            disabled={disabled || !current}
            data-help={hints.reviewSkip}
            onClick={() => {
              if (current) choose(current.id, []);
              nextItem();
            }}
          >
            {t('metadataReview.skipNext')}
          </button>
          <button
            className="danger"
            disabled={disabled || !page?.album_id}
            onClick={() => void rejectAlbum()}
            data-help={hints.reviewReject}
            title={t('metadataReview.rejectAlbumTitle')}
          >
            {t('metadataReview.rejectAlbum')}
          </button>
          <button
            disabled={disabled || !candidate}
            onClick={() => void rejectCurrent()}
            data-help={hints.reviewReject}
          >
            {t('metadataReview.rejectCurrent')}
          </button>
          <button
            className="primary"
            disabled={disabled || (!selected.length && !cover) || (!!cover && !coverReady)}
            data-help={hints.reviewAccept}
            onClick={() => void accept()}
          >
            {busy ? t('metadataReview.applying') : t('metadataReview.acceptSelected')}
          </button>
        </div>
      </footer>
      {refresh && current && (
        <MetadataRefreshDialog
          target={{ scope: 'album', id: current.album_id, label: current.album }}
          onClose={() => setRefresh(false)}
          onQueued={() => setNotice(t('metadataReview.refreshQueuedNotice'))}
        />
      )}
    </section>
  );
}

export function MetadataReviewDialog({
  trackId,
  batchId,
  onClose,
  onApplied,
}: {
  trackId?: string;
  batchId?: string;
  onClose: () => void;
  onApplied?: () => void | Promise<void>;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden';
    dialog.current?.showModal();
    return () => {
      document.documentElement.style.overflow = previous;
    };
  }, []);
  return (
    <dialog
      className="metadata-review-dialog"
      ref={dialog}
      aria-label={t('metadataReview.dialogAria')}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
    >
      <MetadataReviewWorkbench
        initialTrackId={trackId}
        initialBatchId={batchId}
        onApplied={onApplied}
        onBusy={setBusy}
        onClose={onClose}
      />
    </dialog>
  );
}
