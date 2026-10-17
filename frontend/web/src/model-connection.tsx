import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from './api';
import type { AgentConnection, AgentPage } from './agent-api';
import { errorText } from './workspace-ui';

export function useModelConnections() {
  const [items, setItems] = useState<AgentConnection[]>([]),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [unsupported, setUnsupported] = useState(false),
    [revision, setRevision] = useState(0);
  const epoch = useRef(0);
  const reload = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    const controller = new AbortController(),
      sequence = ++epoch.current;
    setLoading(true);
    setError('');
    void (async () => {
      const values: AgentConnection[] = [];
      let offset = 0;
      while (!controller.signal.aborted) {
        const page = await api<AgentPage<AgentConnection>>(
          `/agent/connections?limit=100&offset=${offset}`,
          { signal: controller.signal },
        );
        values.push(...page.items);
        offset += page.items.length;
        if (offset >= page.total) break;
        if (!page.items.length || offset >= 10000)
          throw new Error('连接列表读取不完整，请稍后刷新。');
      }
      if (!controller.signal.aborted && sequence === epoch.current) {
        setItems(values);
        setUnsupported(false);
      }
    })()
      .catch((reason) => {
        if (controller.signal.aborted || sequence !== epoch.current) return;
        if (reason instanceof ApiError && [404, 405, 501].includes(reason.status)) {
          setUnsupported(true);
          setItems([]);
        } else setError(errorText(reason));
      })
      .finally(() => {
        if (!controller.signal.aborted && sequence === epoch.current) setLoading(false);
      });
    return () => {
      controller.abort();
      ++epoch.current;
    };
  }, [revision]);
  return { items, loading, error, unsupported, reload };
}
export function connectionLabel(item: AgentConnection) {
  return `${item.name} · ${item.id === 'legacy' ? '兼容实例' : item.scope === 'personal' ? '个人' : item.shared ? '共享实例' : '实例'} · ${item.model}`;
}
export function ModelConnectionChoice({
  items,
  value,
  onChange,
  label = 'AI 连接',
  disabled = false,
  onManage,
}: {
  items: AgentConnection[];
  value: string;
  onChange: (value: string) => void;
  label?: string;
  disabled?: boolean;
  onManage?: () => void;
}) {
  const selected = items.find((item) => item.id === value);
  return (
    <div className="model-connection-choice">
      <div className="model-connection-label">
        <label>
          {label}
          <select
            aria-label={label}
            value={value}
            disabled={disabled}
            onChange={(event) => onChange(event.target.value)}
          >
            <option value="local">本地模式 · 不使用模型</option>
            {items
              .filter((item) => item.enabled || item.id === value)
              .map((item) => (
                <option key={item.id} value={item.id} disabled={!item.enabled}>
                  {connectionLabel(item)}
                  {item.enabled ? '' : '（已关闭）'}
                </option>
              ))}
            {value !== 'local' && !selected && (
              <option value={value} disabled>
                之前的连接已不可用
              </option>
            )}
          </select>
        </label>
        {onManage && (
          <button type="button" className="text-button" onClick={onManage}>
            管理模型连接 ↗
          </button>
        )}
      </div>
      <p className="muted model-budget">
        {value === 'local'
          ? '不向模型发送曲库资料，也不消耗模型额度。'
          : selected
            ? `助手、找歌和推荐共用这条连接，每日上限 ${selected.daily_call_budget ?? '未提供'} 次${selected.daily_calls_remaining != null ? `，今日剩余 ${selected.daily_calls_remaining} 次` : ''}${selected.my_usage?.calls != null ? `；我已用 ${selected.my_usage.calls} 次` : ''}。`
            : '请选择一条有权使用的连接；不会自动切换到其他付费服务。'}
      </p>
    </div>
  );
}
