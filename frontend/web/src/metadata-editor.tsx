import { useEffect, useRef, useState } from 'react';
import { api, type Track } from './api';

export type MetadataFields = Pick<
  Track,
  'title' | 'artists' | 'album' | 'album_artists' | 'track_number' | 'disc_number'
>;
interface MetadataRecord {
  track_id: string;
  version: number;
  observed: MetadataFields;
  effective: MetadataFields;
  overrides: Partial<MetadataFields>;
}
const labels: Record<keyof MetadataFields, string> = {
  title: '歌名',
  artists: '歌曲艺人',
  album: '专辑',
  album_artists: '专辑艺人',
  track_number: '曲号',
  disc_number: '碟号',
};
const fields = Object.keys(labels) as (keyof MetadataFields)[];
function display(value: unknown): string {
  return Array.isArray(value) ? value.join('\n') : value === null ? '' : String(value);
}
export function MetadataEditor({
  track,
  onClose,
  onSaved,
}: {
  track: Track;
  onClose: () => void;
  onSaved: (id: string) => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const request = useRef<AbortController | null>(null);
  const [record, setRecord] = useState<MetadataRecord | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [overridden, setOverridden] = useState<string[]>([]);
  const [preview, setPreview] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
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
  const overrides: Record<string, unknown> = {};
  for (const key of overridden) {
    const value = values[key];
    overrides[key] =
      key === 'artists' || key === 'album_artists'
        ? value
            .split('\n')
            .map((v) => v.trim())
            .filter(Boolean)
        : key === 'track_number' || key === 'disc_number'
          ? value.trim()
            ? Number(value)
            : null
          : value.trim() || (key === 'album' ? null : '');
  }
  function validate() {
    if (overridden.includes('title') && !values.title.trim()) {
      setError('请填写歌名。');
      return;
    }
    for (const key of ['track_number', 'disc_number'])
      if (
        overridden.includes(key) &&
        values[key] &&
        (!Number.isInteger(Number(values[key])) ||
          Number(values[key]) < 1 ||
          Number(values[key]) > 99999)
      ) {
        setError('曲号和碟号应为 1–99999 的整数，或留空。');
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
      setError(reason instanceof Error ? reason.message : '保存未完成，请重试。');
    } finally {
      setBusy(false);
    }
  }
  const next = record ? { ...record.observed, ...overrides } : null;
  return (
    <dialog
      className="metadata-editor playlist-editor"
      ref={dialog}
      aria-label="编辑歌曲信息"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <div className="editor-heading">
        <div>
          <span className="eyebrow">MAKE IT YOURS</span>
          <h2>编辑歌曲信息</h2>
          <p className="muted">{track.title}</p>
        </div>
        <button className="icon-button" disabled={busy} aria-label="关闭歌曲编辑" onClick={onClose}>
          ×
        </button>
      </div>
      {record ? (
        <>
          <p className="muted">保存后曲库信息立即生效，重新扫描会保留。本次保存不写入音乐标签。</p>
          {!preview ? (
            <div className="metadata-fields">
              {fields.map((key) => (
                <label className="metadata-field" key={key}>
                  <span className="metadata-field-label">
                    {labels[key]}
                    <span className="metadata-source">
                      {overridden.includes(key) ? '人工编辑' : '文件标签'}
                    </span>
                  </span>
                  {key === 'artists' || key === 'album_artists' ? (
                    <textarea
                      aria-label={labels[key]}
                      value={values[key] || ''}
                      maxLength={10000}
                      rows={2}
                      onChange={(e) => {
                        setValues({ ...values, [key]: e.target.value });
                        setOverridden((keys) => [...new Set([...keys, key])]);
                      }}
                      placeholder="每行一位艺人"
                    />
                  ) : (
                    <input
                      aria-label={labels[key]}
                      type={key.endsWith('number') ? 'number' : 'text'}
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
                    文件值：{display(record.observed[key]).replaceAll('\n', ' / ') || '未填写'}
                  </span>
                  {overridden.includes(key) && (
                    <button
                      className="text-button"
                      type="button"
                      onClick={() => {
                        setValues({ ...values, [key]: display(record.observed[key]) });
                        setOverridden((keys) => keys.filter((v) => v !== key));
                      }}
                    >
                      使用文件值 · {labels[key]}
                    </button>
                  )}
                </label>
              ))}
            </div>
          ) : (
            <div className="metadata-diff" aria-label="元数据修改预览">
              <h3>确认修改</h3>
              {fields.map((key) => (
                <div key={key}>
                  <strong>{labels[key]}</strong>
                  <span>{display(record.effective[key]).replaceAll('\n', ' / ') || '未填写'}</span>
                  <span aria-hidden="true">→</span>
                  <span>{display(next![key]).replaceAll('\n', ' / ') || '未填写'}</span>
                </div>
              ))}
            </div>
          )}
          {error && (
            <p className="error" role="alert">
              {error}{' '}
              <button className="text-button" disabled={busy} onClick={load}>
                重新读取
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
              {preview ? '返回编辑' : '取消'}
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
              全部使用文件值
            </button>
            <button
              className="primary"
              disabled={busy}
              onClick={() => (preview ? void save() : validate())}
            >
              {busy ? '保存中…' : preview ? '保存修改' : '预览修改'}
            </button>
          </div>
        </>
      ) : error ? (
        <p className="error" role="alert">
          {error}
          <button onClick={load}>重新读取</button>
        </p>
      ) : (
        <p role="status">读取歌曲信息…</p>
      )}
    </dialog>
  );
}
