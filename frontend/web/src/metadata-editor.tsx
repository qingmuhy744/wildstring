import { useTranslation } from 'react-i18next';
import { useEffect, useRef, useState } from 'react';
import { api, type Track } from './api';
import { OnlineMetadataMatcher } from './online-metadata-matcher';
import { TrackFileInfoDialog } from './track-file-info-dialog';
import { LyricsEditor } from './lyrics-editor';
import { splitMultiValue } from './metadata-parser';
import type { Player } from './player';
import { DialogCloseButton } from './dialog-close';

export type MetadataFields = Pick<
  Track,
  | 'title'
  | 'artists'
  | 'album'
  | 'album_artists'
  | 'track_number'
  | 'disc_number'
  | 'composers'
  | 'lyricists'
  | 'arrangers'
  | 'vocalists'
  | 'genres'
  | 'track_total'
  | 'disc_total'
  | 'release_date'
  | 'original_date'
  | 'artist_credit'
  | 'album_artist_credit'
>;
interface MetadataRecord {
  track_id: string;
  path: string;
  source_path?: string | null;
  source_filename?: string;
  source_stem?: string;
  version: number;
  observed: MetadataFields;
  effective: MetadataFields;
  overrides: Partial<MetadataFields>;
  origins?: Record<string, string>;
}
const labelKeys: Record<keyof MetadataFields, string> = {
  title: 'metadataEditor.fieldTitle',
  artists: 'metadataEditor.fieldArtists',
  album: 'metadataEditor.fieldAlbum',
  album_artists: 'metadataEditor.fieldAlbumArtists',
  track_number: 'metadataEditor.fieldTrackNumber',
  disc_number: 'metadataEditor.fieldDiscNumber',
  composers: 'metadataEditor.fieldComposers',
  lyricists: 'metadataEditor.fieldLyricists',
  arrangers: 'metadataEditor.fieldArrangers',
  vocalists: 'metadataEditor.fieldVocalists',
  genres: 'metadataEditor.fieldGenres',
  track_total: 'metadataEditor.fieldTrackTotal',
  disc_total: 'metadataEditor.fieldDiscTotal',
  release_date: 'metadataEditor.fieldReleaseDate',
  original_date: 'metadataEditor.fieldOriginalDate',
  artist_credit: 'metadataEditor.fieldArtistCredit',
  album_artist_credit: 'metadataEditor.fieldAlbumArtistCredit',
};
const fields = Object.keys(labelKeys) as (keyof MetadataFields)[];
function display(value: unknown): string {
  return Array.isArray(value) ? value.join('\n') : value == null ? '' : String(value);
}
export function MetadataEditor({
  track,
  player,
  onClose,
  onSaved,
}: {
  track: Track;
  player: Player;
  onClose: () => void;
  onSaved: (id: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const getLabel = (key: keyof MetadataFields) => t(labelKeys[key]);
  const dialog = useRef<HTMLDialogElement>(null);
  const [tab, setTab] = useState<'metadata' | 'lyrics' | 'online'>('metadata');
  const request = useRef<AbortController | null>(null);
  const [record, setRecord] = useState<MetadataRecord | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [overridden, setOverridden] = useState<string[]>([]);
  const [fillNotice, setFillNotice] = useState('');
  const [preview, setPreview] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [showFileInfo, setShowFileInfo] = useState(false);

  const handleApplyOnlineSuggestion = (fieldsData: Record<string, unknown>) => {
    const nextValues = { ...values };
    const changedKeys: string[] = [];

    const fieldMap: Record<string, string> = {
      title: 'title',
      artists: 'artists',
      album: 'album',
      album_artists: 'album_artists',
      track_number: 'track_number',
      disc_number: 'disc_number',
      release_date: 'release_date',
      original_date: 'original_date',
      genres: 'genres',
      composers: 'composers',
      lyricists: 'lyricists',
      arrangers: 'arrangers',
      vocalists: 'vocalists',
      track_total: 'track_total',
      disc_total: 'disc_total',
    };

    for (const [key, targetKey] of Object.entries(fieldMap)) {
      if (fieldsData[key] !== undefined && fieldsData[key] !== null) {
        const val = fieldsData[key];
        if (Array.isArray(val)) {
          nextValues[targetKey] = val.join('\n');
          changedKeys.push(targetKey);
        } else if (typeof val === 'string' || typeof val === 'number') {
          nextValues[targetKey] = String(val);
          changedKeys.push(targetKey);
        }
      }
    }

    setValues(nextValues);
    setOverridden((prev) => Array.from(new Set([...prev, ...changedKeys])));
    setFillNotice(t('metadataEditor.fillNotice'));
  };
  function load() {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setError('');
    api<MetadataRecord>(`/manage/tracks/${track.id}/metadata`, { signal: controller.signal })
      .then((data) => {
        if (controller.signal.aborted) return;
        setRecord(data);
        setValues(Object.fromEntries(fields.map((key) => [key, display(data.effective[key])])));
        setOverridden(Object.keys(data.overrides));
        setPreview(false);
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setError(reason.message);
      });
  }
  useEffect(() => {
    const node = dialog.current;
    node?.showModal();
    load();
    return () => {
      request.current?.abort();
      node?.close();
    };
  }, [track.id]);
  const overrides: Record<string, unknown> = Object.fromEntries(
    Object.entries(record?.overrides || {}).filter(
      ([key]) => !fields.includes(key as keyof MetadataFields),
    ),
  );
  for (const key of overridden.filter((k) => fields.includes(k as keyof MetadataFields))) {
    const value = values[key];
    overrides[key] = [
      'artists',
      'album_artists',
      'composers',
      'lyricists',
      'arrangers',
      'vocalists',
      'genres',
    ].includes(key)
      ? splitMultiValue(value)
      : ['track_number', 'disc_number', 'track_total', 'disc_total'].includes(key)
        ? value.trim()
          ? Number(value)
          : null
        : value.trim() || (['album', 'release_date', 'original_date'].includes(key) ? null : '');
  }
  function validate() {
    if (overridden.includes('title') && !values.title.trim()) {
      setError(t('metadataEditor.errorTitleRequired'));
      return;
    }
    for (const key of ['track_number', 'disc_number', 'track_total', 'disc_total'])
      if (
        overridden.includes(key) &&
        values[key] &&
        (!Number.isInteger(Number(values[key])) ||
          Number(values[key]) < 1 ||
          Number(values[key]) > 99999)
      ) {
        setError(t('metadataEditor.errorNumberRange'));
        return;
      }
    setError('');
    setPreview(true);
  }
  async function save() {
    if (!record) return;
    setBusy(true);
    setError('');
    try {
      await api(`/manage/tracks/${track.id}/metadata`, {
        method: 'PUT',
        body: JSON.stringify({ version: record.version, overrides }),
      });
      await onSaved(track.id);
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('metadataEditor.saveFailed'));
    } finally {
      setBusy(false);
    }
  }
  const next = record ? { ...record.observed, ...overrides } : null;
  return (
    <dialog
      className="metadata-editor playlist-editor"
      ref={dialog}
      aria-label={t('metadataEditor.dialogAria')}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <div className="editor-heading">
        <div>
          <span className="eyebrow">{t('metadataEditor.eyebrow')}</span>
          <h2>{t('metadataEditor.heading')}</h2>
          <p className="muted">{track.title}</p>
        </div>
        <DialogCloseButton
          disabled={busy}
          aria-label={t('metadataEditor.closeAria')}
          onClick={onClose}
        />
      </div>
      <nav className="management-tabs" aria-label={t('metadataEditor.tabsAria')}>
        <button aria-pressed={tab === 'metadata'} onClick={() => setTab('metadata')}>
          {t('metadataEditor.tabMetadata')}
        </button>
        <button aria-pressed={tab === 'lyrics'} onClick={() => setTab('lyrics')}>
          {t('metadataEditor.tabLyrics')}
        </button>
      </nav>
      <div hidden={tab !== 'metadata'}>
        {record ? (
          <>
            <p className="muted">{t('metadataEditor.noticeEffective')}</p>
            {fillNotice && (
              <div
                style={{
                  background: 'rgba(144, 238, 144, 0.15)',
                  border: '1px solid rgba(144, 238, 144, 0.4)',
                  color: '#98fb98',
                  padding: '8px 12px',
                  borderRadius: '6px',
                  fontSize: '12px',
                  margin: '8px 0',
                }}
              >
                ✓ {fillNotice}
              </div>
            )}
            <OnlineMetadataMatcher
              trackId={track.id}
              currentTitle={values.title || track.title}
              currentArtist={
                values.artists?.split('\n')[0] || (track.artists && track.artists[0]) || ''
              }
              onApply={handleApplyOnlineSuggestion}
            />
            <div
              className="metadata-file-row"
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '8px',
                margin: '8px 0 12px',
              }}
            >
              <span
                className="metadata-file-path"
                title={t('metadataEditor.filePathTooltip')}
                style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
              >
                {t('metadataEditor.filePathPrefix')}
                <code>{record.path}</code>
              </span>
              <button
                type="button"
                className="text-button"
                style={{ flexShrink: 0, padding: '2px 8px' }}
                onClick={() => setShowFileInfo(true)}
              >
                {t('metadataEditor.viewFileAttributes')}
              </button>
            </div>
            {!preview ? (
              <div className="metadata-fields">
                {fields.map((key) => (
                  <label className="metadata-field" key={key}>
                    <span className="metadata-field-label">
                      {getLabel(key)}
                      <span className="metadata-source" data-help={t('metadataEditor.sourceHelp')}>
                        {overridden.includes(key)
                          ? record.origins?.[key]?.startsWith('musicbrainz:')
                            ? 'MusicBrainz'
                            : record.origins?.[key]?.startsWith('lastfm:')
                              ? 'Last.fm'
                              : t('metadataEditor.sourceManual')
                          : t('metadataEditor.sourceFileTag')}
                      </span>
                    </span>
                    {[
                      'artists',
                      'album_artists',
                      'composers',
                      'lyricists',
                      'arrangers',
                      'vocalists',
                      'genres',
                    ].includes(key) ? (
                      <textarea
                        aria-label={getLabel(key)}
                        value={values[key] || ''}
                        maxLength={10000}
                        rows={2}
                        onChange={(e) => {
                          setValues({ ...values, [key]: e.target.value });
                          setOverridden((keys) => [...new Set([...keys, key])]);
                        }}
                        placeholder={t('metadataEditor.listInputPlaceholder')}
                      />
                    ) : (
                      <input
                        aria-label={getLabel(key)}
                        type={key.endsWith('number') || key.endsWith('total') ? 'number' : 'text'}
                        min={1}
                        max={99999}
                        maxLength={1000}
                        value={values[key] || ''}
                        onChange={(e) => {
                          setValues({ ...values, [key]: e.target.value });
                          setOverridden((keys) => [...new Set([...keys, key])]);
                        }}
                      />
                    )}
                    <span className="metadata-origin">
                      {t('metadataEditor.fileValue', {
                        value:
                          display(record.observed[key]).replaceAll('\n', ' / ') ||
                          t('metadataEditor.notFilled'),
                      })}
                    </span>
                    {key === 'title' &&
                      record.source_stem &&
                      record.source_stem !== values.title && (
                        <button
                          className="text-button"
                          type="button"
                          style={{
                            color: 'var(--accent-text)',
                            fontSize: '12px',
                            padding: '2px 6px',
                            textAlign: 'left',
                          }}
                          onClick={() => {
                            setValues({ ...values, title: record.source_stem! });
                            setOverridden((keys) => [...new Set([...keys, 'title'])]);
                          }}
                        >
                          {t('metadataEditor.fillFromFilename', { name: record.source_stem })}
                        </button>
                      )}
                    {key === 'track_number' &&
                      !values.track_number &&
                      /^[a-zA-Z](\d{1,3})$/.test(String(record.observed.title || '')) && (
                        <button
                          className="text-button"
                          type="button"
                          style={{
                            color: 'var(--accent-text)',
                            fontSize: '12px',
                            padding: '2px 6px',
                            textAlign: 'left',
                          }}
                          onClick={() => {
                            const match = /^[a-zA-Z](\d{1,3})$/.exec(
                              String(record.observed.title || ''),
                            );
                            if (match) {
                              const num = String(parseInt(match[1], 10));
                              setValues({ ...values, track_number: num });
                              setOverridden((keys) => [...new Set([...keys, 'track_number'])]);
                            }
                          }}
                        >
                          {t('metadataEditor.fillFromOriginalCode', {
                            number: parseInt(
                              /^[a-zA-Z](\d{1,3})$/.exec(String(record.observed.title || ''))![1],
                              10,
                            ),
                          })}
                        </button>
                      )}
                    {overridden.includes(key) && (
                      <button
                        className="text-button"
                        type="button"
                        onClick={() => {
                          setValues({ ...values, [key]: display(record.observed[key]) });
                          setOverridden((keys) => keys.filter((v) => v !== key));
                        }}
                      >
                        {t('metadataEditor.useFileValueForField', { field: getLabel(key) })}
                      </button>
                    )}
                  </label>
                ))}
              </div>
            ) : (
              <div className="metadata-diff" aria-label={t('metadataEditor.diffPreviewAria')}>
                <h3>{t('metadataEditor.confirmChanges')}</h3>
                {fields.map((key) => (
                  <div key={key}>
                    <strong>{getLabel(key)}</strong>
                    <span>
                      {display(record.effective[key]).replaceAll('\n', ' / ') ||
                        t('metadataEditor.notFilled')}
                    </span>
                    <span aria-hidden="true">→</span>
                    <span>
                      {display(next![key]).replaceAll('\n', ' / ') || t('metadataEditor.notFilled')}
                    </span>
                  </div>
                ))}
              </div>
            )}
            {error && (
              <p className="error" role="alert">
                {error}{' '}
                <button className="text-button" disabled={busy} onClick={load}>
                  {t('metadataEditor.reload')}
                </button>
              </p>
            )}
            <div className="editor-footer">
              <button
                disabled={busy}
                onClick={() => {
                  if (preview) setPreview(false);
                  else onClose();
                }}
              >
                {preview ? t('metadataEditor.backToEdit') : t('metadataEditor.cancel')}
              </button>
              <button
                className="text-button"
                disabled={busy}
                onClick={() => {
                  setOverridden([]);
                  setValues(
                    Object.fromEntries(fields.map((key) => [key, display(record.observed[key])])),
                  );
                  setPreview(false);
                }}
              >
                {t('metadataEditor.useAllFileValues')}
              </button>
              <button
                className="primary"
                disabled={busy}
                onClick={() => (preview ? void save() : validate())}
              >
                {busy
                  ? t('metadataEditor.saving')
                  : preview
                    ? t('metadataEditor.saveChanges')
                    : t('metadataEditor.previewChanges')}
              </button>
            </div>
          </>
        ) : error ? (
          <p className="error" role="alert">
            {error}
            <button onClick={load}>{t('metadataEditor.reload')}</button>
          </p>
        ) : (
          <p role="status">{t('metadataEditor.loadingTrackInfo')}</p>
        )}
      </div>
      <LyricsEditor key={track.id} track={track} player={player} active={tab === 'lyrics'} />
      {showFileInfo && (
        <TrackFileInfoDialog
          track={track}
          canManage={true}
          onClose={() => setShowFileInfo(false)}
          onReorganized={load}
        />
      )}
    </dialog>
  );
}
