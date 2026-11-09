import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CurationDraftPreview } from './curation-drafts';
import { api, errorCodeMessage, eventId, type User, type Track } from './api';
import type { AgentConnection, AgentDraft, AgentPage, AgentSchedule, AgentTask } from './agent-api';
import {
  DiagnosticId,
  errorText,
  localDate,
  RefreshWorkspace,
  StateBadge,
  useWorkspaceResource,
  WorkspaceHeader,
  WorkspaceNotice,
} from './workspace-ui';

const fieldKeys: Record<string, string> = {
  title: 'agentWorkbench.fieldTitle',
  artists: 'agentWorkbench.fieldArtists',
  album: 'agentWorkbench.fieldAlbum',
  album_artists: 'agentWorkbench.fieldAlbumArtists',
  composers: 'agentWorkbench.fieldComposers',
  lyricists: 'agentWorkbench.fieldLyricists',
  arrangers: 'agentWorkbench.fieldArrangers',
  vocalists: 'agentWorkbench.fieldVocalists',
  genres: 'agentWorkbench.fieldGenres',
  track_number: 'agentWorkbench.fieldTrackNumber',
  disc_number: 'agentWorkbench.fieldDiscNumber',
  release_date: 'agentWorkbench.fieldReleaseDate',
  artist_credit: 'agentWorkbench.fieldArtistCredit',
  album_artist_credit: 'agentWorkbench.fieldAlbumArtistCredit',
};
const format = (v: unknown, empty = '') =>
  Array.isArray(v) ? v.join(' / ') : v == null ? empty : String(v);
const issueKeys: Record<string, string> = {
  missing_album: 'agentWorkbench.issueMissingAlbum',
  missing_cover: 'agentWorkbench.issueMissingCover',
  missing_lyrics: 'agentWorkbench.issueMissingLyrics',
  missing_artist: 'agentWorkbench.issueMissingArtist',
  missing_title: 'agentWorkbench.issueMissingTitle',
  missing_track_number: 'agentWorkbench.issueMissingTrackNumber',
  track_number_conflict: 'agentWorkbench.issueTrackNumberConflict',
  track_number_out_of_range: 'agentWorkbench.issueTrackNumberOutOfRange',
  disc_number_out_of_range: 'agentWorkbench.issueDiscNumberOutOfRange',
  missing_disc_number: 'agentWorkbench.issueMissingDiscNumber',
  same_title_versions: 'agentWorkbench.issueSameTitleVersions',
  possible_duplicate_recording: 'agentWorkbench.issuePossibleDuplicateRecording',
  possible_multidisc_split: 'agentWorkbench.issuePossibleMultidiscSplit',
  possible_album_split: 'agentWorkbench.issuePossibleAlbumSplit',
  inspection_context_limited: 'agentWorkbench.issueInspectionContextLimited',
  metadata_conflict: 'agentWorkbench.issueMetadataConflict',
  object_version_changed: 'agentWorkbench.issueObjectVersionChanged',
};
const findingKeys: Record<string, string> = {
  inspection_context_limited: 'agentWorkbench.findingInspectionContextLimited',
  missing_title: 'agentWorkbench.findingMissingTitle',
  missing_artist: 'agentWorkbench.findingMissingArtist',
  missing_album: 'agentWorkbench.findingMissingAlbum',
  missing_cover: 'agentWorkbench.findingMissingCover',
  missing_lyrics: 'agentWorkbench.findingMissingLyrics',
  missing_track_number: 'agentWorkbench.findingMissingTrackNumber',
  track_number_conflict: 'agentWorkbench.findingTrackNumberConflict',
  track_number_out_of_range: 'agentWorkbench.findingTrackNumberOutOfRange',
  disc_number_out_of_range: 'agentWorkbench.findingDiscNumberOutOfRange',
  missing_disc_number: 'agentWorkbench.findingMissingDiscNumber',
  same_title_versions: 'agentWorkbench.findingSameTitleVersions',
  possible_duplicate_recording: 'agentWorkbench.findingPossibleDuplicateRecording',
  possible_multidisc_split: 'agentWorkbench.findingPossibleMultidiscSplit',
  possible_album_split: 'agentWorkbench.findingPossibleAlbumSplit',
};
const lyricLevelKeys = [
  'lyricScans.levelNone',
  'lyricScans.levelStatic',
  'lyricScans.levelSyncedLine',
  'lyricScans.levelBilingualLine',
  'lyricScans.levelSyncedWord',
  'lyricScans.levelBilingualWord',
];
const lyricQualityLabel = (t: (key: string) => string, value: unknown) => {
  const q = value as { level?: number; label?: string } | undefined;
  if (!q) return '';
  if (typeof q.level === 'number' && lyricLevelKeys[q.level]) return t(lyricLevelKeys[q.level]);
  return String(q.label || '');
};
const localizeAnalysis = (
  t: (key: string, options?: Record<string, unknown>) => string,
  text: string,
) => {
  const skipped = text.match(/^本地规则已检查 (\d+) 首，未发现待解释的问题，已跳过本次 AI 分析。/);
  if (skipped) return t('agentWorkbench.ruleCheckSkippedAi', { count: Number(skipped[1]) });
  const progress = text.match(/^已完成 (\d+) 次受控工具调用，请查看草案及实际应用状态。$/);
  if (progress) return t('agentWorkbench.toolCallsProgress', { count: Number(progress[1]) });
  return text;
};

