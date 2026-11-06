import { useEffect, useState, type FormEvent } from 'react';
import { api } from './api';
interface ServerSettingsRecord {
  instance_id: string;
  name: string;
  connection_policy: 'legacy' | 'mixed' | 'https_only';
  sources: Record<'name' | 'connection_policy', 'database' | 'environment' | 'default'>;
}
const sources = { database: '页面设置', environment: '环境配置', default: '程序默认' };
export function ServerSettings() {
  const [record, setRecord] = useState<ServerSettingsRecord | null>(null);
  const [name, setName] = useState('');
  const [policy, setPolicy] = useState<ServerSettingsRecord['connection_policy']>('legacy');
  const [nameEdited, setNameEdited] = useState(false);
  const [policyEdited, setPolicyEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  function receive(value: ServerSettingsRecord) {
    setRecord(value);
    setName(value.name);
    setPolicy(value.connection_policy);
    setNameEdited(false);
    setPolicyEdited(false);
  }
  useEffect(() => {
    const controller = new AbortController();
    api<ServerSettingsRecord>('/manage/server', { signal: controller.signal })
      .then((value) => {
        if (!controller.signal.aborted) receive(value);
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setError(reason.message);
      });
    return () => controller.abort();
  }, []);
  async function save(body: Record<string, string | null>) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      receive(
        await api<ServerSettingsRecord>('/manage/server', {
          method: 'PATCH',
          body: JSON.stringify(body),
        }),
      );
      setNotice('设置已保存。连接策略立即生效；受影响的 HTTP 会话需要重新登录。');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '保存失败，请重试。');
    } finally {
      setBusy(false);
    }
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    const body: Record<string, string> = {};
    if (nameEdited) body.name = name.trim();
    if (policy !== 'legacy' && policyEdited) body.connection_policy = policy;
    void save(body);
  }
  return (
    <form
      className="management-card account-form"
      aria-label="服务器名称与连接安全"
      onSubmit={submit}
    >
      <h2>服务器名称与连接安全</h2>
      <p className="muted">
        给音乐库所在的服务器起一个名字。页面保存的设置优先于环境配置，重启后仍然保留。
      </p>
      <label>
        服务器名称
        <input
          required
          maxLength={80}
          value={name}
          disabled={!record || busy}
          onChange={(e) => {
            setName(e.target.value);
            setNameEdited(true);
          }}
        />
      </label>
      {record && (
        <div className="workspace-actions">
          <small>来源：{sources[record.sources.name]}</small>
          <button
            type="button"
            disabled={busy || record.sources.name !== 'database'}
            onClick={() => void save({ name: null })}
          >
            名称恢复使用环境配置
          </button>
        </div>
      )}
      <label>
        连接策略
        <select
          value={policy}
          disabled={!record || busy}
          onChange={(e) => {
            setPolicy(e.target.value as ServerSettingsRecord['connection_policy']);
            setPolicyEdited(true);
          }}
        >
          {record?.connection_policy === 'legacy' && <option value="legacy">沿用升级前配置</option>}
          <option value="mixed">HTTP + HTTPS（内网 / SD-WAN 与公网）</option>
          <option value="https_only">仅 HTTPS</option>
        </select>
      </label>
      <p className="muted">
        混合模式按线路分别登录；HTTPS 自动使用 Secure Cookie。仅 HTTPS 会拒绝 HTTP 登录、API 与 MCP
        请求。可信反向代理由部署环境配置。
      </p>
      {policy === 'https_only' && location.protocol === 'http:' && (
        <p role="note" className="access-warning">
          你当前通过 HTTP 访问。保存后需要改用已部署的 HTTPS 地址重新连接。
        </p>
      )}
      {record && (
        <div className="workspace-actions">
          <small>来源：{sources[record.sources.connection_policy]}</small>
          <button
            type="button"
            disabled={busy || record.sources.connection_policy !== 'database'}
            onClick={() => void save({ connection_policy: null })}
          >
            策略恢复使用环境配置
          </button>
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      <button className="primary" disabled={!record || busy}>
        {busy ? '保存中…' : '保存服务器设置'}
      </button>
    </form>
  );
}
