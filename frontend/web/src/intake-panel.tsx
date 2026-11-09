import { HelpLabel } from './desktop-help';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from './api';

type Preferences = {
  enabled: boolean;
  interval_seconds: number;
  stable_seconds: number;
  version: number;
  download_policy?: { wait_for_album: boolean; partial_suffixes: string[] };
};
type Metadata = {
  title?: string;
  artists?: string[];
  album?: string | null;
  album_artists?: string[];
  track_number?: number | null;
  disc_number?: number | null;
};
type Item = {
  id: string;
  source_path: string;
  state: string;
  metadata: Metadata;
  overrides: Metadata;
  issues: string[];
  version: number;
  can_approve: boolean;
};
type Items = { items: Item[]; total: number; limit: number; offset: number };

export function IntakePanel() {
  const { t } = useTranslation();
  const [preferences, setPreferences] = useState<Preferences | null>(null);
  const [suffixText, setSuffixText] = useState('');
  const [items, setItems] = useState<Items | null>(null);
  const [offset, setOffset] = useState(0),
    [tick, setTick] = useState(0);
  const [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<Item | null>(null),
    [fields, setFields] = useState<string[]>([]);

  function getLabel(code: string) {
    return t(`intakePanel.label_${code}`, { defaultValue: code });
  }

  useEffect(() => {
    const controller = new AbortController();
    api<Preferences>('/manage/intake/settings', { signal: controller.signal })
      .then((value) => {
        setPreferences(value);
        setSuffixText(value.download_policy?.partial_suffixes.join(', ') || '');
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setError(reason.message);
      });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    let reading = false;
    async function refresh() {
      if (reading) return;
      reading = true;
      try {
        const value = await api<Items>(`/manage/intake/items?limit=20&offset=${offset}`, {
          signal: controller.signal,
        });
        if (!controller.signal.aborted) setItems(value);
      } catch (reason) {
        if (!controller.signal.aborted) setError((reason as Error).message);
      } finally {
        reading = false;
      }
    }
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [offset, tick]);
  function edit(item: Item) {
    const data = { ...item.metadata, ...item.overrides };
    setEditing(item);
    setFields([
      data.title || '',
      (data.artists || []).join('\n'),
      data.album || '',
      (data.album_artists || []).join('\n'),
      String(data.track_number || ''),
      String(data.disc_number || ''),
    ]);
    setError('');
  }
  async function act(item: Item, action: 'approve' | 'ignore' | 'retry') {
    setBusy(true);
    setError('');
    setNotice('');
    const lines = (s: string) =>
      s
        .split('\n')
        .map((v) => v.trim())
        .filter(Boolean);
    const body =
      action === 'approve'
        ? {
            version: item.version,
            overrides: {
              title: fields[0].trim(),
              artists: lines(fields[1]),
              album: fields[2].trim() || null,
              album_artists: lines(fields[3]),
              track_number: fields[4] ? Number(fields[4]) : null,
              disc_number: fields[5] ? Number(fields[5]) : null,
            },
          }
        : { version: item.version };
    try {
      await api(`/manage/intake/items/${item.id}/${action}`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      setEditing(null);
      setTick((value) => value + 1);
      setNotice(
        action === 'approve'
          ? t('intakePanel.noticeApprove')
          : action === 'ignore'
            ? t('intakePanel.noticeIgnore')
            : t('intakePanel.noticeRetry'),
      );
    } catch (reason) {
      setError(t('intakePanel.errorActionWithHint', { message: (reason as Error).message }));
    } finally {
      setBusy(false);
    }
  }

  const fieldLabels = [
    t('intakePanel.fieldTitle'),
    t('intakePanel.fieldArtists'),
    t('intakePanel.fieldAlbum'),
    t('intakePanel.fieldAlbumArtists'),
    t('intakePanel.fieldTrackNumber'),
    t('intakePanel.fieldDiscNumber'),
  ];

  return (
    <>
      <section className="management-card">
        <span className="eyebrow">{t('intakePanel.eyebrow')}</span>
        <h2>{t('intakePanel.title')}</h2>
        <p className="muted">{t('intakePanel.description')}</p>
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            if (!preferences) return;
            setBusy(true);
            setError('');
            setNotice('');
            try {
              setPreferences(
                await api<Preferences>('/manage/intake/settings', {
                  method: 'PUT',
                  body: JSON.stringify({
                    ...preferences,
                    ...(preferences.download_policy
                      ? {
                          download_policy: {
                            ...preferences.download_policy,
                            partial_suffixes: suffixText.split(/[,\s]+/).filter(Boolean),
                          },
                        }
                      : {}),
                  }),
                }),
              );
              setNotice(t('intakePanel.savedNotice'));
            } catch (reason) {
              setError((reason as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <fieldset disabled={!preferences || busy} className="intake-settings">
            <label className="management-checkbox">
              <input
                type="checkbox"
                checked={preferences?.enabled || false}
                onChange={(event) =>
                  setPreferences((value) => value && { ...value, enabled: event.target.checked })
                }
              />
              {t('intakePanel.enableAutoImport')}
            </label>
            <label>
              <HelpLabel hint="importInterval">{t('intakePanel.intervalSeconds')}</HelpLabel>
              <input
                type="number"
                min="15"
                max="86400"
                required
                value={preferences?.interval_seconds ?? 60}
                onChange={(event) =>
                  setPreferences(
                    (value) => value && { ...value, interval_seconds: Number(event.target.value) },
                  )
                }
              />
            </label>
            <label>
              <HelpLabel hint="importStable">{t('intakePanel.stableSeconds')}</HelpLabel>
              <input
                type="number"
                min="5"
                max="86400"
                required
                value={preferences?.stable_seconds ?? 120}
                onChange={(event) =>
                  setPreferences(
                    (value) => value && { ...value, stable_seconds: Number(event.target.value) },
                  )
                }
              />
            </label>
            {preferences?.download_policy && (
              <>
                <label className="management-checkbox">
                  <input
                    type="checkbox"
                    checked={preferences.download_policy.wait_for_album}
                    onChange={(event) =>
                      setPreferences((value) =>
                        value?.download_policy
                          ? {
                              ...value,
                              download_policy: {
                                ...value.download_policy,
                                wait_for_album: event.target.checked,
                              },
                            }
                          : value,
                      )
                    }
                  />
                  {t('intakePanel.waitForAlbum')}
                </label>
                <label>
                  <HelpLabel hint="downloadSuffix">{t('intakePanel.downloadSuffixes')}</HelpLabel>
                  <input
                    required
                    value={suffixText}
                    maxLength={300}
                    onChange={(event) => setSuffixText(event.target.value)}
                  />
                </label>
                <p className="muted">{t('intakePanel.downloadNotice')}</p>
              </>
            )}
            <button className="primary">{t('intakePanel.saveSettings')}</button>
          </fieldset>
        </form>
      </section>
      <section className="management-card" aria-label={t('intakePanel.reviewSectionAria')}>
        <div className="management-section-heading">
          <div>
            <h2>
              {t('intakePanel.reviewTitle')} <small>{items?.total ?? '…'}</small>
            </h2>
            <p className="muted">{t('intakePanel.reviewDescription')}</p>
          </div>
          <button disabled={busy} onClick={() => setTick((value) => value + 1)}>
            {t('intakePanel.refreshReview')}
          </button>
        </div>
        {notice && <p role="status">{notice}</p>}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {items?.items.length === 0 && <p className="muted">{t('intakePanel.emptyList')}</p>}
        <ul className="intake-list">
          {items?.items.map((item) => (
            <li key={item.id}>
              <div>
                <strong>{getLabel(item.state)}</strong>
                <code>{item.source_path}</code>
                <p className="muted">{item.issues.map((code) => getLabel(code)).join(' · ')}</p>
              </div>
              {editing?.id === item.id ? (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    void act(editing, 'approve');
                  }}
                  className="intake-edit"
                  aria-label={t('intakePanel.editFormAria')}
                >
                  <p className="muted">{t('intakePanel.editFormHint')}</p>
                  {fieldLabels.map((label, i) => (
                    <label key={label}>
                      {label}
                      {i === 1 || i === 3 ? (
                        <textarea
                          rows={2}
                          value={fields[i]}
                          onChange={(event) =>
                            setFields((value) =>
                              value.map((field, n) => (n === i ? event.target.value : field)),
                            )
                          }
                        />
                      ) : (
                        <input
                          type={i >= 4 ? 'number' : 'text'}
                          min={i >= 4 ? 1 : undefined}
                          max={i >= 4 ? 99999 : undefined}
                          required={i === 0 || i === 2}
                          maxLength={i < 4 ? 1000 : undefined}
                          value={fields[i]}
                          onChange={(event) =>
                            setFields((value) =>
                              value.map((field, n) => (n === i ? event.target.value : field)),
                            )
                          }
                        />
                      )}
                    </label>
                  ))}
                  <div className="intake-buttons">
                    <button className="primary" disabled={busy}>
                      {t('intakePanel.confirmAndImport')}
                    </button>
                    <button type="button" disabled={busy} onClick={() => setEditing(null)}>
                      {t('intakePanel.cancelEdit')}
                    </button>
                  </div>
                </form>
              ) : (
                <div className="intake-buttons">
                  {item.can_approve && (
                    <button disabled={busy} onClick={() => edit(item)}>
                      {t('intakePanel.supplementInfo')}
                    </button>
                  )}
                  {item.state === 'failed' && (
                    <button disabled={busy} onClick={() => void act(item, 'retry')}>
                      {t('intakePanel.recheck')}
                    </button>
                  )}
                  {['review', 'waiting', 'failed', 'conflict'].includes(item.state) && (
                    <button disabled={busy} onClick={() => void act(item, 'ignore')}>
                      {t('intakePanel.ignoreItem')}
                    </button>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
        {items && items.total > items.limit && (
          <div className="intake-buttons">
            <button
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - items.limit))}
            >
              {t('intakePanel.prevPage')}
            </button>
            <span>
              {Math.floor(offset / items.limit) + 1} / {Math.ceil(items.total / items.limit)}
            </span>
            <button
              disabled={offset + items.limit >= items.total}
              onClick={() => setOffset(offset + items.limit)}
            >
              {t('intakePanel.nextPage')}
            </button>
          </div>
        )}
      </section>
    </>
  );
}
