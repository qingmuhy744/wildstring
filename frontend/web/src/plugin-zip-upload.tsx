import { useId, useRef, useState } from 'react';
import { Icon } from './icons';

const MAX_ZIP = 16 * 1024 * 1024;

export function PluginZipUpload({
  inputLabel,
  actionLabel,
  disabled,
  working,
  onUpload,
}: {
  inputLabel: string;
  actionLabel: string;
  disabled: boolean;
  working: boolean;
  onUpload: (file: File) => Promise<boolean>;
}) {
  const input = useRef<HTMLInputElement>(null);
  const descriptionId = useId();
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState(false);

  function choose(files: File[]) {
    if (disabled) return;
    setError('');
    if (files.length !== 1) {
      setError('请一次选择一个插件 ZIP。');
      return;
    }
    const next = files[0];
    if (!/\.zip$/i.test(next.name)) {
      setError('请选择 .zip 格式的插件包。');
      return;
    }
    if (next.size > MAX_ZIP) {
      setError('插件 ZIP 超过 16 MiB，请选择较小的包。');
      return;
    }
    if (!next.size) {
      setError('这个文件是空的，请重新选择插件 ZIP。');
      return;
    }
    setFile(next);
  }
  return (
    <div className="plugin-zip-upload" aria-busy={working}>
      <input
        ref={input}
        className="plugin-file-input"
        aria-label={inputLabel}
        type="file"
        accept=".zip,application/zip,application/x-zip-compressed"
        disabled={disabled}
        onChange={(event) => {
          const selected = Array.from(event.target.files || []);
          event.target.value = '';
          if (selected.length) choose(selected);
        }}
      />
      <div
        className={`plugin-dropzone${dragging && !disabled ? ' is-dragging' : ''}`}
        aria-label={`${inputLabel}拖放区`}
        onDragOver={(event) => {
          event.preventDefault();
          if (!disabled) event.dataTransfer.dropEffect = 'copy';
        }}
        onDragEnter={(event) => {
          event.preventDefault();
          if (!disabled) setDragging(true);
        }}
        onDragLeave={(event) => {
          if (
            !(event.relatedTarget instanceof Node) ||
            !event.currentTarget.contains(event.relatedTarget)
          )
            setDragging(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          choose(Array.from(event.dataTransfer.files));
        }}
      >
        <span className="plugin-zip-icon" aria-hidden="true">
          <Icon name="draft" />
          ZIP
        </span>
        <div className="plugin-file-description" id={descriptionId}>
          <strong>{file ? file.name : '选择或拖入插件 ZIP'}</strong>
          <span>
            {file
              ? `${file.size < 1024 * 1024 ? `${(file.size / 1024).toFixed(1)} KiB` : `${(file.size / 1024 / 1024).toFixed(1)} MiB`} · ${working ? '正在上传并校验' : '等待确认上传'}`
              : '每次一个文件，最大 16 MiB'}
          </span>
        </div>
        <div className="plugin-file-controls">
          <button
            type="button"
            disabled={disabled}
            aria-describedby={descriptionId}
            onClick={() => input.current?.click()}
          >
            {file ? '重新选择' : '选择 ZIP'}
          </button>
          {file && (
            <button
              type="button"
              className="text-button"
              disabled={disabled}
              onClick={() => {
                setFile(null);
                setError('');
              }}
            >
              移除文件
            </button>
          )}
        </div>
      </div>
      {error && (
        <p className="plugin-feedback" data-kind="error" role="alert">
          {error}
        </p>
      )}
      <div className="plugin-upload-actions">
        <button
          type="button"
          className="primary"
          disabled={disabled || !file || !!error}
          onClick={async () => {
            if (!file || disabled || error) return;
            if (await onUpload(file)) setFile(null);
          }}
        >
          {working ? '正在上传并校验…' : actionLabel}
        </button>
        {working && <span role="status">请稍候，完成后会显示结果。</span>}
      </div>
    </div>
  );
}
