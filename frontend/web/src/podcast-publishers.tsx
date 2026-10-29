import { useEffect, useId, useRef, useState } from 'react';
import { api, ApiError } from './api';
import { DialogCloseButton } from './dialog-close';
import type { PodcastDetail, PodcastSummary } from './podcasts';

export interface PodcastPublisher {
  id: string;
  name: string;
}

export interface PublisherSummary extends PodcastPublisher {
  podcast_count: number;
}

export interface PublisherDetail {
  publisher: PublisherSummary;
  podcasts: PodcastSummary[];
}

export function PublisherAffiliation({
  podcast,
  canEdit,
  onOpen,
  onSaved,
}: {
  podcast: PodcastSummary;
  canEdit: boolean;
  onOpen: (publisher: PodcastPublisher) => void;
  onSaved: (detail: PodcastDetail) => void;
}) {
  const [editing, setEditing] = useState(false);
  return (
    <>
      <div className="podcast-publisher-affiliation">
        <span>出品方：</span>
        {podcast.publisher ? (
          <button
            type="button"
            className="podcast-publisher-link"
            onClick={() => onOpen(podcast.publisher!)}
          >
            {podcast.publisher.name}
          </button>
        ) : (
          <span className="publisher-unconfirmed">未确认</span>
        )}
        {canEdit && (
          <button type="button" className="podcast-refresh-btn" onClick={() => setEditing(true)}>
            {podcast.publisher ? '修改出品方归属' : '确认出品方'}
          </button>
        )}
      </div>
      {editing && (
        <PublisherEditor
          key={podcast.id}
          podcast={podcast}
          onClose={() => setEditing(false)}
          onSaved={(detail) => {
            onSaved(detail);
            setEditing(false);
          }}
        />
      )}
    </>
  );
}

function PublisherEditor({
  podcast,
  onClose,
  onSaved,
}: {
  podcast: PodcastSummary;
  onClose: () => void;
  onSaved: (detail: PodcastDetail) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const choiceId = useId();
  const nameId = useId();
  const [current, setCurrent] = useState(podcast);
  const [publishers, setPublishers] = useState<PublisherSummary[]>([]);
  const [choice, setChoice] = useState(podcast.publisher?.id || 'new');
  const [name, setName] = useState(podcast.author || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  useEffect(() => {
    dialog.current?.showModal();
    let active = true;
    void api<PublisherSummary[]>('/podcasts/publishers')
      .then((items) => {
        if (active) setPublishers(items);
      })
      .catch(() => {
        if (active) setError('出品方列表暂时无法加载，仍可输入名称后重试。');
      });
    return () => {
      active = false;
    };
  }, []);

  async function reload() {
    setBusy(true);
    try {
      const fresh = await api<PodcastDetail>(`/podcasts/${encodeURIComponent(podcast.id)}`);
      setCurrent(fresh.podcast);
      setChoice(fresh.podcast.publisher?.id || 'new');
      setName(fresh.podcast.publisher?.name || fresh.podcast.author || '');
      setConflict(false);
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '资料加载失败');
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (busy || conflict) return;
    setBusy(true);
    setError('');
    const selection =
      choice === 'new'
        ? { name: name.trim() }
        : { publisher_id: choice === 'none' ? null : choice };
    try {
      const detail = await api<PodcastDetail>(
        `/podcasts/${encodeURIComponent(podcast.id)}/publisher`,
        {
          method: 'PUT',
          body: JSON.stringify({ version: current.publisher_version ?? 1, ...selection }),
        },
      );
      onSaved(detail);
    } catch (reason) {
      setConflict(reason instanceof ApiError && reason.status === 409);
      setError(reason instanceof Error ? reason.message : '保存失败，请重试。');
    } finally {
      setBusy(false);
    }
  }

  return (
    <dialog
      ref={dialog}
      className="podcasts-modal podcast-publisher-editor"
      aria-labelledby="publisher-editor-title"
      onCancel={(event) => {
        if (busy) event.preventDefault();
        else onClose();
      }}
    >
      <header className="podcasts-modal-header">
        <h3 id="publisher-editor-title">出品方归属</h3>
        <DialogCloseButton aria-label="关闭出品方归属" disabled={busy} onClick={onClose} />
      </header>
      <form
        className="podcast-publisher-form"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <p>{podcast.title}</p>
        <p className="publisher-help">
          来源作者：{podcast.author || '未提供'}。作者署名仅作参考，确认后才会加入同出品方聚合。
        </p>
        <p className="publisher-help">当前归属：{current.publisher?.name || '未确认'}</p>
        <div className="publisher-field">
          <label htmlFor={choiceId}>选择出品方</label>
          <select
            id={choiceId}
            value={choice}
            onChange={(event) => setChoice(event.target.value)}
            disabled={busy}
          >
            <option value="new">输入出品方名称</option>
            {current.publisher && !publishers.some((item) => item.id === current.publisher!.id) && (
              <option value={current.publisher.id}>{current.publisher.name}</option>
            )}
            {publishers.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name} · {item.podcast_count} 档节目
              </option>
            ))}
            <option value="none">解除出品方关联</option>
          </select>
        </div>
        {choice === 'new' && (
          <div className="publisher-field">
            <label htmlFor={nameId}>出品方名称</label>
            <input
              id={nameId}
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              maxLength={120}
              disabled={busy}
            />
          </div>
        )}
        {error && <p role="alert">{error}</p>}
        {conflict && (
          <button
            type="button"
            className="modal-cancel-btn"
            disabled={busy}
            onClick={() => void reload()}
          >
            重新读取当前归属
          </button>
        )}
        <div className="publisher-form-actions">
          <button type="button" className="modal-cancel-btn" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button
            type="submit"
            className="modal-submit-btn"
            disabled={busy || conflict || (choice === 'new' && !name.trim())}
          >
            {busy ? '保存中…' : '确认并保存'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
