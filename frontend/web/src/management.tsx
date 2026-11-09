import { SettingsLayout, type SettingsCategory } from './settings-layout';
import { PodcastResourceManager } from './podcast-resources';
import { PodcastDownloadManager } from './podcast-downloads';
import { HelpText } from './desktop-help';
import { importCounterHelp } from './help-content';
import { SystemDiagnostics } from './system-diagnostics';
import { ProviderSettings } from './providers';
import { LyricScanEntry } from './lyric-scans';
import { UsersPanel } from './accounts';
import { TranscodingSettings } from './transcoding-settings';
import { ServerSettings } from './server-settings';
import { HostSettings } from './host-settings';
import { useEffect, useRef, useState } from 'react';
import { api, type Track, type TrackPage, type User } from './api';
import { Pagination } from './track-list';
import { IntakePanel } from './intake-panel';
import { MetadataJobs } from './metadata-tasks';
import { MetadataReviewDialog } from './metadata-review';
import { FolderMetadataEditor } from './folder-metadata';
import { LibrarySources } from './library-sources';
import { MusicLibraryManager, LibrarySwitcher } from './music-libraries';
import { PodcastIdentityAdmin } from './podcast-identity-admin';
import { PodcastProgrammesAdmin } from './podcast-programmes-admin';
import { PodcastSearchSettings } from './podcast-search-settings';
import { PodcastCatalogSettings } from './podcast-catalog-settings';
import { useTranslation } from 'react-i18next';

