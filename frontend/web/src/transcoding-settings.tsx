import { HelpLabel } from './desktop-help';
import { useEffect, useState, type FormEvent } from 'react';
import { api } from './api';
interface Settings {
  version: number;
  retention_days: number;
  max_size_mb: number;
  max_concurrent: number;
  cache_bytes: number;
  cache_entries: number;
  active_jobs: number;
  ffmpeg_available: boolean;
}
export function TranscodingSettings() {
  const [record, setRecord] = useState<Settings | null>(null);
  const [days, setDays] = useState('7'),
    [size, setSize] = useState('10240'),
    [jobs, setJobs] = useState('2');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  function populate(result: Settings) {
    setRecord(result);
    setDays(String(result.retention_days));
    setSize(String(result.max_size_mb));
    setJobs(String(result.max_concurrent));
  }
  async function refresh(signal?: AbortSignal) {
    try {
      const result = await api<Settings>('/manage/transcoding', { signal });
      if (!signal?.aborted) populate(result);
    } catch (reason) {
      if (!signal?.aborted) setError((reason as Error).message);
    }
  }
  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, []);
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!record) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      populate(
        await api<Settings>('/manage/transcoding', {
          method: 'PUT',
          body: JSON.stringify({
            version: record.version,
            retention_days: Number(days),
            max_size_mb: Number(size),
            max_concurrent: Number(jobs),
          }),
        }),
      );
      setNotice('转码缓存设置已保存。');
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function clear() {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await api<{ deferred: number; cache: Settings }>('/manage/transcoding/cache', {
        method: 'DELETE',
      });
      populate(result.cache);
      setNotice(
        result.deferred ? '缓存已清理，正在播放的缓存会在使用结束后删除。' : '转码缓存已清空。',
      );
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="management-card account-form" aria-label="AAC 转码设置" onSubmit={save}>
      <h2>AAC 转码与缓存</h2>
      <p className="muted">
        播放器选择 AAC 时，无损歌曲按所选码率转换；MP3、AAC 等有损歌曲保持原音。
      </p>
      {record && (
        <p className="muted">
          已缓存 {(record.cache_bytes / 1048576).toFixed(1)} MiB · {record.cache_entries} 项 ·
          正在转换 {record.active_jobs} 项
        </p>
      )}
      {record && !record.ffmpeg_available && (
        <p className="error" role="alert">
          FFmpeg 不可用，AAC 转码暂不可用。官方 Docker 镜像已内置。
        </p>
      )}
      <label>
        <HelpLabel hint="cacheDays">保留天数（自上次使用）</HelpLabel>
        <input
          type="number"
          disabled={!record || busy}
          min={1}
          max={365}
          required
          value={days}
          onChange={(e) => setDays(e.target.value)}
        />
      </label>
      <label>
        <HelpLabel hint="cacheSize">缓存上限（MiB）</HelpLabel>
        <input
          type="number"
          disabled={!record || busy}
          min={16}
          max={1048576}
          required
          value={size}
          onChange={(e) => setSize(e.target.value)}
        />
      </label>
      <label>
        <HelpLabel hint="transcodeJobs">同时转码任务数</HelpLabel>
        <input
          type="number"
          disabled={!record || busy}
          min={1}
          max={8}
          required
          value={jobs}
          onChange={(e) => setJobs(e.target.value)}
        />
      </label>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      <div className="settings-actions">
        <button className="primary" disabled={!record || busy}>
          保存转码设置
        </button>
        <button type="button" disabled={!record || busy} onClick={() => void clear()}>
          清理转码缓存
        </button>
        <button type="button" disabled={busy} onClick={() => void refresh()}>
          刷新缓存用量
        </button>
      </div>
    </form>
  );
}
