import { useState } from 'react';
import { mcpClients, mcpSetup, type McpClient } from './mcp-setup';

export function McpOnboarding() {
  const [client, setClient] = useState<McpClient>('codex');
  const [name, setName] = useState('wildstring');
  const [url, setUrl] = useState(() => new URL('mcp', document.baseURI).href);
  const [allowHttp, setAllowHttp] = useState(false);
  const [notice, setNotice] = useState('');
  let setup: ReturnType<typeof mcpSetup> | undefined;
  let error = '';
  try {
    setup = mcpSetup(client, name, url, allowHttp);
  } catch (reason) {
    error = reason instanceof Error ? reason.message : '请检查连接配置。';
  }
  async function copy(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value);
      setNotice(`${label}已复制，不含真实令牌。`);
    } catch {
      setNotice('无法写入剪贴板，请展开下方内容手动复制。');
    }
  }
  return (
    <section className="mcp-onboarding" aria-label="外部 AI 接入配置">
      <h3>连接你的 AI 工具</h3>
      <p className="muted">
        先在下方生成独立凭据，再把接入提示词交给 AI 工具。令牌单独复制，避免留在聊天记录中。
      </p>
      <div className="workspace-form">
        <label>
          AI 客户端
          <select
            aria-label="AI 客户端"
            value={client}
            onChange={(e) => {
              setClient(e.target.value as McpClient);
              setNotice('');
            }}
          >
            {Object.entries(mcpClients).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          连接名称
          <input
            value={name}
            maxLength={64}
            onChange={(e) => {
              setName(e.target.value);
              setNotice('');
            }}
          />
        </label>
        <label className="span-all">
          MCP 地址
          <input
            type="url"
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              setAllowHttp(false);
              setNotice('');
            }}
          />
        </label>
      </div>
      <p className="muted">
        填写外部客户端能访问的完整地址；它可能与浏览器当前地址不同。每个连接使用一条线路。
      </p>
      {url.trim().toLowerCase().startsWith('http:') && (
        <label className="workspace-check">
          <input
            type="checkbox"
            checked={allowHttp}
            onChange={(e) => setAllowHttp(e.target.checked)}
          />
          允许这条 HTTP 线路（HTTP 本身不加密；请自行确认内网或 SD-WAN 的保护）
        </label>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {setup && (
        <>
          <p className="muted">{setup.instructions}</p>
          <div className="workspace-actions">
            <button type="button" onClick={() => void copy(setup!.prompt, 'AI 接入提示词')}>
              复制 AI 接入提示词
            </button>
            {setup.config && (
              <button type="button" onClick={() => void copy(setup!.config, '配置片段')}>
                复制配置
              </button>
            )}
          </div>
          <details>
            <summary>查看配置与提示词</summary>
            {setup.config && (
              <label>
                配置片段
                <textarea aria-label="配置片段" readOnly rows={9} value={setup.config} />
              </label>
            )}
            <label>
              AI 接入提示词
              <textarea aria-label="AI 接入提示词" readOnly rows={12} value={setup.prompt} />
            </label>
          </details>
        </>
      )}
      {notice && <p role="status">{notice}</p>}
      <p className="muted">接入是否成功，以外部客户端完成初始化和只读查询为准。</p>
    </section>
  );
}
