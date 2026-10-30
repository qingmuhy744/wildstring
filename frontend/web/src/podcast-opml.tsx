import { useEffect, useMemo, useRef, useState } from 'react';
import { api, errorCodeMessage } from './api';
import { DialogCloseButton } from './dialog-close';
import './podcast-search.css';

export interface OpmlFeed {
  title: string;
  feed_url: string;
  html_url: string;
  in_catalog: boolean;
  followed: boolean;
  catalog_podcast_id: string | null;
}

interface OpmlParseResponse {
  feeds: OpmlFeed[];
  invalid: number;
  duplicates: number;
}

export interface OpmlImportResult {
  feed_url: string;
  status: 'added' | 'followed' | 'already_followed' | 'failed';
  podcast_id?: string;
  title?: string;
  code?: string;
}

const BATCH = 10;
const MAX_FILE_BYTES = 1_000_000;
export const OPML_EXPORT_URL = '/api/v1/podcasts/opml/export';

const statusLabel: Record<OpmlImportResult['status'], string> = {
  added: '已添加并关注',
  followed: '已关注',
  already_followed: '原本已关注',
  failed: '失败',
};

export function PodcastOpmlImportDialog({
  onClose,
  onImported,
}: {
  onClose: () => void;
  onImported: () => void;
}) {
  const [parsing, setParsing] = useState(false);
  const [error, setError] = useState('');
  const [parsed, setParsed] = useState<OpmlParseResponse | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState(false);
  const [done, setDone] = useState(0);
  const [results, setResults] = useState<OpmlImportResult[] | null>(null);
  const cancelled = useRef(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !importing) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [importing, onClose]);
  useEffect(
    () => () => {
      cancelled.current = true;
    },
    [],
  );

  const readFile = async (file: File | undefined) => {
    if (!file) return;
    setError('');
    setParsed(null);
    setResults(null);
    if (file.size > MAX_FILE_BYTES) {
      setError(errorCodeMessage('podcast_opml_too_large'));
      return;
    }
    setParsing(true);
    try {
      const content = await file.text();
      const body = await api<OpmlParseResponse>('/podcasts/opml/parse', {
        method: 'POST',
        body: JSON.stringify({ content }),
      });
      setParsed(body);
      setSelected(new Set(body.feeds.filter((feed) => !feed.followed).map((f) => f.feed_url)));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setParsing(false);
    }
  };

  const chosen = useMemo(
    () => (parsed ? parsed.feeds.filter((feed) => selected.has(feed.feed_url)) : []),
    [parsed, selected],
  );

  const toggle = (url: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(url)) next.delete(url);
      else next.add(url);
      return next;
    });

  const runImport = async () => {
    setImporting(true);
    setError('');
    setDone(0);
    const collected: OpmlImportResult[] = [];
    try {
      for (let start = 0; start < chosen.length && !cancelled.current; start += BATCH) {
        const batch = chosen.slice(start, start + BATCH);
        try {
          const body = await api<{ results: OpmlImportResult[] }>('/podcasts/opml/import', {
            method: 'POST',
            body: JSON.stringify({ feeds: batch.map((feed) => ({ feed_url: feed.feed_url })) }),
            timeoutMs: 180000,
          });
          collected.push(...body.results);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          collected.push(
            ...batch.map((feed) => ({
              feed_url: feed.feed_url,
              status: 'failed' as const,
              code: message,
            })),
          );
        }
        setDone(Math.min(start + BATCH, chosen.length));
        setResults([...collected]);
      }
    } finally {
      setImporting(false);
      if (collected.some((item) => item.status !== 'failed')) onImported();
    }
  };

  const titleOf = (url: string) =>
    parsed?.feeds.find((feed) => feed.feed_url === url)?.title || url;
  const failed = results?.filter((item) => item.status === 'failed').length ?? 0;

  return (
    <div className="podcasts-modal-backdrop" onClick={importing ? undefined : onClose}>
      <div
        className="podcasts-modal podcast-search-modal podcast-opml-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="podcast-opml-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="podcasts-modal-header">
          <h3 id="podcast-opml-title">导入 OPML</h3>
          <DialogCloseButton
            className="modal-close-btn"
            aria-label="关闭 OPML 导入"
            disabled={importing}
            onClick={onClose}
          />
        </div>
        <p className="podcast-search-hint">
          从其他播客应用导出的 OPML 文件中挑选节目。每个节目都按本服的添加权限和网络策略处理。
        </p>
        <label className="podcast-opml-file">
          <span>选择 OPML 文件</span>
          <input
            type="file"
            accept=".opml,.xml,text/x-opml,text/xml,application/xml"
            disabled={parsing || importing}
            onChange={(event) => void readFile(event.target.files?.[0])}
          />
        </label>
        {parsing && <div className="podcast-search-status">正在读取文件…</div>}
        {error && (
          <div className="modal-error-message" role="alert">
            {error}
          </div>
        )}
        {parsed && !results && (
          <section className="podcast-opml-preview" aria-label="OPML 节目列表">
            <div className="podcast-opml-summary" role="status">
              共 {parsed.feeds.length} 个节目
              {parsed.duplicates ? `，已合并 ${parsed.duplicates} 个重复项` : ''}
              {parsed.invalid ? `，忽略 ${parsed.invalid} 个无效地址` : ''}
            </div>
            <div className="podcast-opml-bulk">
              <button
                type="button"
                className="podcasts-action-btn"
                onClick={() =>
                  setSelected(
                    new Set(parsed.feeds.filter((f) => !f.followed).map((f) => f.feed_url)),
                  )
                }
              >
                全选未关注
              </button>
              <button
                type="button"
                className="podcasts-action-btn"
                onClick={() => setSelected(new Set())}
              >
                全不选
              </button>
            </div>
            <ul className="podcast-search-list podcast-opml-list">
              {parsed.feeds.map((feed) => (
                <li key={feed.feed_url}>
                  <label className="podcast-opml-row">
                    <input
                      type="checkbox"
                      checked={selected.has(feed.feed_url)}
                      disabled={feed.followed}
                      onChange={() => toggle(feed.feed_url)}
                    />
                    <span className="podcast-search-card-text">
                      <span className="podcast-search-card-title">{feed.title}</span>
                      <span className="podcast-search-card-meta">{feed.feed_url}</span>
                    </span>
                    {feed.followed ? (
                      <span className="podcast-search-state followed">已关注</span>
                    ) : feed.in_catalog ? (
                      <span className="podcast-search-state">本服已有</span>
                    ) : null}
                  </label>
                </li>
              ))}
            </ul>
          </section>
        )}
        {results && (
          <section className="podcast-opml-preview" aria-label="导入结果">
            <div className="podcast-opml-summary" role="status">
              {importing
                ? `正在导入… ${done} / ${chosen.length}`
                : `导入完成：成功 ${results.length - failed} 个，失败 ${failed} 个`}
            </div>
            <progress max={chosen.length || 1} value={done} aria-label="导入进度" />
            <ul className="podcast-search-list podcast-opml-list">
              {results.map((item) => (
                <li key={item.feed_url} className={`podcast-opml-result ${item.status}`}>
                  <span className="podcast-search-card-text">
                    <span className="podcast-search-card-title">
                      {item.title || titleOf(item.feed_url)}
                    </span>
                    <span className="podcast-search-card-meta">
                      {statusLabel[item.status]}
                      {item.status === 'failed' && item.code
                        ? `：${errorCodeMessage(item.code)}`
                        : ''}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}
        <div className="modal-actions">
          {results && !importing ? (
            <button type="button" className="modal-submit-btn primary" onClick={onClose}>
              完成
            </button>
          ) : (
            <button
              type="button"
              className="modal-submit-btn primary"
              disabled={!parsed || importing || chosen.length === 0}
              onClick={() => void runImport()}
            >
              {importing ? '正在导入…' : `导入所选（${chosen.length}）`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
