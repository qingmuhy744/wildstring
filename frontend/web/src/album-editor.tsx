import { useEffect, useRef, useState } from 'react';
import { api, type AlbumMetadataRecord } from './api';
import { DefaultArtwork } from './default-artwork';
import { Icon } from './icons';
import { DialogCloseButton } from './dialog-close';
import { splitMultiValue } from './metadata-parser';
import { useTranslation } from 'react-i18next';

export function AlbumEditor({
  albumId,
  initialTitle,
  onClose,
  onSaved,
}: {
  albumId: string;
  initialTitle?: string;
  onClose: () => void;
  onSaved: (savedAlbumId?: string) => Promise<void> | void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const { t } = useTranslation();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [record, setRecord] = useState<AlbumMetadataRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // FLAC 元数据字段
  const [title, setTitle] = useState(initialTitle || '');
  const [albumArtists, setAlbumArtists] = useState('');
  const [releaseDate, setReleaseDate] = useState('');
  const [originalDate, setOriginalDate] = useState('');
  const [genres, setGenres] = useState('');
  const [label, setLabel] = useState('');
  const [catalogNumber, setCatalogNumber] = useState('');
  const [discTotal, setDiscTotal] = useState<number>(1);
  const [description, setDescription] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);

  // 封面相关
  const [newCoverFile, setNewCoverFile] = useState<File | null>(null);
  const [previewCoverUrl, setPreviewCoverUrl] = useState<string | null>(null);
  const [saveSidecar, setSaveSidecar] = useState(true);
  const [coverDeleted, setCoverDeleted] = useState(false);
  const [existingFailed, setExistingFailed] = useState(false);

  useEffect(() => {
    const node = dialog.current;
    if (node && !node.open) node.showModal();
  }, []);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    api<AlbumMetadataRecord>(`/manage/metadata/albums?album_id=${encodeURIComponent(albumId)}`)
      .then((data) => {
        if (!active) return;
        setRecord(data);
        setTitle(data.primary_title || initialTitle || '');
        setAlbumArtists(data.primary_artists.join(', '));
        setReleaseDate(data.release_date || '');
        setOriginalDate(data.original_date || '');
        setGenres(data.genres ? data.genres.join(', ') : '');
        setLabel(data.label || '');
        setCatalogNumber(data.catalog_number || '');
        setDiscTotal(data.disc_total || (data.discs ? data.discs.length : 1));
        setDescription(data.description || '');
        setLoading(false);
      })
      .catch((err) => {
        if (!active) return;
        setError(err.message || t('albumEditor.loadFailed'));
        setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [albumId, initialTitle]);

  // 处理选择图片
  const handleFileSelect = (file: File) => {
    if (!file.type.startsWith('image/')) {
      setError(t('albumEditor.invalidImageType'));
      return;
    }
    setNewCoverFile(file);
    setCoverDeleted(false);
    setError('');
    const url = URL.createObjectURL(file);
    setPreviewCoverUrl(url);
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleFileSelect(e.dataTransfer.files[0]);
    }
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
  };

  const handleRemoveCover = () => {
    setNewCoverFile(null);
    if (previewCoverUrl) {
      URL.revokeObjectURL(previewCoverUrl);
      setPreviewCoverUrl(null);
    }
    setCoverDeleted(true);
  };

  const handleCancelNewCover = () => {
    setNewCoverFile(null);
    if (previewCoverUrl) {
      URL.revokeObjectURL(previewCoverUrl);
      setPreviewCoverUrl(null);
    }
    setCoverDeleted(false);
  };

  // 判定是否具备现有合法封面
  const hasOriginalCover =
    !existingFailed &&
    Boolean(record?.has_custom_cover || record?.tracks?.some((t) => t.has_cover));

  const existingCoverUrl =
    hasOriginalCover && record?.cover_track_id
      ? `/api/v1/tracks/${record.cover_track_id}/cover?size=768&t=${record.tracks[0]?.metadata_version || 1}`
      : null;

  const handleSave = async () => {
    if (!title.trim()) {
      setError(t('albumEditor.titleRequired'));
      return;
    }
    setSaving(true);
    setError('');

    try {
      const parsedArtists = splitMultiValue(albumArtists);
      const parsedGenres = genres ? splitMultiValue(genres) : null;

      // 1. 提交元数据更改
      const overrides: Record<string, unknown> = {
        album: title.trim(),
        album_artists: parsedArtists,
        genres: parsedGenres && parsedGenres.length > 0 ? parsedGenres : [],
        description: description.trim(),
        label: label.trim() || null,
        catalog_number: catalogNumber.trim() || null,
        disc_total: discTotal > 0 ? discTotal : null,
        release_date: releaseDate.trim() || null,
        original_date: originalDate.trim() || null,
      };

      let targetAlbumId = albumId;
      const res = await api<{ album_id: string; updated: number }>('/manage/metadata/albums', {
        method: 'PUT',
        body: JSON.stringify({
          album_id: albumId,
          overrides,
        }),
      });
      if (res?.album_id) {
        targetAlbumId = res.album_id;
      }

      // 2. 如果标记清除自定义封面
      if (coverDeleted && record?.has_custom_cover) {
        await api(`/manage/albums/${encodeURIComponent(targetAlbumId)}/cover`, {
          method: 'DELETE',
        });
      }

      // 3. 如果选了新封面文件
      if (newCoverFile) {
        const formData = new FormData();
        formData.append('file', newCoverFile);
        formData.append('save_sidecar', saveSidecar ? 'true' : 'false');
        await api(`/manage/albums/${encodeURIComponent(targetAlbumId)}/cover`, {
          method: 'POST',
          body: formData,
        });
      }

      await onSaved(targetAlbumId);
      onClose();
    } catch (err: unknown) {
      const errorObj = err as { message?: string };
      setError(errorObj.message || t('albumEditor.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <dialog
      ref={dialog}
      className="playlist-editor album-editor-dialog"
      onCancel={(e) => {
        e.preventDefault();
        if (!saving) onClose();
      }}
    >
      <div className="editor-heading">
        <div>
          <span className="eyebrow">{t('albumEditor.eyebrow')}</span>
          <h2>{t('albumEditor.title')}</h2>
          <p className="muted">{initialTitle || record?.primary_title || albumId}</p>
        </div>
        <DialogCloseButton
          disabled={saving}
          aria-label={t('albumEditor.closeAria')}
          onClick={onClose}
        />
      </div>

      {loading ? (
        <div style={{ padding: '40px 0', textAlign: 'center' }} className="muted">
          {t('albumEditor.loading')}
        </div>
      ) : (
        <div className="album-editor-content">
          {record?.warning && (
            <div className="album-warning-banner" role="alert">
              <Icon name="info" />
              <span>{t('albumEditor.inconsistentWarning')}</span>
            </div>
          )}

          <div className="album-editor-grid">
            {/* 左侧：封面管理区 */}
            <div className="album-cover-column">
              <span className="metadata-field-label">{t('albumEditor.coverLabel')}</span>
              <div
                className="album-cover-dropzone"
                onDrop={handleDrop}
                onDragOver={handleDragOver}
                onClick={() => fileInputRef.current?.click()}
              >
                {previewCoverUrl ? (
                  <img
                    src={previewCoverUrl}
                    alt={t('albumEditor.newCoverAlt')}
                    className="album-cover-preview"
                  />
                ) : existingCoverUrl && !coverDeleted ? (
                  <img
                    src={existingCoverUrl}
                    alt={t('albumEditor.coverAlt')}
                    className="album-cover-preview"
                    onError={() => setExistingFailed(true)}
                  />
                ) : (
                  <DefaultArtwork
                    title={title || record?.primary_title || initialTitle}
                    artist={albumArtists}
                    interactive
                  />
                )}
                <div className="cover-hover-overlay">
                  <span>{t('albumEditor.coverDropHint')}</span>
                </div>
              </div>

              <input
                ref={fileInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                style={{ display: 'none' }}
                onChange={(e) => {
                  if (e.target.files && e.target.files[0]) {
                    handleFileSelect(e.target.files[0]);
                  }
                }}
              />

              <div className="album-cover-actions">
                <button
                  type="button"
                  className="text-button"
                  disabled={saving}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <Icon name="download" />
                  {previewCoverUrl || (existingCoverUrl && !coverDeleted)
                    ? t('albumEditor.changeCover')
                    : t('albumEditor.uploadCover')}
                </button>

                {newCoverFile && (
                  <button
                    type="button"
                    className="text-button"
                    disabled={saving}
                    onClick={handleCancelNewCover}
                  >
                    {t('albumEditor.cancelNewCover')}
                  </button>
                )}

                {!newCoverFile && existingCoverUrl && !coverDeleted && (
                  <button
                    type="button"
                    className="text-button danger-text"
                    disabled={saving}
                    onClick={handleRemoveCover}
                  >
                    <Icon name="remove" /> {t('albumEditor.removeCover')}
                  </button>
                )}
              </div>

              <label className="sidecar-checkbox-label">
                <input
                  type="checkbox"
                  checked={saveSidecar}
                  onChange={(e) => setSaveSidecar(e.target.checked)}
                />
                <span>{t('albumEditor.saveSidecarLabel')}</span>
              </label>
              <p className="field-hint">{t('albumEditor.sidecarHint')}</p>
            </div>

            {/* 右侧：FLAC 元数据表单 */}
            <div className="album-fields-column">
              <label className="metadata-field">
                <span className="metadata-field-label">{t('albumEditor.fieldAlbum')}</span>
                <input
                  type="text"
                  value={title}
                  placeholder={t('albumEditor.albumPlaceholder')}
                  disabled={saving}
                  onChange={(e) => setTitle(e.target.value)}
                />
              </label>

              <label className="metadata-field">
                <span className="metadata-field-label">{t('albumEditor.fieldAlbumArtist')}</span>
                <input
                  type="text"
                  value={albumArtists}
                  placeholder={t('albumEditor.artistsPlaceholder')}
                  disabled={saving}
                  onChange={(e) => setAlbumArtists(e.target.value)}
                />
              </label>

              <div className="fields-row-2">
                <label className="metadata-field">
                  <span className="metadata-field-label">{t('albumEditor.fieldReleaseDate')}</span>
                  <input
                    type="text"
                    value={releaseDate}
                    placeholder={t('albumEditor.releaseDatePlaceholder')}
                    disabled={saving}
                    onChange={(e) => setReleaseDate(e.target.value)}
                  />
                </label>

                <label className="metadata-field">
                  <span className="metadata-field-label">{t('albumEditor.fieldOriginalDate')}</span>
                  <input
                    type="text"
                    value={originalDate}
                    placeholder={t('albumEditor.originalDatePlaceholder')}
                    disabled={saving}
                    onChange={(e) => setOriginalDate(e.target.value)}
                  />
                </label>
              </div>

              <label className="metadata-field">
                <span className="metadata-field-label">{t('albumEditor.fieldGenre')}</span>
                <input
                  type="text"
                  value={genres}
                  placeholder={t('albumEditor.genrePlaceholder')}
                  disabled={saving}
                  onChange={(e) => setGenres(e.target.value)}
                />
              </label>

              {/* 高级字段折叠区 */}
              <div className="advanced-fields-toggle">
                <button
                  type="button"
                  className="text-button"
                  onClick={() => setShowAdvanced(!showAdvanced)}
                >
                  <Icon name={showAdvanced ? 'up' : 'down'} />
                  {showAdvanced
                    ? t('albumEditor.collapseAdvanced')
                    : t('albumEditor.expandAdvanced')}
                </button>
              </div>

              {showAdvanced && (
                <div className="advanced-fields-box">
                  <div className="fields-row-2">
                    <label className="metadata-field">
                      <span className="metadata-field-label">{t('albumEditor.fieldLabel')}</span>
                      <input
                        type="text"
                        value={label}
                        placeholder={t('albumEditor.labelPlaceholder')}
                        disabled={saving}
                        onChange={(e) => setLabel(e.target.value)}
                      />
                    </label>

                    <label className="metadata-field">
                      <span className="metadata-field-label">
                        {t('albumEditor.fieldCatalogNumber')}
                      </span>
                      <input
                        type="text"
                        value={catalogNumber}
                        placeholder={t('albumEditor.catalogPlaceholder')}
                        disabled={saving}
                        onChange={(e) => setCatalogNumber(e.target.value)}
                      />
                    </label>
                  </div>

                  <div className="fields-row-2">
                    <label className="metadata-field">
                      <span className="metadata-field-label">
                        {t('albumEditor.fieldDiscTotal')}
                      </span>
                      <input
                        type="number"
                        min="1"
                        max="99"
                        value={discTotal}
                        disabled={saving}
                        onChange={(e) => setDiscTotal(Math.max(1, parseInt(e.target.value) || 1))}
                      />
                    </label>
                  </div>

                  <label className="metadata-field">
                    <span className="metadata-field-label">
                      {t('albumEditor.fieldDescription')}
                    </span>
                    <textarea
                      rows={3}
                      value={description}
                      placeholder={t('albumEditor.descriptionPlaceholder')}
                      disabled={saving}
                      onChange={(e) => setDescription(e.target.value)}
                    />
                  </label>
                </div>
              )}
            </div>
          </div>

          {/* 包含曲目预览 */}
          {record?.tracks && record.tracks.length > 0 && (
            <div className="album-tracks-summary">
              <span className="metadata-field-label">
                {record.discs && record.discs.length > 1
                  ? t('albumEditor.tracksSummaryMulti', {
                      count: record.tracks.length,
                      discs: record.discs.length,
                    })
                  : t('albumEditor.tracksSummary', { count: record.tracks.length })}
              </span>
              <div className="album-tracks-table-wrap">
                <table className="album-tracks-table">
                  <thead>
                    <tr>
                      <th style={{ width: 44 }}>{t('albumEditor.colDisc')}</th>
                      <th style={{ width: 50 }}>{t('albumEditor.colTrackNo')}</th>
                      <th>{t('albumEditor.colTitle')}</th>
                      <th>{t('albumEditor.colArtists')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {record.tracks.map((t) => (
                      <tr key={t.track_id}>
                        <td className="muted">{t.disc_number || 1}</td>
                        <td className="muted">{t.track_number ?? '-'}</td>
                        <td className="track-title-cell">{t.title}</td>
                        <td className="muted">{t.artists.join(', ')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {error && (
        <p className="error" role="alert" style={{ marginTop: 16 }}>
          {error}
        </p>
      )}

      <div className="editor-footer">
        <button type="button" className="text-button" disabled={saving} onClick={onClose}>
          {t('albumEditor.cancel')}
        </button>
        <button type="button" className="primary" disabled={saving || loading} onClick={handleSave}>
          {saving ? t('albumEditor.saving') : t('albumEditor.save')}
        </button>
      </div>
    </dialog>
  );
}