function DraftDetail({
  draft,
  user,
  onUpdated,
  onApplied,
}: {
  draft: AgentDraft;
  user: User;
  onUpdated: (value: AgentDraft) => void;
  onApplied: () => void;
}) {
  const { t } = useTranslation();
  const fields = Object.fromEntries(Object.entries(fieldKeys).map(([k, key]) => [k, t(key)]));
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [editing, setEditing] = useState(false),
    [coverReady, setCoverReady] = useState(false),
    [name, setName] = useState(draft.title),
    [values, setValues] = useState<Record<string, string>>({}),
    [tracks, setTracks] = useState<Track[]>([]);
  const original = useWorkspaceResource<{ effective: Record<string, unknown> }>(
    draft.kind === 'metadata' && user.profile !== 'listener'
      ? `/manage/tracks/${encodeURIComponent(String(draft.payload.track_id))}/metadata`
      : null,
  );
  const idempotency = useRef(eventId());
  useEffect(() => {
    setName(String(draft.payload.name || draft.title));
    setValues(
      Object.fromEntries(
        Object.entries((draft.payload.overrides || {}) as Record<string, unknown>).map(([k, v]) => [
          k,
          Array.isArray(v) ? v.join('\n') : v == null ? '' : String(v),
        ]),
      ),
    );
    setEditing(false);
    setCoverReady(false);
    setError('');
    idempotency.current = eventId();
  }, [draft.id, draft.version]);
  useEffect(() => {
    const controller = new AbortController();
    setTracks([]);
    if (draft.kind === 'playlist') {
      const ids = [
        ...new Set([
          ...(Array.isArray(draft.payload.track_ids) ? (draft.payload.track_ids as string[]) : []),
          ...(Array.isArray(draft.before?.track_ids) ? (draft.before.track_ids as string[]) : []),
        ]),
      ];
      void Promise.all(
        ids.map((id) =>
          api<Track>(`/tracks/${encodeURIComponent(id)}`, { signal: controller.signal }),
        ),
      )
        .then((items) => {
          if (!controller.signal.aborted) setTracks(items);
        })
        .catch((reason) => {
          if (!controller.signal.aborted) setError(errorText(reason));
        });
    }
    return () => controller.abort();
  }, [draft.id, draft.version]);
  async function action(kind: 'accept' | 'reject' | 'edit') {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      let payload = draft.payload;
      if (kind === 'edit') {
        if (draft.kind === 'playlist') payload = { ...payload, name };
        else
          payload = {
            ...payload,
            overrides: Object.fromEntries(
              Object.entries(values).map(([key, value]) => {
                const prior = (draft.payload.overrides as Record<string, unknown>)[key];
                return [
                  key,
                  Array.isArray(prior)
                    ? value
                        .split('\n')
                        .map((v) => v.trim())
                        .filter(Boolean)
                    : typeof prior === 'number'
                      ? Number(value)
                      : value || null,
                ];
              }),
            ),
          };
      }
      const result = await api<AgentDraft>(
        `/agent/drafts/${draft.id}${kind === 'edit' ? '' : `/${kind}`}`,
        {
          method: kind === 'edit' ? 'PATCH' : 'POST',
          body: JSON.stringify({
            version: draft.version,
            ...(kind === 'accept' && draft.preview_digest
              ? { preview_digest: draft.preview_digest }
              : {}),
            ...(kind === 'accept' ? { idempotency_key: idempotency.current } : {}),
            ...(kind === 'edit'
              ? { payload, title: draft.kind === 'playlist' ? name : draft.title }
              : {}),
          }),
        },
      );
      onUpdated(result);
      if (result.status === 'applied') onApplied();
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  }
  const permitted = draft.kind === 'playlist' || user.profile === 'owner';
  return (
    <article className="workspace-card" aria-label={t('agentWorkbench.draftAriaLabel')}>
      <div className="workspace-card-head">
        <div>
          <h2>{draft.title}</h2>
          <small>
            {
              {
                playlist: t('agentWorkbench.kindPlaylist'),
                metadata: t('agentWorkbench.kindMetadata'),
                intake: t('agentWorkbench.kindIntake'),
                lyrics: t('agentWorkbench.kindLyrics'),
                cover: t('agentWorkbench.kindCover'),
                metadata_batch: t('agentWorkbench.kindMetadataBatch'),
              }[draft.kind]
            }{' '}
            {t('agentWorkbench.draftMeta', {
              version: draft.version,
              date: localDate(draft.updated_at),
            })}
          </small>
        </div>
        <StateBadge state={draft.status} />
      </div>
      <WorkspaceNotice error={error} />
      <p className="muted">
        {draft.status === 'applied'
          ? draft.result?.application_mode === 'automatic'
            ? t('agentWorkbench.statusAppliedAuto')
            : t('agentWorkbench.statusApplied')
          : draft.status === 'approved'
            ? t('agentWorkbench.statusApproved')
            : t('agentWorkbench.statusPending')}
      </p>
      {draft.kind === 'playlist' ? (
        <>
          <p>
            {t('agentWorkbench.playlistSummary', {
              name: String(draft.payload.name || draft.title),
              count: Array.isArray(draft.payload.track_ids) ? draft.payload.track_ids.length : 0,
            })}
          </p>
          {editing && (
            <label>
              {t('agentWorkbench.playlistNameLabel')}
              <input
                aria-label={t('agentWorkbench.playlistNameAriaLabel')}
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={100}
              />
            </label>
          )}
          {draft.before?.name != null && (
            <p className="muted">
              {t('agentWorkbench.playlistDiffNote', {
                beforeName: String(draft.before.name),
                beforeCount: Array.isArray(draft.before.track_ids)
                  ? draft.before.track_ids.length
                  : 0,
                afterName: String(draft.payload.name || draft.title),
                afterCount: Array.isArray(draft.payload.track_ids)
                  ? draft.payload.track_ids.length
                  : 0,
              })}
            </p>
          )}
          {Array.isArray(draft.before?.track_ids) &&
            tracks.some(
              (track) =>
                (draft.before!.track_ids as string[]).includes(track.id) &&
                !(draft.payload.track_ids as string[]).includes(track.id),
            ) && (
              <details open>
                <summary>{t('agentWorkbench.tracksToRemove')}</summary>
                <ul>
                  {tracks
                    .filter(
                      (track) =>
                        (draft.before!.track_ids as string[]).includes(track.id) &&
                        !(draft.payload.track_ids as string[]).includes(track.id),
                    )
                    .map((track) => (
                      <li key={track.id}>
                        {track.title} · {track.artists.join(' / ')}
                      </li>
                    ))}
                </ul>
              </details>
            )}
          <ol className="draft-track-list">
            {tracks
              .filter((track) => ((draft.payload.track_ids as string[]) || []).includes(track.id))
              .map((track) => (
                <li key={track.id}>
                  <strong>{track.title}</strong>
                  <span>
                    {track.artists.join(' / ')} · {track.album || t('agentWorkbench.unknownAlbum')}
                  </span>
                </li>
              ))}
          </ol>
        </>
      ) : draft.kind === 'cover' || draft.kind === 'metadata_batch' ? (
        <CurationDraftPreview
          key={`${draft.id}:${draft.version}`}
          draft={draft}
          fields={fields}
          onPreviewReady={setCoverReady}
        />
      ) : draft.kind === 'lyrics' ? (
        <div>
          <p>
            {t('agentWorkbench.lyricsTrack', {
              title: String(draft.before?.title || draft.before?.track_id || ''),
            })}
          </p>
          <p>
            {t('agentWorkbench.lyricsSourceOffset', {
              provider: String(draft.before?.provider || ''),
              offset: Number(draft.payload.offset_ms || 0),
            })}
          </p>
          <p>
            {t('agentWorkbench.lyricsQuality', {
              current: lyricQualityLabel(t, draft.before?.current_quality),
              candidate: lyricQualityLabel(t, draft.before?.candidate_quality),
            })}
          </p>
          <p>
            {t('agentWorkbench.lyricsMatchBasis', { match: JSON.stringify(draft.before?.match) })}
          </p>
          <div className="workspace-diff">
            <strong>{t('agentWorkbench.lyricsCurrentPreview')}</strong>
            <pre>
              {((draft.before?.current_lines as { text: string }[]) || [])
                .map((line) => line.text)
                .join('\n')}
            </pre>
            <strong>{t('agentWorkbench.lyricsCandidatePreview')}</strong>
            <pre>
              {((draft.before?.candidate_lines as { text: string; translation?: string }[]) || [])
                .map((line) => [line.text, line.translation].filter(Boolean).join(' / '))
                .join('\n')}
            </pre>
          </div>
          <p className="muted">{t('agentWorkbench.lyricsNote')}</p>
        </div>
      ) : (
        <table className="workspace-diff">
          <thead>
            <tr>
              <th>{t('agentWorkbench.tableField')}</th>
              <th>{t('agentWorkbench.tableCurrent')}</th>
              <th>{t('agentWorkbench.tableSuggested')}</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries((draft.payload.overrides || {}) as Record<string, unknown>).map(
              ([key, value]) => (
                <tr key={key}>
                  <th>{fields[key] || key}</th>
                  <td>
                    {draft.before
                      ? format(draft.before[key], t('agentWorkbench.emptyValue'))
                      : original.value
                        ? format(original.value.effective[key], t('agentWorkbench.emptyValue'))
                        : t('agentWorkbench.readingMetadata')}
                  </td>
                  <td>
                    {editing ? (
                      <textarea
                        aria-label={t('agentWorkbench.draftFieldAriaLabel', {
                          field: fields[key] || key,
                        })}
                        value={values[key] || ''}
                        onChange={(e) => setValues({ ...values, [key]: e.target.value })}
                      />
                    ) : (
                      format(value, t('agentWorkbench.emptyValue'))
                    )}
                  </td>
                </tr>
              ),
            )}
          </tbody>
        </table>
      )}
      {draft.kind === 'intake' && (
        <p className="muted">
          {t('agentWorkbench.intakeNote', { source: String(draft.before?.source_path || '') })}
        </p>
      )}
      <h3>{t('agentWorkbench.evidenceHeading')}</h3>
      {draft.evidence.length ? (
        <ul className="draft-evidence">
          {draft.evidence.map((item, index) => (
            <li key={index}>
              <strong>{item.source}</strong>
              <p>{item.summary}</p>
              {item.url && /^https?:\/\//.test(item.url) && (
                <a href={item.url} target="_blank" rel="noopener noreferrer">
                  {t('agentWorkbench.viewSource')}
                </a>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">{t('agentWorkbench.noEvidence')}</p>
      )}
      <DiagnosticId id={draft.trace_id} />
      {draft.status !== 'applied' && draft.status !== 'rejected' && (
        <div className="workspace-actions">
          {editing ? (
            <>
              <button className="primary" disabled={busy} onClick={() => void action('edit')}>
                {t('agentWorkbench.saveAndReconfirm')}
              </button>
              <button disabled={busy} onClick={() => setEditing(false)}>
                {t('agentWorkbench.cancelChanges')}
              </button>
            </>
          ) : (
            <>
              <button
                disabled={
                  busy || !permitted || ['lyrics', 'cover', 'metadata_batch'].includes(draft.kind)
                }
                onClick={() => setEditing(true)}
              >
                {t('agentWorkbench.editDraft')}
              </button>
              <button
                className="primary"
                disabled={
                  busy ||
                  !permitted ||
                  ((draft.kind === 'cover' || !!draft.payload.cover_draft_id) && !coverReady)
                }
                onClick={() => void action('accept')}
              >
                {busy ? t('agentWorkbench.applying') : t('agentWorkbench.acceptAndApply')}
              </button>
              <button disabled={busy} onClick={() => void action('reject')}>
                {t('agentWorkbench.rejectDraft')}
              </button>
            </>
          )}
        </div>
      )}
      {!permitted && <p className="muted">{t('agentWorkbench.adminRequiredNote')}</p>}
      {Boolean(draft.result?.automatic_error) && (
        <p role="alert">
          {t('agentWorkbench.autoError', {
            error: errorCodeMessage(String(draft.result?.automatic_error)),
          })}
        </p>
      )}
      {draft.result && draft.status === 'applied' && (
        <p role="status">
          {t('agentWorkbench.resultPrefix')}
          {draft.result.playlist_id
            ? t('agentWorkbench.resultPlaylistSaved')
            : draft.result.track_id
              ? t('agentWorkbench.resultTrackUpdated')
              : t('agentWorkbench.resultRecorded')}
        </p>
      )}
    </article>
  );
}
export function Drafts({
  user,
  selectedId,
  onChanged,
}: {
  user: User;
  selectedId?: string;
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState('pending'),
    [offset, setOffset] = useState(0),
    [selected, setSelected] = useState<AgentDraft | null>(null),
    [error, setError] = useState('');
  const list = useWorkspaceResource<AgentPage<AgentDraft>>(
    `/agent/drafts?limit=20&offset=${offset}${filter ? `&status=${filter}` : ''}`,
  );
  useEffect(() => {
    if (!selectedId) return;
    const c = new AbortController();
    void api<AgentDraft>(`/agent/drafts/${encodeURIComponent(selectedId)}`, { signal: c.signal })
      .then(setSelected)
      .catch((reason) => {
        if (!c.signal.aborted) setError(errorText(reason));
      });
    return () => c.abort();
  }, [selectedId]);
  return (
    <section className="workspace-page" aria-label={t('agentWorkbench.pageAriaLabel')}>
      <WorkspaceHeader
        title={t('agentWorkbench.headerTitle')}
        description={t('agentWorkbench.headerDescription')}
      >
        <RefreshWorkspace busy={list.loading} onClick={() => void list.reload()} />
      </WorkspaceHeader>
      <WorkspaceNotice error={error || list.error} unavailable={list.unsupported} />
      <div className="workspace-tabs">
        {[
          ['pending', t('agentWorkbench.tabPending')],
          ['approved', t('agentWorkbench.tabApproved')],
          ['applied', t('agentWorkbench.tabApplied')],
          ['rejected', t('agentWorkbench.tabRejected')],
          ['', t('agentWorkbench.tabAll')],
        ].map(([key, label]) => (
          <button
            key={key}
            aria-pressed={filter === key}
            onClick={() => {
              setFilter(key);
              setOffset(0);
            }}
          >
            {label}
          </button>
        ))}
      </div>
      {selected && (
        <>
          <button className="text-button" onClick={() => setSelected(null)}>
            {t('agentWorkbench.backToList')}
          </button>
          <DraftDetail
            key={selected.id}
            draft={selected}
            user={user}
            onUpdated={(value) => {
              setSelected(value);
              void list.reload();
            }}
            onApplied={onChanged}
          />
        </>
      )}
      {!selected && (
        <div className="workspace-card">
          {list.value?.items.map((draft) => (
            <div className="workspace-row" key={draft.id}>
              <div className="workspace-row-main">
                <strong>{draft.title}</strong>
                <small>
                  {
                    {
                      playlist: t('agentWorkbench.kindPlaylistShort'),
                      metadata: t('agentWorkbench.kindMetadataShort'),
                      intake: t('agentWorkbench.kindIntakeShort'),
                      lyrics: t('agentWorkbench.kindLyricsShort'),
                      cover: t('agentWorkbench.kindCoverShort'),
                      metadata_batch: t('agentWorkbench.kindMetadataBatchShort'),
                    }[draft.kind]
                  }{' '}
                  · {localDate(draft.updated_at)}
                </small>
              </div>
              <StateBadge state={draft.status} />
              <button
                aria-label={t('agentWorkbench.viewDiffAria', { title: draft.title })}
                onClick={() => setSelected(draft)}
              >
                {t('agentWorkbench.viewDiff')}
              </button>
            </div>
          ))}
          {!list.value?.items.length && !list.unsupported && (
            <p className="workspace-empty">
              {list.loading ? t('agentWorkbench.loadingDrafts') : t('agentWorkbench.emptyDrafts')}
            </p>
          )}
          <WorkspacePagination
            offset={offset}
            total={list.value?.total || 0}
            onOffset={setOffset}
          />
        </div>
      )}
    </section>
  );
}
export function WorkspacePagination({
  offset,
  total,
  onOffset,
}: {
  offset: number;
  total: number;
  onOffset: (n: number) => void;
}) {
  const { t } = useTranslation();
  return total > 20 ? (
    <div className="workspace-inline">
      <button disabled={!offset} onClick={() => onOffset(Math.max(0, offset - 20))}>
        {t('agentWorkbench.prevPage')}
      </button>
      <span className="muted">
        {offset + 1}–{Math.min(offset + 20, total)} / {total}
      </span>
      <button disabled={offset + 20 >= total} onClick={() => onOffset(offset + 20)}>
        {t('agentWorkbench.nextPage')}
      </button>
    </div>
  ) : null;
}

export function AgentTasks({
  selectedId,
  onDraft,
}: {
  selectedId?: string;
  onDraft?: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [editingSchedule, setEditingSchedule] = useState<AgentSchedule | null>(null);
  const [tab, setTab] = useState('tasks'),
    [offset, setOffset] = useState(0),
    [selected, setSelected] = useState<string | null>(selectedId || null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [maxTracks, setMaxTracks] = useState(500),
    [useAI, setUseAI] = useState(false),
    [connection, setConnection] = useState(''),
    [maxCalls, setMaxCalls] = useState(4),
    [scheduleName, setScheduleName] = useState(() => t('agentWorkbench.defaultScheduleName')),
    [hours, setHours] = useState(24),
    [timezone, setTimezone] = useState(
      Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai',
    );
  const tasks = useWorkspaceResource<AgentPage<AgentTask>>(
      `/agent/tasks?limit=20&offset=${offset}`,
      5000,
    ),
    schedules = useWorkspaceResource<AgentPage<AgentSchedule>>('/agent/schedules?limit=100'),
    connections = useWorkspaceResource<AgentPage<AgentConnection>>('/agent/connections'),
    detail = useWorkspaceResource<AgentTask>(
      selected ? `/agent/tasks/${encodeURIComponent(selected)}` : null,
      5000,
    );
  useEffect(() => setSelected(selectedId || null), [selectedId]);
  async function perform(path: string, method: string, body: unknown, message: string) {
    if (busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await api(path, { method, body: body ? JSON.stringify(body) : undefined });
      setNotice(message);
      await Promise.all([tasks.reload(), schedules.reload(), detail.reload()]);
      return true;
    } catch (reason) {
      setError(errorText(reason));
      return false;
    } finally {
      setBusy(false);
    }
  }
  const params = {
    max_tracks: maxTracks,
    max_calls: useAI ? maxCalls : 0,
    use_ai: useAI,
    ...(useAI ? { connection_id: connection } : {}),
  };
  const availableConnections = (connections.value?.items || []).filter(
    (c) => c.enabled && (tab === 'tasks' || c.background_allowed),
  );
  const selectedConnectionAvailable = availableConnections.some((c) => c.id === connection);
  const item = detail.value;
  const stageName = (stage: string, status: string) =>
    stage === 'completed' && status !== 'succeeded'
      ? t('agentWorkbench.stageCompletedIncomplete')
      : (
          {
            rules: t('agentWorkbench.stageRules'),
            model_call: t('agentWorkbench.stageModelCall'),
            analysis_complete: t('agentWorkbench.stageAnalysisComplete'),
            completed: t('agentWorkbench.stageCompleted'),
            queued: t('agentWorkbench.stageQueued'),
            paused_authorization: t('agentWorkbench.stagePausedAuth'),
            paused_budget: t('agentWorkbench.stagePausedBudget'),
          } as Record<string, string>
        )[stage] || t('agentWorkbench.stageChecking');
  return (
    <section className="workspace-page" aria-label={t('agentWorkbench.tasksAriaLabel')}>
      <WorkspaceHeader
        title={t('agentWorkbench.tasksTitle')}
        description={t('agentWorkbench.tasksDescription')}
      >
        <RefreshWorkspace
          busy={tasks.loading}
          onClick={() => {
            void tasks.reload();
            void detail.reload();
            void schedules.reload();
          }}
        />
      </WorkspaceHeader>
      <WorkspaceNotice
        error={error || tasks.error || schedules.error || detail.error}
        notice={notice}
        unavailable={tasks.unsupported}
      />
      <div className="workspace-tabs">
        <button
          aria-pressed={tab === 'tasks'}
          onClick={() => {
            setTab('tasks');
            setEditingSchedule(null);
          }}
        >
          {t('agentWorkbench.tabTasks')}
        </button>
        <button aria-pressed={tab === 'schedules'} onClick={() => setTab('schedules')}>
          {t('agentWorkbench.tabSchedules')}
        </button>
      </div>
      {!tasks.unsupported && (
        <>
          <form
            id="inspection-form"
            className="workspace-card"
            onSubmit={(e) => {
              e.preventDefault();
              if (useAI && !selectedConnectionAvailable) return;
              void perform(
                tab === 'tasks'
                  ? '/agent/tasks'
                  : editingSchedule
                    ? `/agent/schedules/${editingSchedule.id}`
                    : '/agent/schedules',
                tab === 'schedules' && editingSchedule ? 'PATCH' : 'POST',
                tab === 'tasks'
                  ? params
                  : {
                      name: scheduleName,
                      enabled: editingSchedule?.enabled || false,
                      interval_hours: hours,
                      timezone,
                      parameters: { ...(editingSchedule?.parameters || {}), ...params },
                      ...(editingSchedule ? { version: editingSchedule.version } : {}),
                    },
                tab === 'tasks'
                  ? t('agentWorkbench.taskSubmitted')
                  : editingSchedule
                    ? t('agentWorkbench.scheduleUpdated')
                    : t('agentWorkbench.scheduleSavedDisabled'),
              ).then((success) => {
                if (success) setEditingSchedule(null);
              });
            }}
          >
            <h2>
              {tab === 'tasks'
                ? t('agentWorkbench.titleStartInspection')
                : editingSchedule
                  ? t('agentWorkbench.titleEditSchedule')
                  : t('agentWorkbench.titleAddSchedule')}
            </h2>
            <div className="workspace-form">
              {tab === 'schedules' && (
                <>
                  <label>
                    {t('agentWorkbench.scheduleNameLabel')}
                    <input
                      required
                      maxLength={100}
                      value={scheduleName}
                      onChange={(e) => setScheduleName(e.target.value)}
                    />
                  </label>
                  <label>
                    {t('agentWorkbench.intervalHoursLabel')}
                    <input
                      required
                      type="number"
                      min={1}
                      max={720}
                      value={hours}
                      onChange={(e) => setHours(Number(e.target.value))}
                    />
                  </label>
                  <label>
                    {t('agentWorkbench.timezoneLabel')}
                    <input
                      required
                      value={timezone}
                      onChange={(e) => setTimezone(e.target.value)}
                    />
                  </label>
                </>
              )}
              <label>
                {t('agentWorkbench.maxTracksLabel')}
                <input
                  aria-label={t('agentWorkbench.maxTracksAriaLabel')}
                  required
                  type="number"
                  min={1}
                  max={5000}
                  value={maxTracks}
                  onChange={(e) => setMaxTracks(Number(e.target.value))}
                />
              </label>
              <label className="workspace-check">
                <input
                  type="checkbox"
                  checked={useAI}
                  onChange={(e) => setUseAI(e.target.checked)}
                />
                {t('agentWorkbench.useAiLabel')}
              </label>
              {useAI && (
                <>
                  <label>
                    {tab === 'tasks'
                      ? t('agentWorkbench.currentModelLabel')
                      : t('agentWorkbench.scheduleModelLabel')}
                    <select
                      aria-label={t('agentWorkbench.modelSelectAriaLabel')}
                      required
                      value={selectedConnectionAvailable ? connection : ''}
                      onChange={(e) => setConnection(e.target.value)}
                    >
                      <option value="">{t('agentWorkbench.selectAiConnection')}</option>
                      {availableConnections.map((c) => (
                        <option value={c.id} key={c.id}>
                          {c.name} · {c.model}
                        </option>
                      ))}
                    </select>
                  </label>
                  {!selectedConnectionAvailable && !connections.loading && (
                    <p role="status">
                      {availableConnections.length
                        ? t('agentWorkbench.selectAiConnectionHint')
                        : tab === 'tasks'
                          ? t('agentWorkbench.noAiConnectionTasks')
                          : t('agentWorkbench.noAiConnectionSchedules')}
                    </p>
                  )}
                  <label>
                    {t('agentWorkbench.maxCallsLabel')}
                    <input
                      required
                      type="number"
                      min={1}
                      max={100}
                      value={maxCalls}
                      onChange={(e) => setMaxCalls(Number(e.target.value))}
                    />
                  </label>
                </>
              )}
              <div className="span-all workspace-inline">
                <button
                  className="primary"
                  disabled={busy || (useAI && !selectedConnectionAvailable)}
                >
                  {busy
                    ? t('agentWorkbench.submitting')
                    : tab === 'tasks'
                      ? useAI
                        ? t('agentWorkbench.submitAiInspection')
                        : t('agentWorkbench.submitRuleInspection')
                      : editingSchedule
                        ? t('agentWorkbench.saveScheduleChanges')
                        : t('agentWorkbench.saveDisabledSchedule')}
                </button>
                {editingSchedule && (
                  <button type="button" disabled={busy} onClick={() => setEditingSchedule(null)}>
                    {t('agentWorkbench.cancelEditSchedule')}
                  </button>
                )}
                <span className="muted">
                  {useAI
                    ? tab === 'tasks'
                      ? t('agentWorkbench.aiTasksNotice')
                      : t('agentWorkbench.aiSchedulesNotice')
                    : t('agentWorkbench.rulesNotice')}
                </span>
              </div>
            </div>
          </form>
          {tab === 'tasks' ? (
            <>
              <div className="workspace-card">
                {tasks.value?.items.map((task) => (
                  <div className="workspace-row" key={task.id}>
                    <div className="workspace-row-main">
                      <strong>
                        {task.parameters.use_ai
                          ? t('agentWorkbench.taskAiInspection')
                          : t('agentWorkbench.taskRuleInspection')}
                      </strong>
                      <small>
                        {localDate(task.created_at)} · {stageName(task.stage, task.status)}
                      </small>
                    </div>
                    <StateBadge state={task.status} />
                    <button onClick={() => setSelected(task.id)}>
                      {t('agentWorkbench.viewTask')}
                    </button>
                  </div>
                ))}
                {!tasks.value?.items.length && (
                  <p className="workspace-empty">{t('agentWorkbench.emptyTasks')}</p>
                )}
                <WorkspacePagination
                  total={tasks.value?.total || 0}
                  offset={offset}
                  onOffset={setOffset}
                />
              </div>
              {item && (
                <article
                  className="workspace-card"
                  aria-label={t('agentWorkbench.detailAriaLabel')}
                >
                  <div className="workspace-card-head">
                    <div>
                      <h2>{t('agentWorkbench.inspectionResultTitle')}</h2>
                      <small>
                        {t('agentWorkbench.taskSummaryHeader', {
                          id: item.id,
                          stage: stageName(item.stage, item.status),
                        })}
                      </small>
                    </div>
                    <StateBadge state={item.status} />
                  </div>
                  <p>
                    {Object.entries(item.counts)
                      .map(
                        ([k, v]) =>
                          `${
                            (
                              {
                                processed: t('agentWorkbench.countProcessed'),
                                total: t('agentWorkbench.countTotal'),
                                issues: t('agentWorkbench.countIssues'),
                                failed: t('agentWorkbench.countFailed'),
                                drafts: t('agentWorkbench.countDrafts'),
                                skipped: t('agentWorkbench.countSkipped'),
                                calls: t('agentWorkbench.countCalls'),
                              } as Record<string, string>
                            )[k] || k
                          } ${v}`,
                      )
                      .join(' · ')}
                  </p>
                  {item.error_code && <p role="status">{errorCodeMessage(item.error_code)}</p>}
                  <DiagnosticId id={item.trace_id} />
                  <div className="workspace-actions">
                    {['queued', 'running', 'retry_wait'].includes(item.status) && (
                      <button
                        disabled={busy}
                        onClick={() =>
                          void perform(
                            `/agent/tasks/${item.id}/cancel`,
                            'POST',
                            {},
                            t('agentWorkbench.cancelRequestedNotice'),
                          )
                        }
                      >
                        {t('agentWorkbench.requestCancel')}
                      </button>
                    )}
                    {[
                      'paused_authorization',
                      'paused_budget',
                      'failed',
                      'interrupted',
                      'partial',
                    ].includes(item.status) && (
                      <button
                        disabled={busy}
                        onClick={() =>
                          void perform(
                            `/agent/tasks/${item.id}/resume`,
                            'POST',
                            {},
                            t('agentWorkbench.resumedNotice'),
                          )
                        }
                      >
                        {t('agentWorkbench.resumeFromProgress')}
                      </button>
                    )}
                  </div>
                  {item.results?.map((result, index) => (
                    <div className="workspace-row" key={result.track_id || `analysis-${index}`}>
                      <div className="workspace-row-main">
                        <strong>
                          {result.analysis
                            ? result.ai_skipped
                              ? t('agentWorkbench.ruleCheckDescription')
                              : t('agentWorkbench.aiAnalysisResult')
                            : result.title || t('agentWorkbench.unreadableTrack')}
                        </strong>
                        {result.analysis ? (
                          <p>{localizeAnalysis(t, result.analysis)}</p>
                        ) : (
                          <small>
                            {result.error_code
                              ? t('agentWorkbench.checkIncompleteError')
                              : (result.issues || [])
                                  .map((issue) => (issueKeys[issue] ? t(issueKeys[issue]) : issue))
                                  .join(' · ') || t('agentWorkbench.noRuleIssues')}
                          </small>
                        )}
                        {result.findings?.map((finding) => (
                          <p className="muted" key={finding.code}>
                            {findingKeys[finding.code]
                              ? t(findingKeys[finding.code])
                              : finding.summary}
                          </p>
                        ))}
                        {result.draft_ids?.map((id) => (
                          <button key={id} onClick={() => onDraft?.(id)}>
                            {t('agentWorkbench.viewDraftAndResult')}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </article>
              )}
            </>
          ) : (
            <div className="workspace-card">
              {schedules.value?.items.map((schedule) => (
                <div className="workspace-row" key={schedule.id}>
                  <div className="workspace-row-main">
                    <strong>{schedule.name}</strong>
                    <small>
                      {t('agentWorkbench.scheduleSummary', {
                        hours: schedule.interval_hours,
                        timezone: schedule.timezone,
                        nextRun: localDate(schedule.next_run_at),
                      })}
                    </small>
                  </div>
                  <button
                    disabled={busy}
                    onClick={() => {
                      setEditingSchedule(schedule);
                      setScheduleName(schedule.name);
                      setHours(schedule.interval_hours);
                      setTimezone(schedule.timezone);
                      setMaxTracks(Number(schedule.parameters.max_tracks) || 500);
                      setUseAI(Boolean(schedule.parameters.use_ai));
                      setMaxCalls(Number(schedule.parameters.max_calls) || 4);
                      setConnection(String(schedule.parameters.connection_id || ''));
                      document
                        .getElementById('inspection-form')
                        ?.scrollIntoView({ behavior: 'smooth' });
                    }}
                  >
                    {t('agentWorkbench.editSchedule')}
                  </button>
                  <button
                    disabled={busy}
                    aria-pressed={schedule.enabled}
                    onClick={() =>
                      void perform(
                        `/agent/schedules/${schedule.id}`,
                        'PATCH',
                        {
                          name: schedule.name,
                          interval_hours: schedule.interval_hours,
                          timezone: schedule.timezone,
                          parameters: schedule.parameters,
                          version: schedule.version,
                          enabled: !schedule.enabled,
                        },
                        schedule.enabled
                          ? t('agentWorkbench.scheduleDisabledNotice')
                          : t('agentWorkbench.scheduleEnabledNotice'),
                      )
                    }
                  >
                    {schedule.enabled
                      ? t('agentWorkbench.disableSchedule')
                      : t('agentWorkbench.enableSchedule')}
                  </button>
                  <button
                    disabled={busy}
                    onClick={() => {
                      if (
                        confirm(t('agentWorkbench.deleteScheduleConfirm', { name: schedule.name }))
                      )
                        void perform(
                          `/agent/schedules/${schedule.id}`,
                          'DELETE',
                          null,
                          t('agentWorkbench.scheduleDeletedNotice'),
                        );
                    }}
                  >
                    {t('agentWorkbench.deleteSchedule')}
                  </button>
                </div>
              ))}
              {!schedules.value?.items.length && (
                <p className="workspace-empty">{t('agentWorkbench.emptySchedules')}</p>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