type Directory = {
  path: string;
  available: boolean;
  free_bytes: number | null;
  total_bytes: number | null;
};
type Run = {
  status: string;
  counts: Record<string, number>;
  errors: { path: string; code: string }[];
};
interface Job {
  id: string;
  kind: 'import' | 'scan';
  full: boolean;
  status: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
  import: Run | null;
  scan: Run | null;
}
interface Jobs {
  items: Job[];
  total: number;
  limit: number;
  offset: number;
}
interface Overview {
  active_job: string | null;
  version: string;
  schema_version: number;
  preferences: { name: string; version: number };
  counts: { tracks: number; size_bytes: number; unavailable: number };
  albums: number;
  artists: number;
  source: Directory;
  library: Directory;
  data: Directory;
  last_scan: Run | null;
  deployment: { host: string; port: number; cookie_secure: boolean; connection_policy?: string };
}
const statuses: Record<string, string> = {
  queued: 'management.statusQueued',
  running: 'management.statusRunning',
  completed: 'management.statusCompleted',
  completed_with_errors: 'management.statusCompletedWithErrors',
  failed: 'management.statusFailed',
  interrupted: 'management.statusInterrupted',
};
const counterLabels: Record<string, string> = {
  visited: 'management.counterVisited',
  added: 'management.counterAdded',
  updated: 'management.counterUpdated',
  unchanged: 'management.counterUnchanged',
  errors: 'management.counterErrors',
  missing: 'management.counterMissing',
  skipped: 'management.counterSkipped',
  copied: 'management.counterCopied',
  duplicates: 'management.counterDuplicates',
  assets_copied: 'management.counterAssetsCopied',
  conflicts: 'management.counterConflicts',
  review: 'management.counterReview',
  waiting: 'management.counterWaiting',
  converted: 'management.counterConverted',
};
const errorLabels: Record<string, string> = {
  metadata_invalid: 'management.errorMetadataInvalid',
  file_unreadable: 'management.errorFileUnreadable',
  file_changed: 'management.errorFileChanged',
  root_unavailable: 'management.errorRootUnavailable',
  source_unavailable: 'management.errorSourceUnavailable',
  source_directory_unreadable: 'management.errorSourceDirectoryUnreadable',
  import_file_unavailable: 'management.errorImportFileUnavailable',
  intake_file_unavailable: 'management.errorIntakeFileUnavailable',
  source_changed_managed_copy_preserved: 'management.errorSourceChangedManagedCopyPreserved',
  source_changed_during_import: 'management.errorSourceChangedDuringImport',
  directory_unreadable: 'management.errorDirectoryUnreadable',
};
function bytes(value: number | null) {
  if (value === null) return 'management.sizeUnavailable';
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(1)} GB`;
}
function timestamp(value: string | null) {
  return value ? new Date(value).toLocaleString() : '—';
}
function RunDetail({ title, run }: { title: string; run: Run | null }) {
  const { t } = useTranslation();
  return (
    run && (
      <section className="run-detail">
        <h4>
          {title} · {t(statuses[run.status] || run.status)}
        </h4>
        <div className="run-counters">
          {Object.entries(run.counts).map(([key, n]) => (
            <HelpText key={key} text={importCounterHelp[key]}>
              {t(counterLabels[key] || key)} <b>{n}</b>
            </HelpText>
          ))}
        </div>
        {run.errors.length > 0 && (
          <ul className="run-errors">
            {run.errors.map((item, i) => (
              <li key={i}>
                <code>{item.path}</code>
                <span>{t(errorLabels[item.code] || item.code)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    )
  );
}

export type ManagementTab =
  | 'home'
  | 'overview'
  | 'tracks'
  | 'jobs'
  | 'intake'
  | 'libraries'
  | 'library-settings'
  | 'users'
  | 'diagnostics'
  | 'programmes'
  | 'catalog'
  | 'search'
  | 'identity'
  | 'resources'
  | 'downloads'
  | 'providers'
  | 'models'
  | 'transcoding'
  | 'access'
  | 'status';

export function Management({
  revision,
  onBack,
  onEdit,
  onChanged,
  onRefresh,
  onOpenConnections,
  onViewPodcast,
  profile,
  initialAction,
  initialTab = 'home',
  onTabChanged,
}: {
  revision: number;
  onBack: () => void;
  onEdit: (track: Track) => void;
  onChanged: () => void;
  onRefresh: () => void;
  onOpenConnections: () => void;
  onViewPodcast: (podcastId: string) => void;
  profile: User['profile'];
  initialAction?: { type: 'metadata-center'; batchId?: string } | null;
  initialTab?: ManagementTab;
  onTabChanged?: (tab: ManagementTab) => void;
}) {
  const canOwner = profile === 'owner';
  const canImport = profile === 'owner' || profile === 'librarian';
  const canPodcastAdmin = canImport;
  const [tab, updateTab] = useState<ManagementTab>(initialTab);
  const { t } = useTranslation();
  const [downloadQueue, setDownloadQueue] = useState<{
    total_pending: number;
    failed_count: number;
  } | null>(null);
  const downloadPending = downloadQueue?.total_pending ?? 0;
  useEffect(() => {
    if (!canPodcastAdmin) return;
    let cancelled = false;
    const load = () =>
      api<{ total_pending: number; failed_count: number }>('/podcasts/downloads/queue')
        .then((queue) => {
          if (!cancelled) setDownloadQueue(queue);
        })
        .catch(() => undefined);
    void load();
    const timer = setInterval(load, downloadPending > 0 ? 5000 : 12000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [canPodcastAdmin, downloadPending]);
  function setTab(value: ManagementTab) {
    updateTab(value);
    onTabChanged?.(value);
  }
  useEffect(() => {
    updateTab(initialTab);
  }, [initialTab]);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [metadataBatchId, setMetadataBatchId] = useState<string | undefined>(
    initialAction?.batchId,
  );
  const finished = useRef<string | null>(null);
  const [overview, setOverview] = useState<Overview | null>(null),
    [jobs, setJobs] = useState<Jobs | null>(null),
    [tracks, setTracks] = useState<TrackPage | null>(null);
  const [jobOffset, setJobOffset] = useState(0),
    [offset, setOffset] = useState(0),
    [draft, setDraft] = useState(''),
    [query, setQuery] = useState('');
  const [name, setName] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true),
    [tick, setTick] = useState(0),
    [full, setFull] = useState(false);
  useEffect(() => {
    if (initialAction?.type === 'metadata-center') {
      setTab('jobs');
      setMetadataBatchId(initialAction.batchId);
    }
  }, [initialAction]);
  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      api<Overview>('/manage/overview', { signal: controller.signal }),
      api<Jobs>(`/manage/jobs?limit=10&offset=${jobOffset}`, { signal: controller.signal }),
    ])
      .then(([info, list]) => {
        setOverview(info);
        setJobs(list);
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setError(reason.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [tick, revision, jobOffset]);
  useEffect(() => {
    if (!jobs) return;
    const signature = jobs.items
      .filter((job) => job.finished_at)
      .map((job) => job.id)
      .join(',');
    if (finished.current !== null && finished.current !== signature) onChanged();
    finished.current = signature;
  }, [jobs, onChanged]);
  useEffect(() => {
    if (overview) setName(overview.preferences.name);
  }, [overview?.preferences.name]);
  useEffect(() => {
    if (!['overview', 'jobs', 'intake'].includes(tab)) return;
    const timer = setInterval(() => {
      if (!document.hidden) setTick((v) => v + 1);
    }, 2000);
    return () => clearInterval(timer);
  }, [tab]);
  useEffect(() => {
    const controller = new AbortController();
    if (tab === 'tracks') {
      setTracks(null);
      api<TrackPage>(`/tracks?q=${encodeURIComponent(query)}&limit=25&offset=${offset}`, {
        signal: controller.signal,
      })
        .then(setTracks)
        .catch((reason) => {
          if (!controller.signal.aborted) setError(reason.message);
        });
    }
    return () => controller.abort();
  }, [tab, query, offset, revision]);
  async function start(kind: 'import' | 'scan') {
    setBusy(true);
    setError('');
    try {
      await api<Job>('/manage/jobs', {
        method: 'POST',
        body: JSON.stringify({ kind, full: kind === 'scan' && full }),
      });
      setJobOffset(0);
      setTab('jobs');
      setTick((v) => v + 1);
      onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('management.taskSubmitFailed'));
    } finally {
      setBusy(false);
    }
  }
  async function saveName() {
    if (!overview) return;
    setBusy(true);
    setError('');
    try {
      const preferences = await api<Overview['preferences']>('/manage/preferences', {
        method: 'PUT',
        body: JSON.stringify({ name, version: overview.preferences.version }),
      });
      setOverview({ ...overview, preferences });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('management.settingsSaveFailed'));
    } finally {
      setBusy(false);
    }
  }
  const groups: (SettingsCategory & { tabs: { id: ManagementTab; label: string }[] })[] = [
    {
      id: 'library',
      label: t('management.groupLibrary'),
      description: t('management.groupLibraryDescription'),
      icon: 'album',
      tabs: [
        { id: 'overview', label: t('management.tabOverview') },
        { id: 'tracks', label: t('management.tabTracks') },
        ...(canImport ? [{ id: 'intake' as const, label: t('management.tabIntake') }] : []),
        ...(canOwner
          ? [
              { id: 'libraries' as const, label: t('management.tabLibraries') },
              { id: 'library-settings' as const, label: t('management.tabLibrarySettings') },
            ]
          : []),
      ],
    },
    ...(canPodcastAdmin
      ? [
          {
            id: 'podcasts',
            label: t('management.groupPodcasts'),
            description: t('management.groupPodcastsDescription'),
            icon: 'podcast' as const,
            tabs: [
              { id: 'programmes' as const, label: t('management.tabProgrammes') },
              { id: 'search' as const, label: t('management.tabSearch') },
              { id: 'identity' as const, label: t('management.tabIdentity') },
              {
                id: 'downloads' as const,
                label:
                  downloadPending > 0
                    ? t('management.tabDownloadsPending', { pending: downloadPending })
                    : downloadQueue && downloadQueue.failed_count > 0
                      ? t('management.tabDownloadsFailed', { failed: downloadQueue.failed_count })
                      : t('management.tabDownloads'),
              },
              ...(canOwner
                ? [
                    { id: 'catalog' as const, label: t('management.tabCatalog') },
                    { id: 'resources' as const, label: t('management.tabResources') },
                  ]
                : []),
            ],
          },
        ]
      : []),
    ...(canOwner
      ? [
          {
            id: 'sources',
            label: t('management.groupSources'),
            description: t('management.groupSourcesDescription'),
            icon: 'assistant' as const,
            tabs: [
              { id: 'providers' as const, label: t('management.tabProviders') },
              { id: 'models' as const, label: t('management.tabModels') },
            ],
          },
          {
            id: 'users',
            label: t('management.groupUsers'),
            description: t('management.groupUsersDescription'),
            icon: 'artist' as const,
            tabs: [{ id: 'users' as const, label: t('management.tabUsers') }],
          },
        ]
      : []),
    {
      id: 'operations',
      label: t('management.groupOperations'),
      description: t('management.groupOperationsDescription'),
      icon: 'task',
      tabs: [
        { id: 'jobs', label: t('management.tabJobs') },
        ...(canOwner
          ? [
              { id: 'diagnostics' as const, label: t('management.tabDiagnostics') },
              { id: 'status' as const, label: t('management.tabStatus') },
            ]
          : []),
      ],
    },
    ...(canOwner
      ? [
          {
            id: 'server',
            label: t('management.groupServer'),
            description: t('management.groupServerDescription'),
            icon: 'settings' as const,
            tabs: [
              { id: 'transcoding' as const, label: t('management.tabTranscoding') },
              { id: 'access' as const, label: t('management.tabAccess') },
            ],
          },
        ]
      : []),
  ];
  const group = groups.find((item) => item.tabs.some((item) => item.id === tab));
  const active = !!overview?.active_job;
  return (
    <main className="library management">
      {reviewOpen && (
        <MetadataReviewDialog onClose={() => setReviewOpen(false)} onApplied={onChanged} />
      )}
      <SettingsLayout
        title={t('management.title')}
        categories={groups}
        selected={group?.id ?? null}
        onSelect={(id) => setTab(id ? groups.find((item) => item.id === id)!.tabs[0].id : 'home')}
        onBack={onBack}
      >
        {group && (
          <nav className="settings-tabs" aria-label={t('management.categoryNav')}>
            {group.tabs.map((item) => (
              <button key={item.id} aria-pressed={tab === item.id} onClick={() => setTab(item.id)}>
                {item.label}
              </button>
            ))}
          </nav>
        )}
        {['overview', 'tracks', 'intake', 'jobs'].includes(tab) && (
          <LibrarySwitcher onChanged={onChanged} management />
        )}
        {error && (
          <p role="alert" className="error">
            {error}
            <button className="text-button" onClick={() => setTick((v) => v + 1)}>
              {t('management.reload')}
            </button>
          </p>
        )}
        {loading ? (
          <p role="status">{t('management.loadingOverview')}</p>
        ) : (
          overview && (
            <>
              {tab === 'diagnostics' && <SystemDiagnostics />}
              {tab === 'intake' && (
                <>
                  <LibrarySources
                    canImport={canImport}
                    canDelete={canImport}
                    canPurge={canOwner}
                    onChanged={onChanged}
                  />
                  <IntakePanel />
                </>
              )}
              {tab === 'users' && <UsersPanel />}
              {tab === 'overview' && (
                <>
                  <section
                    className="management-metrics"
                    aria-label={t('management.libraryOverviewAria')}
                  >
                    {[
                      [overview.counts.tracks, t('management.metricTracks')],
                      [overview.albums, t('management.metricAlbums')],
                      [overview.artists, t('management.metricArtists')],
                      [t(bytes(overview.counts.size_bytes)), t('management.metricMusicSize')],
                    ].map(([n, label]) => (
                      <div key={label}>
                        <strong>{n}</strong>
                        <span>{label}</span>
                      </div>
                    ))}
                  </section>
                  <section className="management-card">
                    <h2>{overview.preferences.name}</h2>
                    {canOwner && (
                      <>
                        <button onClick={onRefresh}>
                          {t('management.refreshLibraryMetadata')}
                        </button>
                        <button onClick={() => setReviewOpen(true)}>
                          {t('management.batchMetadataReview')}
                        </button>
                      </>
                    )}
                    <div className="library-locations">
                      {(
                        [
                          [t('management.importSource'), overview.source],
                          [t('management.managedLibrary'), overview.library],
                        ] as const
                      ).map(([label, item]) => (
                        <div key={label}>
                          <strong>
                            {label}
                            <span className={`availability ${item.available ? '' : 'unavailable'}`}>
                              {item.available
                                ? t('management.available')
                                : t('management.unavailable')}
                            </span>
                          </strong>
                          <code>{item.path}</code>
                          <small>
                            {t('management.freeSpace')} {t(bytes(item.free_bytes))}
                          </small>
                        </div>
                      ))}
                    </div>
                    {canImport && (
                      <div className="management-task-actions">
                        <div>
                          <h3>{t('management.importNewMusic')}</h3>
                          <p className="muted">{t('management.importDescription')}</p>
                          <button
                            className="primary"
                            disabled={busy || active || !overview.source.available}
                            onClick={() => void start('import')}
                          >
                            {t('management.importMusic')}
                          </button>
                        </div>
                        <div>
                          <h3>{t('management.scanLibraryTitle')}</h3>
                          <p className="muted">{t('management.scanDescription')}</p>
                          <label className="management-checkbox">
                            <input
                              type="checkbox"
                              checked={full}
                              onChange={(e) => setFull(e.target.checked)}
                            />
                            {t('management.rereadAllTags')}
                          </label>
                          <button
                            disabled={busy || active || !overview.library.available}
                            onClick={() => void start('scan')}
                          >
                            {t('management.scanLibrary')}
                          </button>
                        </div>
                      </div>
                    )}
                    {active && (
                      <p role="status" className="muted">
                        {t('management.jobActiveNotice')}
                      </p>
                    )}
                    {!!overview.counts.unavailable && (
                      <p className="muted">
                        {t('management.unavailableTracks', { count: overview.counts.unavailable })}
                      </p>
                    )}
                  </section>
                  <section className="management-card">
                    <h2>{t('management.lastScanTitle')}</h2>
                    {overview.last_scan ? (
                      <RunDetail title={t('management.runScan')} run={overview.last_scan} />
                    ) : (
                      <p className="muted">{t('management.noScanRecords')}</p>
                    )}
                  </section>
                  <FolderMetadataEditor onChanged={onChanged} />
                </>
              )}
              {tab === 'tracks' && (
                <section className="management-card">
                  <div className="management-section-heading">
                    <div>
                      <h2>{t('management.editTracksTitle')}</h2>
                      <p className="muted">{t('management.editTracksDescription')}</p>
                    </div>
                    <form
                      className="manage-search"
                      onSubmit={(e) => {
                        e.preventDefault();
                        setQuery(draft);
                        setOffset(0);
                      }}
                    >
                      <input
                        aria-label={t('management.searchTracksAria')}
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        placeholder={t('management.searchTracksPlaceholder')}
                        maxLength={256}
                      />
                      <button>{t('management.searchTracks')}</button>
                    </form>
                  </div>
                  {tracks ? (
                    <>
                      {canOwner && (
                        <button
                          disabled={busy || !tracks.items.length}
                          onClick={() => {
                            setBusy(true);
                            setError(t('management.querySubmitting'));
                            void api('/manage/providers/query', {
                              method: 'POST',
                              body: JSON.stringify({ track_ids: tracks.items.map((t) => t.id) }),
                            })
                              .then(() => setError(t('management.querySubmitted')))
                              .catch(() => setError(t('management.queryNotSubmitted')))
                              .finally(() => setBusy(false));
                          }}
                        >
                          {t('management.queryPageMetadata')}
                        </button>
                      )}
                      <ul className="manage-track-list">
                        {tracks.items.map((track) => (
                          <li key={track.id}>
                            <div>
                              <strong>{track.title}</strong>
                              <span>
                                {track.artists.join(' / ') || t('management.unknownArtists')} ·{' '}
                                {track.album || t('management.unknownAlbum')}
                              </span>
                            </div>
                            <button
                              aria-label={t('management.editTrackAria', { title: track.title })}
                              onClick={() => onEdit(track)}
                            >
                              {t('management.editInfo')}
                            </button>
                          </li>
                        ))}
                      </ul>
                      {!tracks.total && <p className="muted">{t('management.noTracksFound')}</p>}
                      <Pagination
                        page={tracks}
                        onOffset={setOffset}
                        unit={t('management.unitTracks')}
                      />
                    </>
                  ) : (
                    <p role="status">{t('management.loadingTracks')}</p>
                  )}
                </section>
              )}
              {tab === 'jobs' && (
                <section className="management-card">
                  {canOwner && (
                    <MetadataJobs
                      batchId={metadataBatchId}
                      onInspect={(id) => {
                        void api<Track>(`/tracks/${id}`)
                          .then(onEdit)
                          .catch(() => setError(t('management.trackLoadFailed')));
                      }}
                    />
                  )}
                  <div className="management-section-heading">
                    <h2>{t('management.jobsTitle')}</h2>
                    <button onClick={() => setTick((v) => v + 1)}>
                      {t('management.refreshJobs')}
                    </button>
                  </div>
                  <p className="muted">{t('management.jobsServerNote')}</p>
                  {!jobs?.total && (
                    <p className="management-empty">
                      {canImport ? t('management.noJobsImporter') : t('management.noJobsViewer')}
                    </p>
                  )}
                  {jobs?.items.map((job) => (
                    <details className="management-job" key={job.id}>
                      <summary>
                        <div>
                          <strong>
                            {job.kind === 'import'
                              ? t('management.importMusic')
                              : t('management.scanLibrary')}
                            {job.full ? t('management.fullTags') : ''}
                          </strong>
                          <small>{timestamp(job.created_at)}</small>
                        </div>
                        <span className={`job-status ${job.status}`}>
                          {t(statuses[job.status])}
                        </span>
                      </summary>
                      <div className="management-job-body">
                        <p className="muted">
                          {t('management.jobTimes', {
                            start: timestamp(job.started_at),
                            end: timestamp(job.finished_at),
                          })}
                        </p>
                        {job.error && (
                          <p role="status">
                            {job.error === 'waiting_for_library'
                              ? t('management.jobWaitingForLibrary')
                              : job.error === 'worker_interrupted'
                                ? t('management.jobWorkerInterrupted')
                                : t('management.jobIncomplete')}
                          </p>
                        )}
                        <RunDetail title={t('management.runImport')} run={job.import} />
                        <RunDetail title={t('management.runScan')} run={job.scan} />
                        {job.status === 'queued' && !job.error && (
                          <p className="muted">{t('management.jobQueuedNote')}</p>
                        )}
                      </div>
                    </details>
                  ))}
                  {jobs && jobs.total > 10 && (
                    <Pagination
                      page={jobs}
                      onOffset={setJobOffset}
                      unit={t('management.unitItems')}
                    />
                  )}
                </section>
              )}
              {tab === 'libraries' && canOwner && <MusicLibraryManager />}
              {tab === 'programmes' && canPodcastAdmin && (
                <PodcastProgrammesAdmin canCleanResources={canOwner} onView={onViewPodcast} />
              )}
              {tab === 'catalog' && canOwner && <PodcastCatalogSettings />}
              {tab === 'search' && canPodcastAdmin && <PodcastSearchSettings />}
              {tab === 'identity' && canPodcastAdmin && <PodcastIdentityAdmin />}
              {tab === 'resources' && canOwner && <PodcastResourceManager />}
              {tab === 'downloads' && canPodcastAdmin && <PodcastDownloadManager />}
              {tab === 'providers' && canOwner && <ProviderSettings />}
              {tab === 'models' && canOwner && (
                <section className="management-card">
                  <h2>{t('management.modelsTitle')}</h2>
                  <p className="muted">{t('management.modelsDescription')}</p>
                  <button onClick={onOpenConnections}>{t('management.manageConnections')}</button>
                </section>
              )}
              {tab === 'transcoding' && canOwner && <TranscodingSettings />}
              {tab === 'access' && canOwner && (
                <>
                  <ServerSettings />
                  <HostSettings />
                </>
              )}
              {tab === 'library-settings' && canOwner && (
                <>
                  <section
                    className="management-library-settings"
                    aria-label={t('management.librarySettingsAria')}
                  >
                    <LibrarySwitcher onChanged={onChanged} management />
                    <LyricScanEntry />
                    <section className="management-card">
                      <h2>{t('management.librarySettingsTitle')}</h2>
                      <form
                        className="library-settings-form"
                        onSubmit={(e) => {
                          e.preventDefault();
                          void saveName();
                        }}
                      >
                        <label>
                          {t('management.libraryName')}
                          <input
                            required
                            maxLength={100}
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                          />
                        </label>
                        <button
                          className="primary"
                          disabled={busy || name.trim() === overview.preferences.name}
                        >
                          {busy ? t('management.saving') : t('management.saveSettings')}
                        </button>
                      </form>
                    </section>
                  </section>
                </>
              )}
              {tab === 'status' && canOwner && (
                <>
                  <section className="management-card">
                    <h2>{t('management.serverStatusTitle')}</h2>
                    <dl className="management-settings">
                      {[
                        [t('management.statusVersion'), overview.version],
                        [t('management.statusSchemaVersion'), String(overview.schema_version)],
                        [t('management.statusDataDir'), overview.data.path],
                        [
                          t('management.statusServerAddress'),
                          `${overview.deployment.host}:${overview.deployment.port}`,
                        ],
                        [
                          t('management.statusSecureCookie'),
                          overview.deployment.connection_policy &&
                          overview.deployment.connection_policy !== 'legacy'
                            ? t('management.cookieAuto')
                            : overview.deployment.cookie_secure
                              ? t('management.enabled')
                              : t('management.notEnabled'),
                        ],
                        [t('management.statusTagWriteback'), t('management.notEnabled')],
                      ].map(([key, value]) => (
                        <div key={key}>
                          <dt>{key}</dt>
                          <dd>{value}</dd>
                        </div>
                      ))}
                    </dl>
                    <p className="muted">
                      {t('management.deployNote')} <code>make docker-admin</code>
                      {t('management.deployNotePeriod')}
                    </p>
                  </section>
                </>
              )}
            </>
          )
        )}
      </SettingsLayout>
    </main>
  );
}
