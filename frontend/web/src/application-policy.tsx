import { HelpLabel } from './desktop-help';
import { useEffect, useState } from 'react';
import { api } from './api';
import { errorText, useWorkspaceResource, WorkspaceNotice } from './workspace-ui';

type Policy = {
  mode: 'manual' | 'automatic';
  kinds: string[];
  version: number;
  allowed_kinds: string[];
};
const labels: Record<string, string> = {
  playlist: '我的歌单',
  metadata: '单曲信息',
  metadata_batch: '专辑批量信息',
  cover: '封面',
  lyrics: '歌词',
  intake: '导入整理',
};

export function ApplicationPolicySettings() {
  const resource = useWorkspaceResource<Policy>('/agent/application-policy');
  const [form, setForm] = useState<Policy | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  useEffect(() => {
    if (resource.value) setForm(resource.value);
  }, [resource.value]);
  async function save() {
    if (!form || busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const { mode, kinds, version } = form;
      const saved = await api<Policy>('/agent/application-policy', {
        method: 'PUT',
        body: JSON.stringify({ mode, kinds, version }),
      });
      setForm(saved);
      setNotice('整理方式已保存。已有待确认草案保持原状。');
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="workspace-card application-policy" aria-label="自动整理设置">
      <h2>整理方式</h2>
      <p className="muted">
        按账号保存，助手、后台巡检和 MCP 共用。MCP 凭据还需授予“应用草案”权限。
      </p>
      <WorkspaceNotice error={error || resource.error} notice={notice} />
      {form ? (
        <>
          <label>
            <HelpLabel hint="application">应用方式</HelpLabel>
            <select
              aria-label="应用方式"
              value={form.mode}
              disabled={busy}
              onChange={(e) => setForm({ ...form, mode: e.target.value as Policy['mode'] })}
            >
              <option value="manual">审核后应用</option>
              <option value="automatic">自动整理</option>
            </select>
          </label>
          <p>
            {form.mode === 'manual'
              ? '先生成草案；查看差异后，点击“接受并应用”即可完成。'
              : '新草案中，勾选的类型会直接应用并记录结果。未勾选的类型继续等待审核。'}
          </p>
          <fieldset disabled={busy || form.mode !== 'automatic'}>
            <legend>允许自动应用的类型</legend>
            {form.allowed_kinds.map((kind) => (
              <label className="workspace-check" key={kind}>
                <input
                  type="checkbox"
                  checked={form.kinds.includes(kind)}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      kinds: e.target.checked
                        ? [...form.kinds, kind]
                        : form.kinds.filter((k) => k !== kind),
                    })
                  }
                />
                {labels[kind] || kind}
              </label>
            ))}
          </fieldset>
          <p className="muted">
            保留修改前后的记录，仍检查数据版本与权限。资料保存在应用内；导入仅复制，不改动导入源。
          </p>
          <button
            className="primary"
            disabled={busy || (form.mode === 'automatic' && !form.kinds.length)}
            onClick={() => void save()}
          >
            {busy ? '保存中…' : '保存整理方式'}
          </button>
          <button disabled={busy} onClick={() => void resource.reload()}>
            重新读取整理方式
          </button>
        </>
      ) : (
        <button disabled={resource.loading} onClick={() => void resource.reload()}>
          重新读取整理方式
        </button>
      )}
    </section>
  );
}
