import { useCallback, useRef, useState } from 'react';
import { api } from './api';

export interface UploadItem {
  id: string;
  file: File;
  relativePath: string;
  status: 'pending' | 'uploading' | 'imported' | 'duplicate' | 'error';
  error?: string;
  targetPath?: string;
}

const SUPPORTED_EXTENSIONS = new Set(['.mp3', '.flac', '.m4a', '.wav', '.lrc', '.lryc', '.txt']);

function isSupportedFile(filename: string): boolean {
  const dot = filename.lastIndexOf('.');
  if (dot === -1) return false;
  return SUPPORTED_EXTENSIONS.has(filename.slice(dot).toLowerCase());
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface WebkitEntry {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file: (success: (file: File) => void, error?: (err: unknown) => void) => void;
  createReader: () => {
    readEntries: (
      success: (entries: WebkitEntry[]) => void,
      error?: (err: unknown) => void,
    ) => void;
  };
}

async function scanFileSystemEntry(
  entry: WebkitEntry,
  currentPath = '',
): Promise<{ file: File; relativePath: string }[]> {
  if (entry.isFile) {
    return new Promise((resolve) => {
      entry.file(
        (file: File) => {
          const relativePath = currentPath ? `${currentPath}/${file.name}` : file.name;
          resolve(isSupportedFile(file.name) ? [{ file, relativePath }] : []);
        },
        () => resolve([]),
      );
    });
  }
  if (entry.isDirectory) {
    const reader = entry.createReader();
    const children: WebkitEntry[] = [];
    const readBatch = async (): Promise<WebkitEntry[]> => {
      return new Promise((resolve) => {
        reader.readEntries(
          (batch) => {
            if (!batch || batch.length === 0) resolve(children);
            else {
              children.push(...batch);
              readBatch().then(resolve);
            }
          },
          () => resolve(children),
        );
      });
    };
    const allChildren = await readBatch();
    const dirPath = currentPath ? `${currentPath}/${entry.name}` : entry.name;
    const subResults = await Promise.all(
      allChildren.map((child) => scanFileSystemEntry(child, dirPath)),
    );
    return subResults.flat();
  }
  return [];
}

export function MusicUploader({
  canImport,
  onUploaded,
}: {
  canImport: boolean;
  onUploaded: () => void;
}) {
  const [items, setItems] = useState<UploadItem[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [overrideArtist, setOverrideArtist] = useState('');
  const [overrideAlbum, setOverrideAlbum] = useState('');
  const [summary, setSummary] = useState<{
    imported: number;
    duplicate: number;
    error: number;
  } | null>(null);

  const folderInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleSelectedFiles = useCallback((fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    const added: UploadItem[] = [];
    for (let i = 0; i < fileList.length; i++) {
      const file = fileList[i];
      if (isSupportedFile(file.name)) {
        const relativePath =
          (file as { webkitRelativePath?: string }).webkitRelativePath || file.name;
        added.push({
          id: `${file.name}-${file.size}-${Math.random().toString(36).slice(2, 7)}`,
          file,
          relativePath,
          status: 'pending',
        });
      }
    }
    if (added.length > 0) {
      setItems((prev) => [...prev, ...added]);
      setSummary(null);
    }
  }, []);

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      setDragActive(false);
      if (!canImport) return;

      const dataTransfer = e.dataTransfer;
      const collected: { file: File; relativePath: string }[] = [];

      if (dataTransfer.items && dataTransfer.items.length > 0) {
        const entryPromises: Promise<{ file: File; relativePath: string }[]>[] = [];
        for (let i = 0; i < dataTransfer.items.length; i++) {
          const item = dataTransfer.items[i];
          const entry = (
            item as unknown as { webkitGetAsEntry?: () => WebkitEntry | null }
          ).webkitGetAsEntry?.();
          if (entry) {
            entryPromises.push(scanFileSystemEntry(entry));
          } else {
            const file = item.getAsFile();
            if (file && isSupportedFile(file.name)) {
              collected.push({ file, relativePath: file.name });
            }
          }
        }
        const scanned = await Promise.all(entryPromises);
        for (const list of scanned) collected.push(...list);
      } else if (dataTransfer.files) {
        for (let i = 0; i < dataTransfer.files.length; i++) {
          const file = dataTransfer.files[i];
          if (isSupportedFile(file.name)) {
            collected.push({ file, relativePath: file.name });
          }
        }
      }

      if (collected.length > 0) {
        const added: UploadItem[] = collected.map(({ file, relativePath }) => ({
          id: `${file.name}-${file.size}-${Math.random().toString(36).slice(2, 7)}`,
          file,
          relativePath,
          status: 'pending',
        }));
        setItems((prev) => [...prev, ...added]);
        setSummary(null);
      }
    },
    [canImport],
  );

  const startUpload = async () => {
    if (uploading || items.length === 0 || !canImport) return;
    setUploading(true);
    setSummary(null);

    let importedCount = 0;
    let duplicateCount = 0;
    let errorCount = 0;

    const queue = [...items];
    const updateItem = (id: string, patch: Partial<UploadItem>) => {
      setItems((prev) => prev.map((item) => (item.id === id ? { ...item, ...patch } : item)));
    };

    // Upload with concurrency = 2
    const concurrency = 2;
    let cursor = 0;

    const uploadWorker = async () => {
      while (cursor < queue.length) {
        const index = cursor++;
        const item = queue[index];
        if (item.status === 'imported' || item.status === 'duplicate') continue;

        updateItem(item.id, { status: 'uploading' });

        const formData = new FormData();
        formData.append('file', item.file);
        formData.append('relative_path', item.relativePath);
        if (overrideArtist.trim()) formData.append('override_artist', overrideArtist.trim());
        if (overrideAlbum.trim()) formData.append('override_album', overrideAlbum.trim());

        // auto_scan on the very last file
        const isLast = index === queue.length - 1;
        if (isLast) formData.append('auto_scan', 'true');

        try {
          const res = await api<{
            status: string;
            target_path?: string;
            detail?: string;
          }>('/manage/library/upload', {
            method: 'POST',
            body: formData,
          });

          if (res.status === 'duplicate') {
            duplicateCount++;
            updateItem(item.id, { status: 'duplicate', targetPath: res.target_path });
          } else {
            importedCount++;
            updateItem(item.id, { status: 'imported', targetPath: res.target_path });
          }
        } catch (err) {
          errorCount++;
          const message = err instanceof Error ? err.message : '上传失败';
          updateItem(item.id, { status: 'error', error: message });
        }
      }
    };

    const workers = Array.from({ length: Math.min(concurrency, queue.length) }, () =>
      uploadWorker(),
    );
    await Promise.all(workers);

    setUploading(false);
    setSummary({ imported: importedCount, duplicate: duplicateCount, error: errorCount });
    onUploaded();
  };

  const clearItems = () => {
    if (uploading) return;
    setItems([]);
    setSummary(null);
  };

  const totalBytes = items.reduce((sum, item) => sum + item.file.size, 0);
  const completedCount = items.filter(
    (i) => i.status === 'imported' || i.status === 'duplicate' || i.status === 'error',
  ).length;
  const progressPercent = items.length > 0 ? Math.round((completedCount / items.length) * 100) : 0;

  return (
    <section className="management-card music-uploader" aria-label="上传音乐工作台">
      <span className="eyebrow">UPLOAD WORKSPACE</span>
      <h2>上传音乐与文件夹</h2>
      <p className="muted">
        支持拖拽整个文件夹或音频文件，自动解析标签、排他去重并按规范整理入库。若无曲序标签将智能根据文件名提取。
      </p>

      {/* Hidden file inputs */}
      <input
        ref={folderInputRef}
        type="file"
        // @ts-expect-error webkitdirectory is standard in Chromium/Safari/Firefox
        webkitdirectory=""
        directory=""
        multiple
        style={{ display: 'none' }}
        onChange={(e) => {
          handleSelectedFiles(e.target.files);
          e.target.value = '';
        }}
      />
      <input
        ref={fileInputRef}
        type="file"
        accept="audio/*,.lrc,.lryc,.txt"
        multiple
        style={{ display: 'none' }}
        onChange={(e) => {
          handleSelectedFiles(e.target.files);
          e.target.value = '';
        }}
      />

      {/* Dropzone */}
      <div
        className={`upload-dropzone ${dragActive ? 'drag-active' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragActive(true);
        }}
        onDragLeave={() => setDragActive(false)}
        onDrop={handleDrop}
      >
        <div className="dropzone-content">
          <span className="dropzone-icon" aria-hidden="true">
            📂
          </span>
          <p>
            <strong>拖拽文件夹或音频文件到此处</strong>
          </p>
          <span className="muted">支持 FLAC、MP3、M4A、WAV 及伴随歌词 (.lrc)</span>
          <div className="dropzone-buttons">
            <button
              type="button"
              className="primary"
              disabled={!canImport || uploading}
              onClick={() => folderInputRef.current?.click()}
            >
              选择文件夹
            </button>
            <button
              type="button"
              disabled={!canImport || uploading}
              onClick={() => fileInputRef.current?.click()}
            >
              选择音频文件
            </button>
          </div>
        </div>
      </div>

      {/* Staging & Upload list */}
      {items.length > 0 && (
        <div className="upload-queue-panel">
          <div className="queue-header">
            <div>
              <strong>待上传清单</strong>
              <span className="muted">
                （共 {items.length} 个文件 · {formatBytes(totalBytes)}）
              </span>
            </div>
            {!uploading && (
              <button type="button" onClick={clearItems} className="text-button">
                清空列表
              </button>
            )}
          </div>

          {/* Quick Override Fields (Second line of defense) */}
          <div className="upload-overrides">
            <details>
              <summary>标签缺失时的覆盖设置（可选）</summary>
              <div className="overrides-form">
                <label>
                  <span>强制/默认艺人：</span>
                  <input
                    type="text"
                    value={overrideArtist}
                    placeholder="如：周杰伦"
                    disabled={uploading}
                    onChange={(e) => setOverrideArtist(e.target.value)}
                  />
                </label>
                <label>
                  <span>强制/默认专辑：</span>
                  <input
                    type="text"
                    value={overrideAlbum}
                    placeholder="如：范特西"
                    disabled={uploading}
                    onChange={(e) => setOverrideAlbum(e.target.value)}
                  />
                </label>
              </div>
            </details>
          </div>

          {/* Progress bar */}
          {uploading && (
            <div className="upload-progress-bar-wrapper">
              <div className="progress-info">
                <span>正在上传...</span>
                <span>
                  {completedCount} / {items.length} ({progressPercent}%)
                </span>
              </div>
              <div className="progress-track">
                <div className="progress-fill" style={{ width: `${progressPercent}%` }} />
              </div>
            </div>
          )}

          {/* Summary */}
          {summary && (
            <div className="upload-summary-box" role="status">
              <span>
                🎉 上传完成：成功导入 <strong>{summary.imported}</strong> 首， 跳过重复{' '}
                <strong>{summary.duplicate}</strong> 首
                {summary.error > 0 && `，失败 ${summary.error} 项`}。
              </span>
            </div>
          )}

          {/* Item list */}
          <div className="upload-item-list">
            {items.map((item) => (
              <div className="upload-item-row" key={item.id}>
                <div className="item-meta">
                  <span className="item-name" title={item.relativePath}>
                    {item.relativePath}
                  </span>
                  <span className="item-size muted">{formatBytes(item.file.size)}</span>
                </div>
                <div className="item-status">
                  {item.status === 'pending' && <span className="status-tag pending">等待中</span>}
                  {item.status === 'uploading' && (
                    <span className="status-tag uploading">上传中...</span>
                  )}
                  {item.status === 'imported' && (
                    <span className="status-tag success">✓ 已导入</span>
                  )}
                  {item.status === 'duplicate' && (
                    <span className="status-tag duplicate">✓ 重复跳过</span>
                  )}
                  {item.status === 'error' && (
                    <span className="status-tag error" title={item.error}>
                      ✕ {item.error || '失败'}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>

          {/* Action button */}
          <div className="source-actions">
            <button
              type="button"
              className="primary"
              disabled={
                uploading ||
                !canImport ||
                items.every((i) => i.status === 'imported' || i.status === 'duplicate')
              }
              onClick={() => void startUpload()}
            >
              {uploading ? `正在上传 (${completedCount}/${items.length})` : '开始上传入库'}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
