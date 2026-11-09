import { useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
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
  const { t } = useTranslation();
  const input = useRef<HTMLInputElement>(null);
  const descriptionId = useId();
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState(false);

  function choose(files: File[]) {
    if (disabled) return;
    setError('');
    if (files.length !== 1) {
      setError(t('pluginZipUpload.errorSingleFile'));
      return;
    }
    const next = files[0];
    if (!/\.zip$/i.test(next.name)) {
      setError(t('pluginZipUpload.errorZipFormat'));
      return;
    }
    if (next.size > MAX_ZIP) {
      setError(t('pluginZipUpload.errorTooLarge'));
      return;
    }
    if (!next.size) {
      setError(t('pluginZipUpload.errorEmptyFile'));
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
        aria-label={t('pluginZipUpload.dropzoneAria', { label: inputLabel })}
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
          <strong>{file ? file.name : t('pluginZipUpload.selectOrDropPrompt')}</strong>
          <span>
            {file
              ? `${file.size < 1024 * 1024 ? `${(file.size / 1024).toFixed(1)} KiB` : `${(file.size / 1024 / 1024).toFixed(1)} MiB`} · ${working ? t('pluginZipUpload.statusWorking') : t('pluginZipUpload.statusWaiting')}`
              : t('pluginZipUpload.fileLimitHint')}
          </span>
        </div>
        <div className="plugin-file-controls">
          <button
            type="button"
            disabled={disabled}
            aria-describedby={descriptionId}
            onClick={() => input.current?.click()}
          >
            {file ? t('pluginZipUpload.reselect') : t('pluginZipUpload.chooseZip')}
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
              {t('pluginZipUpload.removeFile')}
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
          {working ? t('pluginZipUpload.workingUploading') : actionLabel}
        </button>
        {working && <span role="status">{t('pluginZipUpload.workingHint')}</span>}
      </div>
    </div>
  );
}
