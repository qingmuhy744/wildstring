import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
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
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  return (
    <>
      <div className="podcast-publisher-affiliation">
        <span>{t('podcastPublishers.label')}</span>
        {podcast.publisher ? (
          <button
            type="button"
            className="podcast-publisher-link"
            onClick={() => onOpen(podcast.publisher!)}
          >
            {podcast.publisher.name}
          </button>
        ) : (
          <span className="publisher-unconfirmed">{t('podcastPublishers.unconfirmed')}</span>
        )}
        {canEdit && (
          <button type="button" className="podcast-refresh-btn" onClick={() => setEditing(true)}>
            {podcast.publisher
              ? t('podcastPublishers.editAffiliation')
              : t('podcastPublishers.confirmAffiliation')}
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
  const { t } = useTranslation();
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
        if (active) setError(t('podcastPublishers.loadListFailed'));
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
      setError(reason instanceof Error ? reason.message : t('podcastPublishers.loadDetailsFailed'));
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
      setError(reason instanceof Error ? reason.message : t('podcastPublishers.saveFailed'));
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
        <h3 id="publisher-editor-title">{t('podcastPublishers.dialogTitle')}</h3>
        <DialogCloseButton
          aria-label={t('podcastPublishers.closeDialog')}
          disabled={busy}
          onClick={onClose}
        />
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
          {t('podcastPublishers.sourceAuthorNotice', {
            author: podcast.author || t('podcastPublishers.notProvided'),
          })}
        </p>
        <p className="publisher-help">
          {t('podcastPublishers.currentAffiliation', {
            name: current.publisher?.name || t('podcastPublishers.unconfirmed'),
          })}
        </p>
        <div className="publisher-field">
          <label htmlFor={choiceId}>{t('podcastPublishers.selectPublisher')}</label>
          <select
            id={choiceId}
            value={choice}
            onChange={(event) => setChoice(event.target.value)}
            disabled={busy}
          >
            <option value="new">{t('podcastPublishers.inputPublisherName')}</option>
            {current.publisher && !publishers.some((item) => item.id === current.publisher!.id) && (
              <option value={current.publisher.id}>{current.publisher.name}</option>
            )}
            {publishers.map((item) => (
              <option key={item.id} value={item.id}>
                {t('podcastPublishers.publisherItem', {
                  name: item.name,
                  count: item.podcast_count,
                })}
              </option>
            ))}
            <option value="none">{t('podcastPublishers.unlinkPublisher')}</option>
          </select>
        </div>
        {choice === 'new' && (
          <div className="publisher-field">
            <label htmlFor={nameId}>{t('podcastPublishers.publisherNameLabel')}</label>
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
            {t('podcastPublishers.reloadCurrent')}
          </button>
        )}
        <div className="publisher-form-actions">
          <button type="button" className="modal-cancel-btn" disabled={busy} onClick={onClose}>
            {t('podcastPublishers.cancel')}
          </button>
          <button
            type="submit"
            className="modal-submit-btn"
            disabled={busy || conflict || (choice === 'new' && !name.trim())}
          >
            {busy ? t('podcastPublishers.saving') : t('podcastPublishers.confirmAndSave')}
          </button>
        </div>
      </form>
    </dialog>
  );
}
