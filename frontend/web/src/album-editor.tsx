import { useEffect, useRef, useState } from 'react';
import { api, type AlbumMetadataRecord } from './api';
import { DefaultArtwork } from './default-artwork';
import { Icon } from './icons';
import { splitMultiValue } from './metadata-parser';

export function AlbumEditor({
  albumId,
  initialTitle,
  onClose,
  onSaved,
}: {
  albumId: string;
  initialTitle?: string;
  onClose: () => void;
  onSaved: () => Promise<void> | void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
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
        setError(err.message || '加载专辑元数据失败');
        setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [albumId, initialTitle]);

  // 处理选择图片
  const handleFileSelect = (file: File) => {
    if (!file.type.startsWith('image/')) {
      setError('请选择 JPG、PNG 或 WEBP 格式的图片文件');
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
      setError('专辑名称不能为空');
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
        album_artists: parsedArtists.length > 0 ? parsedArtists : ['未知艺人'],
        genres: parsedGenres && parsedGenres.length > 0 ? parsedGenres : [],
        description: description.trim(),
        label: label.trim() || null,
        catalog_number: catalogNumber.trim() || null,
        disc_total: discTotal > 0 ? discTotal : null,
        release_date: releaseDate.trim() || null,
        original_date: originalDate.trim() || null,
      };

      await api('/manage/metadata/albums', {
        method: 'PUT',
        body: JSON.stringify({
          album_id: albumId,
          overrides,
        }),
      });

      // 2. 如果标记清除自定义封面
      if (coverDeleted && record?.has_custom_cover) {
        await api(`/manage/albums/${encodeURIComponent(albumId)}/cover`, {
          method: 'DELETE',
        });
      }

      // 3. 如果选了新封面文件
      if (newCoverFile) {
        const formData = new FormData();
        formData.append('file', newCoverFile);
        formData.append('save_sidecar', saveSidecar ? 'true' : 'false');
        await api(`/manage/albums/${encodeURIComponent(albumId)}/cover`, {
          method: 'POST',
          body: formData,
        });
      }

      await onSaved();
      onClose();
    } catch (err: unknown) {
      const errorObj = err as { message?: string };
      setError(errorObj.message || '保存失败，请检查网络或字段格式');
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
          <span className="eyebrow">FLAC ALBUM METADATA & ARTWORK</span>
          <h2>编辑专辑</h2>
          <p className="muted">{initialTitle || record?.primary_title || albumId}</p>
        </div>
        <button className="icon-button" disabled={saving} aria-label="关闭" onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>

      {loading ? (
        <div style={{ padding: '40px 0', textAlign: 'center' }} className="muted">
          正在读取专辑曲目与标签信息...
        </div>
      ) : (
        <div className="album-editor-content">
          {record?.warning && (
            <div className="album-warning-banner" role="alert">
              <Icon name="info" />
              <span>
                检测到该专辑内曲目名称或艺人存在不一致。保存后将自动把统一的规范标签同步至全专全部曲目。
              </span>
            </div>
          )}

          <div className="album-editor-grid">
            {/* 左侧：封面管理区 */}
            <div className="album-cover-column">
              <span className="metadata-field-label">专辑封面</span>
              <div
                className="album-cover-dropzone"
                onDrop={handleDrop}
                onDragOver={handleDragOver}
                onClick={() => fileInputRef.current?.click()}
              >
                {previewCoverUrl ? (
                  <img
                    src={previewCoverUrl}
                    alt="新选专辑封面预览"
                    className="album-cover-preview"
                  />
                ) : existingCoverUrl && !coverDeleted ? (
                  <img
                    src={existingCoverUrl}
                    alt="专辑封面"
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
                  <span>点击或拖拽更换封面</span>
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
                    ? '更换封面图片'
                    : '上传本地封面'}
                </button>

                {newCoverFile && (
                  <button
                    type="button"
                    className="text-button"
                    disabled={saving}
                    onClick={handleCancelNewCover}
                  >
                    取消新选
                  </button>
                )}

                {!newCoverFile && existingCoverUrl && !coverDeleted && (
                  <button
                    type="button"
                    className="text-button danger-text"
                    disabled={saving}
                    onClick={handleRemoveCover}
                  >
                    <Icon name="remove" /> 移除封面
                  </button>
                )}
              </div>

              <label className="sidecar-checkbox-label">
                <input
                  type="checkbox"
                  checked={saveSidecar}
                  onChange={(e) => setSaveSidecar(e.target.checked)}
                />
                <span>同时在专辑目录保存 cover.jpg 实体文件</span>
              </label>
              <p className="field-hint">
                发烧友规范：自动在专辑受控文件夹写入标准的 cover.jpg 独立封面文件。
              </p>
            </div>

            {/* 右侧：FLAC 元数据表单 */}
            <div className="album-fields-column">
              <label className="metadata-field">
                <span className="metadata-field-label">专辑名称 (ALBUM)</span>
                <input
                  type="text"
                  value={title}
                  placeholder="请输入专辑名称"
                  disabled={saving}
                  onChange={(e) => setTitle(e.target.value)}
                />
              </label>

              <label className="metadata-field">
                <span className="metadata-field-label">专辑艺人 (ALBUMARTIST)</span>
                <input
                  type="text"
                  value={albumArtists}
                  placeholder="如：崔健 / 支持用斜杠、逗号或顿号分隔"
                  disabled={saving}
                  onChange={(e) => setAlbumArtists(e.target.value)}
                />
              </label>

              <div className="fields-row-2">
                <label className="metadata-field">
                  <span className="metadata-field-label">发行日期 (DATE)</span>
                  <input
                    type="text"
                    value={releaseDate}
                    placeholder="如：1989 或 1989-02-01"
                    disabled={saving}
                    onChange={(e) => setReleaseDate(e.target.value)}
                  />
                </label>

                <label className="metadata-field">
                  <span className="metadata-field-label">首次发行年份 (ORIGINALDATE)</span>
                  <input
                    type="text"
                    value={originalDate}
                    placeholder="首版年份或首次录音日期"
                    disabled={saving}
                    onChange={(e) => setOriginalDate(e.target.value)}
                  />
                </label>
              </div>

              <label className="metadata-field">
                <span className="metadata-field-label">流派风格 (GENRE)</span>
                <input
                  type="text"
                  value={genres}
                  placeholder="如：摇滚 / 民谣 / 流行（支持斜杠、逗号或顿号）"
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
                  {showAdvanced ? '收起唱片厂牌与高级标签' : '展开唱片厂牌、编号与高级标签'}
                </button>
              </div>

              {showAdvanced && (
                <div className="advanced-fields-box">
                  <div className="fields-row-2">
                    <label className="metadata-field">
                      <span className="metadata-field-label">唱片厂牌 (LABEL / ORGANIZATION)</span>
                      <input
                        type="text"
                        value={label}
                        placeholder="如：中国旅游声像出版社"
                        disabled={saving}
                        onChange={(e) => setLabel(e.target.value)}
                      />
                    </label>

                    <label className="metadata-field">
                      <span className="metadata-field-label">唱片编号 (CATALOGNUMBER)</span>
                      <input
                        type="text"
                        value={catalogNumber}
                        placeholder="如：CS-001 / CD-099"
                        disabled={saving}
                        onChange={(e) => setCatalogNumber(e.target.value)}
                      />
                    </label>
                  </div>

                  <div className="fields-row-2">
                    <label className="metadata-field">
                      <span className="metadata-field-label">总碟数 (DISCTOTAL)</span>
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
                      专辑介绍 / 注释 (DESCRIPTION / COMMENT)
                    </span>
                    <textarea
                      rows={3}
                      value={description}
                      placeholder="专辑创作背景、出版说明或私人收藏备注..."
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
                本专辑包含曲目 ({record.tracks.length} 首
                {record.discs && record.discs.length > 1 ? `，共 ${record.discs.length} 碟` : ''})
              </span>
              <div className="album-tracks-table-wrap">
                <table className="album-tracks-table">
                  <thead>
                    <tr>
                      <th style={{ width: 44 }}>碟</th>
                      <th style={{ width: 50 }}>曲号</th>
                      <th>歌曲标题</th>
                      <th>曲目艺人</th>
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
          取消
        </button>
        <button type="button" className="primary" disabled={saving || loading} onClick={handleSave}>
          {saving ? '正在保存专辑...' : '保存专辑'}
        </button>
      </div>
    </dialog>
  );
}
