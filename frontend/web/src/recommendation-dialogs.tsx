import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, artist, type Lyrics, type Playlist, type Track } from './api';
import { DialogCloseButton } from './dialog-close';

export function RecommendationPlaylistDialog({
  tracks,
  playlists,
  onSaved,
  onClose,
}: {
  tracks: Track[];
  playlists: Playlist[];
  onSaved: (playlist: Playlist) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const dialog = useRef<HTMLDialogElement>(null);
  const pending = useRef(false);
  const created = useRef<Playlist | null>(null);
  const [target, setTarget] = useState(playlists[0]?.id || 'new');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  async function save() {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      let list: Playlist;
      if (created.current) list = await api<Playlist>(`/playlists/${created.current.id}`);
      else if (target === 'new') {
        list = await api<Playlist>('/playlists', {
          method: 'POST',
          body: JSON.stringify({ name: name.trim(), kind: 'manual' }),
        });
        created.current = list;
      } else list = await api<Playlist>(`/playlists/${target}`);
      const updated = await api<Playlist>(`/playlists/${list.id}/tracks`, {
        method: 'POST',
        body: JSON.stringify({ version: list.version, track_ids: tracks.map((track) => track.id) }),
      });
      onSaved(updated);
      onClose();
    } catch (reason) {
      const prefix = created.current ? `${t('discover.dialog.playlist.created')} ` : '';
      setError(
        `${prefix}${reason instanceof Error ? reason.message : t('discover.dialog.playlist.failed')}`,
      );
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="recommendation-dialog"
      aria-label={t('discover.dialog.playlist.title')}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <div className="editor-heading">
          <h2>{t('discover.dialog.playlist.title')}</h2>
          <DialogCloseButton
            aria-label={t('discover.dialog.playlist.close')}
            onClick={onClose}
            disabled={busy}
          />
        </div>
        <p className="muted">{t('discover.dialog.playlist.selected', { count: tracks.length })}</p>
        <label>
          {t('discover.dialog.playlist.target')}
          <select
            value={target}
            disabled={busy || !!created.current}
            onChange={(event) => setTarget(event.target.value)}
          >
            {playlists.map((list) => (
              <option key={list.id} value={list.id}>
                {list.name}
              </option>
            ))}
            <option value="new">{t('discover.dialog.playlist.new')}</option>
          </select>
        </label>
        {target === 'new' && (
          <label>
            {t('discover.dialog.playlist.name')}
            <input
              value={name}
              maxLength={120}
              disabled={busy || !!created.current}
              onChange={(event) => setName(event.target.value)}
              placeholder={t('discover.dialog.playlist.placeholder')}
              required
            />
          </label>
        )}
        {error && <p role="alert">{error}</p>}
        <div className="toolbar-actions">
          <button type="submit" disabled={busy || (target === 'new' && !name.trim())}>
            {busy ? t('discover.dialog.playlist.saving') : t('discover.dialog.playlist.save')}
          </button>
        </div>
      </form>
    </dialog>
  );
}

export function RecommendationLyricsDialog({
  track,
  onClose,
}: {
  track: Track;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const dialog = useRef<HTMLDialogElement>(null);
  const [lyrics, setLyrics] = useState<Lyrics | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    dialog.current?.showModal();
    const controller = new AbortController();
    void api<Lyrics>(`/tracks/${track.id}/lyrics`, { signal: controller.signal })
      .then(setLyrics)
      .catch((reason) => {
        if (!controller.signal.aborted)
          setError(
            reason instanceof Error ? reason.message : t('discover.dialog.lyrics.loadError'),
          );
      });
    return () => controller.abort();
  }, [track.id]);
  return (
    <dialog
      ref={dialog}
      className="recommendation-dialog"
      aria-label={t('discover.dialog.lyrics.aria', { title: track.title })}
      onCancel={onClose}
    >
      <div className="editor-heading">
        <h2>{track.title}</h2>
        <DialogCloseButton aria-label={t('discover.dialog.lyrics.close')} onClick={onClose} />
      </div>
      <p className="muted">
        {artist(track)} · {t('discover.dialog.lyrics.preview')}
      </p>
      <div className="recommendation-lyrics">
        {error ? (
          <p role="alert">{error}</p>
        ) : !lyrics ? (
          <p role="status">{t('discover.dialog.lyrics.loading')}</p>
        ) : !lyrics.lines.length ? (
          <p>{t('discover.dialog.lyrics.empty')}</p>
        ) : (
          lyrics.lines.map((line, index) => (
            <p key={index}>
              {line.text}
              {line.translation && <small>{line.translation}</small>}
            </p>
          ))
        )}
      </div>
    </dialog>
  );
}
