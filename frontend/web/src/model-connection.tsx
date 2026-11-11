import { HelpLabel } from './desktop-help';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from './api';
import type { AgentConnection, AgentPage } from './agent-api';
import { errorText } from './workspace-ui';
import i18n from './i18n';

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
          throw new Error(i18n.t('modelConnection.loadError'));
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
export function connectionLabel(item: AgentConnection, t: TFunction) {
  const scope =
    item.scope === 'personal'
      ? t('modelConnection.personal')
      : item.shared
        ? t('modelConnection.shared')
        : t('modelConnection.instance');
  return `${item.name} · ${scope} · ${item.model}`;
}
export function ModelConnectionChoice({
  items,
  value,
  onChange,
  label,
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
  const { t } = useTranslation();
  const text = label || t('modelConnection.defaultLabel');
  const selected = items.find((item) => item.id === value);
  return (
    <div className="model-connection-choice">
      <div className="model-connection-label">
        <label>
          <HelpLabel text={t('modelConnection.help')}>{text}</HelpLabel>
          <select
            aria-label={text}
            value={value}
            disabled={disabled}
            onChange={(event) => onChange(event.target.value)}
          >
            <option value="local">{t('modelConnection.local')}</option>
            {items
              .filter((item) => item.enabled || item.id === value)
              .map((item) => (
                <option key={item.id} value={item.id} disabled={!item.enabled}>
                  {connectionLabel(item, t)}
                  {item.enabled ? '' : t('modelConnection.disabled')}
                </option>
              ))}
            {value !== 'local' && !selected && (
              <option value={value} disabled>
                {t('modelConnection.unavailable')}
              </option>
            )}
          </select>
        </label>
        {onManage && (
          <button type="button" className="text-button" onClick={onManage}>
            {t('modelConnection.manage')}
          </button>
        )}
      </div>
      <p className="muted model-budget">
        {value === 'local'
          ? t('modelConnection.localHint')
          : selected
            ? [
                t('modelConnection.budget', {
                  budget: selected.daily_call_budget ?? t('modelConnection.notProvided'),
                }),
                selected.daily_calls_remaining != null
                  ? t('modelConnection.remaining', { count: selected.daily_calls_remaining })
                  : '',
                selected.my_usage?.calls != null
                  ? t('modelConnection.used', { count: selected.my_usage.calls })
                  : '',
              ]
                .filter(Boolean)
                .join(' ')
            : t('modelConnection.selectHint')}
      </p>
    </div>
  );
}
