import { useTranslation } from 'react-i18next';
import { useEffect, useState } from 'react';
import { api } from './api';

type FolderSummary = {
  folder: string;
  track_count: number;
  album_variants: string[];
  album_artist_variants: string[];
  warning: boolean;
};
type FolderTrack = {
  track_id: string;
  title: string;
  metadata_version: number;
  album: string | null;
  album_artists: string[];
  track_number: number | null;
  disc_number: number | null;
};
type FolderDetail = FolderSummary & { tracks: FolderTrack[] };

export function FolderMetadataEditor({ onChanged }: { onChanged: () => void }) {
  const { t } = useTranslation();
  const [folders, setFolders] = useState<FolderSummary[]>([]);
  const [selected, setSelected] = useState<FolderDetail | null>(null);
  const [album, setAlbum] = useState('');
  const [artists, setArtists] = useState('');
  const [query, setQuery] = useState('');
  const [warningsOnly, setWarningsOnly] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    api<{ items: FolderSummary[] }>('/manage/metadata/folders?limit=200', {
      signal: controller.signal,
    })
      .then((result) => setFolders(result.items))
      .catch((reason) => {
        if (!controller.signal.aborted)
          setError(reason instanceof Error ? reason.message : t('folderMetadata.loadFoldersError'));
      });
    return () => controller.abort();
  }, []);

  async function open(folder: string) {
    setBusy(true);
    setError('');
    try {
      const detail = await api<FolderDetail>(
        `/manage/metadata/folders?folder=${encodeURIComponent(folder)}`,
      );
      setSelected(detail);
      setAlbum(detail.album_variants[0] || '');
      setArtists(detail.album_artist_variants.join(' / '));
      setMessage('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('folderMetadata.loadTracksError'));
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    if (!selected || (!album.trim() && !artists.trim())) return;
    setBusy(true);
    setError('');
    setMessage('');
    const overrides: Record<string, unknown> = {};
    if (album.trim()) overrides.album = album.trim();
    if (artists.trim())
      overrides.album_artists = artists
        .split(/[/,，、]/)
        .map((item) => item.trim())
        .filter(Boolean);
    try {
      const result = await api<{ updated: number }>('/manage/metadata/folders', {
        method: 'PUT',
        body: JSON.stringify({
          folder: selected.folder,
          tracks: selected.tracks.map((track) => ({
            track_id: track.track_id,
            version: track.metadata_version,
          })),
          overrides,
        }),
      });
      setMessage(t('folderMetadata.updatedNotice', { count: result.updated }));
      await open(selected.folder);
      onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('folderMetadata.updateFailed'));
    } finally {
      setBusy(false);
    }
  }

  const filteredFolders = folders.filter((item) => {
    const haystack = `${item.folder} ${item.album_variants.join(' ')} ${item.album_artist_variants.join(' ')}`;
    return (
      haystack.toLowerCase().includes(query.trim().toLowerCase()) && (!warningsOnly || item.warning)
    );
  });
  const visibleFolders = showAll ? filteredFolders : filteredFolders.slice(0, 8);
  const warningCount = folders.filter((item) => item.warning).length;
  const trackCount = folders.reduce((total, item) => total + item.track_count, 0);

  return (
    <section className="management-card" aria-label={t('folderMetadata.sectionAria')}>
      <div className="management-section-heading">
        <div>
          <h2>{t('folderMetadata.headingTitle')}</h2>
          <p className="muted">{t('folderMetadata.headingMuted')}</p>
        </div>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {message && (
        <p className="muted" role="status">
          {message}
        </p>
      )}
      {!folders.length ? (
        <p className="muted">{t('folderMetadata.noFolders')}</p>
      ) : (
        <>
          <div className="folder-metadata-summary" aria-label={t('folderMetadata.overviewAria')}>
            <div>
              <strong>{folders.length}</strong>
              <span>{t('folderMetadata.foldersCount')}</span>
            </div>
            <div>
              <strong>{trackCount}</strong>
              <span>{t('folderMetadata.tracksCount')}</span>
            </div>
            <div className={warningCount ? 'has-warning' : ''}>
              <strong>{warningCount}</strong>
              <span>{t('folderMetadata.pendingReviewCount')}</span>
            </div>
          </div>
          <div className="folder-metadata-layout">
            <div className="folder-metadata-browser">
              <div className="folder-metadata-toolbar">
                <input
                  value={query}
                  onChange={(event) => {
                    setQuery(event.target.value);
                    setShowAll(false);
                  }}
                  placeholder={t('folderMetadata.searchPlaceholder')}
                  aria-label={t('folderMetadata.searchAria')}
                />
                <button
                  className={warningsOnly ? 'active' : ''}
                  onClick={() => {
                    setWarningsOnly((value) => !value);
                    setShowAll(false);
                  }}
                >
                  {warningsOnly
                    ? t('folderMetadata.showAll')
                    : t('folderMetadata.onlyWarnings', { count: warningCount })}
                </button>
              </div>
              <div className="folder-metadata-list-heading">
                <h3>{t('folderMetadata.groupsHeading')}</h3>
                <span>{t('folderMetadata.resultsCount', { count: filteredFolders.length })}</span>
              </div>
              <ul className="manage-track-list folder-metadata-list">
                {visibleFolders.map((item) => (
                  <li
                    key={item.folder}
                    className={selected?.folder === item.folder ? 'selected' : ''}
                  >
                    <div>
                      <strong>{item.folder}</strong>
                      <span>
                        {t('folderMetadata.folderItemSummary', {
                          count: item.track_count,
                          album:
                            item.album_variants.join(' / ') || t('folderMetadata.unnamedAlbum'),
                        })}
                      </span>
                      {item.warning && (
                        <small className="metadata-task-warning">
                          {t('folderMetadata.multiVersionWarning')}
                        </small>
                      )}
                    </div>
                    <button disabled={busy} onClick={() => void open(item.folder)}>
                      {selected?.folder === item.folder
                        ? t('folderMetadata.selectedButton')
                        : t('folderMetadata.editButton')}
                    </button>
                  </li>
                ))}
              </ul>
              {!visibleFolders.length && (
                <p className="muted folder-metadata-empty">
                  {t('folderMetadata.noMatchingFolders')}
                </p>
              )}
              {filteredFolders.length > 8 && (
                <button
                  className="folder-metadata-more"
                  onClick={() => setShowAll((value) => !value)}
                >
                  {showAll
                    ? t('folderMetadata.collapseList')
                    : t('folderMetadata.showAllFolders', { count: filteredFolders.length })}
                </button>
              )}
            </div>
            <div className="folder-metadata-editor">
              {selected ? (
                <>
                  <div className="folder-metadata-editor-heading">
                    <div>
                      <span className="eyebrow">{t('folderMetadata.eyebrowSelected')}</span>
                      <h3>{selected.folder}</h3>
                    </div>
                    <span>
                      {t('folderMetadata.selectedTracksCount', { count: selected.tracks.length })}
                    </span>
                  </div>
                  <p className="muted">
                    {t('folderMetadata.applyToPrefix')}
                    {selected.tracks
                      .slice(0, 5)
                      .map((track) => track.title)
                      .join('、')}
                    {selected.tracks.length > 5
                      ? t('folderMetadata.applyToEllipsis', { count: selected.tracks.length })
                      : ''}
                  </p>
                  {selected.warning && (
                    <p className="error">{t('folderMetadata.warningMultipleValues')}</p>
                  )}
                  <label className="metadata-field">
                    <span>{t('folderMetadata.fieldAlbum')}</span>
                    <input
                      value={album}
                      onChange={(event) => setAlbum(event.target.value)}
                      maxLength={1000}
                    />
                  </label>
                  <label className="metadata-field">
                    <span>{t('folderMetadata.fieldAlbumArtists')}</span>
                    <input
                      value={artists}
                      onChange={(event) => setArtists(event.target.value)}
                      maxLength={1000}
                    />
                  </label>
                  <button
                    className="primary"
                    disabled={busy || (!album.trim() && !artists.trim())}
                    onClick={() => void apply()}
                  >
                    {busy ? t('folderMetadata.updating') : t('folderMetadata.applyToGroup')}
                  </button>
                </>
              ) : (
                <div className="folder-metadata-editor-empty">
                  <strong>{t('folderMetadata.selectFolderPrompt')}</strong>
                  <span>{t('folderMetadata.selectFolderHelp')}</span>
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </section>
  );
}
