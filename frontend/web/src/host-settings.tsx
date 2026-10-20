import { HelpLabel } from './desktop-help';
import { useEffect, useState, type FormEvent } from 'react';
import { api } from './api';
interface Settings {
  enabled: boolean;
  hosts: string[];
  version: number;
}
export function HostSettings() {
  const [record, setRecord] = useState<Settings | null>(null),
    [enabled, setEnabled] = useState(false),
    [text, setText] = useState('');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    api<Settings>('/manage/access', { signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted) {
          setRecord(result);
          setEnabled(result.enabled);
          setText(result.hosts.join('\n'));
        }
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setError(reason.message);
      });
    return () => controller.abort();
  }, []);
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!record) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await api<Settings>('/manage/access', {
        method: 'PUT',
        body: JSON.stringify({
          version: record.version,
          enabled,
          hosts: text
            .split('\n')
            .map((value) => value.trim())
            .filter(Boolean),
        }),
      });
      setRecord(result);
      setText(result.hosts.join('\n'));
      setNotice('域名白名单已保存并生效。');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '保存未完成，请重试。');
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      className="management-card account-form host-settings"
      onSubmit={save}
      aria-label="域名白名单设置"
    >
      <h2>域名白名单</h2>
      <p className="muted">默认不限制访问域名。启用后，只有列表中的域名或 IP 能访问网页和 API。</p>
      <p className="access-warning" role="note">
        <strong>配置错误可能导致无法访问。</strong>
        如果设置后无法打开网站，只能直接修改数据库关闭白名单。请包含所有客户端使用的访问域名或
        IP。当前访问地址：<code>{location.hostname}</code>。
      </p>
      <label className="check-label">
        <input
          type="checkbox"
          checked={enabled}
          disabled={!record || busy}
          onChange={(event) => {
            setEnabled(event.target.checked);
            setNotice('');
          }}
        />
        启用域名白名单
      </label>
      <label>
        <HelpLabel hint="hostAllowlist">允许访问的域名或 IP</HelpLabel>
        <textarea
          rows={5}
          placeholder={'music.example.com\n192.168.10.65'}
          value={text}
          disabled={!record || busy}
          onChange={(event) => {
            setText(event.target.value);
            setNotice('');
          }}
        />
      </label>
      <p className="muted">
        每行一个，填写主机名或 IP，不含协议、端口和路径，不支持通配符。反向代理须保留访问时的 Host。
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="ai-status" role="status">
          {notice}
        </p>
      )}
      <button className="primary" disabled={!record || busy}>
        {busy ? '保存中…' : '保存域名白名单'}
      </button>
    </form>
  );
}
