import { useEffect, useState } from 'react';
import { api } from './api';
interface AIConfig {
  version: number;
  base_url: string;
  model: string;
  timeout: number;
  has_api_key: boolean;
  configured: boolean;
}
export function AISettings() {
  const [config, setConfig] = useState<AIConfig | null>(null),
    [url, setUrl] = useState(''),
    [model, setModel] = useState(''),
    [key, setKey] = useState(''),
    [timeout, setTimeoutValue] = useState(30),
    [clearKey, setClearKey] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  function apply(value: AIConfig) {
    setConfig(value);
    setUrl(value.base_url);
    setModel(value.model);
    setTimeoutValue(value.timeout);
    setKey('');
    setClearKey(false);
  }
  useEffect(() => {
    const controller = new AbortController();
    api<AIConfig>('/manage/ai', { signal: controller.signal })
      .then(apply)
      .catch((reason) => {
        if (!controller.signal.aborted) setError(reason.message);
      });
    return () => controller.abort();
  }, []);
  const dirty =
    !!config &&
    (url !== config.base_url ||
      model !== config.model ||
      timeout !== config.timeout ||
      !!key ||
      clearKey);
  async function save() {
    if (!config) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      apply(
        await api<AIConfig>('/manage/ai', {
          method: 'PUT',
          body: JSON.stringify({
            version: config.version,
            base_url: url,
            model,
            timeout,
            api_key: key || null,
            clear_api_key: clearKey,
          }),
        }),
      );
      setNotice('AI 服务配置已保存');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '配置保存失败。');
    } finally {
      setBusy(false);
    }
  }
  async function probe() {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await api('/manage/ai/test', { method: 'POST' });
      setNotice('模型响应正常。此测试尚未验证工具调用能力。');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '连接测试失败。');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="management-card ai-settings" aria-label="AI 服务配置">
      <div className="management-section-heading">
        <div>
          <h2>原有实例连接</h2>
          <p className="muted">
            接入兼容 Chat Completions 的 API。密钥仅保存在服务端，保存后可测试模型连接。
          </p>
        </div>
        <span className="job-status">{config?.configured ? '已配置' : '未配置'}</span>
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <fieldset disabled={!config || busy}>
          <div className="metadata-fields">
            <label className="metadata-field">
              API 地址
              <input
                required
                type="url"
                aria-label="AI API 地址"
                placeholder="https://your-api.example/v1"
                maxLength={2048}
                value={url}
                onChange={(e) => {
                  setUrl(e.target.value);
                  setNotice('');
                }}
              />
            </label>
            <label className="metadata-field">
              模型名称
              <input
                required
                aria-label="AI 模型名称"
                placeholder="填写服务支持的模型 ID"
                maxLength={200}
                value={model}
                onChange={(e) => {
                  setModel(e.target.value);
                  setNotice('');
                }}
              />
            </label>
            <div className="metadata-field">
              <label htmlFor="ai-api-key">API Key</label>
              <input
                id="ai-api-key"
                type="password"
                aria-label="AI API Key"
                autoComplete="new-password"
                maxLength={4096}
                placeholder={
                  config?.has_api_key ? '已保存；留空保留原密钥' : '本地无鉴权模型可留空'
                }
                disabled={clearKey}
                value={key}
                onChange={(e) => {
                  setKey(e.target.value);
                  setNotice('');
                }}
              />
              {config?.has_api_key && (
                <label className="management-checkbox">
                  <input
                    type="checkbox"
                    checked={clearKey}
                    onChange={(e) => setClearKey(e.target.checked)}
                  />
                  清除已保存的密钥
                </label>
              )}
            </div>
            <label className="metadata-field">
              请求超时（秒）
              <input
                aria-label="AI 请求超时"
                type="number"
                min={1}
                max={120}
                required
                value={timeout}
                onChange={(e) => setTimeoutValue(Number(e.target.value))}
              />
            </label>
          </div>
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          {notice && (
            <p role="status" className="ai-status">
              {notice}
            </p>
          )}
          <div className="ai-settings-actions">
            <button className="primary" disabled={busy || !config || !dirty}>
              {busy ? '处理中…' : '保存 AI 配置'}
            </button>
            <button
              type="button"
              disabled={busy || !config?.configured || dirty}
              onClick={() => void probe()}
            >
              测试模型连接
            </button>
            <span className="muted">测试会发送简短请求，消耗少量 token。</span>
          </div>
        </fieldset>
      </form>
      <p className="muted">
        本配置以 legacy 连接出现在统一列表中；保存不会自动用于找歌或推荐，请在对应功能中明确选择。
      </p>
    </section>
  );
}
