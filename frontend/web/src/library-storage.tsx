import { useEffect, useId, useState } from 'react';
import { api } from './api';
import { FolderPicker } from './folder-picker';
import type { MusicLibrary } from './music-libraries';

type IntakePolicy = {
  version: number;
  enabled: boolean;
  interval_seconds: number;
  stable_seconds: number;
  download_policy: { wait_for_album: boolean; partial_suffixes: string[] };
};
type Migration = {
  id: string;
  status: string;
  target_root: string;
  copied_files: number;
  total_files: number;
  copied_bytes: number;
  total_bytes: number;
  error: string | null;
};
const statusText: Record<string, string> = {
  queued: '等待迁移',
  running: '正在复制并校验',
  completed: '目录已切换，旧文件已保留',
  failed: '迁移未完成，仍使用原目录',
};

export function LibraryStorage({
  library,
  onChanged,
}: {
  library: MusicLibrary;
  onChanged: () => Promise<void>;
}) {
  const id = useId();
  const [policy, setPolicy] = useState<IntakePolicy | null>(null);
  const [job, setJob] = useState<Migration | null>(null);
  const [target, setTarget] = useState('');
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const endpoint = `/libraries/${encodeURIComponent(library.id)}/migrations`;
  const intake = `/manage/intake/settings?library_id=${encodeURIComponent(library.id)}`;
  useEffect(() => {
    let active = true;
    setPolicy(null);
    setJob(null);
    setTarget('');
    setMessage('');
    void Promise.all([api<IntakePolicy>(intake), api<{ items: Migration[] }>(endpoint)])
      .then(([value, jobs]) => {
        if (active) {
          setPolicy(value);
          setJob(jobs.items[0] || null);
        }
      })
      .catch((error: Error) => {
        if (active) setMessage(error.message);
      });
    return () => {
      active = false;
    };
  }, [intake, endpoint]);
  const moving = job?.status === 'queued' || job?.status === 'running';
  useEffect(() => {
    if (!moving) return;
    let active = true;
    const timer = window.setInterval(() => {
      void api<{ items: Migration[] }>(endpoint)
        .then(async (value) => {
          if (!active) return;
          const latest = value.items[0];
          setJob(latest || null);
          if (latest && !['queued', 'running'].includes(latest.status)) await onChanged();
        })
        .catch((error: Error) => {
          if (active) setMessage(error.message);
        });
    }, 1500);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [moving, endpoint, onChanged]);
  async function configure() {
    setBusy(true);
    setMessage('');
    try {
      setPolicy(
        await api<IntakePolicy>(intake, {
          method: 'PUT',
          body: JSON.stringify(
            policy && {
              ...policy,
              download_policy: {
                ...policy.download_policy,
                partial_suffixes: policy.download_policy.partial_suffixes.filter(Boolean),
              },
            },
          ),
        }),
      );
      setMessage('自动导入设置已保存。');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '设置保存失败');
    } finally {
      setBusy(false);
    }
  }
  async function migrate(retry = false) {
    setBusy(true);
    setMessage('');
    try {
      setJob(
        await api<Migration>(retry ? `${endpoint}/${job?.id}/retry` : endpoint, {
          method: 'POST',
          ...(retry
            ? {}
            : { body: JSON.stringify({ version: library.version, managed_root: target.trim() }) }),
        }),
      );
      if (!retry) setTarget('');
      await onChanged();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '迁移提交失败');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="library-storage" aria-label={`${library.name}的存储设置`}>
      <h3>监听与自动导入</h3>
      {policy && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void configure();
          }}
        >
          <fieldset disabled={busy || moving}>
            <legend>自动导入策略</legend>
            <label className="music-library-grant-option">
              <input
                type="checkbox"
                checked={policy.enabled}
                onChange={(e) => setPolicy({ ...policy, enabled: e.target.checked })}
              />
              定期检查监听文件夹
            </label>
            <label htmlFor={`${id}-interval`}>检查间隔（秒）</label>
            <input
              id={`${id}-interval`}
              type="number"
              min={15}
              max={86400}
              value={policy.interval_seconds}
              onChange={(e) => setPolicy({ ...policy, interval_seconds: Number(e.target.value) })}
            />
            <label htmlFor={`${id}-stable`}>文件稳定等待（秒）</label>
            <input
              id={`${id}-stable`}
              type="number"
              min={5}
              max={86400}
              value={policy.stable_seconds}
              onChange={(e) => setPolicy({ ...policy, stable_seconds: Number(e.target.value) })}
            />
            <label className="music-library-grant-option">
              <input
                type="checkbox"
                checked={policy.download_policy.wait_for_album}
                onChange={(e) =>
                  setPolicy({
                    ...policy,
                    download_policy: {
                      ...policy.download_policy,
                      wait_for_album: e.target.checked,
                    },
                  })
                }
              />
              等待整张专辑下载完成
            </label>
            <label htmlFor={`${id}-partial`}>未完成下载的文件后缀（逗号分隔）</label>
            <input
              id={`${id}-partial`}
              value={policy.download_policy.partial_suffixes.join(', ')}
              onChange={(e) =>
                setPolicy({
                  ...policy,
                  download_policy: {
                    ...policy.download_policy,
                    partial_suffixes: e.target.value.split(',').map((value) => value.trim()),
                  },
                })
              }
            />
            <p className="muted">文件停止变化后才复制；暂停单个来源不会影响手动导入。</p>
            <button type="submit">保存自动导入策略</button>
          </fieldset>
        </form>
      )}
      <h3>托管目录</h3>
      <p className="storage-path">{library.managed_root}</p>
      <p className="muted">
        服务端路径；Docker
        使用已挂载且可写的容器内目录。迁移会复制全部文件、校验后切换，保留旧文件、曲目和歌单。迁移期间暂停库的管理操作。
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void migrate();
        }}
      >
        <label htmlFor={`${id}-target`}>新的托管目录</label>
        <input
          id={`${id}-target`}
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          required
          disabled={busy || moving}
          placeholder="填写一个独立的空目录"
        />
        <button type="button" disabled={busy || moving} onClick={() => setPicking(true)}>
          浏览迁移目标目录
        </button>
        <button type="submit" disabled={busy || moving || !target.trim()}>
          复制、校验并迁移
        </button>
      </form>
      {picking && (
        <FolderPicker
          title="选择迁移目标目录"
          onClose={() => setPicking(false)}
          onSelect={(path) => {
            setTarget(path);
            setPicking(false);
          }}
        />
      )}
      {job && (
        <div role="status" className="library-migration-status">
          <strong>{statusText[job.status] || job.status}</strong>
          <p className="storage-path">{job.target_root}</p>
          {moving && (
            <>
              <progress max={Math.max(job.total_bytes, 1)} value={job.copied_bytes} />
              <p>
                {job.copied_files} / {job.total_files} 个文件
              </p>
            </>
          )}
          {job.status === 'failed' && (
            <>
              <p>请检查目标目录、剩余空间和文件是否发生变化。已复制文件保留，可在修正后重试。</p>
              <button type="button" disabled={busy} onClick={() => void migrate(true)}>
                重试迁移
              </button>
            </>
          )}
        </div>
      )}
      {message && <p role="status">{message}</p>}
    </div>
  );
}
